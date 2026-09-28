import { Braces, Plus, RotateCcw, Sparkles, Trash2 } from 'lucide-react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import FormControl from '@mui/material/FormControl';
import FormHelperText from '@mui/material/FormHelperText';
import FormLabel from '@mui/material/FormLabel';
import InputBase from '@mui/material/InputBase';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Typography from '@mui/material/Typography';

import { useI18n } from '@/lib/i18n';
import type { RequestOverrideOperation, RequestOverrideScope } from '@/lib/types';

interface RequestOverridesEditorProps {
  value: RequestOverridesDraft;
  onChange: (value: RequestOverridesDraft) => void;
  disabled?: boolean;
}

export { createRequestOverridesDraft, parseRequestOverridesDraft } from '@/lib/requestOverridesDraft';
export type { RequestOverridesDraft } from '@/lib/requestOverridesDraft';
import { createRequestOverridesDraft, bodyValueError, type RequestBodyOverrideDraft, type RequestHeaderOverrideDraft, emptyHeaderRule, emptyBodyRule, mergeCodexPreset, SCOPE_OPTIONS, OPERATION_OPTIONS, type RequestOverridesDraft } from '@/lib/requestOverridesDraft';

export function RequestOverridesEditor({ value, onChange, disabled = false }: RequestOverridesEditorProps) {
  const { t } = useI18n();
  const ruleCount = value.headers.length + value.body.length;

  const updateHeader = (id: string, patch: Partial<RequestHeaderOverrideDraft>) => {
    onChange({
      ...value,
      headers: value.headers.map(rule => rule.id === id ? { ...rule, ...patch } : rule),
    });
  };

  const updateBody = (id: string, patch: Partial<RequestBodyOverrideDraft>) => {
    onChange({
      ...value,
      body: value.body.map(rule => rule.id === id ? { ...rule, ...patch } : rule),
    });
  };

  return (
    <Box className="border border-border/40 bg-muted/5" component="section">
      <Box className="flex flex-col gap-3 border-b border-border/40 p-4 lg:flex-row lg:items-start lg:justify-between">
        <Box className="min-w-0">
          <Box className="flex flex-wrap items-center gap-2">
            <Braces className="size-4 opacity-70" aria-hidden="true" />
            <Typography className="text-sm font-medium tracking-tight" component="h4">
              {t('请求覆写')}
            </Typography>
            <Chip size="small" variant="outlined" label={t('{{count}} 条规则', { count: ruleCount })} />
          </Box>
          <Typography className="mt-2 max-w-3xl text-xs leading-relaxed text-muted-foreground" component="p">
            {t('在路由转换与鉴权完成后，按上游覆写请求 Header 和 JSON Body。具体协议规则会覆盖 all；模板 {{request_id}} 在同一次请求中保持一致。')}
          </Typography>
        </Box>
        <Box className="flex shrink-0 flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => onChange(mergeCodexPreset(value))}
          >
            <Sparkles className="size-3.5" aria-hidden="true" />
            {t('应用 Codex 客户端兼容预设')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={disabled || ruleCount === 0}
            onClick={() => onChange(createRequestOverridesDraft())}
          >
            <RotateCcw className="size-3.5" aria-hidden="true" />
            {t('清空规则')}
          </Button>
        </Box>
      </Box>

      <Alert className="m-3 border-border/40 bg-background/60" severity="info" variant="outlined">
        {t('一键补齐 Codex 客户端所需的身份标识与元数据；同名规则会被覆盖，其余保留。')}
      </Alert>

      <Box className="grid gap-4 p-3">
        <Box className="grid gap-2.5">
          <Box className="flex flex-wrap items-center justify-between gap-2">
            <Box>
              <Typography className="text-sm font-medium" component="h5">{t('Header 规则')}</Typography>
              <Typography className="mt-1 text-xs text-muted-foreground" component="p">
                {t('设置或移除发送到该上游的请求头。Header 名称不区分大小写。')}
              </Typography>
            </Box>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled || value.headers.length >= 64}
              onClick={() => onChange({ ...value, headers: [...value.headers, emptyHeaderRule()] })}
            >
              <Plus className="size-3.5" aria-hidden="true" />
              {t('添加 Header')}
            </Button>
          </Box>

          {value.headers.length === 0 ? (
            <Box className="rounded border border-dashed border-border/60 px-3 py-4 text-center text-xs text-muted-foreground">
              {t('尚未配置 Header 覆写。')}
            </Box>
          ) : value.headers.map((rule, index) => (
            <Box
              key={rule.id}
              className="grid gap-3 border border-border/40 bg-background/70 p-3 xl:grid-cols-[8rem_8rem_minmax(10rem,0.8fr)_minmax(14rem,1fr)_2.5rem]"
            >
              <FormControl size="small">
                <FormLabel>{t('作用域')}</FormLabel>
                <Select
                  value={rule.scope}
                  disabled={disabled}
                  inputProps={{ 'aria-label': t('Header 规则 {{index}} 作用域', { index: index + 1 }) }}
                  onChange={event => updateHeader(rule.id, { scope: event.target.value as RequestOverrideScope })}
                >
                  {SCOPE_OPTIONS.map(option => (
                    <MenuItem key={option.value} value={option.value}>{t(option.label)}</MenuItem>
                  ))}
                </Select>
              </FormControl>
              <FormControl size="small">
                <FormLabel>{t('操作')}</FormLabel>
                <Select
                  value={rule.operation}
                  disabled={disabled}
                  inputProps={{ 'aria-label': t('Header 规则 {{index}} 操作', { index: index + 1 }) }}
                  onChange={event => updateHeader(rule.id, { operation: event.target.value as RequestOverrideOperation })}
                >
                  {OPERATION_OPTIONS.map(option => (
                    <MenuItem key={option.value} value={option.value}>{t(option.label)}</MenuItem>
                  ))}
                </Select>
              </FormControl>
              <FormControl>
                <FormLabel>{t('Header 名称')}</FormLabel>
                <InputBase
                  value={rule.name}
                  disabled={disabled}
                  placeholder="x-codex-window-id"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  className="bg-background font-mono text-xs"
                  onChange={event => updateHeader(rule.id, { name: event.target.value })}
                />
              </FormControl>
              <FormControl>
                <FormLabel>{t('值')}</FormLabel>
                <InputBase
                  value={rule.operation === 'set' ? rule.value : ''}
                  disabled={disabled || rule.operation === 'remove'}
                  placeholder={rule.operation === 'set' ? '{{request_id}}' : t('移除操作不需要值')}
                  autoComplete="off"
                  spellCheck={false}
                  className="bg-background font-mono text-xs"
                  onChange={event => updateHeader(rule.id, { value: event.target.value })}
                />
              </FormControl>
              <Box className="flex items-end">
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  color="inherit"
                  disabled={disabled}
                  aria-label={t('删除 Header 规则 {{index}}', { index: index + 1 })}
                  onClick={() => onChange({
                    ...value,
                    headers: value.headers.filter(item => item.id !== rule.id),
                  })}
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                </Button>
              </Box>
            </Box>
          ))}
        </Box>

        <Box className="grid gap-3">
          <Box className="flex flex-wrap items-center justify-between gap-2">
            <Box>
              <Typography className="text-sm font-medium" component="h5">{t('Body 规则')}</Typography>
              <Typography className="mt-1 text-xs text-muted-foreground" component="p">
                {t('使用点路径设置或移除 JSON 字段；设置操作的值必须是 JSON，例如 true、123、"text" 或对象。')}
              </Typography>
            </Box>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled || value.body.length >= 128}
              onClick={() => onChange({ ...value, body: [...value.body, emptyBodyRule()] })}
            >
              <Plus className="size-3.5" aria-hidden="true" />
              {t('添加 Body 规则')}
            </Button>
          </Box>

          {value.body.length === 0 ? (
            <Box className="rounded border border-dashed border-border/60 px-3 py-4 text-center text-xs text-muted-foreground">
              {t('尚未配置 Body 覆写。')}
            </Box>
          ) : value.body.map((rule, index) => {
            const valueError = bodyValueError(rule);
            return (
              <Box
                key={rule.id}
                className="grid gap-3 border border-border/40 bg-background/70 p-3 xl:grid-cols-[8rem_8rem_minmax(14rem,0.9fr)_minmax(16rem,1fr)_2.5rem]"
              >
                <FormControl size="small">
                  <FormLabel>{t('作用域')}</FormLabel>
                  <Select
                    value={rule.scope}
                    disabled={disabled}
                    inputProps={{ 'aria-label': t('Body 规则 {{index}} 作用域', { index: index + 1 }) }}
                    onChange={event => updateBody(rule.id, { scope: event.target.value as RequestOverrideScope })}
                  >
                    {SCOPE_OPTIONS.map(option => (
                      <MenuItem key={option.value} value={option.value}>{t(option.label)}</MenuItem>
                    ))}
                  </Select>
                </FormControl>
                <FormControl size="small">
                  <FormLabel>{t('操作')}</FormLabel>
                  <Select
                    value={rule.operation}
                    disabled={disabled}
                    inputProps={{ 'aria-label': t('Body 规则 {{index}} 操作', { index: index + 1 }) }}
                    onChange={event => updateBody(rule.id, { operation: event.target.value as RequestOverrideOperation })}
                  >
                    {OPERATION_OPTIONS.map(option => (
                      <MenuItem key={option.value} value={option.value}>{t(option.label)}</MenuItem>
                    ))}
                  </Select>
                </FormControl>
                <FormControl>
                  <FormLabel>{t('JSON 点路径')}</FormLabel>
                  <InputBase
                    value={rule.path}
                    disabled={disabled}
                    placeholder="client_metadata.x-codex-window-id"
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    className="bg-background font-mono text-xs"
                    onChange={event => updateBody(rule.id, { path: event.target.value })}
                  />
                </FormControl>
                <FormControl error={Boolean(valueError)}>
                  <FormLabel>{t('JSON 值')}</FormLabel>
                  <InputBase
                    value={rule.operation === 'set' ? rule.valueText : ''}
                    disabled={disabled || rule.operation === 'remove'}
                    placeholder={rule.operation === 'set' ? '"{{request_id}}"' : t('移除操作不需要值')}
                    autoComplete="off"
                    spellCheck={false}
                    multiline
                    minRows={1}
                    className="bg-background font-mono text-xs"
                    onChange={event => updateBody(rule.id, { valueText: event.target.value })}
                  />
                  <FormHelperText>{valueError ?? t('字符串必须包含双引号；对象与数组会递归展开 {{request_id}}。')}</FormHelperText>
                </FormControl>
                <Box className="flex items-end">
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    color="inherit"
                    disabled={disabled}
                    aria-label={t('删除 Body 规则 {{index}}', { index: index + 1 })}
                    onClick={() => onChange({
                      ...value,
                      body: value.body.filter(item => item.id !== rule.id),
                    })}
                  >
                    <Trash2 className="size-4" aria-hidden="true" />
                  </Button>
                </Box>
              </Box>
            );
          })}
        </Box>
      </Box>
    </Box>
  );
}
