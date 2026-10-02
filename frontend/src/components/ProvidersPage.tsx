import CloseOutlined from "@mui/icons-material/CloseOutlined";
import Accordion from "@mui/material/Accordion";
import AccordionDetails from "@mui/material/AccordionDetails";
import AccordionSummary from "@mui/material/AccordionSummary";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Drawer from "@mui/material/Drawer";
import FormControlLabel from "@mui/material/FormControlLabel";
import IconButton from "@mui/material/IconButton";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Tab from "@mui/material/Tab";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Tabs from "@mui/material/Tabs";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import {
lazy,
Suspense,
useContext,
useEffect,
useRef,
useState,
type FormEvent,
} from "react";
import {
Link,
UNSAFE_DataRouterContext,
useBlocker,
useSearchParams,
} from "react-router";

import Plus from "@mui/icons-material/AddOutlined";
import ArrowDown from "@mui/icons-material/ArrowDownwardOutlined";
import ArrowUp from "@mui/icons-material/ArrowUpwardOutlined";
import ChevronDown from "@mui/icons-material/ExpandMoreOutlined";
import MoreHorizontal from "@mui/icons-material/MoreHorizOutlined";
import RefreshCw from "@mui/icons-material/RefreshOutlined";

import * as api from "@/lib/api";
import { formatDateTime,formatMs } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import {
createRequestOverridesDraft,
parseRequestOverridesDraft,
} from "@/lib/requestOverridesDraft";
import type {
ConnectionSettings,
ProviderWorkspace,
SystemConfigResponse,
UpstreamRuntimeState,
} from "@/lib/types";
import { CodexOAuthPanel } from "./CodexOAuthPanel";
import { UpstreamKeyModels } from "./UpstreamKeyModels";

const RulesEditor = lazy(() =>
  import("./console/RequestOverridesEditor").then((m) => ({
    default: m.RequestOverridesEditor,
  })),
);
const providerTypes = [
  ["openai", "OpenAI"],
  ["openai_compatible", "OpenAI Compatible"],
  ["openai_compatible_responses", "OpenAI Compatible (Responses)"],
  ["openai_codex_oauth", "OpenAI Codex OAuth"],
];
const row = {
  display: "flex",
  alignItems: "center",
  gap: 1,
  minWidth: 0,
  flexWrap: "wrap",
} as const;
const grid = {
  display: "grid",
  gap: 1.5,
  gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" },
};
interface Props {
  settings: ConnectionSettings;
  items: ProviderWorkspace[];
  loading?: boolean;
  onRefresh: (message?: string) => Promise<void>;
  onMessage: (message: string) => void;
}

