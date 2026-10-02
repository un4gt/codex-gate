import { isValidElement, StrictMode, type ReactNode } from "react";
import CssBaseline from "@mui/material/CssBaseline";
import { ThemeProvider } from "@mui/material/styles";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { MemoryRouter } from "react-router";
import Root from "@/App";
import { CodexOAuthLoginDialog } from "@/components/CodexOAuthPanel";
import { ApiKeysPage } from "@/components/ApiKeysPage";
import { LogsPage } from "@/components/LogsPage";
import { OAuthPage } from "@/components/OAuthPage";
import { ProvidersPage } from "@/components/ProvidersPage";
import { ModelsPage } from "@/components/ModelsPage";
import { ModelAliasesPage } from "@/components/ModelAliasesPage";
import { PricesPage } from "@/components/PricesPage";
import { SettingsPage } from "@/components/SettingsPage";
import { initializeI18n } from "@/lib/i18n";
import type {
  ModelPrice,
  ProviderModelInventory,
  ProviderWorkspace,
  StatsOverviewResponse,
  StatsPeriod,
} from "@/lib/types";
import { theme } from "@/theme";

function renderWithTheme(children: ReactNode) {
  const routed =
    isValidElement(children) &&
    (children.type === Root || children.type === MemoryRouter) ? (
      children
    ) : (
      <MemoryRouter
        initialEntries={[window.location.pathname + window.location.search]}
      >
        {children}
      </MemoryRouter>
    );
  return render(
    <StrictMode>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        {routed}
      </ThemeProvider>
    </StrictMode>,
  );
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function overviewFixture(
  period: StatsPeriod,
  requests: number,
): StatsOverviewResponse {
  return {
    period,
    window: { from_ms: 0, to_ms: 1000 },
    kpis: {
      requests,
      failed: 0,
      error_rate: 0,
      p95_latency_ms: 0,
      avg_latency_ms: 0,
    },
    service_health: {
      providers_enabled: 1,
      endpoints_enabled: 1,
      upstream_keys_enabled: 1,
      healthy: 1,
      warning: 0,
      error: 0,
    },
    token_usage: {
      total_tokens: 0,
      input_tokens: 0,
      output_tokens: 0,
      visible_output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      reasoning_output_tokens: 0,
      usage_observed_requests: 0,
    },
    pricing: { versions: [], usage_groups: [] },
  };
}

function providerWorkspace(): ProviderWorkspace {
  return {
    provider: {
      id: 7,
      name: "Provider A",
      provider_type: "openai",
      enabled: true,
      priority: 100,
      weight: 1,
      supports_include_usage: true,
      websocket_enabled: false,
      beta_features: [],
      request_overrides: { headers: [], body: [] },
      key_selection_strategy: "round_robin",
      groups: [],
      max_attempts: 2,
      max_concurrency: null,
      circuit_breaker_enabled: true,
      circuit_breaker_failure_threshold: 3,
      circuit_breaker_open_ms: 30_000,
      circuit_breaker_half_open_success_threshold: 2,
    },
    endpoints: [],
    keys: [],
  };
}

function modelPrice(): ModelPrice {
  return {
    id: 11,
    provider_id: null,
    model_name: "model-a",
    price_data: {
      schema_version: 2,
      unit: "usd_per_million_tokens",
      base: {
        input: "5",
        output: "30",
        cache_read: "0.5",
        cache_write: "0.75",
      },
      tiers: [],
    },
    created_at_ms: 1_900_000_000_000,
    updated_at_ms: 1_900_000_000_000,
  };
}

function providerWorkspaceWithConnection(): ProviderWorkspace {
  const workspace = providerWorkspace();
  return {
    ...workspace,
    endpoints: [
      {
        id: 71,
        provider_id: workspace.provider.id,
        name: "Endpoint 1",
        base_url: "https://api.example.test",
        enabled: true,
        priority: 100,
        weight: 1,
      },
    ],
    keys: [
      {
        id: 72,
        provider_id: workspace.provider.id,
        name: "Key 1",
        enabled: true,
        priority: 100,
        weight: 1,
      },
    ],
  };
}

function codexProviderWorkspace(): ProviderWorkspace {
  return {
    provider: {
      ...providerWorkspace().provider,
      id: 17,
      name: "Codex Accounts",
      routing_availability: { available: true, reason: null },
      provider_type: "openai_codex_oauth",
      websocket_enabled: true,
      beta_features: ["responses-http-to-ws"],
    },
    endpoints: [
      {
        id: 171,
        provider_id: 17,
        name: "Codex",
        base_url: "https://chatgpt.com/backend-api/codex",
        enabled: true,
        priority: 100,
        weight: 1,
      },
    ],
    keys: [
      {
        id: 172,
        provider_id: 17,
        name: "Primary account",
        routing_availability: { available: true, reason: null },
        enabled: true,
        priority: 100,
        weight: 1,
        auth_kind: "codex_oauth",
        codex_oauth: {
          upstream_key_id: 172,
          provider_id: 17,
          email_masked: "o***@example.com",
          account_id_suffix: "…1234",
          plan_type: "plus",
          token_expires_at_ms: 2_000_000_000_000,
          last_refresh_at_ms: 1_900_000_000_000,
          auth_status: "active",
          last_error: null,
          quota_checked_at_ms: 1_900_000_100_000,
          quota: {
            plan_type: "plus",
            allowed: true,
            primary_window: {
              used_percent: 25,
              remaining_percent: 75,
              window_seconds: 18_000,
              reset_at_ms: 2_000_000_100_000,
            },
            secondary_window: {
              used_percent: 40,
              remaining_percent: 60,
              window_seconds: 2_592_000,
              reset_at_ms: 2_000_100_000_000,
            },
            code_review_window: null,
            credits: {
              has_credits: true,
              unlimited: false,
              balance: 12.5,
              reset_credits: 20,
              subscription_end_at_ms: 2_010_000_000_000,
            },
          },
        },
      },
      {
        id: 173,
        provider_id: 17,
        name: "Secondary account",
        routing_availability: { available: false, reason: "account_disabled" },
        enabled: false,
        priority: 110,
        weight: 1,
        auth_kind: "codex_oauth",
        codex_oauth: {
          upstream_key_id: 173,
          provider_id: 17,
          email_masked: "s***@example.com",
          account_id_suffix: "…5678",
          plan_type: "team",
          token_expires_at_ms: null,
          last_refresh_at_ms: null,
          auth_status: "forbidden",
          last_error: "workspace deactivated",
          quota: null,
          quota_checked_at_ms: null,
        },
      },
    ],
  };
}

describe("admin console smoke test", () => {
  const consoleError = rs.spyOn(console, "error");
  const fetchRequest = rs.spyOn(globalThis, "fetch");

  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.localStorage.setItem(
      "little_gate_api_base",
      "http://127.0.0.1:8080",
    );
    window.localStorage.setItem("little_gate_locale", "en");
    window.history.replaceState({}, "", "/");
    initializeI18n();
    consoleError.mockClear();
    consoleError.mockImplementation(() => undefined);
    fetchRequest.mockReset();
    fetchRequest.mockRejectedValue(new Error("offline"));
  });

  afterEach(() => {
    cleanup();
    consoleError.mockReset();
    fetchRequest.mockReset();
  });

  it("mounts the connection gate without runtime or console errors", async () => {
    renderWithTheme(<Root />);

    expect(
      await screen.findByRole("heading", { name: "LITTLE GATE" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /enter console/i })).toBeTruthy();
    expect(screen.getByText("Backend not connected.")).toBeTruthy();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("keeps the connection gate closed when the submitted admin token is rejected", async () => {
    fetchRequest.mockResolvedValue(
      jsonResponse({ error: "invalid token" }, 401),
    );

    renderWithTheme(<Root />);

    const tokenInput = screen.getByPlaceholderText("Enter admin token");
    fireEvent.change(tokenInput, {
      target: { value: "wrong-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: /enter console/i }));

    await waitFor(() => expect(fetchRequest).toHaveBeenCalled());
    expect(
      await screen.findByText(
        "The admin token is incorrect. Please try again.",
      ),
    ).toBeTruthy();
    expect(tokenInput.getAttribute("aria-invalid")).toBe("true");
    expect(
      screen.queryByText(/401|invalid token|\/api\/v1\/system\/config/i),
    ).toBeNull();
    expect(screen.getByRole("button", { name: /enter console/i })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Primary" })).toBeNull();
  });

  it("keeps statistics aligned with the selected period when responses arrive out of order", async () => {
    window.sessionStorage.setItem("little_gate_admin_token", "test-token");
    window.history.replaceState({}, "", "/overview");
    const pending: Array<(response: Response) => void> = [];
    fetchRequest.mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/system/config") return jsonResponse({});
      if (url.pathname === "/api/v1/stats/overview") {
        const period = url.searchParams.get("period") as StatsPeriod;
        if (period === "7h")
          return new Promise<Response>((resolve) => pending.push(resolve));
        return jsonResponse(
          overviewFixture(period, period === "today" ? 321 : 987),
        );
      }
      return jsonResponse([]);
    });

    // Flush authentication and the initial statistics request before asserting.
    await act(async () => {
      renderWithTheme(<Root />);
    });
    expect(screen.getByText("321")).toBeTruthy();
    const periods = screen.getByRole("group", { name: "Statistics period" });
    await act(async () => {
      fireEvent.click(
        within(periods).getByRole("button", { name: "Last 7 hours" }),
      );
    });
    expect(pending.length).toBeGreaterThan(0);
    expect(screen.queryByText("321")).toBeNull();
    expect(screen.queryByText("Normal")).toBeNull();

    await act(async () => {
      fireEvent.click(
        within(periods).getByRole("button", { name: "Last 24 hours" }),
      );
    });
    expect(screen.getByText("987")).toBeTruthy();
    await act(async () => {
      pending.forEach((resolve) =>
        resolve(jsonResponse(overviewFixture("7h", 456))),
      );
    });
    expect(screen.getByText("987")).toBeTruthy();
    expect(screen.queryByText("456")).toBeNull();
    expect(
      within(periods)
        .getByRole("button", { name: "Last 24 hours" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("validates a stored admin token before restoring the console", async () => {
    window.sessionStorage.setItem("little_gate_admin_token", "wrong-token");
    fetchRequest.mockResolvedValue(
      jsonResponse({ error: "invalid token" }, 401),
    );

    renderWithTheme(<Root />);

    await waitFor(() => expect(fetchRequest).toHaveBeenCalled());
    expect(
      await screen.findByText(
        "The admin token is incorrect. Please try again.",
      ),
    ).toBeTruthy();
    expect(
      screen
        .getByPlaceholderText("Enter admin token")
        .getAttribute("aria-invalid"),
    ).toBe("true");
    expect(
      screen.queryByText(/401|invalid token|\/api\/v1\/system\/config/i),
    ).toBeNull();
    expect(screen.getByRole("button", { name: /enter console/i })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Primary" })).toBeNull();
  });

  it("opens the pricing settings without the former Ark Field context crash", async () => {
    renderWithTheme(
      <SettingsPage
        settings={{
          apiBase: "http://127.0.0.1:8080",
          adminToken: "test-token",
        }}
        systemConfig={null}
        runtimeSettings={null}
        runtimeEnvPreview={null}
        onApiBaseChange={() => undefined}
        onAdminTokenChange={() => undefined}
        onRefresh={async () => undefined}
        onMessage={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Advanced Settings" }));
    fireEvent.click(screen.getByRole("button", { name: /pricing & cost/i }));

    expect(
      screen
        .getByRole("link", { name: "Go to Price Management" })
        .getAttribute("href"),
    ).toBe("/models/prices");
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("enables encrypted recovery only after saving the advanced Beta setting", async () => {
    fetchRequest.mockResolvedValue(jsonResponse({ ok: true }));
    const refresh = rs.fn().mockResolvedValue(undefined);
    renderWithTheme(
      <SettingsPage
        settings={{
          apiBase: "http://127.0.0.1:8080",
          adminToken: "test-token",
        }}
        systemConfig={null}
        runtimeSettings={{
          updated_at_ms: 0,
          settings: [
            {
              key: "encrypted_content_recovery",
              group: "beta",
              label: "加密内容恢复（Beta）",
              value: false,
              default_value: false,
              editable: true,
              requires_restart: false,
              updated_at_ms: null,
            },
          ],
        }}
        runtimeEnvPreview={null}
        onApiBaseChange={() => undefined}
        onAdminTokenChange={() => undefined}
        onRefresh={refresh}
        onMessage={() => undefined}
      />,
    );
    fireEvent.click(screen.getByText("Advanced Settings"));
    fireEvent.click(screen.getByRole("button", { name: /Beta Features/i }));
    const checkbox = screen.getByRole("checkbox", {
      name: "Enable encrypted content recovery",
    }) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    expect(screen.getByText(/may lose earlier context/i)).toBeTruthy();
    fireEvent.click(checkbox);
    expect(fetchRequest).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const [url, options] = fetchRequest.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("http://127.0.0.1:8080/api/v1/runtime-settings");
    expect(options.method).toBe("PATCH");
    expect(JSON.parse(String(options.body))).toEqual({
      key: "encrypted_content_recovery",
      value: true,
    });
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("keeps long model identifiers and pricing headers on one line", () => {
    const modelName = "openai/gpt-5.4-2026-08-14-long-model-identifier";
    renderWithTheme(
      <PricesPage
        settings={{
          apiBase: "http://127.0.0.1:8080",
          adminToken: "test-token",
        }}
        providers={[]}
        items={[
          {
            id: 11,
            provider_id: null,
            model_name: modelName,
            price_data: {
              schema_version: 2,
              unit: "usd_per_million_tokens",
              base: {
                input: "5",
                output: "30",
                cache_read: null,
                cache_write: "0.5",
              },
              tiers: [],
            },
            created_at_ms: 1_900_000_000_000,
            updated_at_ms: 1_900_000_000_000,
          },
        ]}
        onRefresh={async () => undefined}
        onMessage={() => undefined}
      />,
    );

    const table = screen.getByRole("table", {
      name: "Currently Available Price Items",
    });
    const model = screen.getByTitle(modelName);
    expect(model.textContent).toContain(modelName);
    expect(model.closest("td")).toBeTruthy();
    expect(within(table).getAllByRole("columnheader").length).toBeGreaterThan(
      1,
    );
    expect(table.closest(".MuiTableContainer-root")).toBeTruthy();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("updates a price as a new version and reports historical repricing", async () => {
    let request: {
      method: string;
      path: string;
      body: Record<string, any>;
    } | null = null;
    const refreshMessages: string[] = [];
    fetchRequest.mockImplementation(async (input, init) => {
      request = {
        method: init?.method ?? "GET",
        path: new URL(String(input)).pathname,
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, any>,
      };
      return jsonResponse({
        id: 12,
        replaced_price_id: 11,
        backfilled_requests: 90,
        history_recalculation_pending: false,
      });
    });

    renderWithTheme(
      <PricesPage
        settings={{
          apiBase: "http://127.0.0.1:8080",
          adminToken: "test-token",
        }}
        providers={[]}
        items={[modelPrice()]}
        onRefresh={async (message) => {
          refreshMessages.push(message ?? "");
        }}
        onMessage={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit price model-a" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Edit Model Price",
    });
    fireEvent.change(within(dialog).getByDisplayValue("5"), {
      target: { value: "6" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save Price" }));

    await waitFor(() => expect(request).not.toBeNull());
    expect(request).toMatchObject({
      method: "PATCH",
      path: "/api/v1/prices/11",
    });
    expect((request as any).body.price_data.base.input).toBe("6");
    expect(refreshMessages).toEqual([
      "Price model-a updated. Repriced 90 historical requests with the current price.",
    ]);
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Edit Model Price" }),
      ).toBeNull(),
    );
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("deletes only the active price after an in-app confirmation", async () => {
    const requests: string[] = [];
    const refreshMessages: string[] = [];
    fetchRequest.mockImplementation(async (input, init) => {
      requests.push(
        `${init?.method ?? "GET"} ${new URL(String(input)).pathname}`,
      );
      return jsonResponse({
        ok: true,
        deactivated_price_id: 11,
        provider_id: null,
        model_name: "model-a",
        backfilled_requests: 0,
        history_recalculation_pending: false,
      });
    });

    renderWithTheme(
      <PricesPage
        settings={{
          apiBase: "http://127.0.0.1:8080",
          adminToken: "test-token",
        }}
        providers={[]}
        items={[modelPrice()]}
        onRefresh={async (message) => {
          refreshMessages.push(message ?? "");
        }}
        onMessage={() => undefined}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Delete price model-a" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Delete Current Price",
    });
    expect(within(dialog).getByText(/historical price versions/i)).toBeTruthy();
    const cancelButton = within(dialog).getByRole("button", { name: "Cancel" });
    await waitFor(() => {
      expect(document.activeElement).toBe(cancelButton);
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Confirm Delete" }),
    );

    await waitFor(() =>
      expect(requests.filter((request) => !request.startsWith("GET "))).toEqual(
        ["DELETE /api/v1/prices/11"],
      ),
    );
    expect(refreshMessages).toEqual([
      "Price model-a deleted. No historical requests required repricing.",
    ]);
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Delete Current Price" }),
      ).toBeNull();
    });
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("requires an explicit value for every token price category", () => {
    renderWithTheme(
      <PricesPage
        settings={{
          apiBase: "http://127.0.0.1:8080",
          adminToken: "test-token",
        }}
        providers={[]}
        items={[]}
        onRefresh={async () => undefined}
        onMessage={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add Price" }));
    expect(
      (screen.getByPlaceholderText("2.50") as HTMLInputElement).required,
    ).toBe(true);
    expect(
      (screen.getByPlaceholderText("15.00") as HTMLInputElement).required,
    ).toBe(true);
    expect(
      (screen.getByPlaceholderText("0.25") as HTMLInputElement).required,
    ).toBe(true);
    expect(
      (screen.getByPlaceholderText("3.125") as HTMLInputElement).required,
    ).toBe(true);
    expect(
      screen.getByText(
        "All four rates are required; enter 0 for free token categories.",
      ),
    ).toBeTruthy();
    expect(consoleError).not.toHaveBeenCalled();
  });

  function upstreamFixture() {
    const data = providerWorkspaceWithConnection();
    fetchRequest.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/v1/system/config")
        return jsonResponse({
          capabilities: {
            websocket: true,
            websocket_to_http: true,
            request_rewrite: true,
          },
          stability: { upstream_request_timeout_ms: 60000 },
        });
      if (path.endsWith("/runtime"))
        return jsonResponse({ ...data, recent_errors: [] });
      if ((init?.method ?? "GET") === "GET") return jsonResponse(data);
      return jsonResponse({ ok: true });
    });
    window.localStorage.setItem("little_gate_locale", "zh");
    initializeI18n();
    return data;
  }
  function renderUpstream(data = providerWorkspaceWithConnection()) {
    return renderWithTheme(
      <ProvidersPage
        settings={{
          apiBase: "http://127.0.0.1:8080",
          adminToken: "test-token",
        }}
        items={[data]}
        onRefresh={async () => {}}
        onMessage={() => {}}
      />,
    );
  }
  it("loads connection details only after opening an upstream", async () => {
    const data = upstreamFixture();
    renderUpstream(data);
    expect(fetchRequest).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "管理" }));
    expect(await screen.findByRole("tab", { name: "连接" })).toBeTruthy();
    expect(await screen.findByRole("textbox", { name: "名称" })).toBeTruthy();
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    expect(screen.queryByRole("spinbutton", { name: "优先级" })).toBeNull();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("creates connection resources atomically without upstream scheduling fields", async () => {
    const data = upstreamFixture();
    const writes: Array<any> = [];
    fetchRequest.mockImplementation(async (input, init) => {
      if (init?.method === "POST") {
        writes.push({
          path: new URL(String(input)).pathname,
          body: JSON.parse(String(init.body)),
        });
        return jsonResponse({ id: 7, endpoint_ids: [71], key_ids: [72] });
      }
      return jsonResponse(String(input).endsWith("/config") ? {} : data);
    });
    renderWithTheme(
      <ProvidersPage
        settings={{
          apiBase: "http://127.0.0.1:8080",
          adminToken: "test-token",
        }}
        items={[]}
        onRefresh={async () => {}}
        onMessage={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "新增上游" }));
    fireEvent.change(screen.getByLabelText(/^名称/), {
      target: { value: "New upstream" },
    });
    fireEvent.change(screen.getByLabelText(/^服务地址（每行一个）/), {
      target: { value: "https://example.test/v1" },
    });
    fireEvent.change(screen.getByLabelText(/^API Key（每行一个）/), {
      target: { value: "synthetic-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建上游" }));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[0].body).toMatchObject({
      name: "New upstream",
      endpoints: [
        expect.objectContaining({ base_url: "https://example.test/v1" }),
      ],
      keys: [expect.objectContaining({ secret: "synthetic-key" })],
    });
    expect(writes[0].body).not.toHaveProperty("priority");
    expect(writes[0].body).not.toHaveProperty("groups");
    expect(writes[1].path).toBe("/api/v1/upstreams/7/models/sync");
  });

  it("completes the Codex OAuth browser callback flow", async () => {
    let providerPayload: Record<string, unknown> | null = null;
    let endpointPayload: Record<string, unknown> | null = null;
    let sessionPayload: Record<string, unknown> | null = null;
    let callbackPayload: Record<string, unknown> | null = null;
    let sessionStarts = 0;
    let sessionPolls = 0;
    const requests: string[] = [];
    const refreshMessages: string[] = [];
    fetchRequest.mockImplementation(async (input, init) => {
      const url = String(input);
      const path = new URL(url).pathname;
      const method = init?.method ?? "GET";
      requests.push(`${method} ${path}`);
      if (method === "POST" && path === "/api/v1/upstreams") {
        providerPayload = JSON.parse(String(init?.body));
        endpointPayload = (
          providerPayload?.endpoints as Record<string, unknown>[]
        )[0];
        return jsonResponse({ id: 19, endpoint_ids: [191], key_ids: [] });
      }
      if (method === "POST" && path === "/api/v1/upstreams/19/endpoints") {
        endpointPayload = JSON.parse(String(init?.body));
        return jsonResponse({ id: 191 });
      }
      if (
        method === "POST" &&
        path === "/api/v1/upstreams/19/codex-oauth/sessions"
      ) {
        sessionStarts += 1;
        sessionPayload = JSON.parse(String(init?.body));
        return jsonResponse({
          session_id: "oauth-session-1",
          status: "pending",
          flow: "browser",
          stage: "waiting_for_user",
          verification_uri:
            "https://auth.openai.com/oauth/authorize?state=test",
          expires_at_ms: Date.now() + 60_000,
          poll_interval_ms: 1,
        });
      }
      if (
        method === "POST" &&
        path === "/api/v1/codex-oauth/sessions/oauth-session-1/callback"
      ) {
        callbackPayload = JSON.parse(String(init?.body));
        return jsonResponse(
          {
            session_id: "oauth-session-1",
            status: "pending",
            flow: "browser",
            stage: "exchanging",
            verification_uri:
              "https://auth.openai.com/oauth/authorize?state=test",
            expires_at_ms: Date.now() + 60_000,
            poll_interval_ms: 1,
          },
          202,
        );
      }
      if (
        method === "GET" &&
        path === "/api/v1/codex-oauth/sessions/oauth-session-1"
      ) {
        sessionPolls += 1;
        return jsonResponse({
          session_id: "oauth-session-1",
          status: "completed",
          flow: "browser",
          stage: "finished",
          verification_uri:
            "https://auth.openai.com/oauth/authorize?state=test",
          expires_at_ms: Date.now() + 60_000,
          poll_interval_ms: 1,
          key_id: 192,
          operation: "created",
          warnings: ["quota: temporarily unavailable"],
        });
      }
      return jsonResponse([]);
    });

    renderWithTheme(
      <CodexOAuthLoginDialog
        open
        attemptId={1}
        settings={{
          apiBase: "http://127.0.0.1:8080",
          adminToken: "test-token",
        }}
        providerId={19}
        replaceKeyId={null}
        onClose={() => {}}
        onMessage={() => {}}
        onCompleted={async () => {}}
      />,
    );

    expect(
      await screen.findByRole("link", { name: "Open OpenAI Sign-In" }),
    ).toBeTruthy();
    const callbackUrl =
      "http://localhost:1455/auth/callback?code=code-1&state=test";
    fireEvent.change(screen.getByLabelText("Callback URL"), {
      target: { value: callbackUrl },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Submit Callback URL" }),
    );
    expect(await screen.findByText("Sign-In Complete")).toBeTruthy();
    expect(
      await screen.findByText("Post-Login Checks Reported Warnings"),
    ).toBeTruthy();
    expect(sessionPayload).toEqual({ replace_key_id: null, flow: "browser" });
    expect(callbackPayload).toEqual({ redirect_url: callbackUrl });
    expect(sessionStarts).toBe(1);
    expect(sessionPolls).toBe(1);
    expect(requests.some((request) => request.endsWith("/keys"))).toBe(false);
    expect(requests.some((request) => request.endsWith("/models/sync"))).toBe(
      false,
    );
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("cancels the browser session before switching to the device-code fallback", async () => {
    const startedFlows: string[] = [];
    const cancelledSessions: string[] = [];
    let closed = false;
    fetchRequest.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? "GET";
      if (method === "POST" && path.endsWith("/codex-oauth/sessions")) {
        const flow = JSON.parse(String(init?.body)).flow as string;
        startedFlows.push(flow);
        if (flow === "browser") {
          return jsonResponse({
            session_id: "oauth-session-browser",
            status: "pending",
            flow: "browser",
            stage: "waiting_for_user",
            verification_uri:
              "https://auth.openai.com/oauth/authorize?state=test",
            expires_at_ms: Date.now() + 60_000,
            poll_interval_ms: 60_000,
          });
        }
        return jsonResponse({
          session_id: "oauth-session-device",
          status: "pending",
          flow: "device",
          stage: "waiting_for_user",
          verification_uri: "https://auth.openai.com/codex/device",
          user_code: "DEVICE-CODE",
          expires_at_ms: Date.now() + 60_000,
          poll_interval_ms: 60_000,
        });
      }
      if (method === "DELETE") {
        cancelledSessions.push(path);
        return new Response(null, { status: 204 });
      }
      return jsonResponse([]);
    });

    renderWithTheme(
      <CodexOAuthLoginDialog
        open
        attemptId={1}
        settings={{
          apiBase: "http://127.0.0.1:8080",
          adminToken: "test-token",
        }}
        providerId={19}
        replaceKeyId={null}
        onClose={() => {
          closed = true;
        }}
        onCompleted={() => undefined}
        onMessage={() => undefined}
      />,
    );

    expect(
      await screen.findByRole("link", { name: "Open OpenAI Sign-In" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Device Code" }));
    expect(await screen.findByText("DEVICE-CODE")).toBeTruthy();
    expect(startedFlows).toEqual(["browser", "device"]);
    expect(cancelledSessions).toContain(
      "/api/v1/codex-oauth/sessions/oauth-session-browser",
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(closed).toBe(true));
    expect(cancelledSessions).toContain(
      "/api/v1/codex-oauth/sessions/oauth-session-device",
    );
  });

  it("cancels a browser session that starts after its dialog was already closed", async () => {
    let resolveStart: ((response: Response) => void) | null = null;
    const cancelledSessions: string[] = [];
    fetchRequest.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? "GET";
      if (method === "POST") {
        return await new Promise<Response>((resolve) => {
          resolveStart = resolve;
        });
      }
      if (method === "DELETE") {
        cancelledSessions.push(path);
        return new Response(null, { status: 204 });
      }
      return jsonResponse([]);
    });

    const rendered = renderWithTheme(
      <CodexOAuthLoginDialog
        open
        attemptId={7}
        settings={{
          apiBase: "http://127.0.0.1:8080",
          adminToken: "test-token",
        }}
        providerId={19}
        replaceKeyId={null}
        onClose={() => undefined}
        onCompleted={() => undefined}
        onMessage={() => undefined}
      />,
    );

    await waitFor(() => expect(resolveStart).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    rendered.unmount();
    const completeStart = resolveStart as ((response: Response) => void) | null;
    expect(completeStart).toBeTruthy();
    completeStart!(
      jsonResponse({
        session_id: "late-browser-session",
        status: "pending",
        flow: "browser",
        stage: "waiting_for_user",
        verification_uri: "https://auth.openai.com/oauth/authorize?state=late",
        expires_at_ms: Date.now() + 60_000,
        poll_interval_ms: 60_000,
      }),
    );

    await waitFor(() =>
      expect(cancelledSessions).toEqual([
        "/api/v1/codex-oauth/sessions/late-browser-session",
      ]),
    );
  });

  it("creates the default Codex provider from the OAuth page and starts browser sign-in", async () => {
    let providerPayload: Record<string, unknown> | null = null;
    let endpointPayload: Record<string, unknown> | null = null;
    let sessionPayload: Record<string, unknown> | null = null;
    const refreshMessages: string[] = [];
    fetchRequest.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? "GET";
      if (method === "POST" && path === "/api/v1/upstreams") {
        providerPayload = JSON.parse(String(init?.body));
        endpointPayload = (
          providerPayload?.endpoints as Record<string, unknown>[]
        )[0];
        return jsonResponse({ id: 31 });
      }
      if (method === "POST" && path === "/api/v1/upstreams/31/endpoints") {
        endpointPayload = JSON.parse(String(init?.body));
        return jsonResponse({ id: 311 });
      }
      if (
        method === "POST" &&
        path === "/api/v1/upstreams/31/codex-oauth/sessions"
      ) {
        sessionPayload = JSON.parse(String(init?.body));
        return jsonResponse({
          session_id: "oauth-page-session",
          status: "pending",
          flow: "browser",
          stage: "waiting_for_user",
          verification_uri:
            "https://auth.openai.com/oauth/authorize?state=oauth-page",
          expires_at_ms: Date.now() + 60_000,
          poll_interval_ms: 60_000,
        });
      }
      if (method === "DELETE") return new Response(null, { status: 204 });
      return jsonResponse([]);
    });

    renderWithTheme(
      <MemoryRouter initialEntries={["/oauth"]}>
        <OAuthPage
          settings={{
            apiBase: "http://127.0.0.1:8080",
            adminToken: "test-token",
          }}
          items={[]}
          loading={false}
          onRefresh={async (message) => {
            refreshMessages.push(message ?? "");
          }}
          onMessage={() => undefined}
        />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create and Sign In" }));
    expect(
      await screen.findByRole("link", { name: "Open OpenAI Sign-In" }),
    ).toBeTruthy();
    expect(providerPayload).toMatchObject({
      name: "OpenAI Codex OAuth",
      provider_type: "openai_codex_oauth",
      websocket_enabled: true,
      beta_features: ["responses-http-to-ws"],
    });
    expect(endpointPayload).toMatchObject({
      name: "Codex",
      base_url: "https://chatgpt.com/backend-api/codex",
    });
    expect(sessionPayload).toEqual({ replace_key_id: null, flow: "browser" });
    expect(refreshMessages).toContain("The Codex OAuth provider was created.");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  });

  it("keeps OAuth creation atomic when the default endpoint cannot be stored", async () => {
    const deleted: string[] = [];
    fetchRequest.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? "GET";
      if (method === "POST" && path === "/api/v1/upstreams")
        return jsonResponse({ error: "endpoint failed" }, 500);
      if (method === "POST" && path === "/api/v1/upstreams/32/endpoints") {
        return jsonResponse({ error: "endpoint failed" }, 500);
      }
      if (method === "DELETE") {
        deleted.push(path);
        return new Response(null, { status: 204 });
      }
      return jsonResponse([]);
    });

    renderWithTheme(
      <MemoryRouter initialEntries={["/oauth"]}>
        <OAuthPage
          settings={{
            apiBase: "http://127.0.0.1:8080",
            adminToken: "test-token",
          }}
          items={[]}
          loading={false}
          onRefresh={async () => undefined}
          onMessage={() => undefined}
        />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create and Sign In" }));
    expect(await screen.findByText("Failed to create provider.")).toBeTruthy();
    expect(deleted).toEqual([]);
  });

  it("renders Codex accounts without batch controls and calls per-account APIs", async () => {
    const requests: string[] = [];
    fetchRequest.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? "GET";
      if (method === "GET" && path === "/api/v1/upstreams/17")
        return jsonResponse(codexProviderWorkspace());
      requests.push(`${method} ${path}`);
      if (method === "POST" && path.endsWith("/quota/refresh"))
        return jsonResponse({});
      if (method === "PATCH") return jsonResponse({ ok: true });
      if (method === "DELETE") return new Response(null, { status: 204 });
      return jsonResponse([]);
    });

    renderWithTheme(
      <ProvidersPage
        settings={{
          apiBase: "http://127.0.0.1:8080",
          adminToken: "test-token",
        }}
        items={[codexProviderWorkspace()]}
        onRefresh={async () => undefined}
        onMessage={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Manage" }));
    expect(
      await screen.findByRole("heading", { name: "OAuth Accounts" }),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "API Keys" })).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "Key Model Restrictions" }),
    ).toBeNull();
    expect(screen.queryByText(/select all/i)).toBeNull();

    // 多账号默认折叠：异常状态留在行内，明细要展开才出现
    expect(screen.getByText("Account disabled")).toBeTruthy();
    expect(screen.queryByText("Credits Balance")).toBeNull();

    const primaryToggle = screen
      .getByText("o***@example.com")
      .closest("button") as HTMLElement;
    const secondaryToggle = screen
      .getByText("s***@example.com")
      .closest("button") as HTMLElement;
    expect(primaryToggle).toBeTruthy();
    expect(secondaryToggle).toBeTruthy();

    fireEvent.click(primaryToggle);
    expect(await screen.findByText("Credits Balance")).toBeTruthy();
    expect(screen.getByText("5-Hour Quota")).toBeTruthy();
    expect(screen.getByText("30-Day Quota")).toBeTruthy();

    // 每行操作收在溢出菜单里，没有批量控件
    const primaryRow = primaryToggle.parentElement as HTMLElement;
    fireEvent.click(
      within(primaryRow).getByRole("button", { name: "Account actions" }),
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Refresh Quota" }),
    );
    await waitFor(() =>
      expect(requests).toContain(
        "POST /api/v1/keys/172/codex-oauth/quota/refresh",
      ),
    );

    const secondaryRow = secondaryToggle.parentElement as HTMLElement;
    fireEvent.click(
      within(secondaryRow).getByRole("button", { name: "Account actions" }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Enable" }));
    await waitFor(() => expect(requests).toContain("PATCH /api/v1/keys/173"));

    fireEvent.click(
      within(primaryRow).getByRole("button", { name: "Account actions" }),
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Model restrictions" }),
    );
    const modelsDialog = await screen.findByRole("dialog", {
      name: /Model restrictions/,
    });
    expect(
      await within(modelsDialog).findByText("No model restrictions configured"),
    ).toBeTruthy();
    expect(
      within(modelsDialog).getByText(
        /Deleting all entries removes the restriction/,
      ),
    ).toBeTruthy();
    fireEvent.change(within(modelsDialog).getByRole("textbox"), {
      target: { value: "gpt-6-astra" },
    });
    fireEvent.click(within(modelsDialog).getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(requests).toContain("POST /api/v1/keys/172/models"),
    );
    fireEvent.click(
      within(modelsDialog).getByRole("button", { name: "Close" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: /Model restrictions/ }),
      ).toBeNull(),
    );

    // 删除走应用内确认框，不再是原生 window.confirm
    fireEvent.click(
      within(primaryRow).getByRole("button", { name: "Account actions" }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Delete OAuth Account",
    });
    expect(within(dialog).getByText(/cannot be undone/i)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(requests).toContain("DELETE /api/v1/keys/172"));
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("retries synchronization without recreating an upstream", async () => {
    const data = upstreamFixture();
    let creates = 0;
    let syncs = 0;
    fetchRequest.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (init?.method === "POST" && path === "/api/v1/upstreams") {
        creates++;
        return jsonResponse({ id: 7, endpoint_ids: [], key_ids: [] });
      }
      if (init?.method === "POST" && path.endsWith("/sync")) {
        syncs++;
        return syncs === 1
          ? new Response("sync failed", { status: 502 })
          : jsonResponse([]);
      }
      return jsonResponse(path.endsWith("/config") ? {} : data);
    });
    renderUpstream(data);
    fireEvent.click(screen.getByRole("button", { name: "新增上游" }));
    fireEvent.change(screen.getByLabelText(/^名称/), {
      target: { value: "Retry" },
    });
    fireEvent.change(screen.getByLabelText(/^服务地址（每行一个）/), {
      target: { value: "https://example.test" },
    });
    fireEvent.change(screen.getByLabelText(/^API Key（每行一个）/), {
      target: { value: "synthetic" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建上游" }));
    fireEvent.click(await screen.findByRole("button", { name: "重试同步" }));
    await waitFor(() => expect(syncs).toBe(2));
    expect(creates).toBe(1);
  });

  it("preserves connection drafts after a failed atomic creation", async () => {
    upstreamFixture();
    fetchRequest.mockResolvedValue(
      new Response("atomic save failed", { status: 500 }),
    );
    renderUpstream();
    fireEvent.click(screen.getByRole("button", { name: "新增上游" }));
    fireEvent.change(screen.getByLabelText(/^名称/), {
      target: { value: "Draft" },
    });
    fireEvent.change(screen.getByLabelText(/^服务地址（每行一个）/), {
      target: { value: "https://example.test" },
    });
    fireEvent.change(screen.getByLabelText(/^API Key（每行一个）/), {
      target: { value: "synthetic" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建上游" }));
    expect(await screen.findByText(/atomic save failed/)).toBeTruthy();
    expect(
      (screen.getByLabelText(/^API Key（每行一个）/) as HTMLInputElement).value,
    ).toBe("synthetic");
  });

  it("saves basic connection settings without overwriting advanced configuration", async () => {
    const data = upstreamFixture();
    renderUpstream(data);
    fireEvent.click(screen.getByRole("button", { name: "管理" }));
    await screen.findByLabelText(/^名称/);
    fireEvent.change(screen.getByLabelText(/^名称/), {
      target: { value: "Renamed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存基础信息" }));
    await waitFor(() =>
      expect(
        fetchRequest.mock.calls.some(([, i]) => i?.method === "PATCH"),
      ).toBe(true),
    );
    const patch = fetchRequest.mock.calls.find(
      ([, i]) => i?.method === "PATCH",
    )!;
    expect(JSON.parse(String(patch[1]?.body))).toEqual({
      name: "Renamed",
      provider_type: data.provider.provider_type,
      enabled: true,
    });
  });

  it("marks an expired access key as expired and excludes it from usable keys", () => {
    renderWithTheme(
      <ApiKeysPage
        settings={{
          apiBase: "http://127.0.0.1:8080",
          adminToken: "test-token",
        }}
        providers={[]}
        items={[
          {
            apiKey: {
              id: 1,
              name: "expired-client",
              enabled: true,
              log_enabled: true,
              expires_at_ms: Date.now() - 1000,
              provider_groups: [],
            },
            totals: {
              requests: 0,
              success: 0,
              failed: 0,
              tokens: 0,
              averageWaitMs: 0,
              activeDays: 0,
            },
            recentModels: [],
          },
        ]}
        onRefresh={async () => undefined}
        onMessage={() => undefined}
      />,
    );
    const row = screen.getByText("expired-client").closest("tr")!;
    expect(within(row).getByText("Expired")).toBeTruthy();
    expect(within(row).queryByText("Expiring Soon")).toBeNull();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("synchronizes models from the connection summary", async () => {
    const data = upstreamFixture();
    renderUpstream(data);
    fireEvent.click(screen.getByRole("button", { name: "管理" }));
    fireEvent.click(await screen.findByRole("button", { name: "同步模型" }));
    await waitFor(() =>
      expect(
        fetchRequest.mock.calls.some(
          ([u, i]) =>
            String(u).endsWith("/upstreams/7/models/sync") &&
            i?.method === "POST",
        ),
      ).toBe(true),
    );
  });

  it("keeps a connection draft while switching tabs and refreshing runtime", async () => {
    const data = upstreamFixture();
    renderUpstream(data);
    fireEvent.click(screen.getByRole("button", { name: "管理" }));
    await screen.findByLabelText(/^名称/);
    fireEvent.change(screen.getByLabelText(/^名称/), {
      target: { value: "Unsaved" },
    });
    fireEvent.click(screen.getByRole("tab", { name: "状态 / 调试" }));
    fireEvent.click(await screen.findByRole("button", { name: "刷新状态" }));
    fireEvent.click(screen.getByRole("tab", { name: "连接" }));
    expect((screen.getByLabelText(/^名称/) as HTMLInputElement).value).toBe(
      "Unsaved",
    );
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(
      await screen.findByRole("dialog", { name: "放弃未保存的修改？" }),
    ).toBeTruthy();
  });

  it("shows only supported protocol controls and defers the request rule editor", async () => {
    const data = upstreamFixture();
    renderUpstream(data);
    fireEvent.click(screen.getByRole("button", { name: "管理" }));
    await screen.findByLabelText(/^名称/);
    fireEvent.click(screen.getByRole("tab", { name: "高级设置" }));
    expect(screen.queryByRole("spinbutton", { name: "权重" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "协议兼容" }));
    expect(
      await screen.findByLabelText("允许 WebSocket 请求回退到 HTTP 上游"),
    ).toBeTruthy();
    expect(screen.queryByText("HTTP→WS Beta")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "应用 Codex 客户端兼容预设" }),
    ).toBeNull();
  });

  it("cancels provider deletion without sending a request", async () => {
    const data = upstreamFixture();
    renderUpstream(data);
    fireEvent.click(screen.getByRole("button", { name: "管理" }));
    await screen.findByLabelText(/^名称/);
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "删除整个上游" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "确认删除整个上游？历史数据会保留。",
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(
      fetchRequest.mock.calls.some(([, i]) => i?.method === "DELETE"),
    ).toBe(false);
  });

  it("deletes a provider once and refreshes the list", async () => {
    const data = upstreamFixture();
    renderUpstream(data);
    fireEvent.click(screen.getByRole("button", { name: "管理" }));
    await screen.findByLabelText(/^名称/);
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "删除整个上游" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "确认删除整个上游？历史数据会保留。",
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "确认删除" }));
    await waitFor(() =>
      expect(
        fetchRequest.mock.calls.filter(([, i]) => i?.method === "DELETE"),
      ).toHaveLength(1),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps the confirmation open when provider deletion fails", async () => {
    const data = upstreamFixture();
    fetchRequest.mockImplementation(async (input, init) =>
      init?.method === "DELETE"
        ? new Response("delete failed", { status: 500 })
        : jsonResponse(String(input).endsWith("/config") ? {} : data),
    );
    renderUpstream(data);
    fireEvent.click(screen.getByRole("button", { name: "管理" }));
    await screen.findByLabelText(/^名称/);
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "删除整个上游" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "确认删除整个上游？历史数据会保留。",
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "确认删除" }));
    expect(await within(dialog).findByText(/delete failed/)).toBeTruthy();
    expect(
      screen.getByRole("dialog", {
        name: "确认删除整个上游？历史数据会保留。",
      }),
    ).toBeTruthy();
  });

  it("makes every navigation row sortable while preserving link navigation", async () => {
    window.sessionStorage.setItem("little_gate_admin_token", "test-token");
    window.history.replaceState({}, "", "/overview");
    fetchRequest.mockImplementation(async (input) => {
      if (String(input).endsWith("/api/v1/system/config"))
        return jsonResponse({});
      throw new Error("offline");
    });

    renderWithTheme(<Root />);

    const navigation = await screen.findByRole("navigation", {
      name: "Primary",
    });
    const links = Array.from(
      navigation.querySelectorAll<HTMLElement>('[data-nav-sortable="true"]'),
    );

    expect(links).toHaveLength(8);
    expect(
      navigation
        .querySelector<HTMLElement>('[data-nav-key="oauth"]')
        ?.getAttribute("href"),
    ).toBe("/oauth");
    for (const link of links) {
      expect(link.getAttribute("data-nav-sortable")).toBe("true");
      expect(link.getAttribute("aria-describedby")).toBe(
        "primary-nav-sort-instructions",
      );
      expect(link.getAttribute("data-nav-sortable")).toBe("true");
    }
    expect(
      within(navigation).queryByRole("button", { name: /reorder navigation/i }),
    ).toBeNull();
    expect(
      screen.getByText(/Drag any navigation item to reorder it/i),
    ).toBeTruthy();

    const logsLink = navigation.querySelector<HTMLElement>(
      '[data-nav-key="logs"]',
    );
    expect(logsLink).toBeTruthy();
    fireEvent.click(logsLink!);

    await waitFor(() => expect(window.location.pathname).toBe("/logs"));
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("inserts OAuth and Models into an existing custom navigation order without resetting it", async () => {
    window.sessionStorage.setItem("little_gate_admin_token", "test-token");
    window.localStorage.setItem(
      "little_gate_nav_order",
      JSON.stringify(["logs", "overview", "upstreams", "keys", "settings"]),
    );
    window.history.replaceState({}, "", "/overview");
    fetchRequest.mockImplementation(async (input) => {
      if (String(input).endsWith("/api/v1/system/config"))
        return jsonResponse({});
      throw new Error("offline");
    });

    renderWithTheme(<Root />);

    const navigation = await screen.findByRole("navigation", {
      name: "Primary",
    });
    expect(
      Array.from(
        navigation.querySelectorAll<HTMLElement>('[data-nav-sortable="true"]'),
      ).map((link) => link.getAttribute("href")),
    ).toEqual([
      "/logs",
      "/overview",
      "/upstreams",
      "/oauth",
      "/models",
      "/keys",
      "/settings",
      "/notifications",
    ]);
  });

  const catalogResponse = (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/v1/system/config") return jsonResponse({});
    if (path === "/api/v1/upstreams")
      return jsonResponse([providerWorkspaceWithConnection()]);
    if (path === "/api/v1/upstreams/7")
      return jsonResponse(providerWorkspaceWithConnection());
    if (path === "/api/v1/provider-models")
      return jsonResponse([
        {
          id: 11,
          provider_id: 7,
          provider_name: "Provider A",
          provider_type: "openai_compatible",
          upstream_model: "model-a",
          alias: null,
          enabled: true,
          available: true,
          responses_via_chat_enabled: false,
          native_api_formats: ["chat_completions"],
          created_at_ms: 1,
          updated_at_ms: 1,
        },
      ]);
    if (path === "/api/v1/prices") return jsonResponse([modelPrice()]);
    if (path === "/api/v1/console-preferences")
      return jsonResponse({
        model_column_widths: {},
        log_column_widths: {},
        log_visible_columns: ["time"],
      });
    return jsonResponse([]);
  };

  it("disables a model only for the selected provider and preserves the same model on another provider", async () => {
    window.history.replaceState({}, "", "/models?provider_id=7");
    const inventory: ProviderModelInventory[] = [7, 8].map(
      (providerId, index) => ({
        id: 11 + index,
        provider_id: providerId,
        provider_name: index === 0 ? "Provider A" : "Provider B",
        provider_type: "openai_compatible",
        upstream_model: "model-a",
        alias: null,
        enabled: true,
        available: true,
        responses_via_chat_enabled: false,
        native_api_formats: ["chat_completions"],
        created_at_ms: 1,
        updated_at_ms: 1,
      }),
    );
    const patches: Array<{ path: string; body: unknown }> = [];
    fetchRequest.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body));
        patches.push({ path, body });
        const model = inventory.find(
          (item) => path === `/api/v1/provider-models/${item.id}`,
        );
        if (!model) return jsonResponse({ error: "unexpected update" }, 400);
        model.enabled = body.enabled;
        return jsonResponse({ ok: true });
      }
      if (path === "/api/v1/provider-models") return jsonResponse(inventory);
      return catalogResponse(input);
    });
    renderWithTheme(
      <ModelsPage
        settings={{
          apiBase: "http://127.0.0.1:8080",
          adminToken: "test-token",
        }}
        providers={[providerWorkspace()]}
        onMessage={() => undefined}
      />,
    );

    const providerA = (await screen.findByRole("checkbox", {
      name: "Toggle model-a for Provider A",
    })) as HTMLInputElement;
    expect(providerA.checked).toBe(true);
    expect(
      screen.queryByRole("checkbox", {
        name: "Toggle global state for model-a",
      }),
    ).toBeNull();
    fireEvent.click(providerA);
    await waitFor(() => expect(providerA.checked).toBe(false));
    expect(patches).toEqual([
      { path: "/api/v1/provider-models/11", body: { enabled: false } },
    ]);
    expect(inventory.map((model) => model.enabled)).toEqual([false, true]);

    fireEvent.mouseDown(screen.getByRole("combobox", { name: "Providers" }));
    fireEvent.click(await screen.findByRole("option", { name: "Provider B" }));
    const providerB = (await screen.findByRole("checkbox", {
      name: "Toggle model-a for Provider B",
    })) as HTMLInputElement;
    expect(providerB.checked).toBe(true);
    expect(
      screen.queryByRole("checkbox", { name: "Toggle model-a for Provider A" }),
    ).toBeNull();

    fireEvent.mouseDown(screen.getByRole("combobox", { name: "Providers" }));
    fireEvent.click(
      await screen.findByRole("option", { name: "All Providers" }),
    );
    const global = (await screen.findByRole("checkbox", {
      name: "Toggle global state for model-a",
    })) as HTMLInputElement;
    expect(global.checked).toBe(true);
    expect(
      within(screen.getByRole("table", { name: "Model Inventory" })).getByText(
        "1 / 2",
      ),
    ).toBeTruthy();
    expect(patches).toHaveLength(1);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("shows an existing global block in a provider view and restores it only through the explicit global control", async () => {
    window.history.replaceState({}, "", "/models?provider_id=7");
    let globallyEnabled = false;
    const patches: Array<{ path: string; body: unknown }> = [];
    fetchRequest.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/v1/gateway-models") {
        if (init?.method === "PATCH") {
          const body = JSON.parse(String(init.body));
          patches.push({ path, body });
          globallyEnabled = body.enabled;
          return jsonResponse({ ok: true });
        }
        return jsonResponse([
          {
            model_name: "model-a",
            enabled: globallyEnabled,
            created_at_ms: 1,
            updated_at_ms: 1,
          },
        ]);
      }
      return catalogResponse(input);
    });
    renderWithTheme(
      <ModelsPage
        settings={{
          apiBase: "http://127.0.0.1:8080",
          adminToken: "test-token",
        }}
        providers={[providerWorkspace()]}
        onMessage={() => undefined}
      />,
    );

    const table = await screen.findByRole("table", { name: "Model Inventory" });
    expect(await within(table).findByText("Disabled")).toBeTruthy();
    expect(
      (
        within(table).getByRole("checkbox", {
          name: "Toggle model-a for Provider A",
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    expect(patches).toHaveLength(0);

    fireEvent.click(within(table).getByRole("button", { name: "model-a" }));
    const dialog = await screen.findByRole("dialog", { name: "model-a" });
    expect(
      within(dialog).getByText(
        "This model is disabled globally and cannot be used through any provider.",
      ),
    ).toBeTruthy();
    const global = within(dialog).getByRole("checkbox", {
      name: "Globally Enabled",
    }) as HTMLInputElement;
    expect(global.checked).toBe(false);
    fireEvent.click(global);
    await waitFor(() => expect(global.checked).toBe(true));
    expect(patches).toEqual([
      {
        path: "/api/v1/gateway-models",
        body: { model_name: "model-a", enabled: true },
      },
    ]);
    expect(
      (
        within(dialog).getByRole("checkbox", {
          name: "Toggle model-a for Provider A",
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    expect(
      within(dialog).queryByText(
        "This model is disabled globally and cannot be used through any provider.",
      ),
    ).toBeNull();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("restores a saved session directly into a deep link without showing the connection gate", async () => {
    window.sessionStorage.setItem("little_gate_admin_token", "test-token");
    window.history.replaceState({}, "", "/models?provider_id=7&model=model-a");
    const pending: Array<(response: Response) => void> = [];
    fetchRequest.mockImplementation((input) =>
      String(input).endsWith("/system/config")
        ? new Promise<Response>((resolve) => pending.push(resolve))
        : Promise.resolve(catalogResponse(input)),
    );
    renderWithTheme(<Root />);
    expect(screen.getByText("Restoring connection…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /enter console/i })).toBeNull();
    expect(window.location.pathname).toBe("/models");
    await act(async () => {
      pending.forEach((resolve) => resolve(jsonResponse({})));
    });
    expect(await screen.findByRole("dialog", { name: "model-a" })).toBeTruthy();
    expect(window.location.search).toBe("?provider_id=7&model=model-a");
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("navigates from an upstream detail to its models without validating the session again and restores the detail on back", async () => {
    window.sessionStorage.setItem("little_gate_admin_token", "test-token");
    window.history.replaceState({}, "", "/upstreams?provider_id=7");
    fetchRequest.mockImplementation(async (input) => catalogResponse(input));
    renderWithTheme(<Root />);
    const provider = await screen.findByRole("dialog", { name: "Provider A" });
    const validations = fetchRequest.mock.calls.filter(([input]) =>
      String(input).endsWith("/system/config"),
    ).length;
    fireEvent.click(
      within(provider).getByRole("link", { name: "Manage models →" }),
    );
    expect(
      await screen.findByRole("table", { name: "Model Inventory" }),
    ).toBeTruthy();
    expect(window.location.pathname + window.location.search).toBe(
      "/models?provider_id=7",
    );
    expect(
      fetchRequest.mock.calls.filter(([input]) =>
        String(input).endsWith("/system/config"),
      ),
    ).toHaveLength(validations);
    await act(async () => {
      window.history.back();
    });
    expect(
      await screen.findByRole("dialog", { name: "Provider A" }),
    ).toBeTruthy();
    expect(window.location.pathname + window.location.search).toBe(
      "/upstreams?provider_id=7",
    );
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("keeps the old prices address and filters compatible", async () => {
    window.sessionStorage.setItem("little_gate_admin_token", "test-token");
    window.history.replaceState({}, "", "/prices?q=model-a&scope=global");
    fetchRequest.mockImplementation(async (input) => catalogResponse(input));
    renderWithTheme(<Root />);
    expect(
      await screen.findByRole("table", {
        name: "Currently Available Price Items",
      }),
    ).toBeTruthy();
    expect(window.location.pathname + window.location.search).toBe(
      "/models/prices?q=model-a&scope=global",
    );
    expect(
      screen
        .getByRole("tab", { name: "Price Management" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("retries a connection failure at the original deep link", async () => {
    window.sessionStorage.setItem("little_gate_admin_token", "test-token");
    window.history.replaceState({}, "", "/models?provider_id=7");
    fetchRequest.mockResolvedValue(jsonResponse({ error: "offline" }, 503));
    renderWithTheme(<Root />);
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.queryByRole("button", { name: /enter console/i })).toBeNull();
    fetchRequest.mockImplementation(async (input) => catalogResponse(input));
    fireEvent.click(retry);
    expect(
      await screen.findByRole("table", { name: "Model Inventory" }),
    ).toBeTruthy();
    expect(window.location.pathname + window.location.search).toBe(
      "/models?provider_id=7",
    );
  });

  it("ignores a pending session refresh after logout", async () => {
    window.sessionStorage.setItem("little_gate_admin_token", "test-token");
    window.history.replaceState({}, "", "/models");
    fetchRequest.mockImplementation(async (input) => catalogResponse(input));
    renderWithTheme(<Root />);
    await screen.findByRole("table", { name: "Model Inventory" });
    let completeRefresh: ((value: Response) => void) | undefined;
    fetchRequest.mockImplementation((input) =>
      String(input).endsWith("/system/config")
        ? new Promise<Response>((resolve) => {
            completeRefresh = resolve;
          })
        : Promise.resolve(catalogResponse(input)),
    );
    fireEvent.click(screen.getByRole("button", { name: "Sync" }));
    await waitFor(() => expect(completeRefresh).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Log out" }));
    await act(async () => {
      completeRefresh?.(jsonResponse({}));
    });
    expect(screen.getByRole("button", { name: /enter console/i })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Primary" })).toBeNull();
    expect(window.sessionStorage.getItem("little_gate_admin_token")).toBe("");
  });

  it("prefills a provider price without editing the inherited global price and refreshes the detail after saving", async () => {
    window.sessionStorage.setItem("little_gate_admin_token", "test-token");
    window.history.replaceState({}, "", "/models?provider_id=7&model=model-a");
    let created: Record<string, any> | null = null;
    let priceItems = [modelPrice()];
    fetchRequest.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/prices")) {
        if (init?.method === "POST") {
          created = JSON.parse(String(init.body));
          priceItems = [...priceItems, { ...modelPrice(), ...created, id: 12 }];
          return jsonResponse({
            id: 12,
            backfilled_requests: 3,
            history_recalculation_pending: false,
          });
        }
        return jsonResponse(priceItems);
      }
      return catalogResponse(input);
    });
    renderWithTheme(<Root />);
    const detail = await screen.findByRole(
      "dialog",
      { name: "model-a" },
      { timeout: 3000 },
    );
    fireEvent.click(
      await within(detail).findByRole("button", { name: "Set Provider Price" }),
    );
    const editor = await screen.findByRole("dialog", { name: "Add Price" });
    expect(within(editor).getByDisplayValue("model-a")).toBeTruthy();
    for (const [placeholder, value] of [
      ["2.50", "6"],
      ["15.00", "30"],
      ["0.25", "0"],
      ["3.125", "0"],
    ]) {
      fireEvent.change(within(editor).getByPlaceholderText(placeholder), {
        target: { value },
      });
    }
    fireEvent.click(within(editor).getByRole("button", { name: "Add Price" }));
    await waitFor(() =>
      expect(created).toMatchObject({ provider_id: 7, model_name: "model-a" }),
    );
    const restored = await screen.findByRole(
      "dialog",
      { name: "model-a" },
      { timeout: 3000 },
    );
    expect(await within(restored).findByText("$6 / MToken")).toBeTruthy();
    expect(priceItems[0].provider_id).toBeNull();
    expect(priceItems[0].price_data.base.input).toBe("5");
  });

  it("expires an invalid admin session without losing the requested model filters", async () => {
    window.sessionStorage.setItem("little_gate_admin_token", "test-token");
    window.history.replaceState({}, "", "/models?provider_id=7");
    let expired = false;
    fetchRequest.mockImplementation(async (input) =>
      expired
        ? jsonResponse({ error: "invalid token" }, 401)
        : catalogResponse(input),
    );
    renderWithTheme(<Root />);
    await screen.findByRole("table", { name: "Model Inventory" });
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    expired = true;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByRole("button", { name: /enter console/i });
    expect(window.location.pathname + window.location.search).toBe(
      "/models?provider_id=7",
    );
    expired = false;
    fireEvent.change(screen.getByPlaceholderText("Enter admin token"), {
      target: { value: "new-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: /enter console/i }));
    expect(
      await screen.findByRole("table", { name: "Model Inventory" }),
    ).toBeTruthy();
    expect(window.location.pathname + window.location.search).toBe(
      "/models?provider_id=7",
    );
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("keeps inventory usable and global controls disabled when policy loading fails", async () => {
    window.history.replaceState({}, "", "/models");
    fetchRequest.mockImplementation(async (input) =>
      String(input).endsWith("/gateway-models")
        ? jsonResponse({ error: "policy service unavailable" }, 500)
        : catalogResponse(input),
    );
    renderWithTheme(
      <ModelsPage
        settings={{
          apiBase: "http://127.0.0.1:8080",
          adminToken: "test-token",
        }}
        providers={[providerWorkspace()]}
        onMessage={() => undefined}
      />,
    );
    expect(
      await screen.findByRole("table", { name: "Model Inventory" }),
    ).toBeTruthy();
    expect(
      (
        screen.getByRole("checkbox", {
          name: "Toggle global state for model-a",
        }) as HTMLInputElement
      ).disabled,
    ).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain(
      "policy service unavailable",
    );
    fireEvent.click(screen.getByRole("button", { name: "model-a" }));
    const dialog = await screen.findByRole("dialog", { name: "model-a" });
    expect(
      (
        within(dialog).getByRole("checkbox", {
          name: "Toggle model-a for Provider A",
        }) as HTMLInputElement
      ).disabled,
    ).toBe(false);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("tracks provider query changes during browser back and forward", async () => {
    window.sessionStorage.setItem("little_gate_admin_token", "test-token");
    window.history.replaceState({ idx: 0, key: "provider-7" }, "", "/models?provider_id=7");
    window.history.pushState({ idx: 1, key: "provider-8" }, "", "/models?provider_id=8");
    fetchRequest.mockImplementation(async (input) => {
      if (String(input).endsWith("/provider-models"))
        return jsonResponse(
          [7, 8].map((id) => ({
            id,
            provider_id: id,
            provider_name: `Provider ${id}`,
            provider_type: "openai_compatible",
            upstream_model: `model-${id}`,
            alias: null,
            enabled: true,
            available: true,
            responses_via_chat_enabled: false,
            native_api_formats: ["chat_completions"],
            created_at_ms: 1,
            updated_at_ms: 1,
          })),
        );
      return catalogResponse(input);
    });
    renderWithTheme(<Root />);
    expect(
      await screen.findByRole("button", { name: "model-8" }, { timeout: 3000 }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "model-7" })).toBeNull();
    await act(async () => {
      await new Promise<void>(resolve => {
        window.addEventListener("popstate", () => resolve(), { once: true });
        window.history.back();
      });
    });
    expect(
      await screen.findByRole("button", { name: "model-7" }, { timeout: 3000 }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "model-8" })).toBeNull();
    await act(async () => {
      await new Promise<void>(resolve => {
        window.addEventListener("popstate", () => resolve(), { once: true });
        window.history.forward();
      });
    });
    expect(
      await screen.findByRole("button", { name: "model-8" }, { timeout: 3000 }),
    ).toBeTruthy();
    expect(consoleError).not.toHaveBeenCalled();
  }, 15000);

  it("keeps an edited price draft when saving fails and allows retry", async () => {
    let fail = true;
    let refreshes = 0;
    fetchRequest.mockImplementation(async () =>
      fail
        ? jsonResponse({ error: "write failed" }, 500)
        : jsonResponse({
            id: 12,
            backfilled_requests: 0,
            history_recalculation_pending: false,
          }),
    );
    renderWithTheme(
      <PricesPage
        settings={{
          apiBase: "http://127.0.0.1:8080",
          adminToken: "test-token",
        }}
        providers={[]}
        items={[modelPrice()]}
        onRefresh={async () => {
          refreshes += 1;
        }}
        onMessage={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit price model-a" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Edit Model Price",
    });
    fireEvent.change(within(dialog).getByDisplayValue("5"), {
      target: { value: "7.125" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save Price" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "write failed",
    );
    expect(within(dialog).getByDisplayValue("7.125")).toBeTruthy();
    expect(refreshes).toBe(0);
    fail = false;
    fireEvent.click(within(dialog).getByRole("button", { name: "Save Price" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Edit Model Price" }),
      ).toBeNull(),
    );
    expect(refreshes).toBe(1);
  });

  it("paginates aliases and returns to the first page when searching", async () => {
    const aliases = Array.from({ length: 60 }, (_, index) => ({
      id: index + 1,
      name: `route-${String(index).padStart(3, "0")}`,
      mode: "ordered" as const,
      enabled: true,
      created_at_ms: 1,
      updated_at_ms: 1,
      targets: [],
    }));
    renderWithTheme(
      <ModelAliasesPage
        settings={{
          apiBase: "http://127.0.0.1:8080",
          adminToken: "test-token",
        }}
        providers={[]}
        aliases={aliases}
        onRefresh={async () => undefined}
      />,
    );
    expect(
      within(
        screen.getByRole("table", { name: "Routing Aliases" }),
      ).getAllByRole("row"),
    ).toHaveLength(51);
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(
      within(
        screen.getByRole("table", { name: "Routing Aliases" }),
      ).getAllByRole("row"),
    ).toHaveLength(11);
    fireEvent.change(
      screen.getByRole("textbox", { name: "Search Routing Aliases" }),
      { target: { value: "route-005" } },
    );
    expect(screen.getByText("route-005")).toBeTruthy();
    expect(
      within(
        screen.getByRole("table", { name: "Routing Aliases" }),
      ).getAllByRole("row"),
    ).toHaveLength(2);
  });

  it("filters the aggregated model inventory by search text", async () => {
    fetchRequest.mockImplementation(async (input) => {
      if (String(input).endsWith("/api/v1/gateway-models"))
        return jsonResponse([]);
      return jsonResponse([
        {
          id: 11,
          provider_id: 7,
          provider_name: "Provider A",
          provider_type: "openai_compatible",
          upstream_model: "model-a",
          alias: "alpha",
          enabled: true,
          available: true,
          responses_via_chat_enabled: false,
          native_api_formats: ["chat_completions"],
          created_at_ms: 1,
          updated_at_ms: 1,
        },
        {
          id: 12,
          provider_id: 8,
          provider_name: "Provider B",
          provider_type: "openai_compatible_responses",
          upstream_model: "model-b",
          alias: null,
          enabled: true,
          available: true,
          responses_via_chat_enabled: false,
          native_api_formats: ["responses"],
          created_at_ms: 1,
          updated_at_ms: 1,
        },
      ]);
    });

    renderWithTheme(
      <ModelsPage
        settings={{
          apiBase: "http://127.0.0.1:8080",
          adminToken: "test-token",
        }}
        providers={[providerWorkspace()]}
        onMessage={() => undefined}
      />,
    );

    expect(await screen.findByText("model-a")).toBeTruthy();
    expect(screen.getByText("model-b")).toBeTruthy();
    const inventoryTable = screen.getByRole("table", {
      name: "Model Inventory",
    });
    expect(inventoryTable.className).toContain("MuiTable-stickyHeader");
    expect(
      inventoryTable.querySelectorAll('[data-column-id="provider_count"]')
        .length,
    ).toBeGreaterThan(0);
    expect(inventoryTable.querySelectorAll("[data-sticky-column]").length).toBe(
      0,
    );
    expect(screen.queryByRole("button", { name: "Sync Provider" })).toBeNull();
    fireEvent.change(
      screen.getByPlaceholderText("Search models, aliases, or providers"),
      {
        target: { value: "alpha" },
      },
    );

    expect(screen.getByText("model-a")).toBeTruthy();
    expect(screen.queryByText("model-b")).toBeNull();
  });

  it("ignores legacy model widths and exposes an explicit detail action", async () => {
    let widthPatch: Record<string, number> | null = null;
    fetchRequest.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/v1/console-preferences")) {
        if (init?.method === "PATCH") {
          const body = JSON.parse(String(init.body)) as {
            model_column_widths: Record<string, number>;
          };
          widthPatch = body.model_column_widths;
          return jsonResponse({
            log_visible_columns: ["time"],
            log_column_widths: {},
            model_column_widths: body.model_column_widths,
          });
        }
        return jsonResponse({
          log_visible_columns: ["time"],
          log_column_widths: {},
          model_column_widths: { provider: 104, model: 176 },
        });
      }
      if (url.endsWith("/api/v1/gateway-models")) return jsonResponse([]);
      if (url.endsWith("/api/v1/provider-models"))
        return jsonResponse([
          {
            id: 11,
            provider_id: 7,
            provider_name: "Provider A",
            provider_type: "openai_compatible",
            upstream_model: "model-a",
            alias: null,
            enabled: true,
            available: true,
            responses_via_chat_enabled: false,
            native_api_formats: ["chat_completions"],
            created_at_ms: 1,
            updated_at_ms: 1,
          },
        ]);
      return jsonResponse([]);
    });

    renderWithTheme(
      <ModelsPage
        settings={{
          apiBase: "http://127.0.0.1:8080",
          adminToken: "test-token",
        }}
        providers={[providerWorkspace()]}
        onMessage={() => undefined}
      />,
    );

    const table = await screen.findByRole("table", { name: "Model Inventory" });
    expect(table.querySelector("colgroup")).toBeNull();
    expect(screen.queryByRole("separator")).toBeNull();
    expect(widthPatch).toBeNull();
    fireEvent.click(within(table).getByRole("button", { name: "Details" }));
    expect(await screen.findByRole("dialog", { name: "model-a" })).toBeTruthy();
  });

  it("creates a model alias from the Models page and refreshes aliases", async () => {
    let aliasPayload: Record<string, unknown> | null = null;
    let aliasRefreshes = 0;
    fetchRequest.mockImplementation(async (input, init) => {
      const url = String(input);
      if (init?.method === "POST" && url.endsWith("/api/v1/model-aliases")) {
        aliasPayload = JSON.parse(String(init.body));
        return jsonResponse({ id: 21 });
      }
      return jsonResponse([]);
    });

    renderWithTheme(
      <ModelAliasesPage
        settings={{
          apiBase: "http://127.0.0.1:8080",
          adminToken: "test-token",
        }}
        providers={[providerWorkspace()]}
        aliases={[]}
        onRefresh={async () => {
          aliasRefreshes += 1;
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add Routing Alias" }));
    fireEvent.change(screen.getByPlaceholderText("gpt-5"), {
      target: { value: "codex-route" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add Model" }));

    await waitFor(() =>
      expect(aliasPayload).toEqual({
        name: "codex-route",
        enabled: true,
        mode: "ordered",
      }),
    );
    await waitFor(() => expect(aliasRefreshes).toBe(1));
  });

  it("rolls back a model conversion toggle when saving fails", async () => {
    const messages: string[] = [];
    fetchRequest.mockImplementation(async (input, init) => {
      if (init?.method === "PATCH")
        return new Response("failed", { status: 500 });
      if (String(input).endsWith("/api/v1/gateway-models"))
        return jsonResponse([]);
      return jsonResponse([
        {
          id: 11,
          provider_id: 7,
          provider_name: "Provider A",
          provider_type: "openai_compatible",
          upstream_model: "model-a",
          alias: null,
          enabled: true,
          available: true,
          responses_via_chat_enabled: false,
          native_api_formats: ["chat_completions"],
          created_at_ms: 1,
          updated_at_ms: 1,
        },
      ]);
    });

    renderWithTheme(
      <ModelsPage
        settings={{
          apiBase: "http://127.0.0.1:8080",
          adminToken: "test-token",
        }}
        providers={[providerWorkspace()]}
        onMessage={(message) => messages.push(message)}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "model-a" }));
    const checkbox = await screen.findByRole("checkbox", {
      name: "Toggle Responses conversion for model-a",
    });
    expect((checkbox as HTMLInputElement).checked).toBe(false);
    fireEvent.click(checkbox);
    await waitFor(() =>
      expect((checkbox as HTMLInputElement).checked).toBe(false),
    );
    expect(messages.some((message) => message.includes("500"))).toBe(true);
  });

  it("preserves saved log column order and visibility changes", async () => {
    fetchRequest.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/api/v1/console-preferences")) {
        if (init?.method === "PATCH") {
          const body = JSON.parse(String(init.body)) as {
            log_visible_columns: string[];
          };
          return jsonResponse(body);
        }
        return jsonResponse({ log_visible_columns: ["provider", "time"] });
      }
      if (url.includes("/api/v1/logs"))
        return jsonResponse([
          {
            id: "req-1",
            time_ms: 1,
            api_key_id: 1,
            provider_id: 7,
            endpoint_id: 71,
            upstream_key_id: 72,
            model: "model-a",
            http_status: 200,
            duration_ms: 10,
            api_format: "responses",
            upstream_api_format: "chat_completions",
            span_kind: "http_request",
            transport: "http",
            usage_observed: false,
          },
        ]);
      return jsonResponse([]);
    });

    renderWithTheme(
      <LogsPage
        settings={{
          apiBase: "http://127.0.0.1:8080",
          adminToken: "test-token",
        }}
        providers={[providerWorkspaceWithConnection()]}
        apiKeys={[]}
        refreshKey={0}
        onMessage={() => undefined}
      />,
    );

    const table = await screen.findByRole("table", { name: "Request Logs" });
    expect(table.className).toContain("MuiTable-stickyHeader");
    await waitFor(() =>
      expect(
        table.querySelector("thead [data-column-id]")?.textContent,
      ).toContain("Provider"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Providers" }));

    await waitFor(() =>
      expect(
        table.querySelector("thead [data-column-id]")?.textContent,
      ).toContain("Time"),
    );
  });

  it("renders total usage with accessible breakdown and ignores legacy widths", async () => {
    let widthPatch: Record<string, number> | null = null;
    fetchRequest.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/api/v1/console-preferences")) {
        if (init?.method === "PATCH") {
          const body = JSON.parse(String(init.body)) as {
            log_column_widths: Record<string, number>;
          };
          widthPatch = body.log_column_widths;
          return jsonResponse({
            log_visible_columns: ["time", "total_tokens"],
            log_column_widths: body.log_column_widths,
            model_column_widths: {},
          });
        }
        return jsonResponse({
          log_visible_columns: [
            "time",
            "input_tokens",
            "cache_read",
            "reasoning",
          ],
          log_column_widths: { time: 136 },
          model_column_widths: {},
        });
      }
      if (url.includes("/api/v1/logs"))
        return jsonResponse([
          {
            id: "req-usage",
            time_ms: 1,
            api_key_id: 1,
            provider_id: 7,
            endpoint_id: 71,
            upstream_key_id: 72,
            model: "model-a",
            http_status: 200,
            duration_ms: 10,
            api_format: "responses",
            upstream_api_format: "responses",
            span_kind: "http_request",
            transport: "http",
            usage_observed: true,
            input_tokens: 101,
            output_tokens: 202,
            cache_read_input_tokens: 303,
            cache_creation_input_tokens: 404,
            reasoning_output_tokens: 505,
          },
        ]);
      return jsonResponse([]);
    });

    renderWithTheme(
      <LogsPage
        settings={{
          apiBase: "http://127.0.0.1:8080",
          adminToken: "test-token",
        }}
        providers={[providerWorkspaceWithConnection()]}
        apiKeys={[]}
        refreshKey={0}
        onMessage={() => undefined}
      />,
    );

    const table = await screen.findByRole("table", { name: "Request Logs" });
    expect(table.querySelector("colgroup")).toBeNull();
    expect(
      within(table).getByRole("columnheader", { name: "Usage" }),
    ).toBeTruthy();
    const usage = table.querySelector(
      'tbody [data-column-id="total_tokens"] [tabindex="0"]',
    );
    expect(usage?.textContent).toBe("1.01k");
    expect(usage?.getAttribute("aria-label")).toContain("101");
    expect(usage?.getAttribute("aria-label")).toContain("505");
    expect(widthPatch).toBeNull();
    expect(
      within(table).getByRole("button", { name: /req-usage/ }),
    ).toBeTruthy();
  });
});
