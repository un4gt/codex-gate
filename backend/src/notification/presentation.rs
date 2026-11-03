use chrono::{DateTime, Utc};
use chrono_tz::Tz;
use rust_decimal::Decimal;
use serde::Serialize;

use super::report::{NotificationPayload, WindowPayload};

#[derive(Serialize)]
pub(super) struct WindowDisplay {
    pub from: String,
    pub to: String,
    pub timezone: String,
}

pub(super) fn window_display(window: &WindowPayload) -> WindowDisplay {
    let timezone = window.timezone.parse::<Tz>().unwrap_or(chrono_tz::UTC);
    WindowDisplay {
        from: timestamp(window.from_ms, timezone),
        to: timestamp(window.to_ms, timezone),
        timezone: timezone.to_string(),
    }
}

pub(super) fn timestamp(ms: i64, timezone: Tz) -> String {
    DateTime::<Utc>::from_timestamp_millis(ms)
        .map(|date| {
            date.with_timezone(&timezone)
                .format("%y-%m-%d %H:%M:%S")
                .to_string()
        })
        .unwrap_or_else(|| "—".into())
}

pub(super) fn percent(value: Option<f64>) -> String {
    value
        .filter(|value| value.is_finite())
        .map_or_else(|| "—".into(), |value| format!("{value:.2}%"))
}

pub(super) fn integer(value: i64) -> String {
    let digits = value.unsigned_abs().to_string();
    let mut out = if value < 0 { "-".into() } else { String::new() };
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

pub(super) fn cost(value: &str) -> String {
    let Ok(value) = value.parse::<Decimal>() else {
        return "—".into();
    };
    let rounded = value.round_dp(4);
    if value > Decimal::ZERO && rounded.is_zero() {
        "<$0.0001".into()
    } else {
        format!("${}", rounded.normalize())
    }
}

pub(super) fn title(payload: &NotificationPayload) -> String {
    let label = match (
        payload.rule.locale.as_str(),
        payload.event.event_type.as_str(),
    ) {
        ("en-US", "alert_triggered") => "[Alert] ",
        ("en-US", "alert_reminder") => "[Ongoing alert] ",
        ("en-US", "alert_recovered") => "[Recovered] ",
        (_, "alert_triggered") => "[告警] ",
        (_, "alert_reminder") => "[持续告警] ",
        (_, "alert_recovered") => "[已恢复] ",
        _ => "",
    };
    format!("{label}{}", payload.rule.name)
}

pub(super) fn truncate_utf8_bytes(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_owned();
    }
    let suffix = if max_bytes >= '…'.len_utf8() {
        "…"
    } else {
        ""
    };
    let mut end = max_bytes - suffix.len();
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{suffix}", &value[..end])
}

pub(super) fn truncate_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_owned();
    }
    let mut out = value
        .chars()
        .take(max_chars.saturating_sub(1))
        .collect::<String>();
    if max_chars > 0 {
        out.push('…');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_and_numbers_are_readable_without_changing_source_precision() {
        assert_eq!(
            timestamp(1_793_387_656_921, chrono_tz::Asia::Shanghai),
            "26-10-31 03:14:16"
        );
        assert_eq!(
            timestamp(1_793_387_956_921, chrono_tz::UTC),
            "26-10-30 19:19:16"
        );
        assert_eq!(percent(Some(0.2654740820507333)), "0.27%");
        assert_eq!(percent(None), "—");
        assert_eq!(integer(2_390_068), "2,390,068");
        assert_eq!(cost("2.556272"), "$2.5563");
        assert_eq!(cost("0.000001"), "<$0.0001");
    }
}
