import { useId, type ReactNode } from 'react';
import { X } from "lucide-react";
import { useI18n } from '@/lib/i18n';
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
  const { t } = useI18n();
  const titleId = useId();

  return (
    <Drawer
      anchor="right"
      aria-labelledby={titleId}
      open={props.open}
      onClose={props.onClose}
      slotProps={{
        backdrop: {
          className: 'fixed inset-0 bg-foreground/20 backdrop-blur-[2px]',
        },
        paper: {
          role: 'dialog',
          'aria-modal': true,
          'aria-labelledby': titleId,
          className: 'flex h-full w-full max-w-3xl flex-col border-l border-border bg-card outline-none',
          sx: { boxShadow: 'var(--shadow-overlay)' },
        },
      }}
    >
      <Box className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-border bg-card px-5 py-5 sm:px-6">
        <Box className="flex min-w-0 flex-col gap-1">
          <Typography id={titleId} className="truncate text-lg font-semibold tracking-normal text-foreground" component="h2" title={t(props.title)}>
            {t(props.title)}
          </Typography>
          {props.description ? (
            <Typography className="break-words text-[0.8125rem] leading-5 text-muted-foreground" component="p">
              {t(props.description)}
            </Typography>
          ) : null}
        </Box>
        <Button autoFocus type="button" variant="ghost" size="icon" aria-label={t('关闭')} className="-mr-1" onClick={props.onClose}>
          <X className="size-4" />
        </Button>
      </Box>
      <Box className="min-h-0 flex-1 overflow-y-auto p-5 sm:p-6">{props.children}</Box>
      {props.footer ? <Box className="border-t border-border bg-background px-5 py-4 sm:px-6">{props.footer}</Box> : null}
    </Drawer>
  );
}
