use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::RwLock;
use serde::Serialize;
use serde_json::Value;

use crate::config::Config;
use crate::db::Database;
use crate::selector::EndpointSelectorStrategy;

#[derive(Clone, Debug)]
pub struct RuntimeSettingsSnapshot {
    pub inject_include_usage: bool,
    pub endpoint_selector_strategy: EndpointSelectorStrategy,
    pub usage_capture_bytes: usize,
    pub usage_capture_tail_bytes: usize,
    pub request_log_retention_days: u32,
    pub stats_daily_retention_days: u32,
}

impl RuntimeSettingsSnapshot {
    pub fn from_config(config: &Config) -> Self {
        Self {
            inject_include_usage: config.inject_include_usage,
            endpoint_selector_strategy: config.endpoint_selector_strategy,
            usage_capture_bytes: config.usage_capture_bytes,
            usage_capture_tail_bytes: config.usage_capture_tail_bytes,
            request_log_retention_days: config.request_log_retention_days,
            stats_daily_retention_days: config.stats_daily_retention_days,
        }
    }

    fn apply_value(&mut self, key: &str, value: &Value) -> Result<(), String> {
        match key {
            "inject_include_usage" => {
                self.inject_include_usage = value
                    .as_bool()
                    .ok_or_else(|| "inject_include_usage must be boolean".to_string())?;
            }
            "endpoint_selector_strategy" => {
                let raw = value
                    .as_str()
                    .ok_or_else(|| "endpoint_selector_strategy must be string".to_string())?;
                self.endpoint_selector_strategy = EndpointSelectorStrategy::parse(raw)
                    .ok_or_else(|| "invalid endpoint_selector_strategy".to_string())?;
            }
            "usage_capture_bytes" => {
                self.usage_capture_bytes = json_usize(value, key)?.max(1);
                self.usage_capture_tail_bytes =
                    self.usage_capture_tail_bytes.min(self.usage_capture_bytes);
            }
            "usage_capture_tail_bytes" => {
                self.usage_capture_tail_bytes =
                    json_usize(value, key)?.min(self.usage_capture_bytes);
            }
            "request_log_retention_days" => {
                self.request_log_retention_days = json_u32(value, key)?;
            }
            "stats_daily_retention_days" => {
                self.stats_daily_retention_days = json_u32(value, key)?;
            }
            _ => return Err(format!("unsupported runtime setting: {key}")),
        }
        Ok(())
    }
}

#[derive(Clone)]
pub struct RuntimeSettings {
    defaults: RuntimeSettingsSnapshot,
    current: Arc<RwLock<RuntimeSettingsSnapshot>>,
}

#[derive(Clone, Debug, Serialize)]
pub struct RuntimeSettingView {
    pub key: &'static str,
    pub group: &'static str,
    pub label: &'static str,
    pub value: Value,
    pub default_value: Value,
    pub editable: bool,
    pub requires_restart: bool,
    pub updated_at_ms: Option<i64>,
}

struct RuntimeSettingSpec {
    key: &'static str,
    group: &'static str,
    label: &'static str,
    editable: bool,
    requires_restart: bool,
}

const SPECS: &[RuntimeSettingSpec] = &[
    RuntimeSettingSpec {
        key: "inject_include_usage",
        group: "routing",
        label: "返回用量",
        editable: true,
        requires_restart: false,
    },
    RuntimeSettingSpec {
        key: "endpoint_selector_strategy",
        group: "routing",
        label: "节点分配",
        editable: true,
        requires_restart: false,
    },
    RuntimeSettingSpec {
        key: "usage_capture_bytes",
        group: "telemetry",
        label: "用量采样",
        editable: true,
        requires_restart: false,
    },
    RuntimeSettingSpec {
        key: "usage_capture_tail_bytes",
        group: "telemetry",
        label: "尾部采样",
        editable: true,
        requires_restart: false,
    },
    RuntimeSettingSpec {
        key: "request_log_retention_days",
        group: "retention",
        label: "日志保留",
        editable: true,
        requires_restart: false,
    },
    RuntimeSettingSpec {
        key: "stats_daily_retention_days",
        group: "retention",
        label: "统计保留",
        editable: true,
        requires_restart: false,
    },
    RuntimeSettingSpec {
        key: "db_max_connections",
        group: "runtime",
        label: "数据库连接",
        editable: false,
        requires_restart: true,
    },
    RuntimeSettingSpec {
        key: "max_request_bytes",
        group: "runtime",
        label: "请求大小",
        editable: false,
        requires_restart: true,
    },
];

