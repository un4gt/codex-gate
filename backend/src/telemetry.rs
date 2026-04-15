use std::collections::HashMap;
use std::str::FromStr;
use std::time::Duration;

use log::{error, info, warn};
use rust_decimal::Decimal;
use tokio::sync::mpsc;

use crate::db::{Database, DbError};
use crate::types::{RequestLogRow, StatsDailyRow, Usage};
use crate::util;

pub const COST_SCALE: u32 = 15;
const MILLIS_PER_DAY: i64 = 86_400_000;
const RETENTION_MAX_BATCHES_PER_RUN: usize = 4;

#[derive(Clone, Debug)]
pub struct TelemetryEvent {
    pub api_key_id: i64,
    pub log_enabled: bool,

    pub provider_id: Option<i64>,
    pub endpoint_id: Option<i64>,
    pub upstream_key_id: Option<i64>,

    pub api_format: &'static str,
    pub model: Option<String>,
    pub http_status: Option<i32>,
    pub error_type: Option<String>,
    pub error_message: Option<String>,

    pub t_stream_ms: Option<i64>,
    pub t_first_byte_ms: Option<i64>,
    pub t_first_token_ms: Option<i64>,
    pub duration_ms: Option<i64>,

    pub usage: Usage,
    pub cost_in_usd: Decimal,
    pub cost_out_usd: Decimal,
    pub time_ms: i64,
}

#[derive(Clone, Debug)]
pub struct RetentionPolicy {
    pub request_log_retention_days: u32,
    pub stats_daily_retention_days: u32,
    pub cleanup_interval: Duration,
    pub delete_batch: usize,
    pub request_log_archive_enabled: bool,
    pub request_log_archive_dir: String,
    pub request_log_archive_compress: bool,
}

impl RetentionPolicy {
    pub fn new(
        request_log_retention_days: u32,
        stats_daily_retention_days: u32,
        cleanup_interval: Duration,
        delete_batch: usize,
        request_log_archive_enabled: bool,
        request_log_archive_dir: String,
        request_log_archive_compress: bool,
    ) -> Self {
        Self {
            request_log_retention_days,
            stats_daily_retention_days,
            cleanup_interval,
            delete_batch: delete_batch.max(1),
            request_log_archive_enabled,
            request_log_archive_dir,
            request_log_archive_compress,
        }
    }

    fn enabled(&self) -> bool {
        self.request_log_retention_days > 0 || self.stats_daily_retention_days > 0
    }
}

#[derive(Clone)]
pub struct Telemetry {
    tx: mpsc::Sender<TelemetryEvent>,
}

impl Telemetry {
    pub async fn start(
        db: Database,
        flush_interval: Duration,
        queue_capacity: usize,
        retention: RetentionPolicy,
    ) -> Result<Self, DbError> {
        let (tx, rx) = mpsc::channel(queue_capacity.max(1));

        let mut worker =
            TelemetryWorker::new(db, flush_interval, queue_capacity.max(1), retention).await?;
        tokio::spawn(async move { worker.run(rx).await });

        Ok(Self { tx })
    }

    pub async fn reserve_permit(
        &self,
    ) -> Result<mpsc::OwnedPermit<TelemetryEvent>, mpsc::error::SendError<()>> {
        self.tx.clone().reserve_owned().await
    }
}

#[derive(Clone, Debug, Default)]
struct StatsAgg {
    request_success: i64,
    request_failed: i64,
    input_tokens: i64,
    output_tokens: i64,
    cache_read_input_tokens: i64,
    cache_creation_input_tokens: i64,
    cost_in_usd: Decimal,
    cost_out_usd: Decimal,
    wait_time_ms: i64,
}

