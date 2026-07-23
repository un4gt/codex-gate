import { StrictMode, type ReactNode } from 'react';
import GlobalStyles from '@mui/material/GlobalStyles';
import { StyledEngineProvider, ThemeProvider } from '@mui/material/styles';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, rs } from '@rstest/core';
import Root from '@/App';
import { LogsPage } from '@/components/LogsPage';
import { ProvidersPage } from '@/components/ProvidersPage';
import { ModelsPage } from '@/components/ModelsPage';
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
    await waitFor(() => expect(screen.getByText('Please enter the admin token.')).toBeTruthy());
    expect(consoleError).not.toHaveBeenCalled();
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
    fireEvent.change(screen.getByPlaceholderText('https://api.example.com'), { target: { value: 'https://api.example.test' } });
    fireEvent.change(screen.getByPlaceholderText('sk-...'), { target: { value: 'sk-test' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Priority' }), { target: { value: '25' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Weight' }), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create and Sync' }));

    await waitFor(() => expect(providerPayload).toBeTruthy());
    expect(providerPayload).toMatchObject({ priority: 25, weight: 4 });
    expect(await screen.findByText('Model Sync Complete')).toBeTruthy();
    expect(requests).toContain('POST /api/v1/providers/9/endpoints');
    expect(requests).toContain('POST /api/v1/providers/9/keys');
    expect(requests).toContain('POST /api/v1/providers/9/models/sync');
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
    fireEvent.change(screen.getByPlaceholderText('https://api.example.com'), { target: { value: 'https://old.example.test' } });
    fireEvent.change(screen.getByPlaceholderText('sk-...'), { target: { value: 'sk-old' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create and Sync' }));

    expect(await screen.findByText('Sync Failed')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('https://api.example.com'), { target: { value: 'https://new.example.test' } });
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
    fireEvent.change(screen.getByPlaceholderText('https://api.example.com'), { target: { value: 'https://api.example.test' } });
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

  it('sends edited provider priority and weight', async () => {
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
    fireEvent.click(screen.getByRole('button', { name: 'Save Provider' }));

    await waitFor(() => expect(patchPayload).toBeTruthy());
    expect(patchPayload).toMatchObject({ priority: 50, weight: 3 });
    expect(consoleError).not.toHaveBeenCalled();
  });

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

    renderWithTheme(<Root />);

    const navigation = await screen.findByRole('navigation', { name: 'Primary' });
    const links = within(navigation).getAllByRole('link');

    expect(links).toHaveLength(6);
    for (const link of links) {
      expect(link.getAttribute('data-nav-sortable')).toBe('true');
      expect(link.getAttribute('aria-describedby')).toBe('primary-nav-sort-instructions');
      expect(link.className).toContain('cursor-grab');
    }
    expect(within(navigation).queryByRole('button', { name: /reorder navigation/i })).toBeNull();
    expect(screen.getByText(/Drag any navigation item to reorder it/i)).toBeTruthy();

    fireEvent.click(within(navigation).getByRole('link', { name: 'Logs' }));

    await waitFor(() => expect(window.location.pathname).toBe('/logs'));
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('inserts Models into an existing custom navigation order without resetting it', async () => {
    window.sessionStorage.setItem('little_gate_admin_token', 'test-token');
    window.localStorage.setItem('little_gate_nav_order', JSON.stringify([
      'logs', 'overview', 'upstreams', 'keys', 'settings',
    ]));
    window.history.replaceState({}, '', '/overview');

    renderWithTheme(<Root />);

    const navigation = await screen.findByRole('navigation', { name: 'Primary' });
    expect(within(navigation).getAllByRole('link').map(link => link.getAttribute('href')))
      .toEqual(['/logs', '/overview', '/upstreams', '/models', '/keys', '/settings']);
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
});
