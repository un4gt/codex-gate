import { t } from './i18n';
import type { RoutingAvailability } from './types';
const reasons: Record<string, string> = {
  provider_disabled: '上游已禁用', account_disabled: '账户已禁用', reauth_required: '需要重新登录',
  account_forbidden: '账户无访问权限', quota_unavailable: '额度不可用', no_allowed_models: '无允许路由的模型',
  provider_circuit_open: '上游熔断中', provider_capacity_exhausted: '上游并发已满', account_unhealthy: '账户健康检查不可用',
  no_available_endpoint: '无可用连接目标', no_available_accounts: '无可用账户', account_removed: '账户已移除',
};
export function routingAvailabilityLabel(value: RoutingAvailability | undefined): string {
  if (!value) return t('状态未确认');
  if (value.available) return t('可用');
  return t(reasons[value.reason ?? ''] ?? value.reason ?? '不可用');
}
