import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { useSearchParams } from 'react-router';
import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import FormControl from '@mui/material/FormControl';
import FormLabel from '@mui/material/FormLabel';
import LinearProgress from '@mui/material/LinearProgress';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Typography from '@mui/material/Typography';
import { CodexOAuthLoginDialog, CodexOAuthPanel } from '@/components/CodexOAuthPanel';
import { EmptyState } from '@/components/console/EmptyState';
import { StatusBadge } from '@/components/console/StatusBadge';
import { createEndpoint, createProvider, deleteProvider } from '@/lib/api';
import { t } from '@/lib/i18n';
import type { ConnectionSettings, CreateProviderInput, ProviderWorkspace } from '@/lib/types';

const CODEX_PROVIDER_TYPE = 'openai_codex_oauth';
const CODEX_DEFAULT_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const DEFAULT_CODEX_PROVIDER: CreateProviderInput = {
  name: 'OpenAI Codex OAuth',
  provider_type: CODEX_PROVIDER_TYPE,
  enabled: true,
  priority: 100,
  weight: 1,
  supports_include_usage: true,
  websocket_enabled: true,
  beta_features: ['responses-http-to-ws'],
  request_overrides: { headers: [], body: [] },
  key_selection_strategy: 'round_robin',
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
  const [searchParams, setSearchParams] = useSearchParams();
  const [creatingProvider, setCreatingProvider] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [pendingLogin, setPendingLogin] = useState<PendingLogin | null>(null);
  const loginSequenceRef = useRef(0);
  const codexProviders = useMemo(
    () => props.items.filter(item => item.provider.provider_type === CODEX_PROVIDER_TYPE),
    [props.items],
  );
  const requestedProviderId = Number(searchParams.get('provider'));
  const selected = codexProviders.find(item => item.provider.id === requestedProviderId)
    ?? codexProviders[0]
    ?? null;

  useEffect(() => {
    if (!selected || searchParams.get('provider') === String(selected.provider.id)) return;
    const next = new URLSearchParams(searchParams);
    next.set('provider', String(selected.provider.id));
    setSearchParams(next, { replace: true });
  }, [searchParams, selected, setSearchParams]);

  const selectProvider = (providerId: number) => {
    const next = new URLSearchParams(searchParams);
    next.set('provider', String(providerId));
    setSearchParams(next);
  };

  const createAndLogin = async () => {
    setCreatingProvider(true);
    setCreateError(null);
    let providerId: number | null = null;
    try {
      const provider = await createProvider(props.settings, DEFAULT_CODEX_PROVIDER);
      providerId = provider.id;
      await createEndpoint(props.settings, provider.id, {
        name: 'Codex',
        base_url: CODEX_DEFAULT_BASE_URL,
        enabled: true,
        priority: 100,
        weight: 1,
      });
      await props.onRefresh(t('Codex OAuth 上游已创建。'));
      selectProvider(provider.id);
      loginSequenceRef.current += 1;
      setPendingLogin({ providerId: provider.id, attemptId: loginSequenceRef.current });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : t('创建 Codex OAuth 上游失败。');
      if (providerId !== null) {
        try {
          await deleteProvider(props.settings, providerId);
        } catch (rollbackCause) {
          const rollbackMessage = rollbackCause instanceof Error
            ? rollbackCause.message
            : t('自动回滚失败。');
          const combined = t('{{message}} 自动回滚失败：{{rollback}}', {
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
    return <LinearProgress aria-label={t('正在加载 OAuth 账号')} />;
  }

  return (
    <Box className="section-stack">
      {codexProviders.length === 0 ? (
        <Box className="grid gap-4">
          {createError ? (
            <Alert severity="error" role="alert" variant="outlined">
              <AlertTitle>{t('创建上游失败。')}</AlertTitle>
              {createError}
            </Alert>
          ) : null}
          <EmptyState
            title="尚无 Codex OAuth 上游"
            description="创建默认上游后即可登录并管理 Codex 账号。"
            action={(
              <Button type="button" disabled={creatingProvider} onClick={() => void createAndLogin()}>
                <Plus className="mr-2 size-4" aria-hidden="true" />
                {t(creatingProvider ? '创建中…' : '创建并登录')}
              </Button>
            )}
          />
        </Box>
      ) : selected ? (
        <Box className="grid gap-4">
          <Box className="flex flex-col gap-3 border-b border-border/40 pb-4 lg:flex-row lg:items-end lg:justify-between">
            <Box className="min-w-0">
              <Typography className="text-sm font-medium text-foreground" component="h2">
                {selected.provider.name}
              </Typography>
              <Box className="mt-1.5 flex flex-wrap items-center gap-2">
                <StatusBadge tone={selected.provider.enabled ? 'normal' : 'disabled'}>
                  {t(selected.provider.enabled ? '已启用' : '已禁用')}
                </StatusBadge>
                <Typography className="font-mono text-xs text-muted-foreground" component="span">
                  {t('{{count}} 个 OAuth 账号', { count: selected.keys.length })}
                </Typography>
              </Box>
            </Box>
            {codexProviders.length > 1 ? (
              <FormControl className="w-full lg:w-80">
                <FormLabel>{t('Codex 上游')}</FormLabel>
                <Select
                  value={selected.provider.id}
                  inputProps={{ 'aria-label': t('Codex 上游') }}
                  onChange={event => selectProvider(Number(event.target.value))}
                >
                  {codexProviders.map(item => (
                    <MenuItem key={item.provider.id} value={item.provider.id}>
                      {item.provider.name}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            ) : null}
          </Box>

          <CodexOAuthPanel
            settings={props.settings}
            item={selected}
            onRefresh={props.onRefresh}
            onMessage={props.onMessage}
          />
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
          onCompleted={async session => {
            await props.onRefresh(t(
              session.operation === 'updated' ? 'Codex OAuth 账号已更新。' : 'Codex OAuth 账号已创建。',
            ));
          }}
        />
      ) : null}
    </Box>
  );
}