impl StatsAgg {
    fn add(
        &mut self,
        ok: bool,
        usage: &Usage,
        cost_in: Decimal,
        cost_out: Decimal,
        wait_time_ms: i64,
    ) {
        if ok {
            self.request_success += 1;
        } else {
            self.request_failed += 1;
        }
        self.input_tokens += usage.input_tokens;
        self.output_tokens += usage.output_tokens;
        self.cache_read_input_tokens += usage.cache_read_input_tokens;
        self.cache_creation_input_tokens += usage.cache_creation_input_tokens;
        self.cost_in_usd += cost_in;
        self.cost_out_usd += cost_out;
        self.wait_time_ms += wait_time_ms;
    }
}

struct TelemetryWorker {
    db: Database,
    flush_interval: Duration,
    log_batch_max: usize,
    retention: RetentionPolicy,
    next_retention_run_ms: i64,

    current_date: String,
    stats_by_key: HashMap<i64, StatsAgg>,
    dirty: bool,

    log_buffer: Vec<RequestLogRow>,
}

impl TelemetryWorker {
    async fn new(
        db: Database,
        flush_interval: Duration,
        log_batch_max: usize,
        retention: RetentionPolicy,
    ) -> Result<Self, DbError> {
        let current_date = util::today_yyyymmdd_utc();
        let mut stats_by_key = HashMap::new();

        let rows = db.list_stats_daily_by_date(&current_date).await?;
        for row in rows {
            let cost_in = Decimal::from_str(&row.cost_in_usd).unwrap_or(Decimal::ZERO);
            let cost_out = Decimal::from_str(&row.cost_out_usd).unwrap_or(Decimal::ZERO);
            stats_by_key.insert(
                row.api_key_id,
                StatsAgg {
                    request_success: row.request_success,
                    request_failed: row.request_failed,
                    input_tokens: row.input_tokens,
                    output_tokens: row.output_tokens,
                    cache_read_input_tokens: row.cache_read_input_tokens,
                    cache_creation_input_tokens: row.cache_creation_input_tokens,
                    cost_in_usd: cost_in,
                    cost_out_usd: cost_out,
                    wait_time_ms: row.wait_time_ms,
                },
            );
        }

        let now_ms = util::now_ms();
        let next_retention_run_ms = if retention.enabled() {
            now_ms + retention.cleanup_interval.as_millis().min(i64::MAX as u128) as i64
        } else {
            i64::MAX
        };

        Ok(Self {
            db,
            flush_interval,
            log_batch_max: log_batch_max.max(1),
            retention,
            next_retention_run_ms,
            current_date,
            stats_by_key,
            dirty: false,
            log_buffer: Vec::new(),
        })
    }

    async fn run(&mut self, mut rx: mpsc::Receiver<TelemetryEvent>) {
        let mut ticker = tokio::time::interval(self.flush_interval);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

        loop {
            tokio::select! {
                biased;
                maybe = rx.recv() => {
                    let Some(event) = maybe else {
                        break;
                    };
                    self.on_event(event).await;
                }
                _ = ticker.tick() => {
                    self.maybe_rotate_day().await;
                    self.flush().await;
                    self.maybe_run_retention().await;
                }
            }
        }

        self.maybe_rotate_day().await;
        self.flush().await;
        self.maybe_run_retention().await;
    }

    async fn maybe_rotate_day(&mut self) {
        let now_date = util::today_yyyymmdd_utc();
        if now_date == self.current_date {
            return;
        }

        self.flush().await;
        self.current_date = now_date;
        self.stats_by_key.clear();
        self.dirty = false;

        match self.db.list_stats_daily_by_date(&self.current_date).await {
            Ok(rows) => {
                for row in rows {
                    let cost_in = Decimal::from_str(&row.cost_in_usd).unwrap_or(Decimal::ZERO);
                    let cost_out = Decimal::from_str(&row.cost_out_usd).unwrap_or(Decimal::ZERO);
                    self.stats_by_key.insert(
                        row.api_key_id,
                        StatsAgg {
                            request_success: row.request_success,
                            request_failed: row.request_failed,
                            input_tokens: row.input_tokens,
                            output_tokens: row.output_tokens,
                            cache_read_input_tokens: row.cache_read_input_tokens,
                            cache_creation_input_tokens: row.cache_creation_input_tokens,
                            cost_in_usd: cost_in,
                            cost_out_usd: cost_out,
                            wait_time_ms: row.wait_time_ms,
                        },
                    );
                }
            }
            Err(e) => warn!(
                "failed to load stats for new day {}: {}",
                self.current_date, e
            ),
        }
    }

