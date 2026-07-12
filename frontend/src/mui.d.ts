import '@mui/material/Button';

declare module '@mui/material/Button' {
  interface ButtonPropsVariantOverrides {
    default: true;
    secondary: true;
    outline: true;
    ghost: true;
    destructive: true;
    subtle: true;
  }

  interface ButtonPropsSizeOverrides {
    default: true;
    icon: true;
    sm: true;
    lg: true;
  }
}
