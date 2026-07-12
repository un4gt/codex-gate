import { type JSX } from "react";
import { SquareTerminal } from "lucide-react";
import { t } from '@/lib/i18n';
import Box from "@mui/material/Box";
export function EmptyState(props: {
  title: string;
  description?: string;
  action?: JSX.Element;
}) {
  return <Box className="flex flex-col items-center justify-center border border-dashed border-border/60 bg-muted/10 p-10 text-center">
      <Box className="mb-6 flex size-12 items-center justify-center border border-border/50 bg-background text-muted-foreground opacity-60">
        <SquareTerminal className="size-5" />
      </Box>
      <Box className="mb-2 text-sm font-semibold uppercase tracking-[0.08em] text-foreground" component="h3">{t(props.title)}</Box>
      {props.description ? <Box className="max-w-md text-xs leading-5 text-muted-foreground opacity-80" component="p">{t(props.description!)}</Box> : null}
      {props.action ? <Box className="mt-6">{props.action}</Box> : null}
    </Box>;
}
