import type { CSSProperties } from 'react';
import { createTheme } from '@mui/material/styles';
import { ChevronDown } from 'lucide-react';

const interactiveTransition = 'color 150ms ease, background-color 150ms ease, border-color 150ms ease, opacity 150ms ease';

const buttonBase: CSSProperties = {
  alignItems: 'center',
  borderRadius: 'calc(var(--radius) * 0.8)',
  boxShadow: 'none',
  display: 'inline-flex',
  fontFamily: 'var(--font-ui)',
  fontSize: '0.8125rem',
  fontWeight: 550,
  gap: '0.375rem',
  height: '2.25rem',
  justifyContent: 'center',
  letterSpacing: 0,
  lineHeight: 1.25,
  minWidth: 0,
  padding: '0 0.875rem',
  textTransform: 'none',
  transition: interactiveTransition,
  whiteSpace: 'nowrap',
};

export const theme = createTheme({
  palette: {
    primary: { main: '#3659cf' },
    background: { default: '#f5f7fb', paper: '#ffffff' },
    text: { primary: '#202b3d', secondary: '#627087' },
    divider: '#dfe5ef',
    success: { main: '#16744e' },
    warning: { main: '#916013' },
  },
  shape: {
    borderRadius: 10,
  },
  typography: {
    fontFamily: 'var(--font-ui)',
    body1: { fontSize: '0.875rem', lineHeight: 1.6 },
    body2: { fontSize: '0.8125rem', lineHeight: 1.6 },
    caption: { fontSize: '0.75rem', lineHeight: 1.5 },
    button: { textTransform: 'none' },
  },
  components: {
    MuiButtonBase: {
      defaultProps: {
        disableRipple: true,
      },
      styleOverrides: {
        root: {
          fontFamily: 'inherit',
          '&.Mui-focusVisible': {
            outline: '2px solid var(--primary)',
            outlineOffset: 3,
          },
        },
      },
    },
    MuiButton: {
      defaultProps: {
        disableElevation: true,
        size: 'default',
        variant: 'default',
      },
      styleOverrides: {
        root: {
          ...buttonBase,
          '& svg': {
            flexShrink: 0,
            height: '0.875rem',
            pointerEvents: 'none',
            width: '0.875rem',
          },
          '&.Mui-focusVisible': {
            boxShadow: '0 0 0 3px var(--ring)',
            outline: '2px solid var(--primary)',
            outlineOffset: 2,
          },
          '@media (pointer: coarse)': { minHeight: 44 },
        },
        sizeSmall: {
          fontSize: '0.75rem',
          height: '2rem',
          lineHeight: 1.25,
          padding: '0 0.625rem',
        },
        sizeLarge: {
          fontSize: '0.875rem',
          height: '2.25rem',
          padding: '0 1.25rem',
        },
      },
      variants: [
        {
          props: { variant: 'default' },
          style: {
            backgroundColor: 'var(--primary)',
            color: 'var(--primary-foreground)',
            '&:hover': {
              backgroundColor: 'color-mix(in oklab, var(--primary) 88%, black)',
              boxShadow: 'none',
            },
            '&.Mui-disabled': {
              backgroundColor: 'var(--primary)',
              color: 'var(--primary-foreground)',
              opacity: 0.45,
            },
          },
        },
        {
          props: { variant: 'secondary' },
          style: {
            backgroundColor: 'var(--secondary)',
            color: 'var(--secondary-foreground)',
            '&:hover': {
              backgroundColor: 'color-mix(in oklab, var(--secondary) 80%, transparent)',
              boxShadow: 'none',
            },
            '&.Mui-disabled': {
              backgroundColor: 'var(--secondary)',
              color: 'var(--secondary-foreground)',
              opacity: 0.45,
            },
          },
        },
        {
          props: { variant: 'outline' },
          style: {
            backgroundColor: 'var(--card)',
            border: '1px solid var(--border)',
            color: 'var(--foreground)',
            '&:hover': {
              backgroundColor: 'var(--accent)',
              color: 'var(--accent-foreground)',
            },
            '&.Mui-disabled': {
              backgroundColor: 'var(--background)',
              border: '1px solid var(--border)',
              color: 'var(--foreground)',
              opacity: 0.45,
            },
          },
        },
        {
          props: { variant: 'ghost' },
          style: {
            backgroundColor: 'transparent',
            color: 'var(--foreground)',
            '&:hover': {
              backgroundColor: 'var(--accent)',
              color: 'var(--accent-foreground)',
            },
            '&.Mui-disabled': {
              backgroundColor: 'transparent',
              color: 'var(--foreground)',
              opacity: 0.45,
            },
          },
        },
        {
          props: { variant: 'destructive' },
          style: {
            backgroundColor: 'var(--destructive)',
            color: 'var(--destructive-foreground)',
            '&:hover': {
              backgroundColor: 'color-mix(in oklab, var(--destructive) 90%, transparent)',
            },
            '&.Mui-disabled': {
              backgroundColor: 'var(--destructive)',
              color: 'var(--destructive-foreground)',
              opacity: 0.45,
            },
          },
        },
        {
          props: { variant: 'subtle' },
          style: {
            backgroundColor: 'color-mix(in oklab, var(--muted) 70%, transparent)',
            border: '1px solid var(--border)',
            color: 'var(--muted-foreground)',
            '&:hover': {
              backgroundColor: 'color-mix(in oklab, var(--muted) 90%, transparent)',
              color: 'var(--foreground)',
            },
            '&.Mui-disabled': {
              backgroundColor: 'color-mix(in oklab, var(--muted) 70%, transparent)',
              border: '1px solid var(--border)',
              color: 'var(--muted-foreground)',
              opacity: 0.45,
            },
          },
        },
        {
          props: { size: 'icon' },
          style: {
            height: '2.25rem',
            minWidth: '2.25rem',
            padding: 0,
            width: '2.25rem',
          },
        },
        {
          props: { size: 'sm' },
          style: {
            fontSize: '0.75rem',
            height: '2rem',
            lineHeight: 1.25,
            padding: '0 0.625rem',
          },
        },
        {
          props: { size: 'lg' },
          style: {
            fontSize: '0.875rem',
            height: '2.25rem',
            padding: '0 1.25rem',
          },
        },
        {
          props: { color: 'error' },
          style: {
            backgroundColor: 'var(--danger-surface)',
            color: 'var(--danger)',
            '&:hover': { backgroundColor: 'color-mix(in oklab, var(--danger) 12%, var(--card))' },
          },
        },
      ],
    },
    MuiPaper: {
      defaultProps: {
        elevation: 0,
        square: true,
      },
      styleOverrides: {
        root: {
          backgroundImage: 'none',
          color: 'inherit',
        },
      },
    },
    MuiCard: {
      defaultProps: {
        elevation: 0,
        square: false,
      },
      styleOverrides: {
        root: {
          backgroundColor: 'var(--card)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          boxShadow: 'var(--shadow-surface)',
        },
      },
    },
    MuiCardContent: {
      styleOverrides: {
        root: {
          padding: '1rem',
          '.MuiCard-root > :not(style) ~ &': { paddingTop: 0 },
          '&:last-child': {
            paddingBottom: '1rem',
          },
        },
      },
    },
    MuiFormControl: {
      styleOverrides: {
        root: {
          display: 'flex',
          flexDirection: 'column',
          gap: '0.5rem',
        },
      },
    },
    MuiFormLabel: {
      styleOverrides: {
        root: {
          color: 'var(--foreground)',
          fontFamily: 'var(--font-ui)',
          fontSize: '0.75rem',
          fontWeight: 600,
          letterSpacing: 0,
          lineHeight: 1.5,
          textTransform: 'none',
          '&.Mui-focused': {
            color: 'var(--foreground)',
          },
        },
      },
    },
    MuiFormHelperText: {
      styleOverrides: {
        root: {
          color: 'var(--muted-foreground)',
          fontFamily: 'var(--font-ui)',
          fontSize: '0.75rem',
          lineHeight: '1rem',
          margin: 0,
        },
      },
    },
    MuiInputBase: {
      styleOverrides: {
        root: {
          backgroundColor: 'var(--card)',
          border: '1px solid var(--input)',
          borderRadius: 'calc(var(--radius) * 0.8)',
          boxSizing: 'border-box',
          color: 'var(--foreground)',
          fontFamily: 'var(--font-ui)',
          fontSize: '0.8125rem',
          height: '2.25rem',
          padding: '0 0.75rem',
          gap: '0.5rem',
          transition: interactiveTransition,
          width: '100%',
          '&.Mui-focused': {
            borderColor: 'var(--primary)',
            boxShadow: '0 0 0 3px var(--ring)',
          },
          '&.Mui-error': {
            borderColor: 'var(--destructive)',
            boxShadow: '0 0 0 1px color-mix(in oklab, var(--destructive) 35%, transparent)',
          },
          '&.Mui-disabled': {
            cursor: 'not-allowed',
            opacity: 0.5,
          },
          '&.MuiInputBase-multiline': {
            height: 'auto',
            minHeight: '4rem',
            paddingBlock: '0.4375rem',
          },
          '@media (pointer: coarse)': { minHeight: 44, fontSize: '1rem' },
        },
        input: {
          boxSizing: 'border-box',
          color: 'inherit',
          font: 'inherit',
          height: '100%',
          padding: 0,
          '@media (pointer: coarse)': { fontSize: '1rem' },
          '&:not(textarea)': {
            display: 'flex',
          },
          '&::placeholder': {
            color: 'color-mix(in oklab, var(--muted-foreground) 80%, transparent)',
            opacity: 1,
          },
        },
      },
    },
    MuiTextField: {
      defaultProps: { size: 'small' },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          border: 0,
          '&.Mui-focused .MuiOutlinedInput-notchedOutline': { borderColor: 'var(--primary)', borderWidth: 1 },
        },
        notchedOutline: { borderColor: 'var(--input)' },
      },
    },
    MuiSelect: {
      defaultProps: {
        IconComponent: ChevronDown,
        MenuProps: {
          anchorOrigin: {
            horizontal: 'left',
            vertical: 'bottom',
          },
          elevation: 0,
          marginThreshold: 12,
          transformOrigin: {
            horizontal: 'left',
            vertical: 'top',
          },
          transitionDuration: {
            enter: 160,
            exit: 110,
          },
        },
        variant: 'standard',
      },
      styleOverrides: {
        root: {
          backgroundColor: 'var(--card)',
          cursor: 'pointer',
          marginTop: '0 !important',
          '&:hover:not(.Mui-disabled):not(.Mui-focused)': {
            borderColor: 'color-mix(in oklab, var(--border) 65%, var(--foreground))',
          },
          '&.Mui-disabled': {
            cursor: 'not-allowed',
          },
          '&::before, &::after': {
            display: 'none',
          },
        },
        select: {
          alignItems: 'center',
          boxSizing: 'border-box',
          cursor: 'inherit',
          display: 'flex',
          fontWeight: 500,
          height: '100%',
          lineHeight: 1.5,
          minHeight: '0 !important',
          padding: '0 1.75rem 0 0 !important',
          '&:focus': {
            backgroundColor: 'transparent',
          },
        },
        icon: {
          color: 'var(--muted-foreground)',
          height: '0.875rem',
          pointerEvents: 'none',
          right: '0.5rem',
          strokeWidth: 1.75,
          transition: 'color 150ms ease, transform 180ms ease-out',
          width: '0.875rem',
          '@media (prefers-reduced-motion: reduce)': {
            transition: 'none',
          },
        },
        iconOpen: {
          color: 'var(--primary)',
          transform: 'rotate(180deg)',
        },
      },
    },
    MuiMenu: {
      styleOverrides: {
        paper: {
          backgroundColor: 'var(--popover)',
          backgroundImage: 'none',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          boxShadow: 'var(--shadow-overlay)',
          color: 'var(--popover-foreground)',
          marginTop: '0.25rem',
          maxHeight: 'min(20rem, calc(100dvh - 2rem))',
          maxWidth: 'calc(100vw - 1.5rem)',
          scrollbarColor: 'color-mix(in oklab, var(--muted-foreground) 35%, transparent) transparent',
          scrollbarWidth: 'thin',
          '@media (prefers-reduced-motion: reduce)': {
            transition: 'none !important',
          },
        },
        list: {
          display: 'grid',
          gap: '0.0625rem',
          padding: '0.25rem',
        },
      },
    },
    MuiMenuItem: {
      defaultProps: {
        disableRipple: true,
      },
      styleOverrides: {
        root: {
          borderLeft: '2px solid transparent',
          borderRadius: 'calc(var(--radius) * 0.6)',
          color: 'var(--popover-foreground)',
          fontFamily: 'var(--font-ui)',
          fontSize: '0.8125rem',
          fontWeight: 500,
          gap: '0.5rem',
          letterSpacing: '0.01em',
          lineHeight: 1.4,
          minHeight: '2rem !important',
          overflowWrap: 'anywhere',
          padding: '0.375rem 0.625rem',
          transition: interactiveTransition,
          whiteSpace: 'normal',
          '&:hover': {
            backgroundColor: 'color-mix(in oklab, var(--muted) 72%, transparent)',
            color: 'var(--foreground)',
          },
          '&:active': {
            backgroundColor: 'color-mix(in oklab, var(--primary) 16%, var(--popover))',
          },
          '&.Mui-selected': {
            backgroundColor: 'color-mix(in oklab, var(--primary) 10%, var(--popover))',
            borderLeftColor: 'var(--primary)',
            color: 'var(--foreground)',
            fontWeight: 600,
          },
          '&.Mui-selected:hover': {
            backgroundColor: 'color-mix(in oklab, var(--primary) 14%, var(--popover))',
          },
          '&.Mui-focusVisible': {
            backgroundColor: 'color-mix(in oklab, var(--primary) 12%, var(--popover))',
            outline: '2px solid var(--primary)',
            outlineOffset: '-2px',
          },
          '&.Mui-disabled': {
            color: 'var(--muted-foreground)',
            opacity: 0.45,
          },
          '@media (prefers-reduced-motion: reduce)': {
            transition: 'none',
          },
        },
      },
    },
    MuiCheckbox: {
      defaultProps: {
        disableRipple: true,
        size: 'small',
      },
      styleOverrides: {
        root: {
          color: 'var(--primary)',
          flexShrink: 0,
          height: '1.125rem',
          padding: 0,
          width: '1.125rem',
          '&.Mui-checked, &.MuiCheckbox-indeterminate': {
            color: 'var(--primary)',
          },
          '&.Mui-disabled': {
            opacity: 0.5,
          },
          '& .MuiSvgIcon-root': {
            fontSize: '1.125rem',
          },
          '@media (pointer: coarse)': { width: 44, height: 44 },
        },
      },
    },
    MuiFormControlLabel: {
      styleOverrides: {
        root: { marginLeft: 0, marginRight: '0.75rem', gap: '0.5rem' },
        label: { fontSize: '0.8125rem' },
      },
    },
    MuiChip: {
      defaultProps: {
        size: 'small',
        variant: 'outlined',
      },
      styleOverrides: {
        root: {
          backgroundColor: 'transparent',
          borderColor: 'var(--border)',
          borderRadius: '999px',
          color: 'var(--muted-foreground)',
          fontFamily: 'var(--font-ui)',
          fontSize: '0.6875rem',
          fontWeight: 500,
          height: 'auto',
          letterSpacing: 0,
          minHeight: '1.375rem',
          textTransform: 'none',
        },
        label: {
          alignItems: 'center',
          display: 'inline-flex',
          gap: '0.25rem',
          padding: '0.125rem 0.5rem',
        },
      },
      variants: [
        {
          props: { color: 'default', variant: 'outlined' },
          style: {
            backgroundColor: 'transparent',
            borderColor: 'var(--border)',
            color: 'var(--muted-foreground)',
          },
        },
        {
          props: { color: 'success', variant: 'outlined' },
          style: {
            backgroundColor: 'var(--success-surface)',
            borderColor: 'var(--success-border)',
            color: 'var(--success)',
          },
        },
        {
          props: { color: 'warning', variant: 'outlined' },
          style: {
            backgroundColor: 'var(--warning-surface)',
            borderColor: 'var(--warning-border)',
            color: 'var(--warning)',
          },
        },
        {
          props: { color: 'error', variant: 'outlined' },
          style: {
            backgroundColor: 'var(--danger-surface)',
            borderColor: 'var(--danger-border)',
            color: 'var(--danger)',
          },
        },
      ],
    },
    MuiAlert: {
      defaultProps: {
        icon: false,
        variant: 'outlined',
      },
      styleOverrides: {
        root: {
          backgroundColor: 'transparent',
          borderColor: 'var(--border)',
          borderRadius: 'var(--radius)',
          boxShadow: 'none',
          color: 'var(--foreground)',
          display: 'block',
          fontSize: 'inherit',
          lineHeight: 'inherit',
          padding: '0.625rem 0.875rem',
        },
        message: {
          padding: 0,
          width: '100%',
        },
      },
      // severity 必须看得见：默认样式把所有等级抹平成同一个灰框，
      // 会让「额度不可用」这类关键提示比旁边的装饰元素还弱。
      variants: [
        {
          props: { severity: 'success' },
          style: {
            backgroundColor: 'var(--success-surface)',
            borderColor: 'var(--success-border)',
            borderLeft: '3px solid var(--success)',
            '& .MuiAlertTitle-root': { color: 'var(--success)' },
          },
        },
        {
          props: { severity: 'warning' },
          style: {
            backgroundColor: 'var(--warning-surface)',
            borderColor: 'var(--warning-border)',
            borderLeft: '3px solid var(--warning)',
            '& .MuiAlertTitle-root': { color: 'var(--warning)' },
          },
        },
        {
          props: { severity: 'error' },
          style: {
            backgroundColor: 'var(--danger-surface)',
            borderColor: 'var(--danger-border)',
            borderLeft: '3px solid var(--danger)',
            '& .MuiAlertTitle-root': { color: 'var(--danger)' },
          },
        },
        {
          props: { severity: 'info' },
          style: {
            backgroundColor: 'color-mix(in oklab, var(--primary) 7%, var(--background))',
            borderColor: 'color-mix(in oklab, var(--primary) 28%, var(--border))',
            borderLeft: '3px solid var(--primary)',
          },
        },
      ],
    },
    MuiAlertTitle: {
      styleOverrides: {
        root: {
          fontFamily: 'var(--font-ui)',
          fontSize: '0.8125rem',
          fontWeight: 600,
          lineHeight: 1.4,
          margin: '0 0 0.25rem',
        },
      },
    },
    MuiDivider: {
      styleOverrides: {
        root: {
          borderColor: 'color-mix(in oklab, var(--border) 40%, transparent)',
        },
      },
    },
    MuiTableContainer: {
      styleOverrides: {
        root: {
          backgroundColor: 'var(--card)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          overflowX: 'auto',
          width: '100%',
          scrollbarColor: 'var(--input) transparent',
        },
      },
    },
    MuiTable: {
      styleOverrides: {
        root: {
          color: 'inherit',
          fontFamily: 'var(--font-ui)',
          fontSize: '0.8125rem',
          lineHeight: '1.125rem',
        },
      },
    },
    MuiTableHead: {
      styleOverrides: {
        root: {
          '& .MuiTableRow-root': {
            borderBottom: '1px solid var(--border)',
          },
        },
      },
    },
    MuiTableBody: {
      styleOverrides: {
        root: {
          '& .MuiTableRow-root:last-child': {
            borderBottom: '0 !important',
          },
        },
      },
    },
    MuiTableRow: {
      styleOverrides: {
        root: {
          borderBottom: '1px solid var(--border)',
          transition: 'background-color 150ms ease',
          '&:hover': {
            backgroundColor: 'var(--accent)',
          },
          '&:hover td[data-sticky-column]': {
            backgroundColor: 'var(--accent)',
          },
        },
      },
    },
    MuiTableCell: {
      styleOverrides: {
        root: {
          borderBottom: '1px solid var(--border)',
          color: 'inherit',
          fontFamily: 'var(--font-ui)',
          fontSize: '0.8125rem',
          lineHeight: '1.125rem',
          padding: '0.625rem 0.875rem',
          verticalAlign: 'middle',
        },
        head: {
          backgroundColor: 'var(--background)',
          color: 'var(--muted-foreground)',
          fontSize: '0.75rem',
          fontWeight: 600,
          height: '2.625rem',
          letterSpacing: 0,
          padding: '0 0.875rem',
          textTransform: 'none',
        },
      },
    },
    MuiDrawer: {
      styleOverrides: {
        paper: {
          backgroundColor: 'var(--card)',
          backgroundImage: 'none',
          borderRadius: 0,
          boxShadow: 'none',
          color: 'var(--foreground)',
        },
      },
    },
    MuiDialog: {
      defaultProps: {
        transitionDuration: {
          enter: 160,
          exit: 110,
        },
      },
      styleOverrides: {
        paper: {
          backgroundColor: 'var(--card)',
          backgroundImage: 'none',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          boxShadow: 'var(--shadow-overlay)',
          color: 'var(--foreground)',
        },
      },
    },
    MuiDialogTitle: {
      styleOverrides: {
        root: {
          borderBottom: '1px solid color-mix(in oklab, var(--border) 60%, transparent)',
          fontFamily: 'var(--font-ui)',
          fontSize: '1rem',
          fontWeight: 600,
          letterSpacing: 0,
          lineHeight: 1.4,
          padding: '1.25rem 1.5rem',
        },
      },
    },
    MuiDialogContent: {
      styleOverrides: {
        root: {
          fontSize: '0.8125rem',
          padding: '1.5rem',
        },
      },
    },
    MuiDialogActions: {
      styleOverrides: {
        root: {
          borderTop: '1px solid color-mix(in oklab, var(--border) 60%, transparent)',
          gap: '0.5rem',
          padding: '1rem 1.5rem',
          backgroundColor: 'var(--background)',
          '& > :not(style) ~ :not(style)': {
            marginLeft: 0,
          },
        },
      },
    },
    MuiToggleButtonGroup: {
      styleOverrides: {
        root: {
          gap: '0.25rem',
        },
        grouped: {
          border: '1px solid var(--border) !important',
          borderRadius: 'var(--radius) !important',
        },
      },
    },
    MuiToggleButton: {
      defaultProps: {
        disableRipple: true,
      },
      styleOverrides: {
        root: {
          backgroundColor: 'var(--background)',
          color: 'var(--muted-foreground)',
          fontFamily: 'var(--font-ui)',
          fontSize: '0.8125rem',
          fontWeight: 500,
          letterSpacing: '0.01em',
          lineHeight: 1.25,
          minHeight: '2rem',
          padding: '0 0.75rem',
          textTransform: 'none',
          transition: interactiveTransition,
          '&:hover': {
            backgroundColor: 'var(--accent)',
            color: 'var(--accent-foreground)',
          },
          '&.Mui-selected': {
            backgroundColor: 'var(--foreground)',
            borderColor: 'var(--foreground) !important',
            color: 'var(--background)',
          },
          '&.Mui-selected:hover': {
            backgroundColor: 'color-mix(in oklab, var(--foreground) 92%, transparent)',
            color: 'var(--background)',
          },
          '&.Mui-disabled': {
            color: 'var(--muted-foreground)',
            opacity: 0.45,
          },
          '&.Mui-selected.Mui-disabled': {
            backgroundColor: 'var(--foreground)',
            color: 'var(--background)',
            opacity: 0.45,
          },
        },
      },
    },
    MuiLinearProgress: {
      styleOverrides: {
        root: {
          backgroundColor: 'var(--muted)',
          borderRadius: 'var(--radius)',
          height: '0.25rem',
        },
        bar: {
          backgroundColor: 'var(--primary)',
        },
      },
    },
    MuiTypography: {
      styleOverrides: {
        root: {
          fontFamily: 'var(--font-ui)',
        },
      },
    },
    MuiIconButton: {
      styleOverrides: {
        root: {
          color: 'var(--muted-foreground)',
          borderRadius: 'calc(var(--radius) * 0.8)',
          transition: interactiveTransition,
          '&:hover': { backgroundColor: 'var(--accent)', color: 'var(--primary)' },
          '@media (pointer: coarse)': { minWidth: 44, minHeight: 44 },
        },
      },
    },
    MuiTabs: {
      styleOverrides: {
        root: { minHeight: 44 },
        indicator: { height: 3, borderRadius: '3px 3px 0 0', backgroundColor: 'var(--primary)' },
      },
    },
    MuiTab: {
      styleOverrides: {
        root: {
          minHeight: 44,
          minWidth: 0,
          padding: '0.75rem 1rem',
          fontSize: '0.8125rem',
          fontWeight: 500,
          color: 'var(--muted-foreground)',
          textTransform: 'none',
          '&.Mui-selected': { color: 'var(--primary)', fontWeight: 600 },
        },
      },
    },
    MuiTooltip: {
      styleOverrides: {
        tooltip: { backgroundColor: 'var(--foreground)', fontSize: '0.75rem', padding: '0.5rem 0.75rem' },
      },
    },
    MuiSnackbarContent: {
      styleOverrides: {
        root: {
          backgroundColor: 'var(--foreground)',
          color: 'var(--card)',
          borderRadius: 'var(--radius)',
          boxShadow: 'var(--shadow-overlay)',
          fontSize: '0.8125rem',
          maxWidth: 480,
          flexWrap: 'nowrap',
        },
        message: { overflowWrap: 'anywhere' },
      },
    },
  },
});