    async fn on_event(&mut self, event: TelemetryEvent) {
        let ok = event.http_status.unwrap_or(500) < 400 && event.error_type.is_none();
        let wait = event.duration_ms.unwrap_or(0);

        self.stats_by_key.entry(event.api_key_id).or_default().add(
            ok,
            &event.usage,
            event.cost_in_usd,
            event.cost_out_usd,
            wait,
        );

        self.stats_by_key.entry(0).or_default().add(
            ok,
            &event.usage,
            event.cost_in_usd,
            event.cost_out_usd,
            wait,
        );

        self.dirty = true;

        if event.log_enabled {
            let id = util::new_ulid();
            let mut err_msg = event.error_message;
            if let Some(ref mut s) = err_msg
                && s.len() > 512
            {
                s.truncate(512);
            }

            let log_row = RequestLogRow {
                id,
                time_ms: event.time_ms,
                api_key_id: event.api_key_id,
                provider_id: event.provider_id,
                endpoint_id: event.endpoint_id,
                upstream_key_id: event.upstream_key_id,
                api_format: event.api_format.to_string(),
                model: event.model,
                http_status: event.http_status,
                error_type: event.error_type,
                error_message: err_msg,
                input_tokens: event.usage.input_tokens,
                output_tokens: event.usage.output_tokens,
                cache_read_input_tokens: event.usage.cache_read_input_tokens,
                cache_creation_input_tokens: event.usage.cache_creation_input_tokens,
                cost_in_usd: to_cost_storage(event.cost_in_usd),
                cost_out_usd: to_cost_storage(event.cost_out_usd),
                cost_total_usd: to_cost_storage(event.cost_in_usd + event.cost_out_usd),
                t_stream_ms: event.t_stream_ms,
                t_first_byte_ms: event.t_first_byte_ms,
                t_first_token_ms: event.t_first_token_ms,
                duration_ms: event.duration_ms,
                created_at_ms: util::now_ms(),
            };

            self.log_buffer.push(log_row);
            if self.log_buffer.len() >= self.log_batch_max {
                self.flush_logs().await;
            }
        }
    }

    async fn flush(&mut self) {
        if self.dirty {
            // Only clear the dirty flag if the flush succeeds.
            // `flush_stats()` will set it back to true on error.
            self.dirty = false;
            self.flush_stats().await;
        }
        if !self.log_buffer.is_empty() {
            self.flush_logs().await;
        }
    }

    async fn flush_stats(&mut self) {
        let now_ms = util::now_ms();
        let mut rows = Vec::with_capacity(self.stats_by_key.len());
        for (api_key_id, agg) in &self.stats_by_key {
            rows.push(StatsDailyRow {
                date: self.current_date.clone(),
                api_key_id: *api_key_id,
                request_success: agg.request_success,
                request_failed: agg.request_failed,
                input_tokens: agg.input_tokens,
                output_tokens: agg.output_tokens,
                cache_read_input_tokens: agg.cache_read_input_tokens,
                cache_creation_input_tokens: agg.cache_creation_input_tokens,
                cost_in_usd: to_cost_storage(agg.cost_in_usd),
                cost_out_usd: to_cost_storage(agg.cost_out_usd),
                cost_total_usd: to_cost_storage(agg.cost_in_usd + agg.cost_out_usd),
                wait_time_ms: agg.wait_time_ms,
                updated_at_ms: now_ms,
            });
        }

        if let Err(e) = self.db.upsert_stats_daily(&rows).await {
            error!("failed to upsert stats_daily: {}", e);
            self.dirty = true;
        }
    }