export function ProvidersPage(props: Props) {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const id = Number(params.get("provider_id")) || null;
  const tab = ["connection", "advanced", "runtime"].includes(
    params.get("tab") ?? "",
  )
    ? params.get("tab")!
    : "connection";
  const [create, setCreate] = useState(false);
  const open = (id: number | null) =>
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (id === null) {
        next.delete("provider_id");
        next.delete("tab");
      } else {
        next.set("provider_id", String(id));
        next.delete("tab");
      }
      return next;
    });
  return (
    <Stack spacing={2}>
      <Stack
        component="header"
        direction="row"
        sx={{ justifyContent: "flex-end", flexWrap: "wrap", gap: 1.5 }}
      >
        {
          <>
            <Button
              variant="text"
              onClick={() => void props.onRefresh()}
              disabled={props.loading}
            >
              <RefreshCw fontSize="small" />
              {t("刷新")}
            </Button>
            <Button variant="contained" onClick={() => setCreate(true)}>
              <Plus fontSize="small" />
              {t("新增上游")}
            </Button>
          </>
        }
      </Stack>
      {props.loading && !props.items.length ? (
        <CircularProgress size={24} />
      ) : null}
      {!props.loading && !props.items.length ? (
        <Box sx={{ py: 6, px: 2, textAlign: "center" }}>
          <Typography variant="subtitle1">{t("暂无上游")}</Typography>
          <Typography color="text.secondary" sx={{ mt: 1 }}>
            {t("添加服务地址和凭据以连接模型服务。")}
          </Typography>
        </Box>
      ) : null}
      <TableContainer component={Paper} variant="outlined">
        <Table aria-label={t("上游列表")} sx={{ minWidth: 720 }}>
          <TableHead>
            <TableRow>
              {[
                "名称",
                "协议",
                "地址数",
                "凭据数",
                "模型数",
                "状态",
                "管理",
              ].map((label) => (
                <TableCell key={label}>{t(label)}</TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {props.items.map(({ provider: p }) => (
              <TableRow key={p.id} hover>
                <TableCell
                  sx={{
                    fontWeight: 600,
                    maxWidth: 320,
                    overflowWrap: "anywhere",
                  }}
                >
                  {p.name}
                </TableCell>
                <TableCell>{p.provider_type}</TableCell>
                <TableCell align="right">{p.endpoint_count ?? 0}</TableCell>
                <TableCell align="right">{p.key_count ?? 0}</TableCell>
                <TableCell align="right">{p.model_count ?? 0}</TableCell>
                <TableCell>
                  <Chip
                    color={
                      !p.enabled
                        ? "default"
                        : p.routing_availability?.available
                          ? "success"
                          : "warning"
                    }
                    label={t(
                      !p.enabled
                        ? "停用"
                        : p.routing_availability?.available
                          ? "可用"
                          : "暂不可用",
                    )}
                  />
                </TableCell>
                <TableCell>
                  <Button variant="text" onClick={() => open(p.id)}>
                    {t("管理")}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      {create ? (
        <CreateUpstream
          {...props}
          onClose={() => setCreate(false)}
          onCreated={(id) => {
            setCreate(false);
            open(id);
          }}
        />
      ) : null}
      {id ? (
        <UpstreamDetail
          key={`${props.settings.apiBase}:${id}`}
          {...props}
          id={id}
          tab={tab}
          setTab={(tab) =>
            setParams((current) => {
              const next = new URLSearchParams(current);
              next.set("tab", tab);
              return next;
            })
          }
          onClose={() => open(null)}
        />
      ) : null}
    </Stack>
  );
}

function CreateUpstream(
  props: Props & { onClose: () => void; onCreated: (id: number) => void },
) {
  const { t } = useI18n();
  const [type, setType] = useState("openai_compatible");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [urls, setUrls] = useState("");
  const [secrets, setSecrets] = useState("");
  const sync = async (id: number) => {
    await api.syncProviderModels(props.settings, id);
    await props.onRefresh();
    props.onCreated(id);
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (created) {
        await sync(created);
        return;
      }
      const baseUrls = urls
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      const keys = secrets
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      const oauth = type === "openai_codex_oauth";
      if (!baseUrls.length || (!oauth && !keys.length))
        throw new Error(t("请填写服务地址和凭据。"));
      const result = await api.createProvider(props.settings, {
        name: name.trim(),
        provider_type: type,
        endpoints: baseUrls.map((base_url, i) => ({
          name: i ? "备用地址" : "主地址",
          base_url,
          enabled: true,
          priority: i * 10,
          weight: 1,
        })),
        keys: oauth
          ? []
          : keys.map((secret, i) => ({
              name: `Key ${i + 1}`,
              secret,
              enabled: true,
              priority: i * 10,
              weight: 1,
            })),
      });
      setCreated(result.id);
      setSecrets("");
      await props.onRefresh();
      if (oauth) props.onCreated(result.id);
      else await sync(result.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Drawer
      anchor="right"
      open={true}
      onClose={() => {
        if (!busy) props.onClose();
      }}
      slotProps={{
        paper: {
          role: "dialog",
          "aria-modal": true,
          "aria-label": t("新增上游"),
          sx: { width: { xs: "100%", sm: 720 }, maxWidth: "100%" },
        },
      }}
    >
      <Box
        sx={{
          display: "flex",
          alignItems: "flex-start",
          gap: 2,
          p: 3,
          borderBottom: 1,
          borderColor: "divider",
        }}
      >
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography
            component="h2"
            variant="h2"
            sx={{ overflowWrap: "anywhere" }}
          >
            {t("新增上游")}
          </Typography>
          <Typography color="text.secondary" sx={{ mt: 1 }}>
            {"填写连接信息，创建后同步模型。"}
          </Typography>
        </Box>
        <IconButton
          aria-label={t("关闭")}
          onClick={() => {
            if (!busy) props.onClose();
          }}
        >
          <CloseOutlined />
        </IconButton>
      </Box>
      <Box
        sx={{ flex: 1, minHeight: 0, overflowY: "auto", p: { xs: 2, sm: 3 } }}
      >
        <Stack component="form" spacing={2} onSubmit={submit}>
          {error ? (
            <Alert severity="error">
              {created
                ? t("上游已创建，同步失败，可重试或稍后处理。") + " "
                : ""}
              {error}
            </Alert>
          ) : null}
          <TextField
            label={t("名称")}
            required
            value={name}
            disabled={busy || !!created}
            onChange={(e) => setName(e.target.value)}
          />
          <TextField
            select
            label={t("类型")}
            value={type}
            disabled={busy || !!created}
            onChange={(e) => {
              setType(e.target.value);
              if (e.target.value === "openai_codex_oauth")
                setUrls("https://chatgpt.com/backend-api/codex");
            }}
          >
            {providerTypes.map(([v, l]) => (
              <MenuItem key={v} value={v}>
                {l}
              </MenuItem>
            ))}
          </TextField>
          <Typography variant="body2" color="text.secondary">
            {t(
              type === "openai_codex_oauth"
                ? "创建后登录 ChatGPT Codex 账号，仅支持 Responses 协议。"
                : type === "openai_compatible_responses"
                  ? "仅支持 Responses 协议。"
                  : "支持 OpenAI 兼容协议。",
            )}
          </Typography>
          <TextField
            label={t("服务地址（每行一个）")}
            multiline
            minRows={2}
            required
            value={urls}
            disabled={busy || !!created}
            onChange={(e) => setUrls(e.target.value)}
          />
          {type !== "openai_codex_oauth" ? (
            <TextField
              label={t("API Key（每行一个）")}
              multiline
              minRows={2}
              required={!created}
              value={secrets}
              disabled={busy || !!created}
              autoComplete="off"
              onChange={(e) => setSecrets(e.target.value)}
            />
          ) : null}
          <Button
            loading={Boolean(busy)}
            type="submit"
            variant="contained"
            disabled={busy}
          >
            {t(busy ? "处理中…" : created ? "重试同步" : "创建上游")}
          </Button>
          {created ? (
            <Button
              variant="text"
              onClick={() => props.onCreated(created)}
              disabled={busy}
            >
              {t("稍后同步，打开详情")}
            </Button>
          ) : null}
        </Stack>
      </Box>
    </Drawer>
  );
}

function UpstreamDetail(
  props: Props & {
    id: number;
    tab: string;
    setTab: (tab: string) => void;
    onClose: () => void;
  },
) {
  const { t } = useI18n();
  const [config, setConfig] = useState<ProviderWorkspace | null>(null);
  const [system, setSystem] = useState<SystemConfigResponse | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const [discard, setDiscard] = useState(false);
  const [remove, setRemove] = useState(false);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const active = useRef(true);
  const hasDirty = Object.values(dirty).some(Boolean);
  const dataRouter = useContext(UNSAFE_DataRouterContext);
  const mark = (section: string, value: boolean) =>
    setDirty((d) => ({ ...d, [section]: value }));
  const refresh = async () => {
    const data = await api.loadUpstreamConfig(props.settings, props.id);
    if (active.current) setConfig(data);
  };
  useEffect(() => {
    active.current = true;
    void Promise.all([
      api.loadUpstreamConfig(props.settings, props.id),
      api.loadSystemConfig(props.settings),
    ])
      .then(([c, s]) => {
        if (active.current) {
          setConfig(c);
          setSystem(s);
        }
      })
      .catch((e) => {
        if (active.current) setError(String(e));
      });
    return () => {
      active.current = false;
    };
  }, [props.id, props.settings]);
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (hasDirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [hasDirty]);
  const run = async (operation: () => Promise<unknown>, section?: string) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await operation();
      if (section) mark(section, false);
      if (active.current) {
        await refresh();
        await props.onRefresh();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      setBusy(false);
    }
  };
  const action = (operation: () => Promise<unknown>, section?: string) =>
    void run(operation, section).catch(() => {});
  return (
    <Drawer
      anchor="right"
      open={true}
      onClose={() => {
        if (!busy) {
          if (hasDirty && !dataRouter) setDiscard(true);
          else props.onClose();
        }
      }}
      slotProps={{
        paper: {
          role: "dialog",
          "aria-modal": true,
          "aria-label": t(config?.provider.name ?? "上游详情"),
          sx: { width: { xs: "100%", sm: 720 }, maxWidth: "100%" },
        },
      }}
    >
      <Box
        sx={{
          display: "flex",
          alignItems: "flex-start",
          gap: 2,
          p: 3,
          borderBottom: 1,
          borderColor: "divider",
        }}
      >
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography
            component="h2"
            variant="h2"
            sx={{ overflowWrap: "anywhere" }}
          >
            {t(config?.provider.name ?? "上游详情")}
          </Typography>
        </Box>
        <IconButton
          aria-label={t("关闭")}
          onClick={() => {
            if (!busy) {
              if (hasDirty && !dataRouter) setDiscard(true);
              else props.onClose();
            }
          }}
        >
          <CloseOutlined />
        </IconButton>
      </Box>
      {
        <Box sx={{ ...row, px: 2, borderBottom: 1, borderColor: "divider" }}>
          <Tabs
            value={props.tab}
            onChange={(_, v) => props.setTab(v)}
            variant="scrollable"
            scrollButtons="auto"
            sx={{ flex: 1 }}
          >
            {[
              ["connection", "连接"],
              ["advanced", "高级设置"],
              ["runtime", "状态 / 调试"],
            ].map(([v, l]) => (
              <Tab
                key={v}
                value={v}
                id={`upstream-tab-${v}`}
                aria-controls={`upstream-panel-${v}`}
                label={t(l)}
              />
            ))}
          </Tabs>
          <IconButton
            aria-label={t("更多操作")}
            onClick={(e) => setMenu(e.currentTarget)}
          >
            <MoreHorizontal />
          </IconButton>
          <Menu anchorEl={menu} open={!!menu} onClose={() => setMenu(null)}>
            <MenuItem
              onClick={() => {
                setMenu(null);
                setRemove(true);
              }}
            >
              {t("删除整个上游")}
            </MenuItem>
          </Menu>
        </Box>
      }
      <Box
        sx={{ flex: 1, minHeight: 0, overflowY: "auto", p: { xs: 2, sm: 3 } }}
      >
        {dataRouter ? (
          <UnsavedNavigationGuard dirty={hasDirty} busy={busy} id={props.id} />
        ) : null}
        {error ? (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        ) : null}
        {!config ? (
          <CircularProgress size={24} />
        ) : (
          <>
            <Box
              role="tabpanel"
              id="upstream-panel-connection"
              aria-labelledby="upstream-tab-connection"
              hidden={props.tab !== "connection"}
            >
              <ConnectionEditor
                config={config}
                settings={props.settings}
                busy={busy}
                run={run}
                action={action}
                mark={mark}
                onMessage={props.onMessage}
              />
            </Box>
            <Box
              role="tabpanel"
              id="upstream-panel-advanced"
              aria-labelledby="upstream-tab-advanced"
              hidden={props.tab !== "advanced"}
            >
              <AdvancedEditor
                config={config}
                system={system}
                settings={props.settings}
                busy={busy}
                run={run}
                mark={mark}
              />
            </Box>
            {props.tab === "runtime" ? (
              <Box
                role="tabpanel"
                id="upstream-panel-runtime"
                aria-labelledby="upstream-tab-runtime"
              >
                <RuntimePanel settings={props.settings} id={props.id} />
              </Box>
            ) : null}
          </>
        )}
        <Dialog
          open={discard}
          onClose={busy ? undefined : () => setDiscard(false)}
          aria-label={t("放弃未保存的修改？")}
        >
          <DialogTitle>{t("放弃未保存的修改？")}</DialogTitle>
          <DialogContent></DialogContent>
          <DialogActions>
            <Button
              autoFocus
              variant="outlined"
              disabled={busy}
              onClick={() => setDiscard(false)}
            >
              {t("取消")}
            </Button>
            <Button color="error" loading={busy} onClick={props.onClose}>
              {t("放弃修改")}
            </Button>
          </DialogActions>
        </Dialog>
        <Dialog
          open={remove}
          onClose={busy ? undefined : () => setRemove(false)}
          aria-label={t("确认删除整个上游？历史数据会保留。")}
        >
          <DialogTitle>{t("确认删除整个上游？历史数据会保留。")}</DialogTitle>
          <DialogContent>
            {error ? <Alert severity="error">{error}</Alert> : null}
          </DialogContent>
          <DialogActions>
            <Button
              autoFocus
              variant="outlined"
              disabled={busy}
              onClick={() => setRemove(false)}
            >
              {t("取消")}
            </Button>
            <Button
              color="error"
              loading={busy}
              onClick={() =>
                action(async () => {
                  await api.deleteProvider(props.settings, props.id);
                  await props.onRefresh();
                  props.onClose();
                })
              }
            >
              {t("确认删除")}
            </Button>
          </DialogActions>
        </Dialog>
      </Box>
    </Drawer>
  );
}
type Run = (
  operation: () => Promise<unknown>,
  section?: string,
) => Promise<void>;
type Action = (operation: () => Promise<unknown>, section?: string) => void;
type EditorProps = {
  config: ProviderWorkspace;
  settings: ConnectionSettings;
  busy: boolean;
  run: Run;
  mark: (section: string, value: boolean) => void;
};

function ConnectionEditor({
  config,
  settings,
  busy,
  run,
  mark,
  action,
  onMessage,
}: EditorProps & { action: Action; onMessage: (message: string) => void }) {
  const { t } = useI18n();
  const p = config.provider;
  const [name, setName] = useState(p.name);
  const [type, setType] = useState(p.provider_type);
  const [enabled, setEnabled] = useState(p.enabled);
  const [edit, setEdit] = useState<string | null>(null);
  const [childDirty, setChildDirty] = useState(false);
  const [pending, setPending] = useState<string | null | undefined>(undefined);
  const [test, setTest] = useState<Record<number, string>>({});
  const [removal, setRemoval] = useState<{
    label: string;
    run: () => Promise<unknown>;
  } | null>(null);
  const choose = (next: string | null) => {
    if (childDirty) setPending(next);
    else setEdit(next);
  };
  const childChanged = (value: boolean) => {
    setChildDirty(value);
    mark("child", value);
  };
  const reorder = (
    kind: "keys" | "endpoints",
    index: number,
    offset: number,
  ) => {
    const ids = config[kind].map((v) => v.id);
    [ids[index], ids[index + offset]] = [ids[index + offset], ids[index]];
    action(() => api.reorderProviderChildren(settings, p.id, kind, ids));
  };
  const orderButtons = (kind: "keys" | "endpoints", index: number) => (
    <>
      <IconButton
        size="small"
        aria-label={t("上移")}
        disabled={busy || index === 0}
        onClick={() => reorder(kind, index, -1)}
      >
        <ArrowUp fontSize="small" />
      </IconButton>
      <IconButton
        size="small"
        aria-label={t("下移")}
        disabled={busy || index === config[kind].length - 1}
        onClick={() => reorder(kind, index, 1)}
      >
        <ArrowDown fontSize="small" />
      </IconButton>
    </>
  );
  return (
    <Stack spacing={2}>
      <Box
        component="form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(
            () =>
              api.updateProvider(settings, p.id, {
                name,
                provider_type: type,
                enabled,
              }),
            "basic",
          ).catch(() => {});
        }}
        onChange={() => mark("basic", true)}
        sx={grid}
      >
        <TextField
          size="small"
          label={t("名称")}
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <TextField
          select
          size="small"
          label={t("类型")}
          value={type}
          onChange={(e) => setType(e.target.value)}
        >
          {providerTypes.map(([v, l]) => (
            <MenuItem key={v} value={v}>
              {l}
            </MenuItem>
          ))}
        </TextField>
        <FormControlLabel
          control={
            <Checkbox checked={enabled} onChange={(_, v) => setEnabled(v)} />
          }
          label={t("启用上游")}
        />
        <Box sx={{ ...row, justifyContent: "flex-end" }}>
          <Button
            variant="text"
            onClick={() => {
              setName(p.name);
              setType(p.provider_type);
              setEnabled(p.enabled);
              mark("basic", false);
            }}
          >
            {t("取消")}
          </Button>
          <Button
            loading={Boolean(busy)}
            variant="text"
            type="submit"
            disabled={busy}
          >
            {t("保存基础信息")}
          </Button>
        </Box>
      </Box>
      <Box component="section">
        <Box sx={{ ...row, justifyContent: "space-between", mb: 0.5 }}>
          <Typography component="h3" variant="subtitle2">
            {t("服务地址")}
          </Typography>
          {
            <Button
              variant="text"
              size="small"
              onClick={() => choose("endpoint:new")}
            >
              {t("添加地址")}
            </Button>
          }
        </Box>
        {
          <>
            {config.endpoints.map((e, index) => (
              <Box key={e.id}>
                <Box
                  sx={{
                    ...row,
                    minHeight: 44,
                    borderBottom: 1,
                    borderColor: "divider",
                  }}
                  draggable={!edit}
                  onDragStart={(event) =>
                    event.dataTransfer.setData("text/plain", String(e.id))
                  }
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    const from = config.endpoints.findIndex(
                      (e) =>
                        e.id ===
                        Number(event.dataTransfer.getData("text/plain")),
                    );
                    if (from >= 0 && from !== index) {
                      const ids = config.endpoints.map((e) => e.id);
                      ids.splice(index, 0, ids.splice(from, 1)[0]);
                      action(() =>
                        api.reorderProviderChildren(
                          settings,
                          p.id,
                          "endpoints",
                          ids,
                        ),
                      );
                    }
                  }}
                >
                  <Typography variant="body2">
                    {t(index ? "备用地址" : "主地址")}
                  </Typography>
                  <Typography
                    variant="body2"
                    sx={{ flex: "1 1 180px", overflowWrap: "anywhere" }}
                  >
                    {e.base_url}
                  </Typography>
                  <Typography variant="caption">
                    {t(
                      !e.enabled
                        ? "停用"
                        : e.health?.available === false
                          ? "冷却中"
                          : "可用",
                    )}
                  </Typography>
                  {orderButtons("endpoints", index)}
                  <Button
                    variant="text"
                    size="small"
                    disabled={busy}
                    onClick={() =>
                      action(async () => {
                        const result = await api.testEndpointConnection(
                          settings,
                          e.id,
                        );
                        setTest((current) => ({
                          ...current,
                          [e.id]: result.ok
                            ? t("地址可达（未验证 Key）")
                            : (result.message ?? t("地址不可达")),
                        }));
                      })
                    }
                  >
                    {t("测试")}
                  </Button>
                  <Button
                    variant="text"
                    size="small"
                    onClick={() => choose(`endpoint:${e.id}`)}
                  >
                    {t("编辑")}
                  </Button>
                </Box>
                {test[e.id] ? (
                  <Typography variant="caption">{test[e.id]}</Typography>
                ) : null}
              </Box>
            ))}
          </>
        }
      </Box>
      {edit?.startsWith("endpoint:") ? (
        <ChildEditor
          key={edit}
          kind="endpoint"
          config={config}
          itemId={Number(edit.split(":")[1]) || null}
          settings={settings}
          busy={busy}
          run={run}
          onDirty={childChanged}
          onClose={() => choose(null)}
          onSaved={() => {
            childChanged(false);
            setEdit(null);
          }}
          onDelete={(label, operation) => setRemoval({ label, run: operation })}
        />
      ) : null}
      {p.provider_type === "openai_codex_oauth" ? (
        <CodexOAuthPanel
          settings={settings}
          item={config}
          onRefresh={async () => {
            await run(async () => {});
          }}
          onMessage={onMessage}
        />
      ) : (
        <>
          <Box component="section">
            <Box sx={{ ...row, justifyContent: "space-between", mb: 0.5 }}>
              <Typography component="h3" variant="subtitle2">
                {t("API Key")}
              </Typography>
              {
                <Button
                  variant="text"
                  size="small"
                  onClick={() => choose("key:new")}
                >
                  {t("添加 Key")}
                </Button>
              }
            </Box>
            {
              <>
                <TextField
                  size="small"
                  select
                  label={t("Key 使用方式")}
                  value={p.key_selection_strategy}
                  disabled={busy}
                  sx={{ width: { xs: "100%", sm: 240 }, my: 1 }}
                  onChange={(e) =>
                    action(() =>
                      api.updateProvider(settings, p.id, {
                        key_selection_strategy: e.target.value as
                          "ordered" | "round_robin",
                      }),
                    )
                  }
                >
                  <MenuItem value="round_robin">{t("轮流使用")}</MenuItem>
                  <MenuItem value="ordered">{t("主备顺序")}</MenuItem>
                  {p.key_selection_strategy === "weighted" ? (
                    <MenuItem value="weighted" disabled>
                      {t("加权分配（兼容旧配置）")}
                    </MenuItem>
                  ) : null}
                </TextField>
                {config.keys.map((k, index) => (
                  <Box
                    key={k.id}
                    sx={{
                      ...row,
                      minHeight: 44,
                      borderBottom: 1,
                      borderColor: "divider",
                    }}
                  >
                    <Typography
                      variant="body2"
                      sx={{ flex: 1, overflowWrap: "anywhere" }}
                    >
                      {k.name}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {t("已配置")}
                    </Typography>
                    <Typography variant="caption">
                      {t(
                        !k.enabled
                          ? "停用"
                          : k.routing_availability?.available === false
                            ? "冷却 / 不可用"
                            : "可用",
                      )}
                    </Typography>
                    {p.key_selection_strategy === "ordered"
                      ? orderButtons("keys", index)
                      : null}
                    <Button
                      variant="text"
                      size="small"
                      onClick={() => choose(`key:${k.id}`)}
                    >
                      {t("编辑")}
                    </Button>
                  </Box>
                ))}
              </>
            }
          </Box>
          {edit?.startsWith("key:") ? (
            <ChildEditor
              key={edit}
              kind="key"
              config={config}
              itemId={Number(edit.split(":")[1]) || null}
              settings={settings}
              busy={busy}
              run={run}
              onDirty={childChanged}
              onClose={() => choose(null)}
              onSaved={() => {
                childChanged(false);
                setEdit(null);
              }}
              onDelete={(label, operation) =>
                setRemoval({ label, run: operation })
              }
            />
          ) : null}
        </>
      )}
      <Box component="section">
        <Box sx={{ ...row, justifyContent: "space-between", mb: 0.5 }}>
          <Typography component="h3" variant="subtitle2">
            {t("模型")}
          </Typography>
          {
            <Box sx={row}>
              <Button
                variant="text"
                disabled={busy}
                onClick={() =>
                  action(() => api.syncProviderModels(settings, p.id))
                }
              >
                {t("同步模型")}
              </Button>
              <Button
                variant="text"
                component={Link}
                to={`/models?provider_id=${p.id}`}
              >
                {t("管理模型 →")}
              </Button>
            </Box>
          }
        </Box>
        {
          <>
            <Typography variant="body2" color="text.secondary">
              {t("已发现")} {p.model_count ?? 0} {t("个模型")} ·{" "}
              {t("最近成功同步")}：
              {p.model_sync?.last_success_ms
                ? formatDateTime(p.model_sync.last_success_ms)
                : t("尚未同步")}
            </Typography>
            {p.model_sync?.error ? (
              <Alert severity="warning">
                {t("最近同步失败，保留上次成功库存。")}
              </Alert>
            ) : null}
          </>
        }
      </Box>
      <Dialog
        open={pending !== undefined}
        onClose={busy ? undefined : () => setPending(undefined)}
        aria-label={t("放弃当前编辑的修改？")}
      >
        <DialogTitle>{t("放弃当前编辑的修改？")}</DialogTitle>
        <DialogContent></DialogContent>
        <DialogActions>
          <Button
            autoFocus
            variant="outlined"
            disabled={busy}
            onClick={() => setPending(undefined)}
          >
            {t("取消")}
          </Button>
          <Button
            color="error"
            loading={busy}
            onClick={() => {
              childChanged(false);
              setEdit(pending ?? null);
              setPending(undefined);
            }}
          >
            {t("放弃修改")}
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog
        open={!!removal}
        onClose={busy ? undefined : () => setRemoval(null)}
        aria-label={t("确认删除 {{name}}？", { name: removal?.label ?? "" })}
      >
        <DialogTitle>
          {t("确认删除 {{name}}？", { name: removal?.label ?? "" })}
        </DialogTitle>
        <DialogContent></DialogContent>
        <DialogActions>
          <Button
            autoFocus
            variant="outlined"
            disabled={busy}
            onClick={() => setRemoval(null)}
          >
            {t("取消")}
          </Button>
          <Button
            color="error"
            loading={busy}
            onClick={() => {
              if (removal)
                void run(removal.run, "child")
                  .then(() => {
                    setRemoval(null);
                    childChanged(false);
                    setEdit(null);
                  })
                  .catch(() => {});
            }}
          >
            {t("确认删除")}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

function ChildEditor(props: {
  kind: "endpoint" | "key";
  config: ProviderWorkspace;
  itemId: number | null;
  settings: ConnectionSettings;
  busy: boolean;
  run: Run;
  onDirty: (v: boolean) => void;
  onClose: () => void;
  onSaved: () => void;
  onDelete: (label: string, op: () => Promise<unknown>) => void;
}) {
  const { t } = useI18n();
  const endpoint = props.config.endpoints.find((e) => e.id === props.itemId);
  const key = props.config.keys.find((k) => k.id === props.itemId);
  const item = props.kind === "endpoint" ? endpoint : key;
  const [name, setName] = useState(item?.name ?? "");
  const [value, setValue] = useState(endpoint?.base_url ?? "");
  const [enabled, setEnabled] = useState(item?.enabled ?? true);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const common = { name, enabled };
    const order = {
      priority:
        props.config[props.kind === "endpoint" ? "endpoints" : "keys"].length *
        10,
      weight: 1,
    };
    void props
      .run(async () => {
        if (props.kind === "endpoint") {
          if (endpoint)
            await api.updateEndpoint(props.settings, endpoint.id, {
              ...common,
              base_url: value,
            });
          else
            await api.createEndpoint(props.settings, props.config.provider.id, {
              ...common,
              ...order,
              base_url: value,
            });
        } else {
          if (key)
            await api.updateProviderKey(props.settings, key.id, {
              ...common,
              ...(value ? { secret: value } : {}),
            });
          else
            await api.createProviderKey(
              props.settings,
              props.config.provider.id,
              { ...common, ...order, secret: value },
            );
        }
      }, "child")
      .then(props.onSaved)
      .catch(() => {});
  };
  return (
    <Box sx={{ p: 2, border: 1, borderColor: "divider", borderRadius: 1 }}>
      <Box
        component="form"
        onSubmit={submit}
        onChange={() => props.onDirty(true)}
        sx={grid}
      >
        <TextField
          size="small"
          label={t("名称")}
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <TextField
          size="small"
          label={t(
            props.kind === "endpoint"
              ? "服务地址"
              : item
                ? "替换 API Key（留空保留）"
                : "API Key",
          )}
          required={props.kind === "endpoint" || !item}
          type={props.kind === "endpoint" ? "url" : "password"}
          autoComplete="off"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <FormControlLabel
          label={t("启用")}
          control={
            <Checkbox checked={enabled} onChange={(_, v) => setEnabled(v)} />
          }
        />
        <Box sx={row}>
          <Button
            loading={props.busy}
            variant="text"
            type="submit"
            disabled={props.busy}
          >
            {t("保存")}
          </Button>
          <Button variant="text" onClick={props.onClose}>
            {t("取消")}
          </Button>
          {item ? (
            <Button
              variant="text"
              color="error"
              disabled={props.busy}
              onClick={() =>
                props.onDelete(item.name, () =>
                  props.kind === "endpoint"
                    ? api.deleteEndpoint(props.settings, item.id)
                    : api.deleteProviderKey(props.settings, item.id),
                )
              }
            >
              {t("删除")}
            </Button>
          ) : null}
        </Box>
      </Box>
      {key && props.kind === "key" ? (
        <Accordion
          sx={{ mt: 1 }}
          slotProps={{ transition: { unmountOnExit: true } }}
        >
          <AccordionSummary expandIcon={<ChevronDown fontSize="small" />}>
            {t("高级：模型允许列表")}
          </AccordionSummary>
          <AccordionDetails>
            <UpstreamKeyModels
              settings={props.settings}
              keyId={key.id}
              onChanged={async () => {}}
            />
          </AccordionDetails>
        </Accordion>
      ) : null}
    </Box>
  );
}

function AdvancedEditor({
  config,
  settings,
  system,
  busy,
  run,
  mark,
}: EditorProps & { system: SystemConfigResponse | null }) {
  const { t } = useI18n();
  const p = config.provider;
  const [retries, setRetries] = useState(
    p.max_retries ?? Math.min((p.max_attempts ?? 2) - 1, 2),
  );
  const [timeout, setTimeout] = useState(
    p.request_timeout_ms?.toString() ?? "",
  );
  const [concurrency, setConcurrency] = useState(
    p.max_concurrency?.toString() ?? "",
  );
  const [failover, setFailover] = useState(p.endpoint_failover ?? true);
  const [ws, setWs] = useState(p.websocket_enabled);
  const [bridge, setBridge] = useState(
    p.beta_features.includes("responses-http-to-ws"),
  );
  const [usage, setUsage] = useState(p.supports_include_usage);
  const [rules, setRules] = useState(() =>
    createRequestOverridesDraft(p.request_overrides),
  );
  const [showRules, setShowRules] = useState(false);
  const [ruleError, setRuleError] = useState("");
  const submit = (
    e: FormEvent,
    section: string,
    payload: Parameters<typeof api.updateProvider>[2],
  ) => {
    e.preventDefault();
    void run(() => api.updateProvider(settings, p.id, payload), section).catch(
      () => {},
    );
  };
  return (
    <Stack spacing={2}>
      <Accordion>
        <AccordionSummary expandIcon={<ChevronDown fontSize="small" />}>
          {t("请求策略")}
        </AccordionSummary>
        <AccordionDetails>
          <Box
            component="form"
            onChange={() => mark("request", true)}
            onSubmit={(e) =>
              submit(e, "request", {
                max_retries: retries,
                request_timeout_ms: timeout ? Number(timeout) : null,
                max_concurrency: concurrency ? Number(concurrency) : null,
                endpoint_failover: failover,
              })
            }
            sx={{ ...grid }}
          >
            <TextField
              size="small"
              label={t("最大重试次数")}
              type="number"
              value={retries}
              slotProps={{ htmlInput: { min: 0, max: 2, step: 1 } }}
              onChange={(e) => setRetries(Number(e.target.value))}
            />
            <TextField
              size="small"
              label={t("请求超时（毫秒）")}
              type="number"
              value={timeout}
              placeholder={String(
                system?.stability?.upstream_request_timeout_ms ?? "",
              )}
              helperText={t("留空继承全局配置")}
              slotProps={{ htmlInput: { min: 1, max: 3600000, step: 1 } }}
              onChange={(e) => setTimeout(e.target.value)}
            />
            <TextField
              size="small"
              label={t("最大并发")}
              type="number"
              value={concurrency}
              helperText={t("留空不限制")}
              slotProps={{ htmlInput: { min: 1, max: 100000, step: 1 } }}
              onChange={(e) => setConcurrency(e.target.value)}
            />
            <FormControlLabel
              label={t("地址故障自动切换")}
              control={
                <Checkbox
                  checked={failover}
                  onChange={(_, v) => setFailover(v)}
                />
              }
            />
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ gridColumn: "1 / -1" }}
            >
              {t(
                "总尝试数为重试次数加一。全请求最多发送 3 次，包含跨上游切换和 OAuth 认证重放。",
              )}
            </Typography>
            <Button
              variant="text"
              disabled={busy}
              onClick={() => {
                setRetries(
                  p.max_retries ?? Math.min((p.max_attempts ?? 2) - 1, 2),
                );
                setTimeout(p.request_timeout_ms?.toString() ?? "");
                setConcurrency(p.max_concurrency?.toString() ?? "");
                setFailover(p.endpoint_failover ?? true);
                mark("request", false);
              }}
            >
              {t("取消")}
            </Button>
            <Button
              loading={Boolean(busy)}
              variant="text"
              type="submit"
              disabled={busy}
            >
              {t("保存请求策略")}
            </Button>
          </Box>
        </AccordionDetails>
      </Accordion>
      <Accordion>
        <AccordionSummary expandIcon={<ChevronDown fontSize="small" />}>
          {t("协议兼容")}
        </AccordionSummary>
        <AccordionDetails>
          <Stack
            component="form"
            onChange={() => mark("protocol", true)}
            onSubmit={(e) =>
              submit(e, "protocol", {
                supports_include_usage: usage,
                websocket_enabled: ws,
                beta_features: bridge ? ["responses-http-to-ws"] : [],
              })
            }
            spacing={1}
          >
            <FormControlLabel
              label={t("补充 Usage 信息（Chat Completions 流式请求）")}
              control={
                <Checkbox checked={usage} onChange={(_, v) => setUsage(v)} />
              }
            />
            {system?.capabilities?.websocket ? (
              <FormControlLabel
                label={t("启用 WebSocket 传输")}
                control={
                  <Checkbox checked={ws} onChange={(_, v) => setWs(v)} />
                }
              />
            ) : null}
            {system?.capabilities?.websocket_to_http ? (
              <FormControlLabel
                label={t("允许 WebSocket 请求回退到 HTTP 上游")}
                control={
                  <Checkbox
                    checked={bridge}
                    onChange={(_, v) => setBridge(v)}
                  />
                }
              />
            ) : null}
            <Button
              variant="text"
              disabled={busy}
              onClick={() => {
                setUsage(p.supports_include_usage);
                setWs(p.websocket_enabled);
                setBridge(p.beta_features.includes("responses-http-to-ws"));
                mark("protocol", false);
              }}
            >
              {t("取消")}
            </Button>
            <Button
              loading={Boolean(busy)}
              variant="text"
              type="submit"
              disabled={busy}
            >
              {t("保存协议兼容")}
            </Button>
          </Stack>
        </AccordionDetails>
      </Accordion>
      {system?.capabilities?.request_rewrite ? (
        <Accordion>
          <AccordionSummary expandIcon={<ChevronDown fontSize="small" />}>
            {t("请求覆写")} ·{" "}
            {p.request_overrides.headers.length +
              p.request_overrides.body.length}{" "}
            {t("条规则")}
          </AccordionSummary>
          <AccordionDetails>
            {!showRules ? (
              <Button variant="text" onClick={() => setShowRules(true)}>
                {t("配置")}
              </Button>
            ) : (
              <Stack spacing={2}>
                <Suspense fallback={<CircularProgress size={24} />}>
                  <RulesEditor
                    value={rules}
                    disabled={busy}
                    onChange={(v) => {
                      setRules(v);
                      mark("rules", true);
                    }}
                  />
                </Suspense>
                {ruleError ? <Alert severity="error">{ruleError}</Alert> : null}
                <Button
                  variant="text"
                  disabled={busy}
                  onClick={() => {
                    setRules(createRequestOverridesDraft(p.request_overrides));
                    setRuleError("");
                    mark("rules", false);
                    setShowRules(false);
                  }}
                >
                  {t("取消")}
                </Button>
                <Button
                  variant="text"
                  disabled={busy}
                  onClick={() => {
                    const result = parseRequestOverridesDraft(rules);
                    if (!result.ok) {
                      setRuleError(result.error);
                      return;
                    }
                    setRuleError("");
                    void run(
                      () =>
                        api.updateProvider(settings, p.id, {
                          request_overrides: result.value,
                        }),
                      "rules",
                    ).catch(() => {});
                  }}
                >
                  {t("保存请求覆写")}
                </Button>
              </Stack>
            )}
          </AccordionDetails>
        </Accordion>
      ) : null}
    </Stack>
  );
}

