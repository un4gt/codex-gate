import Plus from "@mui/icons-material/AddOutlined";
import CloseOutlined from "@mui/icons-material/CloseOutlined";
import Trash2 from "@mui/icons-material/DeleteOutlined";
import Search from "@mui/icons-material/SearchOutlined";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Drawer from "@mui/material/Drawer";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import TablePagination from "@mui/material/TablePagination";
import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";

import {
  createModelAlias,
  createModelAliasTarget,
  deleteModelAlias,
  deleteModelAliasTarget,
  updateModelAlias,
  updateModelAliasTarget,
} from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import type {
  ConnectionSettings,
  ModelAlias,
  ModelAliasTarget,
  ProviderWorkspace,
} from "@/lib/types";
import { paginate, useListQuery } from "@/lib/useListQuery";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import CircularProgress from "@mui/material/CircularProgress";
import FormControlLabel from "@mui/material/FormControlLabel";
import MenuItem from "@mui/material/MenuItem";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";

const ModelRoutesEditor = lazy(() => import("./ModelRoutesEditor"));

interface ModelAliasesPageProps {
  settings: ConnectionSettings;
  providers: ProviderWorkspace[];
  aliases: ModelAlias[];
  loading?: boolean;
  error?: string | null;
  onRefresh: (message?: string) => Promise<void>;
}

