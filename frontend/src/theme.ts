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
    fontFamily: 'Inter, "Noto Sans SC Variable", "PingFang SC", "Microsoft YaHei", sans-serif',
    h1: { fontSize: 20, fontWeight: 600, letterSpacing: "-0.01em" },
    h2: { fontSize: 14, fontWeight: 600 },
    h3: { fontSize: 14, fontWeight: 600 },
    subtitle1: { fontSize: 14, fontWeight: 600 },
    body1: { fontSize: 13 },
    body2: { fontSize: 13 },
    caption: { fontSize: 11.5 },
    button: { textTransform: "none", fontSize: 13, fontWeight: 500 },
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
        "@font-face": {
          fontFamily: "Noto Sans SC Variable",
          src: 'url("/fonts/NotoSansSC-Variable.woff2") format("woff2")',
          fontStyle: "normal",
          fontWeight: "100 900",
          fontDisplay: "swap",
        },
        // 全局隐藏滚动条（保留滚动能力）
        "*": { scrollbarWidth: "none", msOverflowStyle: "none" },
        "*::-webkit-scrollbar": { display: "none", width: 0, height: 0 },
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
      defaultProps: { variant: "contained", disableElevation: true, size: "small" },
      styleOverrides: {
        root: {
          gap: 6,
          minHeight: 30,
          borderRadius: 6,
          "& .MuiSvgIcon-root": { fontSize: 16 },
          transition: "background-color 120ms, color 120ms, border-color 120ms",
        },
      },
    },
    MuiIconButton: {
      defaultProps: { size: "small" },
      styleOverrides: { root: { padding: 5, "& .MuiSvgIcon-root": { fontSize: 18 } } },
    },
    MuiSvgIcon: { styleOverrides: { fontSizeMedium: { fontSize: 20 } } },
    MuiCard: {
      defaultProps: { variant: "outlined" },
      styleOverrides: { root: { backgroundImage: "none" } },
    },
    MuiTextField: { defaultProps: { size: "small", fullWidth: true } },
    MuiSelect: { defaultProps: { size: "small", variant: "outlined" } },
    MuiFormLabel: { styleOverrides: { root: { fontSize: 13 } } },
    MuiInputBase: { styleOverrides: { root: { fontSize: 13 } } },
    MuiChip: { defaultProps: { size: "small", variant: "outlined" } },
    MuiTableContainer: {
      styleOverrides: {
        root: { maxWidth: "100%", overflowX: "auto", borderRadius: 8 },
      },
    },
    MuiTableCell: {
      styleOverrides: {
        root: { padding: "8px 12px", fontSize: 13 },
        head: {
          fontWeight: 600,
          fontSize: 12,
          color: "var(--mui-palette-text-secondary)",
          whiteSpace: "nowrap",
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
    MuiCardHeader: {
      styleOverrides: {
        root: { padding: "12px 16px" },
        title: { fontSize: 14, fontWeight: 600 },
        subheader: { fontSize: 12 },
        action: { margin: 0, alignSelf: "center" },
      },
    },
    MuiCardContent: {
      styleOverrides: {
        root: { padding: "12px 16px", "&:last-child": { paddingBottom: 12 } },
      },
    },
    MuiAlert: {
      styleOverrides: {
        root: { padding: "2px 12px", fontSize: 13, borderRadius: 8, alignItems: "center" },
        icon: { padding: "6px 0", marginRight: 8, "& .MuiSvgIcon-root": { fontSize: 18 } },
        message: { padding: "6px 0" },
      },
    },
    MuiAlertTitle: { styleOverrides: { root: { fontSize: 13, marginBottom: 2 } } },
    MuiToggleButtonGroup: { defaultProps: { size: "small" } },
    MuiToggleButton: {
      styleOverrides: {
        root: { padding: "4px 10px", fontSize: 12, textTransform: "none", lineHeight: 1.5 },
      },
    },
    MuiTableRow: {
      styleOverrides: {
        root: { "&:last-child > .MuiTableCell-body": { borderBottom: 0 } },
      },
    },
    MuiAccordion: {
      defaultProps: { disableGutters: true, elevation: 0 },
      styleOverrides: {
        root: {
          border: "1px solid var(--mui-palette-divider)",
          borderRadius: 8,
          "&::before": { display: "none" },
        },
      },
    },
    MuiAccordionSummary: {
      styleOverrides: {
        root: { minHeight: 44, padding: "0 16px", fontSize: 14, fontWeight: 600 },
        content: { margin: "10px 0" },
      },
    },
    MuiAccordionDetails: { styleOverrides: { root: { padding: "0 16px 16px" } } },
    MuiFormHelperText: { styleOverrides: { root: { fontSize: 11.5, marginTop: 2 } } },
  },
});
