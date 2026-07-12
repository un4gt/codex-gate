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
  return <Card className="rounded-none border border-border bg-background shadow-none">
      <Box className="flex flex-col gap-3 p-6 pb-4">
        <Typography className="text-xl font-medium tracking-tight text-foreground" component="div">{t(props.title ?? '快捷操作')}</Typography>
      </Box>
      <CardContent className="grid gap-0">
        {props.items.map(item => <Box key={item.title} className="flex items-center justify-between gap-4 border-b border-border/40 py-4 last:border-0 last:pb-0 first:pt-0 overflow-hidden">
              <Box className="flex min-w-0 flex-col gap-1">
                <Box className="text-sm font-medium text-foreground truncate" component="strong">{t(item.title)}</Box>
                <Box className="font-mono text-xs text-muted-foreground opacity-70 uppercase tracking-wider truncate" component="span">{t(item.description)}</Box>
              </Box>
              <Box className="shrink-0">{item.action}</Box>
            </Box>)}
      </CardContent>
    </Card>;
}
