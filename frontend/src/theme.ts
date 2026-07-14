import type { CSSProperties } from 'react';
import { createTheme } from '@mui/material/styles';
import { ChevronDown } from 'lucide-react';

const interactiveTransition = 'color 150ms ease, background-color 150ms ease, border-color 150ms ease, opacity 150ms ease';

const buttonBase: CSSProperties = {
  alignItems: 'center',
  borderRadius: 0,
  boxShadow: 'none',
  display: 'inline-flex',
  fontFamily: 'var(--font-ui)',
  fontSize: '0.75rem',
  fontWeight: 600,
  gap: '0.5rem',
  height: '2.5rem',
  justifyContent: 'center',
  letterSpacing: '0.08em',
  lineHeight: '1rem',
  minWidth: 0,
  padding: '0.5rem 1.5rem',
  textTransform: 'uppercase',
  transition: interactiveTransition,
  whiteSpace: 'nowrap',
};

export const theme = createTheme({
  shape: {
    borderRadius: 0,
  },
  typography: {
    fontFamily: 'var(--font-ui)',
  },
  components: {
    MuiButtonBase: {
      defaultProps: {
        disableRipple: true,
      },
      styleOverrides: {
        root: {
          fontFamily: 'inherit',
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
            height: '1rem',
            pointerEvents: 'none',
            width: '1rem',
          },
          '&.Mui-focusVisible': {
            boxShadow: '0 0 0 1px var(--ring)',
            outline: 'none',
          },
        },
        sizeSmall: {
          fontSize: '0.72rem',
          height: '2rem',
          lineHeight: 1.5,
          padding: '0 1rem',
        },
        sizeLarge: {
          height: '3rem',
          padding: '0 2rem',
        },
      },
      variants: [
        {
          props: { variant: 'default' },
          style: {
            backgroundColor: 'var(--foreground)',
            color: 'var(--background)',
            '&:hover': {
              backgroundColor: 'color-mix(in oklab, var(--foreground) 92%, transparent)',
              boxShadow: 'none',
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
          },
        },
        {
          props: { variant: 'outline' },
          style: {
            backgroundColor: 'var(--background)',
            border: '1px solid var(--border)',
            color: 'var(--foreground)',
            '&:hover': {
              backgroundColor: 'var(--accent)',
              color: 'var(--accent-foreground)',
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
          },
        },
        {
          props: { size: 'icon' },
          style: {
            height: '2.5rem',
            minWidth: '2.5rem',
            padding: 0,
            width: '2.5rem',
          },
        },
        {
          props: { size: 'sm' },
          style: {
            fontSize: '0.72rem',
            height: '2rem',
            lineHeight: 1.5,
            padding: '0 1rem',
          },
        },
        {
          props: { size: 'lg' },
          style: {
            height: '3rem',
            padding: '0 2rem',
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
        square: true,
      },
      styleOverrides: {
        root: {
          backgroundColor: 'var(--card)',
          border: '1px solid var(--border)',
          boxShadow: 'none',
        },
      },
    },
    MuiCardContent: {
      styleOverrides: {
        root: {
          padding: '1.5rem',
          paddingTop: 0,
          '&:last-child': {
            paddingBottom: '1.5rem',
          },
        },
      },
    },
    MuiFormControl: {
      styleOverrides: {
        root: {
          display: 'flex',
          flexDirection: 'column',
          gap: '0.75rem',
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
          letterSpacing: '0.08em',
          lineHeight: 1.5,
          textTransform: 'uppercase',
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
          lineHeight: '1.25rem',
          margin: 0,
          opacity: 0.8,
        },
      },
    },
    MuiInputBase: {
      styleOverrides: {
        root: {
          backgroundColor: 'transparent',
          border: '1px solid var(--border)',
          borderRadius: 0,
          boxSizing: 'border-box',
          color: 'var(--foreground)',
          fontFamily: 'var(--font-ui)',
          fontSize: '0.875rem',
          height: '2.5rem',
          padding: '0 0.75rem',
          transition: interactiveTransition,
          width: '100%',
          '&.Mui-focused': {
            borderColor: 'var(--primary)',
            boxShadow: '0 0 0 1px var(--ring)',
          },
          '&.Mui-disabled': {
            cursor: 'not-allowed',
            opacity: 0.5,
          },
          '&.MuiInputBase-multiline': {
            height: 'auto',
            minHeight: '5rem',
            paddingBlock: '0.5rem',
          },
        },
        input: {
          boxSizing: 'border-box',
          color: 'inherit',
          font: 'inherit',
          height: '100%',
          padding: 0,
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
          backgroundColor: 'var(--background)',
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
          padding: '0 2.5rem 0 0 !important',
          '&:focus': {
            backgroundColor: 'transparent',
          },
        },
        icon: {
          color: 'var(--muted-foreground)',
          height: '1rem',
          pointerEvents: 'none',
          right: '0.75rem',
          strokeWidth: 1.75,
          transition: 'color 150ms ease, transform 180ms ease-out',
          width: '1rem',
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
          borderRadius: 0,
          boxShadow: '0 18px 38px -24px rgb(0 0 0 / 0.42), 0 8px 18px -14px rgb(0 0 0 / 0.28)',
          color: 'var(--popover-foreground)',
          marginTop: '0.375rem',
          maxHeight: 'min(22rem, calc(100dvh - 2rem))',
          maxWidth: 'calc(100vw - 1.5rem)',
          scrollbarColor: 'color-mix(in oklab, var(--muted-foreground) 35%, transparent) transparent',
          scrollbarWidth: 'thin',
          '@media (prefers-reduced-motion: reduce)': {
            transition: 'none !important',
          },
        },
        list: {
          display: 'grid',
          gap: '0.125rem',
          padding: '0.375rem',
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
          color: 'var(--popover-foreground)',
          fontFamily: 'var(--font-ui)',
          fontSize: '0.875rem',
          fontWeight: 500,
          gap: '0.625rem',
          letterSpacing: '0.01em',
          lineHeight: 1.5,
          minHeight: '2.75rem !important',
          overflowWrap: 'anywhere',
          padding: '0.625rem 0.875rem',
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
          height: '1rem',
          padding: 0,
          width: '1rem',
          '&.Mui-checked, &.MuiCheckbox-indeterminate': {
            color: 'var(--primary)',
          },
          '&.Mui-disabled': {
            opacity: 0.5,
          },
          '& .MuiSvgIcon-root': {
            fontSize: '1rem',
          },
        },
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
          borderRadius: 0,
          color: 'var(--muted-foreground)',
          fontFamily: 'var(--font-ui)',
          fontSize: '0.72rem',
          fontWeight: 500,
          height: 'auto',
          letterSpacing: '0.08em',
          minHeight: '1.625rem',
          textTransform: 'uppercase',
        },
        label: {
          alignItems: 'center',
          display: 'inline-flex',
          gap: '0.25rem',
          padding: '0.25rem 0.75rem',
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
            backgroundColor: 'rgb(16 185 129 / 0.1)',
            borderColor: 'rgb(16 185 129 / 0.5)',
            color: 'rgb(5 150 105)',
          },
        },
        {
          props: { color: 'warning', variant: 'outlined' },
          style: {
            backgroundColor: 'rgb(245 158 11 / 0.1)',
            borderColor: 'rgb(245 158 11 / 0.5)',
            color: 'rgb(217 119 6)',
          },
        },
        {
          props: { color: 'error', variant: 'outlined' },
          style: {
            backgroundColor: 'rgb(239 68 68 / 0.1)',
            borderColor: 'rgb(239 68 68 / 0.5)',
            color: 'rgb(220 38 38)',
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
          borderRadius: 0,
          boxShadow: 'none',
          color: 'var(--foreground)',
          display: 'block',
          fontSize: 'inherit',
          lineHeight: 'inherit',
          padding: '1rem 1.25rem',
        },
        message: {
          padding: 0,
          width: '100%',
        },
      },
    },
    MuiAlertTitle: {
      styleOverrides: {
        root: {
          fontFamily: 'var(--font-ui)',
          fontSize: '0.875rem',
          fontWeight: 500,
          lineHeight: 1,
          margin: '0 0 0.5rem',
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
          backgroundColor: 'var(--background)',
          border: '1px solid var(--border)',
          overflowX: 'auto',
          width: '100%',
        },
      },
    },
    MuiTable: {
      styleOverrides: {
        root: {
          color: 'inherit',
          fontFamily: 'var(--font-ui)',
          fontSize: '0.875rem',
          lineHeight: '1.25rem',
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
          borderBottom: '1px solid color-mix(in oklab, var(--border) 50%, transparent)',
          transition: 'background-color 150ms ease',
          '&:hover': {
            backgroundColor: 'color-mix(in oklab, var(--muted) 50%, transparent)',
          },
        },
      },
    },
    MuiTableCell: {
      styleOverrides: {
        root: {
          borderBottom: 0,
          color: 'inherit',
          fontFamily: 'var(--font-ui)',
          fontSize: '0.875rem',
          lineHeight: '1.25rem',
          padding: '1rem 1.25rem',
          verticalAlign: 'middle',
        },
        head: {
          backgroundColor: 'color-mix(in oklab, var(--muted) 20%, transparent)',
          color: 'var(--muted-foreground)',
          fontSize: '0.72rem',
          fontWeight: 600,
          height: '3rem',
          letterSpacing: '0.08em',
          padding: '0 1.25rem',
          textTransform: 'uppercase',
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
    MuiTypography: {
      styleOverrides: {
        root: {
          fontFamily: 'var(--font-ui)',
        },
      },
    },
  },
});