    async fn flush_logs(&mut self) {
        if self.log_buffer.is_empty() {
            return;
        }

        let batch = std::mem::take(&mut self.log_buffer);
        if let Err(e) = self.db.insert_request_logs(&batch).await {
            error!(
                "failed to insert request_logs (dropping {} logs): {}",
                batch.len(),
                e
            );
        }
    }

    async fn maybe_run_retention(&mut self) {
        if !self.retention.enabled() {
            return;
        }

        let now_ms = util::now_ms();
        if now_ms < self.next_retention_run_ms {
            return;
        }

        self.next_retention_run_ms = now_ms
            + self
                .retention
                .cleanup_interval
                .as_millis()
                .min(i64::MAX as u128) as i64;

        let batch = self.retention.delete_batch as i64;
        let mut deleted_request_logs = 0_u64;
        let mut archived_request_logs = 0_u64;
        let mut deleted_stats_daily = 0_u64;

        if self.retention.request_log_retention_days > 0 {
            let cutoff_time_ms = now_ms.saturating_sub(
                (self.retention.request_log_retention_days as i64).saturating_mul(MILLIS_PER_DAY),
            );
            for _ in 0..RETENTION_MAX_BATCHES_PER_RUN {
                let rows = match self
                    .db
                    .list_request_logs_before(cutoff_time_ms, batch)
                    .await
                {
                    Ok(rows) => rows,
                    Err(e) => {
                        warn!(
                            "failed to list request_logs for archive before {}: {}",
                            cutoff_time_ms, e
                        );
                        break;
                    }
                };
                if rows.is_empty() {
                    break;
                }

                if self.retention.request_log_archive_enabled {
                    match crate::log_archive::archive_request_logs_jsonl(
                        &self.retention.request_log_archive_dir,
                        &rows,
                        self.retention.request_log_archive_compress,
                    )
                    .await
                    {
                        Ok(Some(result)) => {
                            archived_request_logs += result.row_count as u64;
                            info!(
                                "archived {} request_logs rows to {} (compressed={}, file_size={}B, raw_size={}B, index={})",
                                result.row_count,
                                result.path.display(),
                                result.compressed,
                                result.file_size_bytes,
                                result.uncompressed_bytes,
                                result.index_path.display(),
                            );
                        }
                        Ok(None) => {}
                        Err(e) => {
                            warn!(
                                "failed to archive request_logs batch before {}: {}",
                                cutoff_time_ms, e
                            );
                            break;
                        }
                    }
                }

                match self
                    .db
                    .delete_request_logs_before(cutoff_time_ms, batch)
                    .await
                {
                    Ok(removed) => {
                        deleted_request_logs += removed;
                        if removed < batch as u64 {
                            break;
                        }
                    }
                    Err(e) => {
                        warn!(
                            "failed to cleanup request_logs before {}: {}",
                            cutoff_time_ms, e
                        );
                        break;
                    }
                }
            }
        }

        if self.retention.stats_daily_retention_days > 0 {
            let cutoff_date = util::yyyymmdd_utc_days_ago(
                self.retention.stats_daily_retention_days.saturating_sub(1) as i64,
            );
            for _ in 0..RETENTION_MAX_BATCHES_PER_RUN {
                match self.db.delete_stats_daily_before(&cutoff_date, batch).await {
                    Ok(removed) => {
                        deleted_stats_daily += removed;
                        if removed < batch as u64 {
                            break;
                        }
                    }
                    Err(e) => {
                        warn!(
                            "failed to cleanup stats_daily before {}: {}",
                            cutoff_date, e
                        );
                        break;
                    }
                }
            }
        }

        if deleted_request_logs > 0 || deleted_stats_daily > 0 || archived_request_logs > 0 {
            info!(
                "retention cleanup archived {} request_logs rows, removed {} request_logs rows and {} stats_daily rows",
                archived_request_logs, deleted_request_logs, deleted_stats_daily
            );
        }
    }
}

fn to_cost_storage(v: Decimal) -> String {
    v.round_dp_with_strategy(
        COST_SCALE,
        rust_decimal::RoundingStrategy::MidpointAwayFromZero,
    )
    .normalize()
    .to_string()
}
