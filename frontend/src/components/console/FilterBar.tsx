import { type JSX } from "react";
import { Filter } from "lucide-react";
import { t } from '@/lib/i18n';
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
interface FilterBarProps {
  primary: JSX.Element;
  advanced?: JSX.Element;
  actions?: JSX.Element;
  advancedOpen?: boolean;
  onToggleAdvanced?: () => void;
}
export function FilterBar(props: FilterBarProps) {
  return <Card className="border border-border bg-background shadow-none mb-4">
      <CardContent className="flex flex-col gap-4 p-4">
        <Box className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
          <Box className="grid flex-1 gap-3 md:grid-cols-2 xl:grid-cols-5">{props.primary}</Box>
          <Box className="flex flex-wrap gap-2 items-center">
            {props.actions}
            {props.advanced ? <Button type="button" variant="ghost" size="sm" onClick={props.onToggleAdvanced} className="px-2.5 ml-1">
                <Filter className="mr-1.5 size-3" />
                {props.advancedOpen ? t('HIDE FILTERS') : t('ADVANCED')}
              </Button> : null}
          </Box>
        </Box>
        {props.advanced && props.advancedOpen ? <Box className="grid gap-3 border-t border-border/40 pt-4 md:grid-cols-2 xl:grid-cols-4">{props.advanced}</Box> : null}
      </CardContent>
    </Card>;
}
