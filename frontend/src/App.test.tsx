import { StrictMode, type ReactNode } from 'react';
import GlobalStyles from '@mui/material/GlobalStyles';
import { StyledEngineProvider, ThemeProvider } from '@mui/material/styles';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, rs } from '@rstest/core';
import Root from '@/App';
import { ProvidersPage } from '@/components/ProvidersPage';
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
        aliases={[]}
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

  it('sends custom priority and weight when creating a provider', async () => {
    let providerPayload: Record<string, unknown> | null = null;
    fetchRequest.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (method === 'GET') return jsonResponse([]);
      if (method === 'POST' && url.endsWith('/api/v1/providers')) {
        providerPayload = JSON.parse(String(init?.body));
        return jsonResponse({ id: 9 });
      }
      if (method === 'POST') return jsonResponse({ id: 1 });
      return jsonResponse([]);
    });

    renderWithTheme(
      <ProvidersPage
        settings={{ apiBase: 'http://127.0.0.1:8080', adminToken: 'test-token' }}
        items={[]}
        aliases={[]}
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
    fireEvent.click(screen.getByRole('button', { name: 'CREATE' }));

    await waitFor(() => expect(providerPayload).toBeTruthy());
    expect(providerPayload).toMatchObject({ priority: 25, weight: 4 });
    expect(consoleError).not.toHaveBeenCalled();
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
        aliases={[]}
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
        aliases={[]}
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
        aliases={[]}
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
        aliases={[]}
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
        aliases={[]}
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

    expect(links).toHaveLength(5);
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
});
