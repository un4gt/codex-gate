import { useEffect, useState } from "react";
import {
  Alert,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { ChevronDown } from "lucide-react";
import {
  loadModelRoutePolicies,
  saveModelRoutePolicy,
  resetModelRoutePolicy,
} from "@/lib/api";
import type {
  ConnectionSettings,
  ModelRoutePolicy,
  ProviderWorkspace,
} from "@/lib/types";
import { useI18n } from "@/lib/i18n";

export default function ModelRoutesEditor({
  settings,
  providers,
}: {
  settings: ConnectionSettings;
  providers: ProviderWorkspace[];
}) {
  const { t } = useI18n();
  const [policies, setPolicies] = useState<ModelRoutePolicy[]>([]);
  const [error, setError] = useState("");
  const [model, setModel] = useState("");
  useEffect(() => {
    let active = true;
    void loadModelRoutePolicies(settings)
      .then((v) => {
        if (active) setPolicies(v);
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, [settings]);
  return (
    <Stack spacing={1}>
      <Typography variant="subtitle2">{t("模型路由")}</Typography>
      <Typography variant="body2" color="text.secondary">
        {t(
          "未单独配置的模型使用默认路由。访问授权、模型库存和协议能力仍会筛选目标。",
        )}
      </Typography>
      {error ? <Alert severity="error">{error}</Alert> : null}
      {policies.map((p) => (
        <Policy
          key={p.model_name}
          onReset={() =>
            setPolicies((items) =>
              items.filter((item) => item.model_name !== p.model_name),
            )
          }
          initial={p}
          settings={settings}
          providers={providers}
        />
      ))}
      <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
        <TextField
          size="small"
          label={t("真实模型名 / 别名")}
          value={model}
          onChange={(e) => setModel(e.target.value)}
        />
        <Button
          disabled={
            !model.trim() || policies.some((p) => p.model_name === model.trim())
          }
          onClick={() => {
            setPolicies((p) => [
              ...p,
              {
                model_name: model.trim(),
                mode: "ordered",
                sticky: true,
                failover: true,
                targets: [],
              },
            ]);
            setModel("");
          }}
        >
          {t("添加模型路由")}
        </Button>
      </Box>
    </Stack>
  );
}
function Policy({
  onReset,
  initial,
  settings,
  providers,
}: {
  onReset: () => void;
  initial: ModelRoutePolicy;
  settings: ConnectionSettings;
  providers: ProviderWorkspace[];
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  return (
    <Accordion defaultExpanded={initial.model_name === "*"}>
      <AccordionSummary expandIcon={<ChevronDown size={16} />}>
        {initial.model_name === "*" ? t("默认路由") : initial.model_name}
      </AccordionSummary>
      <AccordionDetails>
        <Stack
          component="form"
          spacing={1.5}
          onChange={() => setSaved(false)}
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            void saveModelRoutePolicy(settings, draft)
              .then(() => setSaved(true))
              .catch((e) => setError(String(e)))
              .finally(() => setBusy(false));
          }}
        >
          {error ? <Alert severity="error">{error}</Alert> : null}
          {saved ? <Alert severity="success">{t("路由已保存")}</Alert> : null}
          <TextField
            size="small"
            select
            label={t("选择方式")}
            value={draft.mode}
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                mode: e.target.value as ModelRoutePolicy["mode"],
              }))
            }
          >
            <MenuItem value="ordered">{t("按顺序")}</MenuItem>
            <MenuItem value="weighted">{t("同优先级内加权")}</MenuItem>
          </TextField>
          {providers.map(({ provider: p }) => {
            const target = draft.targets.find((v) => v.provider_id === p.id);
            const change = (field: "priority" | "weight", value: number) =>
              setDraft((d) => ({
                ...d,
                targets: d.targets.map((v) =>
                  v.provider_id === p.id ? { ...v, [field]: value } : v,
                ),
              }));
            return (
              <Box
                key={p.id}
                sx={{
                  display: "flex",
                  gap: 1,
                  alignItems: "center",
                  flexWrap: "wrap",
                }}
              >
                <FormControlLabel
                  sx={{ flex: "1 1 180px", minWidth: 0 }}
                  label={p.name}
                  control={
                    <Checkbox
                      checked={!!target}
                      onChange={(_, v) =>
                        setDraft((d) => ({
                          ...d,
                          targets: v
                            ? [
                                ...d.targets,
                                { provider_id: p.id, priority: 100, weight: 1 },
                              ]
                            : d.targets.filter((v) => v.provider_id !== p.id),
                        }))
                      }
                    />
                  }
                />
                {target ? (
                  <>
                    <TextField
                      size="small"
                      sx={{ width: 120 }}
                      label={t("优先级")}
                      type="number"
                      value={target.priority}
                      slotProps={{
                        htmlInput: { min: 0, max: 2147483647, step: 1 },
                      }}
                      onChange={(e) =>
                        change("priority", Number(e.target.value))
                      }
                    />
                    {draft.mode === "weighted" ? (
                      <TextField
                        size="small"
                        sx={{ width: 120 }}
                        label={t("权重")}
                        type="number"
                        value={target.weight}
                        slotProps={{
                          htmlInput: { min: 1, max: 2147483647, step: 1 },
                        }}
                        onChange={(e) =>
                          change("weight", Number(e.target.value))
                        }
                      />
                    ) : null}
                  </>
                ) : null}
              </Box>
            );
          })}
          <Accordion>
            <AccordionSummary expandIcon={<ChevronDown size={16} />}>
              {t("高级选项")}
            </AccordionSummary>
            <AccordionDetails>
              <FormControlLabel
                label={t("保持会话（Sticky）")}
                control={
                  <Checkbox
                    checked={draft.sticky}
                    onChange={(_, v) => setDraft((d) => ({ ...d, sticky: v }))}
                  />
                }
              />
              <FormControlLabel
                label={t("允许跨上游故障切换")}
                control={
                  <Checkbox
                    checked={draft.failover}
                    onChange={(_, v) =>
                      setDraft((d) => ({ ...d, failover: v }))
                    }
                  />
                }
              />
            </AccordionDetails>
          </Accordion>
          {initial.model_name !== "*" ? (
            <Button
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError("");
                void resetModelRoutePolicy(settings, initial.model_name)
                  .then(onReset)
                  .catch((e) => setError(String(e)))
                  .finally(() => setBusy(false));
              }}
            >
              {t("恢复默认路由")}
            </Button>
          ) : null}
          <Button type="submit" disabled={busy}>
            {t("保存路由")}
          </Button>
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}
