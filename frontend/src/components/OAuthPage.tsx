import { routingAvailabilityLabel } from "@/lib/routingAvailability";
import Plus from "@mui/icons-material/AddOutlined";
import Chip from "@mui/material/Chip";
import { useEffect,useMemo,useRef,useState } from "react";

import {
CodexOAuthLoginDialog,
CodexOAuthPanel,
} from "@/components/CodexOAuthPanel";
import { createProvider,deleteProvider,loadUpstreamConfig } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import type {
ConnectionSettings,
CreateProviderInput,
ProviderWorkspace,
} from "@/lib/types";
import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import FormControl from "@mui/material/FormControl";
import FormLabel from "@mui/material/FormLabel";
import LinearProgress from "@mui/material/LinearProgress";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Typography from "@mui/material/Typography";
import { useSearchParams } from "react-router";

const CODEX_PROVIDER_TYPE = "openai_codex_oauth";
const CODEX_DEFAULT_BASE_URL = "https://chatgpt.com/backend-api/codex";
const DEFAULT_CODEX_PROVIDER: Omit<CreateProviderInput, "priority" | "weight"> =
  {
    name: "OpenAI Codex OAuth",
    provider_type: CODEX_PROVIDER_TYPE,
    enabled: true,
    supports_include_usage: true,
    websocket_enabled: true,
    beta_features: ["responses-http-to-ws"],
    request_overrides: { headers: [], body: [] },
    key_selection_strategy: "round_robin",
    max_attempts: 2,
    max_concurrency: null,
    circuit_breaker_enabled: true,
    circuit_breaker_failure_threshold: 3,
    circuit_breaker_open_ms: 30_000,
    circuit_breaker_half_open_success_threshold: 2,
  };

interface OAuthPageProps {
  settings: ConnectionSettings;
  items: ProviderWorkspace[];
  loading: boolean;
  onRefresh: (successMessage?: string) => Promise<void>;
  onMessage: (message: string) => void;
}

interface PendingLogin {
  providerId: number;
  attemptId: number;
}