export function ModelAliasesPage(props: ModelAliasesPageProps) {
  const { t } = useI18n();
  const { params, update, filter, page, pageSize } = useListQuery();
  const search = params.get("q") ?? "";
  const editor = params.get("alias_id");
  const selected = props.aliases.find((alias) => String(alias.id) === editor);
  const providerId = params.get("provider_id");
  const filtered = props.aliases
    .filter(
      (alias) =>
        alias.name.toLowerCase().includes(search.trim().toLowerCase()) &&
        (!providerId ||
          alias.targets.some(
            (target) => String(target.provider_id) === providerId,
          )),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  const close = () => update({ alias_id: null }, true);
  return (
    <Box sx={{ display: "grid", gap: 2, minWidth: 0 }}>
      <Suspense fallback={<CircularProgress size={24} />}>
        <ModelRoutesEditor
          settings={props.settings}
          providers={props.providers}
        />
      </Suspense>
      <Stack spacing={2}>
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 2,
          }}
        >
          <Box
            sx={{
              display: "grid",
              gridTemplateColumns:
                "repeat(auto-fit, minmax(min(100%, 180px), 1fr))",
              gap: 2,
              flex: 1,
              minWidth: 0,
            }}
          >
            {
              <TextField
                value={search}
                placeholder={t("搜索路由别名")}
                onChange={(event) => filter("q", event.target.value, true)}
                sx={{ gridColumn: "1 / -1" }}
                label={t("搜索路由别名")}
                slotProps={{
                  input: { startAdornment: <Search fontSize="small" /> },
                  htmlInput: { ...{ "aria-label": t("搜索路由别名") } },
                }}
              />
            }
          </Box>
          <Stack direction="row" spacing={1}>
            {
              <Button
                disabled={props.loading || !!props.error}
                onClick={() => update({ alias_id: "new" })}
              >
                <Plus fontSize="small" />
                {t("新增路由别名")}
              </Button>
            }
          </Stack>
        </Box>
      </Stack>
      <Typography variant="body2" color="text.secondary">
        {t(
          "通过一个调用名称，按顺序或权重选择多个上游模型。显示名称在模型详情中管理。",
        )}
      </Typography>
      {providerId ? (
        <Alert
          severity="info"
          action={
            <Button onClick={() => filter("provider_id", "")}>
              {t("清除筛选")}
            </Button>
          }
        >
          {t("只显示包含所选上游的路由别名。")}
        </Alert>
      ) : null}
      {props.error ? (
        <Alert
          severity="error"
          action={
            <Button onClick={() => void props.onRefresh()}>{t("重试")}</Button>
          }
        >
          {props.error}
        </Alert>
      ) : null}
      {props.loading && props.aliases.length === 0 ? (
        <CircularProgress size={24} />
      ) : null}
      {filtered.length > 0 ? (
        <TableContainer>
          <Table size="small" aria-label={t("路由别名")} sx={{ minWidth: 560 }}>
            <TableHead>
              <TableRow>
                {["别名", "模式", "启用", "目标数量", "操作"].map((label) => (
                  <TableCell key={label}>{t(label)}</TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {paginate(filtered, page, pageSize).items.map((alias) => (
                <TableRow key={alias.id} hover>
                  <TableCell sx={{ fontFamily: "monospace" }}>
                    {alias.name}
                  </TableCell>
                  <TableCell>
                    {t(alias.mode === "ordered" ? "按顺序" : "按权重")}
                  </TableCell>
                  <TableCell>{t(alias.enabled ? "启用" : "停用")}</TableCell>
                  <TableCell>{alias.targets.length}</TableCell>
                  <TableCell>
                    <Button
                      disabled={!!props.error}
                      onClick={() => update({ alias_id: String(alias.id) })}
                    >
                      {t("编辑")}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      ) : !props.loading && !props.error ? (
        <Box sx={{ py: 6, px: 2, textAlign: "center" }}>
          <Typography variant="subtitle1">{t("暂无模型配置")}</Typography>
          <Typography color="text.secondary" sx={{ mt: 1 }}>
            {t("新增一个模型名称后，再为它添加上游目标。")}
          </Typography>
        </Box>
      ) : null}
      <TablePagination
        getItemAriaLabel={(type) =>
          t(
            type === "next"
              ? "下一页"
              : type === "previous"
                ? "上一页"
                : type === "first"
                  ? "首页"
                  : "末页",
          )
        }
        component="div"
        count={filtered.length}
        page={Math.min(
          page - 1,
          Math.max(0, Math.ceil(filtered.length / pageSize) - 1),
        )}
        rowsPerPage={pageSize}
        rowsPerPageOptions={[25, 50, 100]}
        onPageChange={(_, next) => update({ page: String(next + 1) })}
        onRowsPerPageChange={(event) =>
          update({ page_size: event.target.value, page: null })
        }
        labelRowsPerPage={t("每页")}
      />
      {editor ? (
        props.loading && editor !== "new" && !selected ? (
          <Drawer
            anchor="right"
            open={true}
            onClose={close}
            slotProps={{
              paper: {
                role: "dialog",
                "aria-modal": true,
                "aria-label": t("路由别名"),
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
                  {t("路由别名")}
                </Typography>
              </Box>
              <IconButton aria-label={t("关闭")} onClick={close}>
                <CloseOutlined />
              </IconButton>
            </Box>
            <Box
              sx={{
                flex: 1,
                minHeight: 0,
                overflowY: "auto",
                p: { xs: 2, sm: 3 },
              }}
            >
              <CircularProgress size={24} />
            </Box>
          </Drawer>
        ) : props.error || (editor !== "new" && !selected) ? (
          <Drawer
            anchor="right"
            open={true}
            onClose={close}
            slotProps={{
              paper: {
                role: "dialog",
                "aria-modal": true,
                "aria-label": t("路由别名"),
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
                  {t("路由别名")}
                </Typography>
              </Box>
              <IconButton aria-label={t("关闭")} onClick={close}>
                <CloseOutlined />
              </IconButton>
            </Box>
            <Box
              sx={{
                flex: 1,
                minHeight: 0,
                overflowY: "auto",
                p: { xs: 2, sm: 3 },
              }}
            >
              <Alert severity="warning">
                {props.error ?? t("未找到该路由别名。")}
              </Alert>
            </Box>
          </Drawer>
        ) : (
          <AliasEditor
            key={editor}
            {...props}
            alias={selected}
            onClose={close}
            onCreated={(id) => update({ alias_id: String(id) }, true)}
          />
        )
      ) : null}
    </Box>
  );
}

function AliasEditor(
  props: ModelAliasesPageProps & {
    alias?: ModelAlias;
    onClose: () => void;
    onCreated: (id: number) => void;
  },
) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removal, setRemoval] = useState<"alias" | ModelAliasTarget | null>(
    null,
  );
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const run = async (operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (cause) {
      if (active.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (active.current) setBusy(false);
    }
  };
  const submitAlias = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    if (!name) {
      setError(t("模型名称不能为空。"));
      return;
    }
    const payload = {
      name,
      enabled: form.get("enabled") === "on",
      mode: String(form.get("mode")) as "ordered" | "weighted",
    };
    void run(async () => {
      if (props.alias) {
        await updateModelAlias(props.settings, props.alias.id, payload);
        await props.onRefresh(t("模型 {{name}} 已更新。", { name }));
      } else {
        const result = await createModelAlias(props.settings, payload);
        await props.onRefresh(t("模型 {{name}} 已创建。", { name }));
        if (active.current) props.onCreated(result.id);
      }
    });
  };
  const saveTarget = (
    event: FormEvent<HTMLFormElement>,
    target?: ModelAliasTarget,
  ) => {
    event.preventDefault();
    if (!props.alias) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const payload = {
      provider_id: Number(form.get("provider_id")),
      upstream_model: String(form.get("upstream_model") ?? "").trim(),
      enabled: form.get("enabled") === "on",
      priority: Number(form.get("priority")),
      weight: Number(form.get("weight")),
    };
    if (!payload.upstream_model || payload.provider_id <= 0) {
      setError(t("请选择上游并填写模型。"));
      return;
    }
    if (
      ![payload.priority, payload.weight].every(Number.isSafeInteger) ||
      payload.priority < 0 ||
      payload.weight < 1 ||
      Math.max(payload.priority, payload.weight) > 2147483647
    ) {
      setError(t("优先级必须是非负整数，权重必须是正整数。"));
      return;
    }
    const aliasId = props.alias.id;
    void run(async () => {
      if (target)
        await updateModelAliasTarget(props.settings, target.id, payload);
      else await createModelAliasTarget(props.settings, aliasId, payload);
      await props.onRefresh(
        t(target ? "模型目标已更新。" : "模型目标已添加。"),
      );
      if (!target && active.current) formElement.reset();
    });
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
          "aria-label": t(props.alias?.name ?? t("新增路由别名")),
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
            {t(props.alias?.name ?? t("新增路由别名"))}
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
        <Box sx={{ display: "grid", gap: 3 }}>
          {error ? <Alert severity="error">{error}</Alert> : null}
          <Box
            component="form"
            onSubmit={submitAlias}
            sx={{ display: "grid", gap: 2 }}
          >
            <TextField
              name={"name"}
              label={t("别名")}
              placeholder={"gpt-5"}
              defaultValue={props.alias?.name ?? ""}
              required={true}
              disabled={busy}
              slotProps={{
                htmlInput: { min: undefined, max: undefined, step: undefined },
              }}
            />
            <TextField
              select
              name={"mode"}
              label={t("模式")}
              defaultValue={props.alias?.mode ?? "ordered"}
              disabled={busy}
            >
              <MenuItem value="ordered">{t("按顺序")}</MenuItem>
              <MenuItem value="weighted">{t("按权重")}</MenuItem>
            </TextField>
            <FormControlLabel
              control={
                <Checkbox
                  name="enabled"
                  defaultChecked={props.alias?.enabled ?? true}
                  disabled={busy}
                />
              }
              label={t("启用")}
            />
            <Box
              sx={{ display: "flex", justifyContent: "space-between", gap: 1 }}
            >
              {props.alias ? (
                <Button
                  color="error"
                  disabled={busy}
                  onClick={() => setRemoval("alias")}
                >
                  <Trash2 fontSize="small" />
                  {t("删除模型")}
                </Button>
              ) : null}
              <Button loading={Boolean(busy)} type="submit" disabled={busy}>
                {t(props.alias ? "保存" : "新增模型")}
              </Button>
            </Box>
          </Box>
          {props.alias ? (
            <>
              <Typography component="h3" variant="subtitle2">
                {t("上游目标")}
              </Typography>
              {props.alias.targets.map((target) => (
                <TargetForm
                  key={target.id}
                  target={target}
                  providers={props.providers}
                  busy={busy}
                  onSubmit={(event) => saveTarget(event, target)}
                  onDelete={() => setRemoval(target)}
                />
              ))}
              <TargetForm
                providers={props.providers}
                busy={busy}
                onSubmit={(event) => saveTarget(event)}
              />
            </>
          ) : null}
        </Box>
        <Dialog
          open={removal !== null}
          onClose={busy ? undefined : () => setRemoval(null)}
          aria-label={t(
            removal === "alias"
              ? "确认删除模型 {{name}}？"
              : "确认删除这个模型目标？",
            { name: props.alias?.name ?? "" },
          )}
        >
          <DialogTitle>
            {t(
              removal === "alias"
                ? "确认删除模型 {{name}}？"
                : "确认删除这个模型目标？",
              { name: props.alias?.name ?? "" },
            )}
          </DialogTitle>
          <DialogContent>
            {error ? <Alert severity="error">{error}</Alert> : null}
          </DialogContent>
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
              onClick={() =>
                void run(async () => {
                  if (!removal || !props.alias) return;
                  if (removal === "alias")
                    await deleteModelAlias(props.settings, props.alias.id);
                  else await deleteModelAliasTarget(props.settings, removal.id);
                  if (active.current) {
                    setRemoval(null);
                    if (removal === "alias") props.onClose();
                  }
                  await props.onRefresh(
                    t(
                      removal === "alias" ? "模型已删除。" : "模型目标已删除。",
                    ),
                  );
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

function TargetForm(props: {
  target?: ModelAliasTarget;
  providers: ProviderWorkspace[];
  busy: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onDelete?: () => void;
}) {
  const { t } = useI18n();
  const target = props.target;
  return (
    <Box
      component="form"
      onSubmit={props.onSubmit}
      sx={{
        border: 1,
        borderColor: "divider",
        borderRadius: 1,
        p: 2,
        display: "grid",
        gap: 2,
      }}
    >
      <Typography variant="subtitle2">
        {target?.upstream_model ?? t("添加目标")}
      </Typography>
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" },
          gap: 2,
        }}
      >
        <TextField
          select
          name={"provider_id"}
          label={t("上游")}
          defaultValue={target?.provider_id ?? ""}
          required={true}
          disabled={props.busy}
        >
          {target &&
          !props.providers.some(
            (item) => item.provider.id === target.provider_id,
          ) ? (
            <MenuItem value={target.provider_id}>
              {t("上游 #{{id}}", { id: target.provider_id })}
            </MenuItem>
          ) : null}
          {props.providers.map((item) => (
            <MenuItem key={item.provider.id} value={item.provider.id}>
              {item.provider.name}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          name={"upstream_model"}
          label={t("上游模型名称")}
          defaultValue={target?.upstream_model ?? ""}
          required={true}
          disabled={props.busy}
          slotProps={{
            htmlInput: { min: undefined, max: undefined, step: undefined },
          }}
        />
        <TextField
          name={"priority"}
          label={t("优先级")}
          type={"number"}
          defaultValue={target?.priority ?? 100}
          required={true}
          disabled={props.busy}
          slotProps={{ htmlInput: { min: 0, max: 2147483647, step: 1 } }}
        />
        <TextField
          name={"weight"}
          label={t("权重")}
          type={"number"}
          defaultValue={target?.weight ?? 1}
          required={true}
          disabled={props.busy}
          slotProps={{ htmlInput: { min: 1, max: 2147483647, step: 1 } }}
        />
      </Box>
      <Box
        sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 1 }}
      >
        <FormControlLabel
          control={
            <Checkbox
              name="enabled"
              defaultChecked={target?.enabled ?? true}
              disabled={props.busy}
            />
          }
          label={t("启用")}
        />
        <Button loading={props.busy} type="submit" disabled={props.busy}>
          {t(target ? "保存" : "添加目标")}
        </Button>
        {props.onDelete ? (
          <Button color="error" disabled={props.busy} onClick={props.onDelete}>
            {t("删除目标")}
          </Button>
        ) : null}
      </Box>
    </Box>
  );
}
