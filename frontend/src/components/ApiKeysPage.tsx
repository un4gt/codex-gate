import { useState, type FormEvent } from 'react';
import { Copy, Plus, Power, Trash2 } from "lucide-react";
import { DetailDrawer } from '@/components/console/DetailDrawer';
import { EmptyState } from '@/components/console/EmptyState';
import { PageHeader } from '@/components/console/PageHeader';
import { StatsGrid } from '@/components/console/StatsGrid';
import { StatusBadge } from '@/components/console/StatusBadge';
import { t } from '@/lib/i18n';
import { createApiKey, deleteApiKey, updateApiKey } from '../lib/api';
import { formatCompactInteger, formatDateTime, formatDateTimeLocalInput, parseDateTimeLocalInput } from '../lib/format';
import type { ApiKeyWorkspace, ConnectionSettings, CreateApiKeyInput, CreatedApiKey, UpdateApiKeyInput } from '../lib/types';
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Checkbox from "@mui/material/Checkbox";
import FormControl from "@mui/material/FormControl";
import FormHelperText from "@mui/material/FormHelperText";
import FormLabel from "@mui/material/FormLabel";
import InputBase from "@mui/material/InputBase";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TableContainer from "@mui/material/TableContainer";
import Typography from "@mui/material/Typography";
interface ApiKeysPageProps {
  settings: ConnectionSettings;
  items: ApiKeyWorkspace[];
  onRefresh: (successMessage?: string) => Promise<void>;
  onMessage: (message: string) => void;
}
function readString(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '').trim();
}
function readBool(formData: FormData, key: string): boolean {
  return formData.get(key) === 'on';
}
function isExpiringSoon(expiresAtMs: number | null) {
  return typeof expiresAtMs === 'number' && expiresAtMs - Date.now() < 7 * 24 * 60 * 60 * 1000;
}
function keyStatus(item: ApiKeyWorkspace) {
  if (!item.apiKey.enabled) return {
    label: '停用',
    tone: 'disabled' as const
  };
  if (isExpiringSoon(item.apiKey.expires_at_ms)) return {
    label: '即将过期',
    tone: 'warning' as const
  };
  return {
    label: '启用',
    tone: 'normal' as const
  };
}
export function ApiKeysPage(props: ApiKeysPageProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const selected = props.items.find(item => item.apiKey.id === selectedId) ?? null;
  const openCreateDrawer = () => {
    setCreated(null);
    setCreateOpen(true);
  };
  const closeCreateDrawer = () => {
    setCreateOpen(false);
    setCreated(null);
  };
  const ensureLive = () => {
    if (!props.settings.adminToken.trim()) {
      props.onMessage('请先填写管理员口令。');
      return false;
    }
    return true;
  };
  const submitCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!ensureLive()) return;
    const formData = new FormData(event.currentTarget);
    const payload: CreateApiKeyInput = {
      name: readString(formData, 'name'),
      enabled: readBool(formData, 'enabled'),
      log_enabled: readBool(formData, 'log_enabled'),
      expires_at_ms: parseDateTimeLocalInput(readString(formData, 'expires_at'))
    };
    if (!payload.name) {
      props.onMessage('密钥名称不能为空。');
      return;
    }
    setBusy('create');
    try {
      const result = await createApiKey(props.settings, payload);
      setCreated(result);
      await props.onRefresh(t('密钥 {{name}} 已创建。', {
        name: payload.name
      }));
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '创建密钥失败。');
    } finally {
      setBusy(null);
    }
  };
  const submitUpdate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const current = selected;
    if (!current || !ensureLive()) return;
    const formData = new FormData(event.currentTarget);
    const payload: UpdateApiKeyInput = {
      name: readString(formData, 'name'),
      enabled: readBool(formData, 'enabled'),
      log_enabled: readBool(formData, 'log_enabled'),
      expires_at_ms: parseDateTimeLocalInput(readString(formData, 'expires_at'))
    };
    if (!payload.name) {
      props.onMessage('密钥名称不能为空。');
      return;
    }
    setBusy(`update-${current.apiKey.id}`);
    try {
      await updateApiKey(props.settings, current.apiKey.id, payload);
      await props.onRefresh(t('密钥 {{name}} 已更新。', {
        name: payload.name
      }));
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '更新密钥失败。');
    } finally {
      setBusy(null);
    }
  };
  const toggleEnabled = async (item: ApiKeyWorkspace, enabled: boolean) => {
    if (!ensureLive()) return;
    setBusy(`toggle-${item.apiKey.id}`);
    try {
      await updateApiKey(props.settings, item.apiKey.id, {
        enabled
      });
      await props.onRefresh(t(enabled ? '密钥 {{name}} 已启用。' : '密钥 {{name}} 已停用。', {
        name: item.apiKey.name
      }));
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '更新状态失败。');
    } finally {
      setBusy(null);
    }
  };
  const handleDelete = async (item: ApiKeyWorkspace) => {
    if (!ensureLive()) return;
    const confirmed = window.confirm(t('删除密钥“{{name}}”？该操作不可撤销。', {
      name: item.apiKey.name
    }));
    if (!confirmed) return;
    setBusy(`delete-${item.apiKey.id}`);
    try {
      await deleteApiKey(props.settings, item.apiKey.id);
      setSelectedId(current => current === item.apiKey.id ? null : current);
      await props.onRefresh(t('密钥 {{name}} 已删除。', {
        name: item.apiKey.name
      }));
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '删除密钥失败。');
    } finally {
      setBusy(null);
    }
  };
  const stats = () => [{
    label: '密钥总数',
    value: formatCompactInteger(props.items.length),
    hint: '当前已创建的访问密钥'
  }, {
    label: '启用中',
    value: formatCompactInteger(props.items.filter(item => item.apiKey.enabled).length),
    hint: '可立即发起请求'
  }, {
    label: '即将过期',
    value: formatCompactInteger(props.items.filter(item => isExpiringSoon(item.apiKey.expires_at_ms)).length),
    hint: '7 天内到期'
  }, {
    label: '记录日志',
    value: formatCompactInteger(props.items.filter(item => item.apiKey.log_enabled).length),
    hint: '开启请求元数据'
  }];
  return <Box className="section-stack">
      <PageHeader title="密钥" description="创建和管理访问密钥。" actions={<Button type="button" onClick={openCreateDrawer}>
            <Plus />{t("创建密钥")}</Button>} />

      <StatsGrid items={stats()} />

      <Card>
        <Box className="flex flex-col gap-3 p-6 pb-5">
          <Typography className="text-xl font-semibold tracking-normal text-foreground" component="div">{t("密钥列表")}</Typography>
          <Typography className="mt-1 text-sm leading-5 text-muted-foreground" component="div">{t("优先展示正在使用的密钥。")}</Typography>
        </Box>
        <CardContent>
          {props.items.length > 0 ? <TableContainer><Table>
              <TableHead>
                <TableRow>
                  <TableCell>{t("密钥")}</TableCell>
                  <TableCell>{t("状态")}</TableCell>
                  <TableCell>{t("日志")}</TableCell>
                  <TableCell>{t("到期")}</TableCell>
                  <TableCell className="text-right">{t("操作")}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {props.items.map(item => {
              const status = keyStatus(item);
              return <TableRow key={item.apiKey.id} className="cursor-pointer" onClick={() => setSelectedId(item.apiKey.id)}>
                        <TableCell>
                          <Box className="flex flex-col gap-1">
                            <Box className="text-sm font-medium text-foreground" component="strong">{item.apiKey.name}</Box>
                            <Box className="text-xs text-muted-foreground" component="span">#{item.apiKey.id}</Box>
                          </Box>
                        </TableCell>
                        <TableCell>
                          <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                        </TableCell>
                        <TableCell>{t(item.apiKey.log_enabled ? '开启' : '关闭')}</TableCell>
                        <TableCell>{item.apiKey.expires_at_ms ? formatDateTime(item.apiKey.expires_at_ms) : t('不过期')}</TableCell>
                        <TableCell className="text-right">
                          <Box className="flex justify-end gap-2">
                            <Button type="button" size="sm" variant="ghost" onClick={event => {
                      event.stopPropagation();
                      setSelectedId(item.apiKey.id);
                    }}>{t("查看")}</Button>
                            <Button type="button" size="sm" variant="ghost" aria-label={item.apiKey.enabled ? t('停用密钥') : t('启用密钥')} disabled={busy === `toggle-${item.apiKey.id}`} onClick={event => {
                      event.stopPropagation();
                      void toggleEnabled(item, !item.apiKey.enabled);
                    }}>
                              <Power />
                            </Button>
                          </Box>
                        </TableCell>
                      </TableRow>;
            })}
              </TableBody>
            </Table></TableContainer> : <EmptyState title="还没有密钥" description="先创建第一条访问密钥，再提供给接入方使用。" action={<Button type="button" onClick={openCreateDrawer}>{t("创建密钥")}</Button>} />}
        </CardContent>
      </Card>

      <DetailDrawer open={createOpen} title="创建密钥" description="填写必要信息后立即生成。" onClose={closeCreateDrawer}>
        <Box className="flex flex-col gap-4" onSubmit={event => void submitCreate(event)} component="form">
          <Box className="flex flex-col gap-6">
            <FormControl>
              <FormLabel>{t("名称")}</FormLabel>
              <InputBase name="name" placeholder={t("team-default")} />
            </FormControl>
            <FormControl>
              <FormLabel>{t("到期时间")}</FormLabel>
              <InputBase name="expires_at" type="datetime-local" />
              <FormHelperText>{t("留空表示不过期。")}</FormHelperText>
            </FormControl>
          </Box>
          <Box className="grid gap-3 md:grid-cols-2">
            <Box className="check-row" component="label">
              <Checkbox name="enabled" defaultChecked />
              <Box component="span">{t('创建后立即启用')}</Box>
            </Box>
            <Box className="check-row" component="label">
              <Checkbox name="log_enabled" defaultChecked />
              <Box component="span">{t('记录请求元数据')}</Box>
            </Box>
          </Box>
          <Button type="submit" disabled={busy === 'create'}>
            {t(busy === 'create' ? '创建中…' : '创建密钥')}
          </Button>
          {created ? (createdKey => <Card className="border-emerald-500/40 bg-emerald-500/10">
                <CardContent className="flex flex-col gap-2 p-4">
                  <Box className="text-sm font-medium text-foreground">{t('明文密钥只展示一次')}</Box>
                  <Box className="break-all text-sm text-foreground" component="code">{createdKey.api_key}</Box>
                  <Box>
                    <Button type="button" size="sm" variant="outline" onClick={() => void navigator.clipboard.writeText(createdKey.api_key).then(() => props.onMessage(t('新密钥已复制。')))}>
                      <Copy />{t("复制")}</Button>
                  </Box>
                </CardContent>
              </Card>)(created) : null}
        </Box>
      </DetailDrawer>

      <DetailDrawer open={!!selected} title={selected?.apiKey.name ?? '密钥详情'} description={selected ? `查看并维护 #${selected.apiKey.id}` : undefined} onClose={() => setSelectedId(null)}>
        {selected ? (item => {
        const data = item;
        const status = keyStatus(data);
        return <Box className="flex flex-col gap-6">
                <Box className="grid gap-3 md:grid-cols-3">
                  <Box className="surface-tile">
                      <Box className="surface-label">{t('状态')}</Box>
                      <Box className="mt-2">
                        <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                      </Box>
                  </Box>
                  <Box className="surface-tile">
                      <Box className="surface-label">{t('请求元数据')}</Box>
                      <Box className="mt-2 text-xl font-semibold text-foreground">{t(data.apiKey.log_enabled ? '开启' : '关闭')}</Box>
                  </Box>
                  <Box className="surface-tile">
                      <Box className="surface-label">{t('到期')}</Box>
                      <Box className="mt-2 text-xl font-semibold text-foreground">{data.apiKey.expires_at_ms ? formatDateTime(data.apiKey.expires_at_ms) : t('不过期')}</Box>
                  </Box>
                </Box>

                <Box className="flex flex-col gap-4" onSubmit={event => void submitUpdate(event)} component="form">
                  <Box className="flex flex-col gap-6">
                    <FormControl>
                      <FormLabel>{t("名称")}</FormLabel>
                      <InputBase name="name" defaultValue={data.apiKey.name} />
                    </FormControl>
                    <FormControl>
                      <FormLabel>{t("到期时间")}</FormLabel>
                      <InputBase name="expires_at" type="datetime-local" defaultValue={formatDateTimeLocalInput(data.apiKey.expires_at_ms)} />
                    </FormControl>
                  </Box>

                  <Box className="grid gap-3 md:grid-cols-2">
                    <Box className="check-row" component="label">
                      <Checkbox name="enabled" defaultChecked={data.apiKey.enabled} />
                      <Box component="span">{t('启用密钥')}</Box>
                    </Box>
                    <Box className="check-row" component="label">
                      <Checkbox name="log_enabled" defaultChecked={data.apiKey.log_enabled} />
                      <Box component="span">{t('记录请求元数据')}</Box>
                    </Box>
                  </Box>

                  <Box className="flex flex-wrap gap-2">
                    <Button type="submit" disabled={busy === `update-${data.apiKey.id}`}>
                      {t(busy === `update-${data.apiKey.id}` ? '保存中…' : '保存更改')}
                    </Button>
                    <Button type="button" variant="outline" disabled={busy === `toggle-${data.apiKey.id}`} onClick={() => void toggleEnabled(data, !data.apiKey.enabled)}>
                      <Power />
                      {t(data.apiKey.enabled ? '停用' : '启用')}
                    </Button>
                    <Button type="button" variant="outline" disabled={busy === `delete-${data.apiKey.id}`} onClick={() => void handleDelete(data)}>
                      <Trash2 />{t("删除")}</Button>
                  </Box>
                </Box>
              </Box>;
      })(selected) : null}
      </DetailDrawer>
    </Box>;
}