export function OAuthPage(props: OAuthPageProps) {
  const { t } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const [creatingProvider, setCreatingProvider] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [pendingLogin, setPendingLogin] = useState<PendingLogin | null>(null);
  const loginSequenceRef = useRef(0);
  const codexProviders = useMemo(
    () =>
      props.items.filter(
        (item) => item.provider.provider_type === CODEX_PROVIDER_TYPE,
      ),
    [props.items],
  );
  const requestedProviderId = Number(searchParams.get("provider"));
  const selected =
    codexProviders.find((item) => item.provider.id === requestedProviderId) ??
    codexProviders[0] ??
    null;

  useEffect(() => {
    if (
      !selected ||
      searchParams.get("provider") === String(selected.provider.id)
    )
      return;
    const next = new URLSearchParams(searchParams);
    next.set("provider", String(selected.provider.id));
    setSearchParams(next, { replace: true });
  }, [searchParams, selected, setSearchParams]);

  const [details, setDetails] = useState<ProviderWorkspace | null>(null);
  useEffect(() => {
    let active = true;
    setDetails(null);
    if (selected)
      void loadUpstreamConfig(props.settings, selected.provider.id)
        .then((v) => {
          if (active) setDetails(v);
        })
        .catch((e) => {
          if (active) setCreateError(String(e));
        });
    return () => {
      active = false;
    };
  }, [selected, props.settings]);
  const selectProvider = (providerId: number) => {
    const next = new URLSearchParams(searchParams);
    next.set("provider", String(providerId));
    setSearchParams(next);
  };

  const createAndLogin = async () => {
    setCreatingProvider(true);
    setCreateError(null);
    let providerId: number | null = null;
    try {
      const provider = await createProvider(props.settings, {
        ...DEFAULT_CODEX_PROVIDER,
        endpoints: [
          {
            name: "Codex",
            base_url: CODEX_DEFAULT_BASE_URL,
            enabled: true,
            priority: 100,
            weight: 1,
          },
        ],
      });
      providerId = provider.id;
      await props.onRefresh(t("Codex OAuth 上游已创建。"));
      selectProvider(provider.id);
      loginSequenceRef.current += 1;
      setPendingLogin({
        providerId: provider.id,
        attemptId: loginSequenceRef.current,
      });
    } catch (cause) {
      const message =
        cause instanceof Error
          ? cause.message
          : t("创建 Codex OAuth 上游失败。");
      if (providerId !== null) {
        try {
          await deleteProvider(props.settings, providerId);
        } catch (rollbackCause) {
          const rollbackMessage =
            rollbackCause instanceof Error
              ? rollbackCause.message
              : t("自动回滚失败。");
          const combined = t("{{message}} 自动回滚失败：{{rollback}}", {
            message,
            rollback: rollbackMessage,
          });
          setCreateError(combined);
          props.onMessage(combined);
          return;
        }
      }
      setCreateError(message);
      props.onMessage(message);
    } finally {
      setCreatingProvider(false);
    }
  };

  if (props.loading && props.items.length === 0) {
    return <LinearProgress aria-label={t("正在加载 OAuth 账号")} />;
  }

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      {codexProviders.length === 0 ? (
        <Box sx={{ display: "grid", gap: "1rem" }}>
          {createError ? (
            <Alert severity="error" role="alert" variant="outlined">
              <AlertTitle>{t("创建上游失败。")}</AlertTitle>
              {createError}
            </Alert>
          ) : null}
          <Box sx={{ py: 6, px: 2, textAlign: "center" }}>
            <Typography variant="subtitle1">
              {t("尚无 Codex OAuth 上游")}
            </Typography>
            <Typography color="text.secondary" sx={{ mt: 1 }}>
              {t("创建默认上游后即可登录并管理 Codex 账号。")}
            </Typography>
            <Box sx={{ mt: 2 }}>
              {
                <Button
                  type="button"
                  disabled={creatingProvider}
                  onClick={() => void createAndLogin()}
                >
                  <Plus
                    sx={{
                      marginRight: "0.5rem",
                      width: "1rem",
                      height: "1rem",
                    }}
                    aria-hidden="true"
                  />
                  {t(creatingProvider ? "创建中…" : "创建并登录")}
                </Button>
              }
            </Box>
          </Box>
        </Box>
      ) : selected ? (
        <Box sx={{ display: "grid", gap: "1rem" }}>
          <Box
            sx={{
              display: "flex",
              flexDirection: "column",
              gap: "0.75rem",
              borderBottomStyle: "solid",
              borderBottomWidth: "1px",
              borderColor:
                "color-mix(in oklab, var(--mui-palette-divider) 40%, transparent)",
              paddingBottom: "0.75rem",
              "@media (width >= 64rem)": {
                flexDirection: "row",
                alignItems: "flex-end",
                justifyContent: "space-between",
              },
            }}
          >
            <Box
              sx={{
                display: "flex",
                minWidth: "0",
                flexWrap: "wrap",
                alignItems: "center",
                gap: "0.5rem",
              }}
            >
              <Typography
                sx={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontSize: "1rem",
                  lineHeight: "calc(1.5 / 1)",
                  fontWeight: "600",
                  color: "var(--mui-palette-text-primary)",
                }}
                component="h2"
              >
                {selected.provider.name}
              </Typography>
              <Chip
                color={
                  (
                    {
                      normal: "success",
                      warning: "warning",
                      error: "error",
                      disabled: "default",
                      draft: "default",
                      archived: "default",
                    } as const
                  )[
                    selected.provider.routing_availability?.available
                      ? "normal"
                      : "disabled"
                  ]
                }
                label={t(
                  routingAvailabilityLabel(
                    selected.provider.routing_availability,
                  ),
                )}
              />
            </Box>
            {codexProviders.length > 1 ? (
              <FormControl
                sx={{
                  width: "100%",
                  "@media (width >= 64rem)": { width: "20rem" },
                }}
              >
                <FormLabel>{t("Codex 上游")}</FormLabel>
                <Select
                  value={selected.provider.id}
                  inputProps={{ "aria-label": t("Codex 上游") }}
                  onChange={(event) =>
                    selectProvider(Number(event.target.value))
                  }
                >
                  {codexProviders.map((item) => (
                    <MenuItem key={item.provider.id} value={item.provider.id}>
                      {item.provider.name}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            ) : null}
          </Box>

          {details ? (
            <CodexOAuthPanel
              settings={props.settings}
              item={details}
              onRefresh={props.onRefresh}
              onMessage={props.onMessage}
            />
          ) : (
            <LinearProgress />
          )}
        </Box>
      ) : null}

      {pendingLogin ? (
        <CodexOAuthLoginDialog
          open
          attemptId={pendingLogin.attemptId}
          settings={props.settings}
          providerId={pendingLogin.providerId}
          replaceKeyId={null}
          onClose={() => setPendingLogin(null)}
          onMessage={props.onMessage}
          onCompleted={async (session) => {
            await props.onRefresh(
              t(
                session.operation === "updated"
                  ? "Codex OAuth 账号已更新。"
                  : "Codex OAuth 账号已创建。",
              ),
            );
          }}
        />
      ) : null}
    </Box>
  );
}
