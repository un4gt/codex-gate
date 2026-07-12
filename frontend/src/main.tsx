import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import GlobalStyles from '@mui/material/GlobalStyles';
import { StyledEngineProvider, ThemeProvider } from '@mui/material/styles';
import App from './App';
import { initializeI18n } from '@/lib/i18n';
import { theme } from '@/theme';
import './styles.css';

initializeI18n();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StyledEngineProvider enableCssLayer>
      <GlobalStyles styles="@layer theme, base, mui, components, utilities;" />
      <ThemeProvider theme={theme}>
        <App />
      </ThemeProvider>
    </StyledEngineProvider>
  </StrictMode>,
);
