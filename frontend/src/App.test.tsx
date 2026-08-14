import { StrictMode, type ReactNode } from 'react';
import GlobalStyles from '@mui/material/GlobalStyles';
import { StyledEngineProvider, ThemeProvider } from '@mui/material/styles';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, rs } from '@rstest/core';
import Root from '@/App';
import { CodexOAuthLoginDialog } from '@/components/CodexOAuthPanel';
import { LogsPage } from '@/components/LogsPage';
import { ProvidersPage } from '@/components/ProvidersPage';
import { ModelsPage } from '@/components/ModelsPage';
import { PricesPage } from '@/components/PricesPage';
import { SettingsPage } from '@/components/SettingsPage';
import { initializeI18n } from '@/lib/i18n';
import type { ProviderWorkspace } from '@/lib/types';
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

function providerWorkspace(): ProviderWorkspace {
  return {
    provider: {
      id: 7,
      name: 'Provider A',
      provider_type: 'openai',
      enabled: true,
      priority: 100,
      weight: 1,
      supports_include_usage: true,
      websocket_enabled: false,
      beta_features: [],
      request_overrides: { headers: [], body: [] },
      key_selection_strategy: 'round_robin',
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

function providerWorkspaceWithConnection(): ProviderWorkspace {
  const workspace = providerWorkspace();
  return {
    ...workspace,
    endpoints: [{
      id: 71,
      provider_id: workspace.provider.id,
      name: 'Endpoint 1',
      base_url: 'https://api.example.test',
      enabled: true,
      priority: 100,
      weight: 1,
    }],
    keys: [{
      id: 72,
      provider_id: workspace.provider.id,
      name: 'Key 1',
      enabled: true,
      priority: 100,
      weight: 1,
    }],
  };
}

function codexProviderWorkspace(): ProviderWorkspace {
  return {
    provider: {
      ...providerWorkspace().provider,
      id: 17,
      name: 'Codex Accounts',
      provider_type: 'openai_codex_oauth',
      websocket_enabled: true,
      beta_features: ['responses-http-to-ws'],
    },
    endpoints: [{
      id: 171,
      provider_id: 17,
      name: 'Codex',
      base_url: 'https://chatgpt.com/backend-api/codex',
      enabled: true,
      priority: 100,
      weight: 1,
    }],
    keys: [{
      id: 172,
      provider_id: 17,
      name: 'Primary account',
      enabled: true,
      priority: 100,
      weight: 1,
      auth_kind: 'codex_oauth',
      codex_oauth: {
        upstream_key_id: 172,
        provider_id: 17,
        email_masked: 'o***@example.com',
        account_id_suffix: '…1234',
        plan_type: 'plus',
        token_expires_at_ms: 2_000_000_000_000,
        last_refresh_at_ms: 1_900_000_000_000,
        auth_status: 'active',
        last_error: null,
        quota_checked_at_ms: 1_900_000_100_000,
        quota: {
          plan_type: 'plus',
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
    }, {
      id: 173,
      provider_id: 17,
      name: 'Secondary account',
      enabled: false,
      priority: 110,
      weight: 1,
      auth_kind: 'codex_oauth',
      codex_oauth: {
        upstream_key_id: 173,
        provider_id: 17,
        email_masked: 's***@example.com',
        account_id_suffix: '…5678',
        plan_type: 'team',
        token_expires_at_ms: null,
        last_refresh_at_ms: null,
        auth_status: 'forbidden',
        last_error: 'workspace deactivated',
        quota: null,
        quota_checked_at_ms: null,
      },
    }],
  };
}

describe('admin console smoke test', () => {
  const consoleError = rs.spyOn(console, 'error');
  const fetchRequest = rs.spyOn(globalThis, 'fetch');

  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.localStorage.setItem('little_gate_api_base', 'http://127.0.0.1:8080');
    window.localStorage.setItem('little_gate_locale', 'en');
    window.history.replaceState({}, '', '/');
    initializeI18n();
    consoleError.mockClear();
    consoleError.mockImplementation(() => undefined);
    fetchRequest.mockReset();
    fetchRequest.mockRejectedValue(new Error('offline'));
  });

  afterEach(() => {
    cleanup();
    consoleError.mockReset();
    fetchRequest.mockReset();
  });

  it('mounts the connection gate without runtime or console errors', async () => {
    renderWithTheme(<Root />);

    expect(await screen.findByRole('heading', { name: 'LITTLE GATE' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /enter console/i })).toBeTruthy();
    expect(screen.getByText('Backend not connected.')).toBeTruthy();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('keeps the connection gate closed when the submitted admin token is rejected', async () => {
    fetchRequest.mockResolvedValue(jsonResponse({ error: 'invalid token' }, 401));

    renderWithTheme(<Root />);

    const tokenInput = screen.getByPlaceholderText('Enter admin token');
    fireEvent.change(tokenInput, {
      target: { value: 'wrong-token' },
    });
    fireEvent.click(screen.getByRole('button', { name: /enter console/i }));

    await waitFor(() => expect(fetchRequest).toHaveBeenCalled());
    expect(await screen.findByText('The admin token is incorrect. Please try again.')).toBeTruthy();
    expect(tokenInput.getAttribute('aria-invalid')).toBe('true');
    expect(screen.queryByText(/401|invalid token|\/api\/v1\/system\/config/i)).toBeNull();
    expect(screen.getByRole('button', { name: /enter console/i })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Primary' })).toBeNull();
  });

  it('validates a stored admin token before restoring the console', async () => {
    window.sessionStorage.setItem('little_gate_admin_token', 'wrong-token');
    fetchRequest.mockResolvedValue(jsonResponse({ error: 'invalid token' }, 401));

    renderWithTheme(<Root />);

    await waitFor(() => expect(fetchRequest).toHaveBeenCalled());
    expect(await screen.findByText('The admin token is incorrect. Please try again.')).toBeTruthy();
    expect(screen.getByPlaceholderText('Enter admin token').getAttribute('aria-invalid')).toBe('true');
    expect(screen.queryByText(/401|invalid token|\/api\/v1\/system\/config/i)).toBeNull();
    expect(screen.getByRole('button', { name: /enter console/i })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Primary' })).toBeNull();
  });

  it('opens the pricing settings without the former Ark Field context crash', async () => {
    renderWithTheme(
      <SettingsPage
        settings={{ apiBase: 'http://127.0.0.1:8080', adminToken: 'test-token' }}
        systemConfig={null}
        runtimeSettings={null}
        runtimeEnvPreview={null}
        prices={[]}
        providers={[]}
        onApiBaseChange={() => undefined}
        onAdminTokenChange={() => undefined}
        onRefresh={async () => undefined}
        onMessage={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /pricing & cost/i }));

    expect(await screen.findByText('Base Pricing')).toBeTruthy();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('keeps long model identifiers and pricing headers on one line', () => {
    const modelName = 'openai/gpt-5.4-2026-08-14-long-model-identifier';
    renderWithTheme(
      <PricesPage
        settings={{ apiBase: 'http://127.0.0.1:8080', adminToken: 'test-token' }}
        providers={[]}
        items={[{
          id: 11,
          provider_id: null,
          model_name: modelName,
          price_data: {
            schema_version: 2,
            unit: 'usd_per_million_tokens',
            base: {
              input: '5',
              output: '30',
              cache_read: null,
              cache_write: '0.5',
            },
            tiers: [],
          },
          created_at_ms: 1_900_000_000_000,
          updated_at_ms: 1_900_000_000_000,
        }]}
        onRefresh={async () => undefined}
        onMessage={() => undefined}
      />,
    );

    const table = screen.getByRole('table', { name: 'Currently Available Price Items' });
    const model = screen.getByTitle(modelName);
    expect(model.className).toContain('truncate');
    expect(model.className).toContain('block');
    expect(model.closest('td')?.className).toContain('whitespace-nowrap');
    expect(table.className).toContain('table-fixed');
    expect(Array.from(table.querySelectorAll('th')).every(cell => cell.className.includes('whitespace-nowrap'))).toBe(true);
    expect(table.closest('.grid')?.className).not.toContain('grid-cols');
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('renders upstream statistics as a compact responsive summary', () => {
    renderWithTheme(
      <ProvidersPage
        settings={{ apiBase: 'http://127.0.0.1:8080', adminToken: '' }}
        items={[]}
        onRefresh={async () => undefined}
        onMessage={() => undefined}
      />,
    );

    const summary = screen.getByRole('list', { name: 'Provider summary' });
    expect(summary.getAttribute('data-variant')).toBe('compact');
    expect(summary.className).toContain('xl:grid-cols-4');
    expect(within(summary).getAllByRole('listitem')).toHaveLength(4);
    expect(summary.querySelectorAll('dt')).toHaveLength(4);
    expect(summary.querySelectorAll('dd')).toHaveLength(4);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('creates connection resources and syncs models in one provider workflow', async () => {
    let providerPayload: Record<string, unknown> | null = null;
    const requests: string[] = [];
    fetchRequest.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      requests.push(`${method} ${new URL(url).pathname}`);
      if (method === 'GET') return jsonResponse([]);
      if (method === 'POST' && url.endsWith('/api/v1/providers')) {
        providerPayload = JSON.parse(String(init?.body));
        return jsonResponse({ id: 9 });
      }
      if (method === 'POST' && url.endsWith('/models/sync')) return jsonResponse([{ id: 101 }]);
      if (method === 'POST') return jsonResponse({ id: url.endsWith('/endpoints') ? 10 : 20 });
      return jsonResponse([]);
    });

    renderWithTheme(
      <ProvidersPage
        settings={{ apiBase: 'http://127.0.0.1:8080', adminToken: 'test-token' }}
        items={[]}
        onRefresh={async () => undefined}
        onMessage={() => undefined}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: /create provider/i })[0]);
    fireEvent.change(screen.getByPlaceholderText('openai-prod'), { target: { value: 'Provider B' } });
    fireEvent.change(screen.getByPlaceholderText('https://api.example.com/v1'), { target: { value: 'https://api.example.test' } });
    fireEvent.change(screen.getByPlaceholderText('sk-...'), { target: { value: 'sk-test' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Priority' }), { target: { value: '25' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Weight' }), { target: { value: '4' } });
    fireEvent.click(screen.getByText('Request Overrides (Optional)'));
    fireEvent.click(screen.getByRole('button', { name: 'Apply Codex Client Compatibility Preset' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create and Sync' }));

    await waitFor(() => expect(providerPayload).toBeTruthy());
    expect(providerPayload).toMatchObject({
      priority: 25,
      weight: 4,
      request_overrides: {
        headers: expect.arrayContaining([
          expect.objectContaining({
            scope: 'all',
            operation: 'set',
            name: 'User-Agent',
            value: 'codex-tui/0.146.0 (Ubuntu 22.4.0; x86_64) xterm-256color',
          }),
          expect.objectContaining({ name: 'x-codex-window-id', value: '{{request_id}}' }),
        ]),
        body: expect.arrayContaining([
          expect.objectContaining({
            scope: 'responses',
            path: 'client_metadata.x-codex-window-id',
            value: '{{request_id}}',
          }),
        ]),
      },
    });
    expect(await screen.findByText('Model Sync Complete')).toBeTruthy();
    expect(requests).toContain('POST /api/v1/providers/9/endpoints');
    expect(requests).toContain('POST /api/v1/providers/9/keys');
    expect(requests).toContain('POST /api/v1/providers/9/models/sync');
    expect(consoleError).not.toHaveBeenCalled();
  }, 10_000);

  it('creates a Codex OAuth provider without an API key and polls device login', async () => {
    let providerPayload: Record<string, unknown> | null = null;
    let endpointPayload: Record<string, unknown> | null = null;
    let sessionStarts = 0;
    let sessionPolls = 0;
    const requests: string[] = [];
    const refreshMessages: string[] = [];
    const messages: string[] = [];
    const writeText = rs.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    fetchRequest.mockImplementation(async (input, init) => {
      const url = String(input);
      const path = new URL(url).pathname;
      const method = init?.method ?? 'GET';
      requests.push(`${method} ${path}`);
      if (method === 'POST' && path === '/api/v1/providers') {
        providerPayload = JSON.parse(String(init?.body));
        return jsonResponse({ id: 19 });
      }
      if (method === 'POST' && path === '/api/v1/providers/19/endpoints') {
        endpointPayload = JSON.parse(String(init?.body));
        return jsonResponse({ id: 191 });
      }
      if (method === 'POST' && path === '/api/v1/providers/19/codex-oauth/sessions') {
        sessionStarts += 1;
        return jsonResponse({
          session_id: 'oauth-session-1',
          status: 'pending',
          verification_uri: 'https://auth.openai.com/codex/device',
          user_code: 'ABCD-EFGH',
          expires_at_ms: Date.now() + 60_000,
          poll_interval_ms: 1,
        });
      }
      if (method === 'GET' && path === '/api/v1/codex-oauth/sessions/oauth-session-1') {
        sessionPolls += 1;
        return jsonResponse({
          session_id: 'oauth-session-1',
          status: 'completed',
          verification_uri: 'https://auth.openai.com/codex/device',
          expires_at_ms: Date.now() + 60_000,
          poll_interval_ms: 1,
          key_id: 192,
          operation: 'created',
          warnings: ['quota: temporarily unavailable'],
        });
      }
      return jsonResponse([]);
    });

    renderWithTheme(
      <ProvidersPage
        settings={{ apiBase: 'http://127.0.0.1:8080', adminToken: 'test-token' }}
        items={[]}
        onRefresh={async message => {
          refreshMessages.push(message ?? '');
        }}
        onMessage={message => messages.push(message)}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: /create provider/i })[0]);
    fireEvent.change(screen.getByPlaceholderText('openai-prod'), { target: { value: 'Codex Prod' } });
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Type' }));
    fireEvent.click(await screen.findByRole('option', { name: 'OpenAI Codex OAuth' }));

    expect(screen.queryByPlaceholderText('sk-...')).toBeNull();
    expect((screen.getByPlaceholderText('https://api.example.com/v1') as HTMLInputElement).value)
      .toBe('https://chatgpt.com/backend-api/codex');
    fireEvent.click(screen.getByRole('button', { name: 'Create and Sign In' }));

    expect(await screen.findByText('ABCD-EFGH')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy Code' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('ABCD-EFGH'));
    expect(messages).toContain('Verification code copied.');
    expect(await screen.findByText('Sign-In Complete')).toBeTruthy();
    expect(await screen.findByText('Post-Login Checks Reported Warnings')).toBeTruthy();
    expect(providerPayload).toMatchObject({
      provider_type: 'openai_codex_oauth',
      websocket_enabled: true,
      beta_features: ['responses-http-to-ws'],
    });
    expect(endpointPayload).toMatchObject({
      base_url: 'https://chatgpt.com/backend-api/codex',
    });
    expect(sessionStarts).toBe(1);
    expect(sessionPolls).toBe(1);
    expect(requests.some(request => request.endsWith('/keys'))).toBe(false);
    expect(requests.some(request => request.endsWith('/models/sync'))).toBe(false);
    expect(refreshMessages).toEqual(expect.arrayContaining([
      'Provider Codex Prod was created. Complete Codex device login to continue.',
      'The Codex OAuth account was created.',
    ]));
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('cancels a pending Codex device login and clears the dialog', async () => {
    let cancelledSession = '';
    let closed = false;
    fetchRequest.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? 'GET';
      if (method === 'POST') {
        return jsonResponse({
          session_id: 'oauth-session-cancel',
          status: 'pending',
          verification_uri: 'https://auth.openai.com/codex/device',
          user_code: 'CANCEL-ME',
          expires_at_ms: Date.now() + 60_000,
          poll_interval_ms: 60_000,
        });
      }
      if (method === 'DELETE') {
        cancelledSession = path;
        return new Response(null, { status: 204 });
      }
      return jsonResponse([]);
    });

    renderWithTheme(
      <CodexOAuthLoginDialog
        open
        attemptId={1}
        settings={{ apiBase: 'http://127.0.0.1:8080', adminToken: 'test-token' }}
        providerId={19}
        replaceKeyId={null}
        onClose={() => { closed = true; }}
        onCompleted={() => undefined}
        onMessage={() => undefined}
      />,
    );

    expect(await screen.findByText('CANCEL-ME')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(closed).toBe(true));
    expect(cancelledSession).toBe('/api/v1/codex-oauth/sessions/oauth-session-cancel');
  });

  it('renders Codex accounts without batch controls and calls per-account APIs', async () => {
    const requests: string[] = [];
    const confirmDelete = rs.spyOn(window, 'confirm').mockReturnValue(true);
    fetchRequest.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? 'GET';
      requests.push(`${method} ${path}`);
      if (method === 'POST' && path.endsWith('/quota/refresh')) return jsonResponse({});
      if (method === 'PATCH') return jsonResponse({ ok: true });
      if (method === 'DELETE') return new Response(null, { status: 204 });
      return jsonResponse([]);
    });

    renderWithTheme(
      <ProvidersPage
        settings={{ apiBase: 'http://127.0.0.1:8080', adminToken: 'test-token' }}
        items={[codexProviderWorkspace()]}
        onRefresh={async () => undefined}
        onMessage={() => undefined}
      />,
    );

    fireEvent.click(screen.getByText('Codex Accounts'));
    expect(await screen.findByRole('heading', { name: 'OAuth Accounts' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'API Keys' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Key Model Restrictions' })).toBeNull();
    expect(screen.queryByText(/select all/i)).toBeNull();
    expect(screen.getByText('5-Hour Quota')).toBeTruthy();
    expect(screen.getByText('30-Day Quota')).toBeTruthy();
    expect(screen.getByText('Credits Balance')).toBeTruthy();
    expect(screen.getByText('Forbidden')).toBeTruthy();
    expect(screen.getByText('Disabled')).toBeTruthy();

    const primaryCard = screen.getByRole('heading', { name: 'o***@example.com' }).closest('.MuiCard-root');
    const secondaryCard = screen.getByRole('heading', { name: 's***@example.com' }).closest('.MuiCard-root');
    expect(primaryCard).toBeTruthy();
    expect(secondaryCard).toBeTruthy();
    fireEvent.click(within(primaryCard as HTMLElement).getByRole('button', { name: 'Refresh Quota' }));
    await waitFor(() => expect(requests).toContain('POST /api/v1/keys/172/codex-oauth/quota/refresh'));
    fireEvent.click(within(secondaryCard as HTMLElement).getByRole('button', { name: 'Enable' }));
    await waitFor(() => expect(requests).toContain('PATCH /api/v1/keys/173'));
    fireEvent.click(within(primaryCard as HTMLElement).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(requests).toContain('DELETE /api/v1/keys/172'));
    expect(confirmDelete).toHaveBeenCalledWith('Delete OAuth account Primary account?');
    confirmDelete.mockRestore();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('reuses the created provider when model sync is retried', async () => {
    let providerCreates = 0;
    let syncAttempts = 0;
    const patches: string[] = [];
    fetchRequest.mockImplementation(async (input, init) => {
      const url = String(input);
      const path = new URL(url).pathname;
      const method = init?.method ?? 'GET';
      if (method === 'GET') return jsonResponse([]);
      if (method === 'POST' && path === '/api/v1/providers') {
        providerCreates += 1;
        return jsonResponse({ id: 9 });
      }
      if (method === 'POST' && path.endsWith('/endpoints')) return jsonResponse({ id: 10 });
      if (method === 'POST' && path.endsWith('/keys')) return jsonResponse({ id: 20 });
      if (method === 'POST' && path.endsWith('/models/sync')) {
        syncAttempts += 1;
        return syncAttempts === 1 ? new Response('sync failed', { status: 502 }) : jsonResponse([{ id: 101 }]);
      }
      if (method === 'PATCH') {
        patches.push(path);
        return jsonResponse({ ok: true });
      }
      return jsonResponse([]);
    });

    renderWithTheme(
      <ProvidersPage
        settings={{ apiBase: 'http://127.0.0.1:8080', adminToken: 'test-token' }}
        items={[]}
        onRefresh={async () => undefined}
        onMessage={() => undefined}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: /create provider/i })[0]);
    fireEvent.change(screen.getByPlaceholderText('openai-prod'), { target: { value: 'Provider Retry' } });
    fireEvent.change(screen.getByPlaceholderText('https://api.example.com/v1'), { target: { value: 'https://old.example.test' } });
    fireEvent.change(screen.getByPlaceholderText('sk-...'), { target: { value: 'sk-old' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create and Sync' }));

    expect(await screen.findByText('Sync Failed')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('https://api.example.com/v1'), { target: { value: 'https://new.example.test' } });
    fireEvent.change(screen.getByPlaceholderText('sk-...'), { target: { value: 'sk-new' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save and Retry Sync' }));

    expect(await screen.findByText('Model Sync Complete')).toBeTruthy();
    expect(providerCreates).toBe(1);
    expect(syncAttempts).toBe(2);
    expect(patches).toEqual(expect.arrayContaining([
      '/api/v1/providers/9',
      '/api/v1/endpoints/10',
      '/api/v1/keys/20',
    ]));
  });

  it('rolls back a new provider when connection setup fails', async () => {
    const deleted: string[] = [];
    fetchRequest.mockImplementation(async (input, init) => {
      const url = String(input);
      const path = new URL(url).pathname;
      const method = init?.method ?? 'GET';
      if (method === 'GET') return jsonResponse([]);
      if (method === 'POST' && path === '/api/v1/providers') return jsonResponse({ id: 9 });
      if (method === 'POST' && path.endsWith('/endpoints')) return new Response('endpoint failed', { status: 500 });
      if (method === 'POST' && path.endsWith('/keys')) return jsonResponse({ id: 20 });
      if (method === 'DELETE') {
        deleted.push(path);
        return new Response(null, { status: 204 });
      }
      return jsonResponse([]);
    });

    renderWithTheme(
      <ProvidersPage
        settings={{ apiBase: 'http://127.0.0.1:8080', adminToken: 'test-token' }}
        items={[]}
        onRefresh={async () => undefined}
        onMessage={() => undefined}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: /create provider/i })[0]);
    fireEvent.change(screen.getByPlaceholderText('openai-prod'), { target: { value: 'Provider Rollback' } });
    fireEvent.change(screen.getByPlaceholderText('https://api.example.com/v1'), { target: { value: 'https://api.example.test' } });
    fireEvent.change(screen.getByPlaceholderText('sk-...'), { target: { value: 'sk-test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create and Sync' }));

    expect(await screen.findByText(/rolled back/i)).toBeTruthy();
    expect(deleted).toEqual(['/api/v1/providers/9']);
    expect(screen.getByRole('button', { name: 'Create and Sync' }).hasAttribute('disabled')).toBe(false);
  });

  it('syncs models directly from the provider list', async () => {
    let syncCount = 0;
    fetchRequest.mockImplementation(async (input, init) => {
      if (init?.method === 'POST' && String(input).endsWith('/api/v1/providers/7/models/sync')) {
        syncCount += 1;
        return jsonResponse([{ id: 101 }]);
      }
      return jsonResponse([]);
    });

    renderWithTheme(
      <ProvidersPage
        settings={{ apiBase: 'http://127.0.0.1:8080', adminToken: 'test-token' }}
        items={[providerWorkspaceWithConnection()]}
        onRefresh={async () => undefined}
        onMessage={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Sync models for provider Provider A' }));
    await waitFor(() => expect(syncCount).toBe(1));
    expect(screen.queryByRole('heading', { name: 'Provider A' })).toBeNull();
  });

  it('sends edited provider routing and request overrides', async () => {
    let patchPayload: Record<string, unknown> | null = null;
    fetchRequest.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (method === 'PATCH' && url.endsWith('/api/v1/providers/7')) {
        patchPayload = JSON.parse(String(init?.body));
        return jsonResponse({ ok: true });
      }
      return jsonResponse([]);
    });

    renderWithTheme(
      <ProvidersPage
        settings={{ apiBase: 'http://127.0.0.1:8080', adminToken: 'test-token' }}
        items={[providerWorkspace()]}
        onRefresh={async () => undefined}
        onMessage={() => undefined}
      />,
    );

    fireEvent.click(screen.getByText('Provider A'));
    fireEvent.change(await screen.findByRole('spinbutton', { name: 'Priority' }), { target: { value: '50' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Weight' }), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply Codex Client Compatibility Preset' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save Provider' }));

    await waitFor(() => expect(patchPayload).toBeTruthy());
    expect(patchPayload).toMatchObject({
      priority: 50,
      weight: 3,
      request_overrides: {
        headers: expect.arrayContaining([
          expect.objectContaining({ name: 'originator', value: 'codex-tui' }),
        ]),
        body: expect.arrayContaining([
          expect.objectContaining({
            path: 'client_metadata.x-codex-installation-id',
            value: '{{request_id}}',
          }),
        ]),
      },
    });
    expect(consoleError).not.toHaveBeenCalled();
  }, 10_000);

  it('prevents saving an invalid provider weight', async () => {
    let patchCount = 0;
    fetchRequest.mockImplementation(async (_input, init) => {
      if (init?.method === 'PATCH') patchCount += 1;
      return jsonResponse([]);
    });

    renderWithTheme(
      <ProvidersPage
        settings={{ apiBase: 'http://127.0.0.1:8080', adminToken: 'test-token' }}
        items={[providerWorkspace()]}
        onRefresh={async () => undefined}
        onMessage={() => undefined}
      />,
    );

    fireEvent.click(screen.getByText('Provider A'));
    fireEvent.change(await screen.findByRole('spinbutton', { name: 'Weight' }), { target: { value: '0' } });

    expect(screen.getByText('Weight must be an integer from 1 to 2147483647.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save Provider' }).hasAttribute('disabled')).toBe(true);
    expect(patchCount).toBe(0);
  });

  it('cancels provider deletion without sending a request', async () => {
    let deleteCount = 0;
    fetchRequest.mockImplementation(async (_input, init) => {
      if (init?.method === 'DELETE') deleteCount += 1;
      return jsonResponse([]);
    });

    renderWithTheme(
      <ProvidersPage
        settings={{ apiBase: 'http://127.0.0.1:8080', adminToken: 'test-token' }}
        items={[providerWorkspace()]}
        onRefresh={async () => undefined}
        onMessage={() => undefined}
      />,
    );

    fireEvent.click(screen.getByText('Provider A'));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Provider' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete provider “Provider A”?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Delete provider “Provider A”?' })).toBeNull());
    expect(deleteCount).toBe(0);
  });

  it('deletes a provider once and refreshes the list', async () => {
    let deleteCount = 0;
    const refreshMessages: string[] = [];
    fetchRequest.mockImplementation(async (_input, init) => {
      if (init?.method === 'DELETE') {
        deleteCount += 1;
        return new Response(null, { status: 204 });
      }
      return jsonResponse([]);
    });

    renderWithTheme(
      <ProvidersPage
        settings={{ apiBase: 'http://127.0.0.1:8080', adminToken: 'test-token' }}
        items={[providerWorkspace()]}
        onRefresh={async message => {
          refreshMessages.push(message ?? '');
        }}
        onMessage={() => undefined}
      />,
    );

    fireEvent.click(screen.getByText('Provider A'));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Provider' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Delete' }));

    await waitFor(() => expect(deleteCount).toBe(1));
    expect(refreshMessages).toEqual(['Provider Provider A deleted.']);
    expect(screen.queryByRole('dialog', { name: 'Delete provider “Provider A”?' })).toBeNull();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('keeps the confirmation open when provider deletion fails', async () => {
    fetchRequest.mockImplementation(async (_input, init) => {
      if (init?.method === 'DELETE') return new Response('delete failed', { status: 500 });
      return jsonResponse([]);
    });

    renderWithTheme(
      <ProvidersPage
        settings={{ apiBase: 'http://127.0.0.1:8080', adminToken: 'test-token' }}
        items={[providerWorkspace()]}
        onRefresh={async () => undefined}
        onMessage={() => undefined}
      />,
    );

    fireEvent.click(screen.getByText('Provider A'));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Provider' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Delete' }));

    expect(await screen.findByText('Deletion Failed')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Delete provider “Provider A”?' })).toBeTruthy();
  });

  it('makes every navigation row sortable while preserving link navigation', async () => {
    window.sessionStorage.setItem('little_gate_admin_token', 'test-token');
    window.history.replaceState({}, '', '/overview');
    fetchRequest.mockImplementation(async input => {
      if (String(input).endsWith('/api/v1/system/config')) return jsonResponse({});
      throw new Error('offline');
    });

    renderWithTheme(<Root />);

    const navigation = await screen.findByRole('navigation', { name: 'Primary' });
    const links = Array.from(navigation.querySelectorAll<HTMLElement>('[data-nav-sortable="true"]'));

    expect(links).toHaveLength(7);
    for (const link of links) {
      expect(link.getAttribute('data-nav-sortable')).toBe('true');
      expect(link.getAttribute('aria-describedby')).toBe('primary-nav-sort-instructions');
      expect(link.className).toContain('cursor-grab');
    }
    expect(within(navigation).queryByRole('button', { name: /reorder navigation/i })).toBeNull();
    expect(screen.getByText(/Drag any navigation item to reorder it/i)).toBeTruthy();

    const logsLink = navigation.querySelector<HTMLElement>('[data-nav-key="logs"]');
    expect(logsLink).toBeTruthy();
    fireEvent.click(logsLink!);

    await waitFor(() => expect(window.location.pathname).toBe('/logs'));
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('inserts Models into an existing custom navigation order without resetting it', async () => {
    window.sessionStorage.setItem('little_gate_admin_token', 'test-token');
    window.localStorage.setItem('little_gate_nav_order', JSON.stringify([
      'logs', 'overview', 'upstreams', 'keys', 'settings',
    ]));
    window.history.replaceState({}, '', '/overview');
    fetchRequest.mockImplementation(async input => {
      if (String(input).endsWith('/api/v1/system/config')) return jsonResponse({});
      throw new Error('offline');
    });

    renderWithTheme(<Root />);

    const navigation = await screen.findByRole('navigation', { name: 'Primary' });
    expect(Array.from(navigation.querySelectorAll<HTMLElement>('[data-nav-sortable="true"]')).map(link => link.getAttribute('href')))
      .toEqual(['/logs', '/overview', '/upstreams', '/models', '/keys', '/settings', '/notifications']);
  });

  it('filters the aggregated model inventory by search text', async () => {
    fetchRequest.mockImplementation(async input => {
      if (String(input).endsWith('/api/v1/gateway-models')) return jsonResponse([]);
      return jsonResponse([
        {
          id: 11,
          provider_id: 7,
          provider_name: 'Provider A',
          provider_type: 'openai_compatible',
          upstream_model: 'model-a',
          alias: 'alpha',
          enabled: true,
          available: true,
          responses_via_chat_enabled: false,
          native_api_formats: ['chat_completions'],
          created_at_ms: 1,
          updated_at_ms: 1,
        },
        {
          id: 12,
          provider_id: 8,
          provider_name: 'Provider B',
          provider_type: 'openai_compatible_responses',
          upstream_model: 'model-b',
          alias: null,
          enabled: true,
          available: true,
          responses_via_chat_enabled: false,
          native_api_formats: ['responses'],
          created_at_ms: 1,
          updated_at_ms: 1,
        },
      ]);
    });

    renderWithTheme(<ModelsPage
      settings={{ apiBase: 'http://127.0.0.1:8080', adminToken: 'test-token' }}
      providers={[providerWorkspace()]}
      aliases={[]}
      onAliasesRefresh={async () => undefined}
      onMessage={() => undefined}
    />);

    expect(await screen.findByText('model-a')).toBeTruthy();
    expect(screen.getByText('model-b')).toBeTruthy();
    const inventoryTable = screen.getByRole('table', { name: 'Model Inventory' });
    expect(inventoryTable.className).toContain('MuiTable-stickyHeader');
    expect(inventoryTable.querySelectorAll('[data-sticky-column="provider"]').length).toBeGreaterThan(0);
    expect(inventoryTable.querySelectorAll('[data-sticky-column="model"]').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Sync Provider' })).toBeNull();
    fireEvent.change(screen.getByPlaceholderText('Search models, aliases, or providers'), {
      target: { value: 'alpha' },
    });

    expect(screen.getByText('model-a')).toBeTruthy();
    expect(screen.queryByText('model-b')).toBeNull();
  });

  it('restores and persists model column widths while updating sticky offsets', async () => {
    let widthPatch: Record<string, number> | null = null;
    fetchRequest.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/v1/console-preferences')) {
        if (init?.method === 'PATCH') {
          const body = JSON.parse(String(init.body)) as { model_column_widths: Record<string, number> };
          widthPatch = body.model_column_widths;
          return jsonResponse({
            log_visible_columns: ['time'],
            log_column_widths: {},
            model_column_widths: body.model_column_widths,
          });
        }
        return jsonResponse({
          log_visible_columns: ['time'],
          log_column_widths: {},
          model_column_widths: { provider: 104, model: 176 },
        });
      }
      if (url.endsWith('/api/v1/gateway-models')) return jsonResponse([]);
      if (url.endsWith('/api/v1/provider-models')) return jsonResponse([{
        id: 11,
        provider_id: 7,
        provider_name: 'Provider A',
        provider_type: 'openai_compatible',
        upstream_model: 'model-a',
        alias: null,
        enabled: true,
        available: true,
        responses_via_chat_enabled: false,
        native_api_formats: ['chat_completions'],
        created_at_ms: 1,
        updated_at_ms: 1,
      }]);
      return jsonResponse([]);
    });

    renderWithTheme(<ModelsPage
      settings={{ apiBase: 'http://127.0.0.1:8080', adminToken: 'test-token' }}
      providers={[providerWorkspace()]}
      aliases={[]}
      onAliasesRefresh={async () => undefined}
      onMessage={() => undefined}
    />);

    const table = await screen.findByRole('table', { name: 'Model Inventory' });
    await waitFor(() => expect(table.querySelector('col[data-column-id="provider"]')?.getAttribute('style')).toContain('104px'));
    expect(table.querySelector('thead [data-column-id="model"]')?.getAttribute('data-sticky-offset')).toBe('104');

    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize Providers column' }), { key: 'ArrowRight' });

    await waitFor(() => expect(widthPatch?.provider).toBe(112));
    expect(table.querySelector('thead [data-column-id="model"]')?.getAttribute('data-sticky-offset')).toBe('112');
  });

  it('creates a model alias from the Models page and refreshes aliases', async () => {
    let aliasPayload: Record<string, unknown> | null = null;
    let aliasRefreshes = 0;
    fetchRequest.mockImplementation(async (input, init) => {
      const url = String(input);
      if (init?.method === 'POST' && url.endsWith('/api/v1/model-aliases')) {
        aliasPayload = JSON.parse(String(init.body));
        return jsonResponse({ id: 21 });
      }
      return jsonResponse([]);
    });

    renderWithTheme(<ModelsPage
      settings={{ apiBase: 'http://127.0.0.1:8080', adminToken: 'test-token' }}
      providers={[providerWorkspace()]}
      aliases={[]}
      onAliasesRefresh={async () => {
        aliasRefreshes += 1;
      }}
      onMessage={() => undefined}
    />);

    fireEvent.change(screen.getByPlaceholderText('gpt-5'), { target: { value: 'codex-route' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Model' }));

    await waitFor(() => expect(aliasPayload).toEqual({
      name: 'codex-route',
      enabled: true,
      mode: 'ordered',
    }));
    await waitFor(() => expect(aliasRefreshes).toBe(1));
  });

  it('rolls back a model conversion toggle when saving fails', async () => {
    const messages: string[] = [];
    fetchRequest.mockImplementation(async (input, init) => {
      if (init?.method === 'PATCH') return new Response('failed', { status: 500 });
      if (String(input).endsWith('/api/v1/gateway-models')) return jsonResponse([]);
      return jsonResponse([{
        id: 11,
        provider_id: 7,
        provider_name: 'Provider A',
        provider_type: 'openai_compatible',
        upstream_model: 'model-a',
        alias: null,
        enabled: true,
        available: true,
        responses_via_chat_enabled: false,
        native_api_formats: ['chat_completions'],
        created_at_ms: 1,
        updated_at_ms: 1,
      }]);
    });

    renderWithTheme(<ModelsPage
      settings={{ apiBase: 'http://127.0.0.1:8080', adminToken: 'test-token' }}
      providers={[providerWorkspace()]}
      aliases={[]}
      onAliasesRefresh={async () => undefined}
      onMessage={message => messages.push(message)}
    />);

    const checkbox = await screen.findByRole('checkbox', { name: /model-a.*Responses/i });
    expect((checkbox as HTMLInputElement).checked).toBe(false);
    fireEvent.click(checkbox);
    await waitFor(() => expect((checkbox as HTMLInputElement).checked).toBe(false));
    expect(messages.some(message => message.includes('500'))).toBe(true);
  });

  it('keeps the first selected log column sticky when preferences change', async () => {
    fetchRequest.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/api/v1/console-preferences')) {
        if (init?.method === 'PATCH') {
          const body = JSON.parse(String(init.body)) as { log_visible_columns: string[] };
          return jsonResponse(body);
        }
        return jsonResponse({ log_visible_columns: ['provider', 'time'] });
      }
      if (url.includes('/api/v1/logs')) return jsonResponse([{
        id: 'req-1',
        time_ms: 1,
        api_key_id: 1,
        provider_id: 7,
        endpoint_id: 71,
        upstream_key_id: 72,
        model: 'model-a',
        http_status: 200,
        duration_ms: 10,
        api_format: 'responses',
        upstream_api_format: 'chat_completions',
        span_kind: 'http_request',
        transport: 'http',
        usage_observed: false,
      }]);
      return jsonResponse([]);
    });

    renderWithTheme(<LogsPage
      settings={{ apiBase: 'http://127.0.0.1:8080', adminToken: 'test-token' }}
      providers={[providerWorkspaceWithConnection()]}
      apiKeys={[]}
      refreshKey={0}
      onMessage={() => undefined}
    />);

    const table = await screen.findByRole('table', { name: 'Request Logs' });
    expect(table.className).toContain('MuiTable-stickyHeader');
    await waitFor(() => expect(table.querySelector('thead [data-sticky-column="first-visible"]')?.textContent).toContain('Provider'));

    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Providers' }));

    await waitFor(() => expect(table.querySelector('thead [data-sticky-column="first-visible"]')?.textContent).toContain('Time'));
  });

  it('renders usage metrics in one cell and persists log column widths', async () => {
    let widthPatch: Record<string, number> | null = null;
    fetchRequest.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/api/v1/console-preferences')) {
        if (init?.method === 'PATCH') {
          const body = JSON.parse(String(init.body)) as { log_column_widths: Record<string, number> };
          widthPatch = body.log_column_widths;
          return jsonResponse({
            log_visible_columns: ['time', 'total_tokens'],
            log_column_widths: body.log_column_widths,
            model_column_widths: {},
          });
        }
        return jsonResponse({
          log_visible_columns: ['time', 'input_tokens', 'cache_read', 'reasoning'],
          log_column_widths: { time: 136 },
          model_column_widths: {},
        });
      }
      if (url.includes('/api/v1/logs')) return jsonResponse([{
        id: 'req-usage',
        time_ms: 1,
        api_key_id: 1,
        provider_id: 7,
        endpoint_id: 71,
        upstream_key_id: 72,
        model: 'model-a',
        http_status: 200,
        duration_ms: 10,
        api_format: 'responses',
        upstream_api_format: 'responses',
        span_kind: 'http_request',
        transport: 'http',
        usage_observed: true,
        input_tokens: 101,
        output_tokens: 202,
        cache_read_input_tokens: 303,
        cache_creation_input_tokens: 404,
        reasoning_output_tokens: 505,
      }]);
      return jsonResponse([]);
    });

    renderWithTheme(<LogsPage
      settings={{ apiBase: 'http://127.0.0.1:8080', adminToken: 'test-token' }}
      providers={[providerWorkspaceWithConnection()]}
      apiKeys={[]}
      refreshKey={0}
      onMessage={() => undefined}
    />);

    const table = await screen.findByRole('table', { name: 'Request Logs' });
    await waitFor(() => expect(table.querySelector('col[data-column-id="time"]')?.getAttribute('style')).toContain('136px'));
    expect(within(table).getByRole('columnheader', { name: 'Usage' })).toBeTruthy();
    expect(within(table).queryByRole('columnheader', { name: 'Input Tokens' })).toBeNull();
    expect(within(table).getByText('101')).toBeTruthy();
    expect(within(table).getByText('202')).toBeTruthy();
    expect(within(table).getByText('303')).toBeTruthy();
    expect(within(table).getByText('404')).toBeTruthy();
    expect(within(table).getByText('505')).toBeTruthy();

    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize Time column' }), { key: 'ArrowRight' });

    await waitFor(() => expect(widthPatch?.time).toBe(144));
  });
});
