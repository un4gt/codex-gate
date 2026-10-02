import { ThemeProvider } from "@mui/material/styles";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { LogsPage } from "./LogsPage";
import { initializeI18n } from "@/lib/i18n";
import { theme } from "@/theme";

const fetchMock = rs.fn<typeof fetch>();
const settings = { apiBase: "http://localhost", adminToken: "test-token" };
const response = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
function row(id: string, status = 200, observed = true) {
  return {
    id,
    pricing: null,
    time_ms: 1700000000000,
    api_key_id: 1,
    provider_id: 1,
    model: "long-model-name-for-pagination",
    http_status: status,
    api_format: "responses",
    transport: "http",
    span_kind: "http_request",
    duration_ms: 120,
    usage_observed: observed,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    reasoning_output_tokens: 0,
  };
}
function mount() {
  return render(
    <ThemeProvider theme={theme}>
      <LogsPage
        settings={settings}
        providers={[]}
        apiKeys={[]}
        refreshKey={0}
        onMessage={() => undefined}
      />
    </ThemeProvider>,
  );
}
beforeEach(() => {
  localStorage.setItem("little_gate_locale", "en");
  initializeI18n();
  rs.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  rs.unstubAllGlobals();
});

describe("submitted server log queries", () => {
  it("paginates on the server, submits on Enter, and resets the page for query and page size changes", async () => {
    const requests: URL[] = [];
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("console-preferences"))
        return response({
          log_visible_columns: ["time", "model", "status", "total_tokens"],
        });
      requests.push(url);
      const page = Number(url.searchParams.get("page"));
      return response(
        Array.from(
          {
            length: page === 1 ? Number(url.searchParams.get("page_size")) : 3,
          },
          (_, i) => row(`page-${page}-${i}`),
        ),
      );
    });
    mount();
    await screen.findByRole("button", { name: /page-1-0 details/ });
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByRole("button", { name: /page-2-0 details/ });
    expect(requests[requests.length - 1]?.searchParams.get("page")).toBe("2");
    expect(
      (screen.getByRole("button", { name: "Next page" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText("51–53")).toBeTruthy();
    const input = screen.getByLabelText("Search request ID, model, or error");
    const before = requests.length;
    fireEvent.change(input, { target: { value: "new query" } });
    expect(requests.length).toBe(before);
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(requests[requests.length - 1]?.searchParams.get("query")).toBe(
        "new query",
      ),
    );
    expect(requests[requests.length - 1]?.searchParams.get("page")).toBe("1");
    await screen.findByRole("button", { name: /page-1-0 details/ });
    fireEvent.mouseDown(
      screen.getByRole("combobox", { name: "Rows per page" }),
    );
    fireEvent.click(await screen.findByRole("option", { name: "25" }));
    await waitFor(() =>
      expect(requests[requests.length - 1]?.searchParams.get("page_size")).toBe(
        "25",
      ),
    );
    expect(requests[requests.length - 1]?.searchParams.get("page")).toBe("1");
  });

  it("keeps the latest submitted response when an earlier query finishes last", async () => {
    let resolveOld: ((response: Response) => void) | undefined;
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("console-preferences"))
        return response({ log_visible_columns: ["model"] });
      if (url.searchParams.get("query") === "old")
        return new Promise<Response>((resolve) => {
          resolveOld = resolve;
        });
      return response([
        row(
          url.searchParams.get("query") === "new"
            ? "latest-result"
            : "initial-result",
        ),
      ]);
    });
    mount();
    await screen.findByRole("button", { name: /initial-result details/ });
    const input = screen.getByLabelText("Search request ID, model, or error");
    fireEvent.change(input, { target: { value: "old" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(resolveOld).toBeTruthy());
    fireEvent.change(input, { target: { value: "new" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByRole("button", { name: /latest-result details/ });
    await act(async () => resolveOld?.(response([row("stale-result")])));
    expect(
      screen.queryByRole("button", { name: /stale-result details/ }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: /latest-result details/ }),
    ).toBeTruthy();
  });

  it("distinguishes observed zero from missing usage and provides explicit status/detail actions", async () => {
    fetchMock.mockImplementation(async (input) =>
      String(input).includes("console-preferences")
        ? response({ log_visible_columns: ["status", "total_tokens"] })
        : response([
            row("ok", 200),
            row("client-error", 400, false),
            row("upstream-error", 502, false),
          ]),
    );
    mount();
    const table = await screen.findByRole("table", { name: "Request Logs" });
    await waitFor(() =>
      expect(within(table).getAllByRole("row")).toHaveLength(4),
    );
    expect(within(table).getByText("200")).toBeTruthy();
    expect(within(table).getByText("400")).toBeTruthy();
    expect(within(table).getByText("502")).toBeTruthy();
    expect(within(table).getByText("0")).toBeTruthy();
    expect(within(table).getAllByText("Usage not returned")).toHaveLength(2);
    const detail = within(table).getByRole("button", {
      name: /client-error details/,
    });
    detail.focus();
    expect(document.activeElement).toBe(detail);
    fireEvent.click(detail);
    expect(
      await screen.findByRole("dialog", { name: "client-error" }),
    ).toBeTruthy();
  });
  it("expands WS child records without opening the parent detail", async () => {
    fetchMock.mockImplementation(async (input) =>
      String(input).includes("console-preferences")
        ? response({ log_visible_columns: ["model", "status"] })
        : response([
            { ...row("ws-parent"), span_kind: "ws_session", transport: "ws" },
            { ...row("ws-child"), parent_id: "ws-parent", transport: "ws" },
          ]),
    );
    mount();
    const expand = await screen.findByRole("button", {
      name: "Expand WS logs",
    });
    expect(
      screen.queryByRole("button", { name: /ws-child details/ }),
    ).toBeNull();
    fireEvent.click(expand);
    expect(
      await screen.findByRole("button", { name: /ws-child details/ }),
    ).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Collapse WS logs" }));
    expect(
      screen.queryByRole("button", { name: /ws-child details/ }),
    ).toBeNull();
  });
});
