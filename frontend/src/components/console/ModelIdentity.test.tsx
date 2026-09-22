import { ThemeProvider, createTheme } from '@mui/material/styles';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, rs } from '@rstest/core';
import { ModelIdentity, modelBrand } from './ModelIdentity';
afterEach(cleanup);
describe('model identity', () => {
  it('copies the request ID while showing the cloud name and manufacturer', async () => {
    const writeText = rs.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<ModelIdentity id="actual-request-id" display={{ display_name: 'Friendly model', brand: 'anthropic', aliases: [], quote_provider: 'reseller', adaptation: 'supported', present: true }} />);
    expect(screen.getByText('Friendly model')).toBeTruthy();
    expect(screen.getByText('actual-request-id')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'anthropic' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('actual-request-id'));
  });
  it('uses theme foreground colors for local SVG marks in light and dark themes', () => {
    const { rerender } = render(<ThemeProvider theme={createTheme({ palette: { mode: 'light' } })}><ModelIdentity id="gpt-5" /></ThemeProvider>);
    const light = getComputedStyle(screen.getByRole('img', { name: 'openai' })).backgroundColor;
    rerender(<ThemeProvider theme={createTheme({ palette: { mode: 'dark' } })}><ModelIdentity id="gpt-5" /></ThemeProvider>);
    const dark = getComputedStyle(screen.getByRole('img', { name: 'openai' })).backgroundColor;
    expect(light).not.toBe(dark);
    expect(dark).toContain('255');
  });
  it('does not infer an unknown manufacturer from the forwarding provider', () => {
    expect(modelBrand('gpt-5', 'unknown-maker')).toBeNull();
    expect(modelBrand('openai/gpt-5')).toBe('openai');
    expect(modelBrand('unrecognized')).toBeNull();
    render(<ModelIdentity id="unrecognized" />);
    expect(screen.getAllByText('unrecognized')).toHaveLength(1);
  });
});
