import { type JSX } from "react";
import { t } from '@/lib/i18n';
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Typography from "@mui/material/Typography";
interface QuickActionItem {
  title: string;
  description: string;
  action: JSX.Element;
}
interface QuickActionsProps {
  title?: string;
  items: QuickActionItem[];
}
export function QuickActions(props: QuickActionsProps) {
  return <Card className="border border-border bg-background shadow-none">
      <Box className="flex flex-col gap-2 p-4 pb-3">
        <Typography className="text-sm font-semibold tracking-normal text-foreground" component="div">{t(props.title ?? '快捷操作')}</Typography>
      </Box>
      <CardContent className="grid gap-0">
        {props.items.map(item => <Box key={item.title} className="flex items-center justify-between gap-3 border-b border-border/40 py-2.5 last:border-0 last:pb-0 first:pt-0 overflow-hidden">
              <Box className="flex min-w-0 flex-col gap-0.5">
                <Box className="text-[0.8125rem] font-medium text-foreground truncate" component="strong">{t(item.title)}</Box>
                <Box className="font-mono text-[0.6875rem] text-muted-foreground opacity-70 uppercase tracking-wider truncate" component="span">{t(item.description)}</Box>
              </Box>
              <Box className="shrink-0">{item.action}</Box>
            </Box>)}
      </CardContent>
    </Card>;
}
