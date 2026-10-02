import { createTheme } from "@mui/material/styles";

export const theme = createTheme({
  cssVariables: { colorSchemeSelector: "data-color-scheme" },
  colorSchemes: {
    light: {
      palette: {
        primary: { main: "#1976d2" },
        background: { default: "#f5f6f8", paper: "#ffffff" },
      },
    },
    dark: {
      palette: {
        primary: { main: "#90caf9" },
        background: { default: "#101418", paper: "#191f26" },
      },
    },
  },
  spacing: 8,
  shape: { borderRadius: 8 },
  typography: {
    fontFamily: 'Inter, "PingFang SC", "Microsoft YaHei", sans-serif',
    h1: { fontSize: 24, fontWeight: 600 },
    h2: { fontSize: 16, fontWeight: 600 },
    h3: { fontSize: 16, fontWeight: 600 },
    subtitle1: { fontSize: 16, fontWeight: 600 },
    body1: { fontSize: 14 },
    body2: { fontSize: 14 },
    caption: { fontSize: 12 },
    button: { textTransform: "none" },
  },
  transitions: {
    duration: {
      shortest: 120,
      shorter: 120,
      short: 150,
      standard: 180,
      enteringScreen: 180,
      leavingScreen: 120,
    },
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: { fontVariantNumeric: "tabular-nums" },
        "#root": { minHeight: "100dvh" },
        "code, pre": {
          fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
        },
        a: { color: "inherit", textDecoration: "none" },
        "h1, h2, h3, p, dl, dd": { margin: 0 },
        "@media (prefers-reduced-motion: reduce)": {
          "*, *::before, *::after": {
            animationDuration: "0.01ms !important",
            animationIterationCount: "1 !important",
            transitionDuration: "0.01ms !important",
            scrollBehavior: "auto !important",
          },
        },
      },
    },
    MuiButton: {
      defaultProps: { variant: "contained", disableElevation: true },
      styleOverrides: {
        root: {
          gap: 8,
          transition: "background-color 120ms, color 120ms, border-color 120ms",
        },
      },
    },
    MuiIconButton: { defaultProps: { size: "small" } },
    MuiCard: {
      defaultProps: { variant: "outlined" },
      styleOverrides: { root: { backgroundImage: "none" } },
    },
    MuiTextField: { defaultProps: { size: "small", fullWidth: true } },
    MuiSelect: { defaultProps: { size: "small", variant: "outlined" } },
    MuiFormLabel: { styleOverrides: { root: { fontSize: 14 } } },
    MuiChip: { defaultProps: { size: "small", variant: "outlined" } },
    MuiTableContainer: {
      styleOverrides: {
        root: { maxWidth: "100%", overflowX: "auto", borderRadius: 8 },
      },
    },
    MuiTableCell: {
      styleOverrides: {
        root: { padding: "12px 16px" },
        head: {
          fontWeight: 600,
          backgroundColor: "var(--mui-palette-background-paper)",
        },
      },
    },
    MuiDrawer: {
      defaultProps: { transitionDuration: { enter: 180, exit: 120 } },
    },
    MuiDialog: {
      defaultProps: {
        transitionDuration: { enter: 180, exit: 120 },
        fullWidth: true,
        maxWidth: "sm",
      },
    },
    MuiCollapse: { defaultProps: { timeout: 150 } },
    MuiLinearProgress: {
      styleOverrides: { root: { borderRadius: 8, height: 6 } },
    },
    MuiTab: { styleOverrides: { root: { textTransform: "none" } } },
  },
});
