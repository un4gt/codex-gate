import AddOutlined from "@mui/icons-material/AddOutlined";
import CheckOutlined from "@mui/icons-material/CheckOutlined";
import CloseOutlined from "@mui/icons-material/CloseOutlined";
import DeleteOutlined from "@mui/icons-material/DeleteOutlined";
import EditOutlined from "@mui/icons-material/EditOutlined";
import Chip from "@mui/material/Chip";
import IconButton from "@mui/material/IconButton";
import InputAdornment from "@mui/material/InputAdornment";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useRef, type ClipboardEvent, type KeyboardEvent } from "react";
import { useI18n } from "@/lib/i18n";

type EntryKind = "address" | "key";
type EntryDraft = {
  entries: { id: number; value: string }[];
  nextId: number;
  text: string;
  editingId: number | null;
  error: { message: string; line?: number } | null;
};

export function createUpstreamEntryDraft(values: string[] = []): EntryDraft {
  return {
    entries: values.map((value, id) => ({ id, value })),
    nextId: values.length,
    text: "",
    editingId: null,
    error: null,
  };
}

function serviceAddressError(value: string) {
  const invalid = "请输入有效的 HTTP 或 HTTPS 地址。";
  if (!/^https?:\/\/[^/\\?#\s]/i.test(value) || /[\\\s]/.test(value)) return invalid;
  try {
    if (!new URL(value).hostname) return invalid;
  } catch {
    return invalid;
  }
  if (value.split("#", 1)[0].includes("?")) return "服务地址不能包含查询参数。";
}

export function commitUpstreamEntryDraft(
  kind: EntryKind,
  draft: EntryDraft,
  { values = [draft.text], required = false }: { values?: string[]; required?: boolean } = {},
): EntryDraft {
  const items = values.map((value) => value.trim()).filter(Boolean);
  if (!items.length) {
    const missingValue = draft.editingId !== null || (required && draft.entries.length === 0);
    if (!missingValue || draft.error) return draft;
    const message = kind === "key" ? "API 密钥不能为空。" : "服务地址不能为空。";
    return { ...draft, error: { message } };
  }
  if (draft.editingId !== null && items.length > 1) {
    return { ...draft, error: { message: "编辑时请粘贴一项。" } };
  }
  if (kind === "address") {
    for (const [index, value] of items.entries()) {
      const message = serviceAddressError(value);
      if (message) {
        return {
          ...draft,
          error: { message, line: items.length > 1 ? index + 1 : undefined },
        };
      }
    }
  }

  const finished = { ...draft, text: "", editingId: null, error: null };
  if (draft.editingId !== null) {
    return {
      ...finished,
      entries: draft.entries.map((entry) =>
        entry.id === draft.editingId ? { ...entry, value: items[0] } : entry,
      ),
    };
  }
  return {
    ...finished,
    entries: [
      ...draft.entries,
      ...items.map((value, index) => ({ value, id: draft.nextId + index })),
    ],
    nextId: draft.nextId + items.length,
  };
}

export function UpstreamEntryField({
  kind,
  draft,
  disabled,
  onChange,
}: {
  kind: EntryKind;
  draft: EntryDraft;
  disabled: boolean;
  onChange: (draft: EntryDraft) => void;
}) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const isKey = kind === "key";
  const editing = draft.editingId !== null;
  const label = t(isKey ? "API Key" : "服务地址");
  const error = draft.error && t(draft.error.message);
  const helperText = draft.error?.line && error
    ? t("第 {{line}} 项。{{message}}", { line: draft.error.line, message: error })
    : error || t(editing ? "回车保存，Esc 取消。" : "回车添加，支持多行粘贴。");

  const cancelEdit = () => {
    onChange({ ...draft, text: "", editingId: null, error: null });
    input.current?.focus();
  };
  const commit = () => {
    onChange(commitUpstreamEntryDraft(kind, draft));
    input.current?.focus();
  };

  return (
    <TextField
      inputRef={input}
      label={editing ? t("编辑{{label}}", { label }) : label}
      type={isKey ? "password" : "text"}
      placeholder={isKey ? t("输入 API Key") : "https://api.example.com/v1"}
      value={draft.text}
      disabled={disabled}
      error={Boolean(error)}
      helperText={helperText}
      onChange={(event) => onChange({ ...draft, text: event.target.value, error: null })}
      onBlur={() => {
        if (disabled || isKey || draft.error || !draft.text.trim()) return;
        const message = serviceAddressError(draft.text.trim());
        if (message) onChange({ ...draft, error: { message } });
      }}
      slotProps={{
        input: {
          sx: {
            flexWrap: "wrap",
            gap: 0.5,
            px: 0.75,
            py: 0.5,
            "& > input": { flex: "1 1 auto", width: 0, minWidth: 0, px: 1, py: 0.75 },
          },
          startAdornment: draft.entries.length ? (
            <Stack
              component="ul"
              aria-label={label}
              spacing={0.5}
              sx={{ width: "100%", m: 0, p: 0, listStyle: "none" }}
            >
              {draft.entries.map(({ id, value }, index) => {
                const itemLabel = isKey
                  ? t("第 {{index}} 个 API Key", { index: index + 1 })
                  : `${label} ${value}`;
                const maskedKey = value.length > 4 ? `•••• ${value.slice(-4)}` : "••••";
                const selected = draft.editingId === id;
                return (
                  <Chip
                    key={id}
                    component="li"
                    variant="outlined"
                    sx={{
                      borderStyle: "dashed",
                      borderColor: selected ? "primary.main" : "action.disabled",
                      bgcolor: selected ? "action.selected" : "transparent",
                      width: "100%",
                      height: "auto",
                      minHeight: 34,
                      "& .MuiChip-label": {
                        display: "flex",
                        width: "100%",
                        minWidth: 0,
                        alignItems: "center",
                        gap: 0.25,
                        pr: 0.5,
                      },
                    }}
                    label={(
                      <>
                        <Typography
                          component="span"
                          variant="body2"
                          sx={{ flex: 1, minWidth: 0, mr: 0.5, whiteSpace: "normal", overflowWrap: "anywhere" }}
                        >
                          {isKey ? maskedKey : value}
                        </Typography>
                        <Tooltip title={disabled ? "" : t("编辑")}>
                          <IconButton
                            type="button"
                            aria-label={t("编辑{{label}}", { label: itemLabel })}
                            disabled={disabled}
                            onClick={() => {
                              onChange({ ...draft, text: value, editingId: id, error: null });
                              input.current?.focus();
                            }}
                          >
                            <EditOutlined />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title={disabled ? "" : t("删除")}>
                          <IconButton
                            type="button"
                            aria-label={t("删除{{label}}", { label: itemLabel })}
                            disabled={disabled}
                            onClick={() => {
                              const entries = draft.entries.filter((entry) => entry.id !== id);
                              onChange(selected
                                ? { ...draft, entries, text: "", editingId: null, error: null }
                                : { ...draft, entries });
                              input.current?.focus();
                            }}
                          >
                            <DeleteOutlined />
                          </IconButton>
                        </Tooltip>
                      </>
                    )}
                  />
                );
              })}
            </Stack>
          ) : undefined,
          endAdornment: (
            <InputAdornment position="end">
              {editing ? (
                <IconButton
                  type="button"
                  aria-label={t("取消编辑")}
                  disabled={disabled}
                  onClick={cancelEdit}
                >
                  <CloseOutlined />
                </IconButton>
              ) : null}
              <IconButton
                type="button"
                aria-label={t(editing ? "保存{{label}}" : "添加{{label}}", { label })}
                disabled={disabled || !draft.text.trim()}
                onClick={commit}
              >
                {editing ? <CheckOutlined /> : <AddOutlined />}
              </IconButton>
            </InputAdornment>
          ),
        },
        htmlInput: {
          "aria-required": !disabled && !draft.entries.length,
          inputMode: isKey ? undefined : "url",
          autoComplete: isKey ? "new-password" : "off",
          spellCheck: false,
          onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
            if (disabled || event.nativeEvent.isComposing) return;
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            } else if (event.key === "Escape" && (editing || draft.text || draft.error)) {
              event.preventDefault();
              event.stopPropagation();
              cancelEdit();
            }
          },
          onPaste: (event: ClipboardEvent<HTMLInputElement>) => {
            const values = event.clipboardData.getData("text/plain").split(/\r\n|\n|\r/);
            if (values.filter((value) => value.trim()).length < 2) return;
            event.preventDefault();
            const next = commitUpstreamEntryDraft(kind, draft, { values });
            onChange({ ...next, text: draft.text });
          },
        },
      }}
    />
  );
}
