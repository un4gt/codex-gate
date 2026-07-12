import { type JSX } from "react";
import Box from "@mui/material/Box";
interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: JSX.Element;
}
export function PageHeader(props: PageHeaderProps) {
  return props.actions ? <Box className="flex flex-col gap-4 pb-2 md:flex-row md:items-end md:justify-end" component="header">
        <Box className="flex w-full flex-wrap gap-2">{props.actions}</Box>
      </Box> : null;
}
