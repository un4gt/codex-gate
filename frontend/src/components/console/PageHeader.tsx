import { type JSX } from "react";
import Box from "@mui/material/Box";
interface PageHeaderProps {
  actions?: JSX.Element;
}
/**
 * 页面级操作条。页面标题与描述由 App 的 pagebar 统一渲染，
 * 这里只负责放操作按钮——曾经的 title/description 参数从未被渲染，已移除。
 */
export function PageHeader(props: PageHeaderProps) {
  return props.actions ? <Box className="flex flex-col gap-4 pb-2 md:flex-row md:items-end md:justify-end" component="header">
        <Box className="flex w-full flex-wrap gap-2">{props.actions}</Box>
      </Box> : null;
}
