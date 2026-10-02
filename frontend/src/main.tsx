import { initializeI18n } from "@/lib/i18n";
import { theme } from "@/theme";
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import CssBaseline from "@mui/material/CssBaseline";
import { ThemeProvider } from "@mui/material/styles";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

initializeI18n();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider
      theme={theme}
      defaultMode="system"
      modeStorageKey="little-gate-color-mode"
    >
      <CssBaseline />
      <App />
    </ThemeProvider>
  </StrictMode>,
);
