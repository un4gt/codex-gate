import { useId, type JSX } from "react";
import { ChevronDown, SlidersHorizontal } from "lucide-react";
import { useI18n } from '@/lib/i18n';
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
  const { t } = useI18n();
  const advancedId = useId();
  return <Card className="console-panel">
      <CardContent className="flex flex-col gap-4 p-4">
        <Box className="flex min-w-0 flex-col gap-3 2xl:flex-row 2xl:items-start">
          <Box className="filter-fields">{props.primary}</Box>
          {props.actions || props.advanced ? <Box className="flex flex-wrap items-center justify-end gap-2">
            {props.actions}
            {props.advanced ? <Button type="button" variant={props.advancedOpen ? 'secondary' : 'ghost'} onClick={props.onToggleAdvanced} aria-expanded={!!props.advancedOpen} aria-controls={advancedId}>
                <SlidersHorizontal size={15} />
                {props.advancedOpen ? t('HIDE FILTERS') : t('ADVANCED')}
                <ChevronDown className={`transition-transform motion-reduce:transition-none ${props.advancedOpen ? 'rotate-180' : ''}`} size={14} />
              </Button> : null}
          </Box> : null}
        </Box>
        {props.advanced ? <Box id={advancedId} hidden={!props.advancedOpen} className={props.advancedOpen ? 'grid gap-3 border-t border-border pt-4 md:grid-cols-2 xl:grid-cols-4' : 'hidden'}>{props.advanced}</Box> : null}
      </CardContent>
    </Card>;
}
