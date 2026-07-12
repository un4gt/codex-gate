import { StrictMode, type ReactNode } from 'react';
import GlobalStyles from '@mui/material/GlobalStyles';
import { StyledEngineProvider, ThemeProvider } from '@mui/material/styles';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, rs } from '@rstest/core';
import Root from '@/App';
import { SettingsPage } from '@/components/SettingsPage';
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

describe('admin console smoke test', () => {
  const consoleError = rs.spyOn(console, 'error');

  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.localStorage.setItem('little_gate_api_base', 'http://127.0.0.1:8080');
    window.localStorage.setItem('little_gate_locale', 'en');
    window.history.replaceState({}, '', '/');
    initializeI18n();
    consoleError.mockClear();
    consoleError.mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    consoleError.mockReset();
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
});
