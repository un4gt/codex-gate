import { type JSX } from "react";
import { Inbox } from "lucide-react";
import { useI18n } from '@/lib/i18n';
import Box from "@mui/material/Box";
export function EmptyState(props: {
  title: string;
  description?: string;
  action?: JSX.Element;
}) {
  const { t } = useI18n();
  return <Box className="flex min-h-52 flex-col items-center justify-center rounded-xl px-5 py-9 text-center">
      <Box className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-muted/70 text-muted-foreground">
        <Inbox size={22} aria-hidden="true" />
      </Box>
      <Box className="mb-1.5 text-sm font-semibold text-foreground" component="h3">{t(props.title)}</Box>
      {props.description ? <Box className="max-w-md text-[0.8125rem] leading-6 text-muted-foreground" component="p">{t(props.description)}</Box> : null}
      {props.action ? <Box className="mt-4">{props.action}</Box> : null}
    </Box>;
}
