import type { ReactNode } from "react";
import type { SxProps, Theme } from "@mui/material/styles";
import Skeleton from "@mui/material/Skeleton";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";

export interface TableSkeletonColumn {
  label: ReactNode;
  width?: number | string;
  align?: "left" | "center" | "right";
  skeletonWidth?: number | string;
}

interface TableSkeletonProps {
  ariaLabel: string;
  columns: readonly TableSkeletonColumn[];
  rows?: number;
  minWidth?: number;
  containerSx?: SxProps<Theme>;
}

export function TableSkeleton({
  ariaLabel,
  columns,
  rows = 6,
  minWidth = 640,
  containerSx,
}: TableSkeletonProps) {
  return (
    <TableContainer
      sx={[{ maxWidth: "100%", overflow: "auto" }, containerSx] as SxProps<Theme>}
    >
      <Table
        stickyHeader
        size="small"
        aria-label={ariaLabel}
        aria-busy="true"
        sx={{ minWidth }}
      >
        <TableHead>
          <TableRow>
            {columns.map((column, index) => (
              <TableCell
                key={`skeleton-column-${index}`}
                align={column.align}
                sx={{ width: column.width, whiteSpace: "nowrap" }}
              >
                {column.label}
              </TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {Array.from({ length: rows }, (_, row) => (
            <TableRow key={`skeleton-row-${row}`}>
              {columns.map((column, index) => (
                <TableCell key={`skeleton-cell-${row}-${index}`} align={column.align}>
                  <Skeleton
                    animation="wave"
                    width={
                      column.skeletonWidth ??
                      `${45 + ((row * 13 + index * 17) % 40)}%`
                    }
                  />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}
