import { type JSX } from "react";
import { SquareTerminal } from "lucide-react";
import { t } from '@/lib/i18n';
import Box from "@mui/material/Box";
export function EmptyState(props: {
  title: string;
  description?: string;
  action?: JSX.Element;
}) {
  return <Box className="flex flex-col items-center justify-center rounded border border-dashed border-border/60 bg-muted/10 p-6 text-center">
      <Box className="mb-4 flex size-9 items-center justify-center rounded border border-border/50 bg-background text-muted-foreground opacity-60">
        <SquareTerminal className="size-4" />
      </Box>
      <Box className="mb-1.5 text-[0.8125rem] font-semibold uppercase tracking-[0.08em] text-foreground" component="h3">{t(props.title)}</Box>
      {props.description ? <Box className="max-w-md text-[0.6875rem] leading-4 text-muted-foreground opacity-80" component="p">{t(props.description!)}</Box> : null}
      {props.action ? <Box className="mt-4">{props.action}</Box> : null}
    </Box>;
}