function RuntimePanel({
  settings,
  id,
}: {
  settings: ConnectionSettings;
  id: number;
}) {
  const { t } = useI18n();
  const [data, setData] = useState<UpstreamRuntimeState | null>(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const value = await api.loadUpstreamRuntime(settings, id);
        if (!cancelled) {
          setData(value);
          setError("");
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) timer = setTimeout(() => void refresh(), 10000);
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [settings, id, version]);
  return (
    <Stack spacing={2}>
      <Box sx={row}>
        <Button variant="text" onClick={() => setVersion((v) => v + 1)}>
          {t("刷新状态")}
        </Button>
        <Button
          variant="text"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void api
              .resetProviderCircuit(settings, id)
              .then(() => setVersion((v) => v + 1))
              .catch((e) => setError(String(e)))
              .finally(() => setBusy(false));
          }}
        >
          {t("重置故障状态")}
        </Button>
        <Button variant="text" component={Link} to={`/logs?provider_id=${id}`}>
          {t("请求日志 →")}
        </Button>
      </Box>
      <Typography variant="caption" color="text.secondary">
        {t("每 10 秒刷新。重置连接故障时保留上游要求的限流等待。")}
      </Typography>
      {error ? <Alert severity="error">{error}</Alert> : null}
      {!data && !error ? <CircularProgress size={24} /> : null}
      {data ? (
        <>
          <Typography>
            {t("并发")} {data.provider.runtime?.in_flight ?? 0} /{" "}
            {data.provider.runtime?.max_concurrency ?? "∞"} · EWMA{" "}
            {formatMs(data.provider.runtime?.latency_ewma_ms ?? 0)} ·{" "}
            {t("亲和会话")} {data.provider.affinity_sessions ?? 0}
          </Typography>
          <Box component="section">
            <Box sx={{ ...row, justifyContent: "space-between", mb: 0.5 }}>
              <Typography component="h3" variant="subtitle2">
                {t("地址 / Key 健康")}
              </Typography>
              {undefined}
            </Box>
            {
              <>
                {[...data.endpoints, ...data.keys].map((item) => (
                  <Box
                    key={`${"base_url" in item ? "endpoint" : "key"}:${item.id}`}
                    sx={{ py: 1, borderBottom: 1, borderColor: "divider" }}
                  >
                    <Typography variant="body2">
                      {item.name} ·{" "}
                      {t(
                        !item.enabled
                          ? "停用"
                          : item.health?.available === false
                            ? "冷却中"
                            : "可用",
                      )}
                    </Typography>
                    <Typography
                      variant="caption"
                      sx={{ overflowWrap: "anywhere" }}
                    >
                      {"routing_availability" in item
                        ? item.routing_availability?.reason
                        : ""}{" "}
                      {item.health?.last_error_message}{" "}
                      {item.health?.open_until_ms
                        ? formatDateTime(item.health.open_until_ms)
                        : ""}
                      {"quota" in item && item.quota?.cooldown_until_ms
                        ? ` · ${t("配额等待至")} ${formatDateTime(item.quota.cooldown_until_ms)}`
                        : ""}
                    </Typography>
                  </Box>
                ))}
              </>
            }
          </Box>
          <Box component="section">
            <Box sx={{ ...row, justifyContent: "space-between", mb: 0.5 }}>
              <Typography component="h3" variant="subtitle2">
                {t("最近错误")}
              </Typography>
              {undefined}
            </Box>
            {
              <>
                <Typography variant="caption" color="text.secondary">
                  {t("最多 50 条，重启后清空；长期追溯请查看请求日志。")}
                </Typography>
                {data.recent_errors.length ? (
                  data.recent_errors.map((e, i) => (
                    <Box
                      key={`${e.time_ms}:${i}`}
                      sx={{ py: 1, borderBottom: 1, borderColor: "divider" }}
                    >
                      <Typography variant="body2">
                        {formatDateTime(e.time_ms)} · {e.category} ·{" "}
                        {e.status ?? "—"}
                      </Typography>
                      <Typography variant="caption">
                        {t("地址")} #{e.endpoint_id} · Key #{e.key_id} ·{" "}
                        {e.summary}
                      </Typography>
                    </Box>
                  ))
                ) : (
                  <Typography variant="body2">{t("暂无错误")}</Typography>
                )}
              </>
            }
          </Box>
        </>
      ) : null}
    </Stack>
  );
}

function UnsavedNavigationGuard({
  dirty,
  busy,
  id,
}: {
  dirty: boolean;
  busy: boolean;
  id: number;
}) {
  const { t } = useI18n();
  const blocker = useBlocker(
    ({ nextLocation }) =>
      (dirty || busy) &&
      (nextLocation.pathname !== "/upstreams" ||
        Number(new URLSearchParams(nextLocation.search).get("provider_id")) !==
          id),
  );
  return (
    <Dialog
      open={blocker.state === "blocked"}
      onClose={
        busy ? undefined : () => blocker.state === "blocked" && blocker.reset()
      }
      aria-label={t("放弃未保存的修改？")}
    >
      <DialogTitle>{t("放弃未保存的修改？")}</DialogTitle>
      <DialogContent></DialogContent>
      <DialogActions>
        <Button
          autoFocus
          variant="outlined"
          disabled={busy}
          onClick={() => blocker.state === "blocked" && blocker.reset()}
        >
          {t("取消")}
        </Button>
        <Button
          color="error"
          loading={busy}
          onClick={() => blocker.state === "blocked" && blocker.proceed()}
        >
          {t("放弃修改")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
