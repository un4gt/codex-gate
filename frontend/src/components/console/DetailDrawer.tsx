import { useId, type ReactNode } from 'react';
import { X } from "lucide-react";
import { t } from '@/lib/i18n';
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Drawer from '@mui/material/Drawer';
import Typography from '@mui/material/Typography';
interface DetailDrawerProps {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}
export function DetailDrawer(props: DetailDrawerProps) {
  const titleId = useId();

  return (
    <Drawer
      anchor="right"
      aria-labelledby={titleId}
      open={props.open}
      onClose={props.onClose}
      slotProps={{
        backdrop: {
          className: 'fixed inset-0 z-50 bg-background/80 backdrop-blur-sm',
        },
        paper: {
          className: 'flex h-full w-full max-w-3xl flex-col border-l border-border bg-card shadow-none outline-none',
        },
      }}
    >
      <Box className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-border/40 bg-card/95 px-5 py-4 backdrop-blur-md">
        <Box className="flex min-w-0 flex-col gap-1">
          <Typography id={titleId} className="truncate text-lg font-semibold tracking-normal text-foreground" component="h2" title={t(props.title)}>
            {t(props.title)}
          </Typography>
          {props.description ? (
            <Typography className="truncate text-[0.8125rem] leading-5 text-muted-foreground opacity-80" component="p">
              {t(props.description)}
            </Typography>
          ) : null}
        </Box>
        <Button autoFocus type="button" variant="ghost" size="icon" aria-label={t('关闭')} className="-mr-1" onClick={props.onClose}>
          <X className="size-4" />
        </Button>
      </Box>
      <Box className="min-h-0 flex-1 overflow-y-auto p-5">{props.children}</Box>
      {props.footer ? <Box className="border-t border-border/40 bg-muted/5 px-5 py-4">{props.footer}</Box> : null}
    </Drawer>
  );
}
