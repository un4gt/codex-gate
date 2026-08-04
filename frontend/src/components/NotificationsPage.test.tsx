import { StrictMode, type ReactNode } from 'react';
import GlobalStyles from '@mui/material/GlobalStyles';
import { StyledEngineProvider, ThemeProvider } from '@mui/material/styles';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, rs } from '@rstest/core';

import { NotificationsPage } from '@/components/NotificationsPage';
import { initializeI18n } from '@/lib/i18n';
import { theme } from '@/theme';

function renderWithTheme(children: ReactNode) {
  return render(
    <StrictMode>
      <StyledEngineProvider enableCssLayer>
        <GlobalStyles styles="@layer theme, base, mui, components, utilities;" />
        <ThemeProvider theme={theme}>{children}</ThemeProvider>
      </StyledEngineProvider>
    </StrictMode>,
  );
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('notification management page', () => {
  const fetchRequest = rs.spyOn(globalThis, 'fetch');
  const consoleError = rs.spyOn(console, 'error');

  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem('little_gate_locale', 'en');
    initializeI18n();
    fetchRequest.mockReset();
    consoleError.mockReset();
    consoleError.mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    fetchRequest.mockReset();
    consoleError.mockReset();
  });

  it('loads channels, rules, and delivery history in parallel and retries one failed delivery', async () => {
    const requests: string[] = [];
    fetchRequest.mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      requests.push(`${method} ${url.pathname}`);
      if (method === 'POST' && url.pathname.endsWith('/retry')) {
        return jsonResponse({
          id: 'delivery-1',
          run_id: 'run-1',
          rule_id: 7,
          rule_name: 'Daily report',
          event_type: 'scheduled_report',
          channel_id: 3,
          channel_name: 'Ops webhook',
          channel_kind: 'webhook',
          status: 'pending',
          attempts: 1,
          next_attempt_at_ms: Date.now(),
          last_attempt_at_ms: Date.now(),
          delivered_at_ms: null,
          last_error_code: null,
          last_error_message: null,
          created_at_ms: Date.now(),
          window_from_ms: null,
          window_to_ms: null,
        });
      }
      if (method === 'GET' && url.pathname.endsWith('/deliveries/delivery-1')) {
        return jsonResponse({
          id: 'delivery-1',
          run_id: 'run-1',
          rule_id: 7,
          rule_name: 'Daily report',
          event_type: 'scheduled_report',
          channel_id: 3,
          channel_name: 'Ops webhook',
          channel_kind: 'webhook',
          status: 'failed',
          attempts: 1,
          next_attempt_at_ms: null,
          last_attempt_at_ms: 1_900_000_000_000,
          delivered_at_ms: null,
          last_error_code: 'webhook_platform_rejected',
          last_error_message: 'Webhook platform returned code 19001: param invalid',
          created_at_ms: 1_900_000_000_000,
          window_from_ms: 1_899_000_000_000,
          window_to_ms: 1_900_000_000_000,
          last_http_status: 200,
          last_request_body: '{"msg_type":"text","content":{"text":"Daily report"}}',
          last_response_body: '{"code":19001,"msg":"param invalid"}',
          event_payload: { schema_version: 1 },
        });
      }
      if (url.pathname.endsWith('/summary')) {
        return jsonResponse({ enabled_channels: 1, enabled_rules: 1, firing_alerts: 0, failed_deliveries_24h: 1 });
      }
      if (url.pathname.endsWith('/channels')) {
        return jsonResponse({ items: [{
          id: 3,
          name: 'Ops webhook',
          enabled: true,
          kind: 'webhook',
          config: { url_masked: 'https://example.test/…', format: 'feishu', has_signing_secret: false, headers: [] },
          created_at_ms: 1_900_000_000_000,
          updated_at_ms: 1_900_000_000_000,
        }] });
      }
      if (url.pathname.endsWith('/rules')) {
        return jsonResponse({ items: [{
          id: 7,
          name: 'Daily report',
          enabled: true,
          channel_ids: [3],
          kind: 'scheduled_report',
          config: { cron: '0 9 * * *', timezone: 'Asia/Shanghai', locale: 'en-US', top_n: 20 },
          next_run_at_ms: 2_000_000_000_000,
          last_window_end_ms: null,
          created_at_ms: 1_900_000_000_000,
          updated_at_ms: 1_900_000_000_000,
        }] });
      }
      if (url.pathname.endsWith('/deliveries')) {
        return jsonResponse({ items: [{
          id: 'delivery-1',
          run_id: 'run-1',
          rule_id: 7,
          rule_name: 'Daily report',
          event_type: 'scheduled_report',
          channel_id: 3,
          channel_name: 'Ops webhook',
          channel_kind: 'webhook',
          status: 'failed',
          attempts: 1,
          next_attempt_at_ms: null,
          last_attempt_at_ms: 1_900_000_000_000,
          delivered_at_ms: null,
          last_error_code: 'webhook_rejected',
          last_error_message: 'HTTP 400',
          created_at_ms: 1_900_000_000_000,
          window_from_ms: 1_899_000_000_000,
          window_to_ms: 1_900_000_000_000,
        }], offset: 0, limit: 50 });
      }
      return jsonResponse({});
    });

    renderWithTheme(<NotificationsPage
      settings={{ apiBase: 'http://127.0.0.1:8080', adminToken: 'test-token' }}
      providers={[]}
      apiKeys={[]}
      onMessage={() => undefined}
    />);

    expect((await screen.findAllByText('Ops webhook')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Daily report').length).toBeGreaterThan(0);
    expect(screen.queryByText(/select all/i)).toBeNull();
    expect(requests).toEqual(expect.arrayContaining([
      'GET /api/v1/notifications/summary',
      'GET /api/v1/notifications/channels',
      'GET /api/v1/notifications/rules',
      'GET /api/v1/notifications/deliveries',
    ]));

    fireEvent.click(screen.getByRole('button', { name: 'View Details' }));
    expect(await screen.findByText('Actual Request Body')).toBeDefined();
    expect(screen.getByText((content) => content.includes('"msg_type": "text"'))).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    const retry = await screen.findByRole('button', { name: 'Retry' });
    fireEvent.click(retry);
    await waitFor(() => expect(requests).toContain('POST /api/v1/notifications/deliveries/delivery-1/retry'));
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('edits an existing webhook with the flat PATCH contract and clear secret state', async () => {
    const patchBodies: unknown[] = [];
    fetchRequest.mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (method === 'PATCH' && url.pathname.endsWith('/channels/3')) {
        patchBodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({
          id: 3,
          name: 'Ops webhook',
          enabled: true,
          kind: 'webhook',
          config: {
            url_masked: 'https://open.feishu.cn/…',
            format: 'feishu',
            has_signing_secret: false,
            headers: [{ name: 'X-Team', has_value: true }],
          },
          created_at_ms: 1_900_000_000_000,
          updated_at_ms: 1_900_000_000_001,
        });
      }
      if (url.pathname.endsWith('/summary')) {
        return jsonResponse({ enabled_channels: 1, enabled_rules: 0, firing_alerts: 0, failed_deliveries_24h: 0 });
      }
      if (url.pathname.endsWith('/channels')) {
        return jsonResponse({ items: [{
          id: 3,
          name: 'Ops webhook',
          enabled: true,
          kind: 'webhook',
          config: {
            url_masked: 'https://open.feishu.cn/…',
            format: 'generic',
            has_signing_secret: true,
            headers: [{ name: 'X-Team', has_value: true }],
          },
          created_at_ms: 1_900_000_000_000,
          updated_at_ms: 1_900_000_000_000,
        }] });
      }
      if (url.pathname.endsWith('/rules')) return jsonResponse({ items: [] });
      if (url.pathname.endsWith('/deliveries')) return jsonResponse({ items: [], offset: 0, limit: 50 });
      return jsonResponse({});
    });

    renderWithTheme(<NotificationsPage
      settings={{ apiBase: 'http://127.0.0.1:8080', adminToken: 'test-token' }}
      providers={[]}
      apiKeys={[]}
      onMessage={() => undefined}
    />);

    await screen.findByText('Ops webhook');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect((screen.getByLabelText('Channel Name') as HTMLInputElement).value).toBe('Ops webhook');
    expect(screen.getByText('Current URL: https://open.feishu.cn/…')).toBeDefined();
    expect((screen.getByLabelText('New Webhook URL (leave blank to keep)') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Custom Headers') as HTMLTextAreaElement).value).toBe('X-Team:');
    expect(screen.getByText('The current signing secret is configured. Leave blank to keep it.')).toBeDefined();
    const secretInput = screen.getByLabelText('New signing secret (leave blank to keep)');
    expect((secretInput as HTMLInputElement).value).toBe('');
    expect(secretInput.getAttribute('autocomplete')).toBe('new-password');

    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Message Format' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Feishu' }));
    expect(screen.getByText('The message format changed, so the previous signing secret will not be reused. Enter a new secret if needed.')).toBeDefined();
    expect((screen.getByLabelText('Feishu signing secret (optional)') as HTMLInputElement).value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(patchBodies[0]).toEqual({
      name: 'Ops webhook',
      enabled: true,
      kind: 'webhook',
      config: {
        url: '',
        format: 'feishu',
        signing_secret: '',
        headers: [{ name: 'X-Team', value: '' }],
      },
    }));

    const disable = await screen.findByRole('button', { name: 'Disable' });
    await waitFor(() => expect(disable.hasAttribute('disabled')).toBe(false));
    fireEvent.click(disable);
    await waitFor(() => expect(patchBodies[1]).toEqual({ enabled: false }));
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('edits a scheduled rule with the flat PATCH contract and restored field values', async () => {
    let patchBody: unknown;
    const rule = {
      id: 7,
      name: 'Daily report',
      enabled: true,
      channel_ids: [3],
      kind: 'scheduled_report' as const,
      config: { cron: '0 9 * * *', timezone: 'Asia/Shanghai', locale: 'en-US' as const, top_n: 20 },
      next_run_at_ms: 2_000_000_000_000,
      last_window_end_ms: null,
      created_at_ms: 1_900_000_000_000,
      updated_at_ms: 1_900_000_000_000,
    };
    fetchRequest.mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (method === 'PATCH' && url.pathname.endsWith('/rules/7')) {
        patchBody = JSON.parse(String(init?.body));
        return jsonResponse({ ...rule, updated_at_ms: 1_900_000_000_001 });
      }
      if (url.pathname.endsWith('/summary')) {
        return jsonResponse({ enabled_channels: 1, enabled_rules: 1, firing_alerts: 0, failed_deliveries_24h: 0 });
      }
      if (url.pathname.endsWith('/channels')) {
        return jsonResponse({ items: [{
          id: 3,
          name: 'Ops webhook',
          enabled: true,
          kind: 'webhook',
          config: {
            url_masked: 'https://open.feishu.cn/…',
            format: 'feishu',
            has_signing_secret: false,
            headers: [],
          },
          created_at_ms: 1_900_000_000_000,
          updated_at_ms: 1_900_000_000_000,
        }] });
      }
      if (url.pathname.endsWith('/rules')) return jsonResponse({ items: [rule] });
      if (url.pathname.endsWith('/deliveries')) return jsonResponse({ items: [], offset: 0, limit: 50 });
      return jsonResponse({});
    });

    renderWithTheme(<NotificationsPage
      settings={{ apiBase: 'http://127.0.0.1:8080', adminToken: 'test-token' }}
      providers={[]}
      apiKeys={[]}
      onMessage={() => undefined}
    />);

    await screen.findByText('Daily report');
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[1]);
    expect((screen.getByLabelText('Rule Name') as HTMLInputElement).value).toBe('Daily report');
    expect((screen.getByLabelText('Cron (5 fields)') as HTMLInputElement).value).toBe('0 9 * * *');
    expect((screen.getByLabelText('IANA Time Zone') as HTMLInputElement).value).toBe('Asia/Shanghai');
    expect((screen.getByLabelText('Email Top N') as HTMLInputElement).value).toBe('20');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(patchBody).toEqual({
      name: 'Daily report',
      enabled: true,
      channel_ids: [3],
      kind: 'scheduled_report',
      config: {
        cron: '0 9 * * *',
        timezone: 'Asia/Shanghai',
        locale: 'en-US',
        top_n: 20,
      },
    }));
    expect(consoleError).not.toHaveBeenCalled();
  });
});