impl RuntimeSettings {
    pub async fn load(config: &Config, db: &Database) -> Result<Self, String> {
        let defaults = RuntimeSettingsSnapshot::from_config(config);
        let mut current = defaults.clone();
        for row in db
            .list_runtime_settings()
            .await
            .map_err(|e| e.to_string())?
        {
            let value: Value = serde_json::from_str(&row.value_json)
                .map_err(|e| format!("invalid runtime setting {}: {e}", row.key))?;
            current.apply_value(&row.key, &value)?;
        }
        Ok(Self {
            defaults,
            current: Arc::new(RwLock::new(current)),
        })
    }

    pub fn snapshot(&self) -> RuntimeSettingsSnapshot {
        self.current.read().clone()
    }

    pub async fn update(
        &self,
        db: &Database,
        key: &str,
        value: Value,
        now_ms: i64,
    ) -> Result<(), String> {
        let spec = spec_for(key).ok_or_else(|| "unknown setting".to_string())?;
        if !spec.editable {
            return Err("setting requires restart".to_string());
        }

        let mut next = self.snapshot();
        next.apply_value(key, &value)?;
        let value_json = serde_json::to_string(&value).map_err(|e| e.to_string())?;
        db.upsert_runtime_setting(key, &value_json, now_ms)
            .await
            .map_err(|e| e.to_string())?;
        *self.current.write() = next;
        Ok(())
    }

    pub async fn views(
        &self,
        config: &Config,
        db: &Database,
    ) -> Result<Vec<RuntimeSettingView>, String> {
        let rows = db
            .list_runtime_settings()
            .await
            .map_err(|e| e.to_string())?;
        let updated_by_key = rows
            .into_iter()
            .map(|row| (row.key, row.updated_at_ms))
            .collect::<HashMap<_, _>>();
        let current = self.snapshot();
        let mut out = Vec::with_capacity(SPECS.len());
        for spec in SPECS {
            out.push(RuntimeSettingView {
                key: spec.key,
                group: spec.group,
                label: spec.label,
                value: value_for(spec.key, &current, config),
                default_value: value_for(spec.key, &self.defaults, config),
                editable: spec.editable,
                requires_restart: spec.requires_restart,
                updated_at_ms: updated_by_key.get(spec.key).copied(),
            });
        }
        Ok(out)
    }
}

fn spec_for(key: &str) -> Option<&'static RuntimeSettingSpec> {
    SPECS.iter().find(|spec| spec.key == key)
}

fn value_for(key: &str, settings: &RuntimeSettingsSnapshot, config: &Config) -> Value {
    match key {
        "inject_include_usage" => Value::Bool(settings.inject_include_usage),
        "endpoint_selector_strategy" => {
            Value::String(format!("{:?}", settings.endpoint_selector_strategy).to_ascii_lowercase())
        }
        "usage_capture_bytes" => Value::from(settings.usage_capture_bytes as u64),
        "usage_capture_tail_bytes" => Value::from(settings.usage_capture_tail_bytes as u64),
        "request_log_retention_days" => Value::from(settings.request_log_retention_days),
        "stats_daily_retention_days" => Value::from(settings.stats_daily_retention_days),
        "db_max_connections" => Value::from(config.db_max_connections),
        "max_request_bytes" => Value::from(config.max_request_bytes as u64),
        _ => Value::Null,
    }
}

fn json_usize(value: &Value, key: &str) -> Result<usize, String> {
    let raw = value
        .as_u64()
        .ok_or_else(|| format!("{key} must be a positive integer"))?;
    usize::try_from(raw).map_err(|_| format!("{key} is too large"))
}

fn json_u32(value: &Value, key: &str) -> Result<u32, String> {
    let raw = value
        .as_u64()
        .ok_or_else(|| format!("{key} must be a positive integer"))?;
    u32::try_from(raw).map_err(|_| format!("{key} is too large"))
}
