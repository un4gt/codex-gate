use std::time::{SystemTime, UNIX_EPOCH};

use time::format_description;
use time::{Duration, OffsetDateTime};

pub fn now_ms() -> i64 {
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    dur.as_millis() as i64
}

pub fn today_yyyymmdd_utc() -> String {
    let now = OffsetDateTime::now_utc();
    // YYYYMMDD
    let fmt = format_description::parse("[year][month][day]").expect("valid time format");
    now.format(&fmt).unwrap_or_else(|_| "19700101".to_string())
}

pub fn yyyymmdd_utc_days_ago(days_back: i64) -> String {
    let fmt = format_description::parse("[year][month][day]").expect("valid time format");
    let now = OffsetDateTime::now_utc() - Duration::days(days_back.max(0));
    now.format(&fmt).unwrap_or_else(|_| "19700101".to_string())
}

pub fn process_resident_memory_bytes() -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    for line in status.lines() {
        let Some(rest) = line.strip_prefix("VmRSS:") else {
            continue;
        };
        let kb = rest.split_whitespace().next()?.parse::<u64>().ok()?;
        return Some(kb.saturating_mul(1024));
    }
    None
}

pub fn new_ulid() -> String {
    ulid::Ulid::new().to_string()
}
