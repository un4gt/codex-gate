import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Grid from "@mui/material/Grid";
import Skeleton from "@mui/material/Skeleton";
import Typography from "@mui/material/Typography";
import { useI18n } from "@/lib/i18n";
import { TableSkeleton } from "./TableSkeleton";

export function OverviewSkeleton() {
  const { t } = useI18n();

  return (
    <Box
      sx={{ display: "flex", flexDirection: "column", gap: 1 }}
      aria-busy="true"
      aria-label={t("正在加载总览")}
    >
      <Grid container spacing={1.5} aria-label={t("用量概览")}>
        {Array.from({ length: 4 }, (_, index) => (
          <Grid key={`overview-metric-${index}`} size={{ xs: 12, sm: 6, xl: 3 }}>
            <Card sx={{ height: 112 }}>
              <Box
                sx={{
                  display: "flex",
                  height: "100%",
                  alignItems: "stretch",
                  gap: 1.5,
                  px: 2,
                  py: 1.5,
                }}
              >
                <Box sx={{ minWidth: 0, flex: 1 }}>
                  <Skeleton animation="wave" width={index % 2 ? 44 : 56} />
                  <Skeleton
                    animation="wave"
                    width={index % 2 ? 88 : 72}
                    height={32}
                    sx={{ mt: 0.5 }}
                  />
                  <Skeleton animation="wave" width="62%" sx={{ mt: "auto" }} />
                </Box>
                <Skeleton
                  animation="wave"
                  variant="rounded"
                  width={96}
                  height={index < 2 ? 44 : 52}
                  sx={{ alignSelf: "center", flexShrink: 0 }}
                />
              </Box>
            </Card>
          </Grid>
        ))}
      </Grid>
      <Grid container spacing={1.5}>
        <Grid size={{ xs: 12, lg: 8 }}>
          <Card sx={{ height: "100%" }}>
            <CardContent sx={{ p: 2, "&:last-child": { pb: 1.5 } }}>
              <Typography component="h2" variant="h2">
                {t("流量趋势")}
              </Typography>
              <Skeleton
                animation="wave"
                variant="rounded"
                height={280}
                sx={{ mt: 1 }}
              />
            </CardContent>
          </Card>
        </Grid>
        <Grid size={{ xs: 12, lg: 4 }}>
          <Card sx={{ height: "100%" }}>
            <CardContent sx={{ p: 2, "&:last-child": { pb: 1.5 } }}>
              <Typography component="h2" variant="h2">
                {t("Token 构成")}
              </Typography>
              <Box
                sx={{
                  height: 280,
                  mt: 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Skeleton
                  animation="wave"
                  variant="circular"
                  width={190}
                  height={190}
                />
              </Box>
            </CardContent>
          </Card>
        </Grid>
      </Grid>
      <Card>
        <CardContent sx={{ p: 2, "&:last-child": { pb: 1.5 } }}>
          <Typography component="h2" variant="h2">
            {t("模型与渠道用量")}
          </Typography>
          <TableSkeleton
            ariaLabel={t("模型与渠道用量")}
            rows={6}
            minWidth={560}
            containerSx={{ maxHeight: 320, mt: 1 }}
            columns={[
              { label: t("模型") },
              { label: t("请求"), align: "right", skeletonWidth: 36 },
              { label: t("Token 用量"), align: "right", skeletonWidth: 64 },
              { label: t("花费"), align: "right", skeletonWidth: 52 },
            ]}
          />
        </CardContent>
      </Card>
    </Box>
  );
}
