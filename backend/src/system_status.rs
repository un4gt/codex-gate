use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Instant;

use serde::Serialize;

const CGROUP_V2_ROOT: &str = "/sys/fs/cgroup";
const HUGE_CGROUP_V1_LIMIT: u64 = 1_u64 << 60;

#[derive(Clone, Debug, Serialize)]
pub struct ServerStatus {
    pub scope: &'static str,
    pub cpu_usage_percent: Option<f64>,
    pub cpu_capacity_cores: f64,
    pub cpu_sample_ms: Option<u64>,
    pub memory_used_bytes: Option<u64>,
    pub memory_total_bytes: Option<u64>,
    pub memory_usage_percent: Option<f64>,
    pub memory_limited: bool,
}

#[derive(Clone, Copy, Debug)]
enum CpuReading {
    Cgroup {
        usage_nanos: u64,
        capacity_cores: f64,
    },
    Host {
        total_ticks: u64,
        idle_ticks: u64,
        capacity_cores: f64,
    },
}

impl CpuReading {
    fn capacity_cores(self) -> f64 {
        match self {
            Self::Cgroup { capacity_cores, .. } | Self::Host { capacity_cores, .. } => {
                capacity_cores
            }
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct CpuSample {
    reading: CpuReading,
    at: Instant,
}

#[derive(Clone, Copy, Debug)]
struct MemoryReading {
    scope: &'static str,
    used_bytes: Option<u64>,
    total_bytes: Option<u64>,
    limited: bool,
}

pub struct SystemStatusMonitor {
    last_cpu: Mutex<Option<CpuSample>>,
}

impl SystemStatusMonitor {
    pub fn new() -> Self {
        Self {
            last_cpu: Mutex::new(read_cpu_reading().map(|reading| CpuSample {
                reading,
                at: Instant::now(),
            })),
        }
    }

    pub fn snapshot(&self) -> ServerStatus {
        let memory = read_memory_reading();
        let current = read_cpu_reading().map(|reading| CpuSample {
            reading,
            at: Instant::now(),
        });
        let (cpu_usage_percent, cpu_capacity_cores, cpu_sample_ms) = self.cpu_delta(current);

        ServerStatus {
            scope: memory.scope,
            cpu_usage_percent,
            cpu_capacity_cores,
            cpu_sample_ms,
            memory_used_bytes: memory.used_bytes,
            memory_total_bytes: memory.total_bytes,
            memory_usage_percent: percent(memory.used_bytes, memory.total_bytes),
            memory_limited: memory.limited,
        }
    }

    fn cpu_delta(&self, current: Option<CpuSample>) -> (Option<f64>, f64, Option<u64>) {
        let capacity = current
            .map(|sample| sample.reading.capacity_cores())
            .unwrap_or_else(default_cpu_capacity);

        let Some(current_sample) = current else {
            return (None, capacity, None);
        };

        let Ok(mut last) = self.last_cpu.lock() else {
            return (None, capacity, None);
        };

        let usage = last.and_then(|previous| calculate_cpu_percent(previous, current_sample));
        let sample_ms = last.map(|previous| {
            current_sample
                .at
                .saturating_duration_since(previous.at)
                .as_millis() as u64
        });

        *last = Some(current_sample);
        (usage, capacity, sample_ms)
    }
}

fn calculate_cpu_percent(previous: CpuSample, current: CpuSample) -> Option<f64> {
    let elapsed = current.at.saturating_duration_since(previous.at);
    let elapsed_secs = elapsed.as_secs_f64();
    if elapsed_secs <= 0.0 {
        return None;
    }

    let raw = match (previous.reading, current.reading) {
        (
            CpuReading::Cgroup {
                usage_nanos: previous_usage,
                ..
            },
            CpuReading::Cgroup {
                usage_nanos: current_usage,
                capacity_cores,
            },
        ) => {
            let delta = current_usage.checked_sub(previous_usage)? as f64 / 1_000_000_000.0;
            if capacity_cores <= 0.0 {
                return None;
            }
            (delta / elapsed_secs / capacity_cores) * 100.0
        }
        (
            CpuReading::Host {
                total_ticks: previous_total,
                idle_ticks: previous_idle,
                ..
            },
            CpuReading::Host {
                total_ticks: current_total,
                idle_ticks: current_idle,
                ..
            },
        ) => {
            let total_delta = current_total.checked_sub(previous_total)?;
            if total_delta == 0 {
                return None;
            }
            let idle_delta = current_idle.saturating_sub(previous_idle);
            let busy_delta = total_delta.saturating_sub(idle_delta);
            (busy_delta as f64 / total_delta as f64) * 100.0
        }
        _ => return None,
    };

    Some(raw.clamp(0.0, 100.0))
}

fn read_memory_reading() -> MemoryReading {
    let host_total = read_host_memory_total_bytes();
    let containerized = is_containerized();

    if let Some(reading) = read_cgroup_v2_memory(host_total, containerized) {
        return reading;
    }
    if let Some(reading) = read_cgroup_v1_memory(host_total, containerized) {
        return reading;
    }
    read_host_memory(host_total)
}

fn read_cgroup_v2_memory(host_total: Option<u64>, containerized: bool) -> Option<MemoryReading> {
    let cgroup_path = cgroup_v2_path()?;
    let used = read_u64_file(&cgroup_path.join("memory.current"))?;
    let limit = read_memory_max(&cgroup_path.join("memory.max"));
    let should_use = containerized || limit.is_some();
    if !should_use {
        return None;
    }

    Some(MemoryReading {
        scope: if containerized { "container" } else { "cgroup" },
        used_bytes: Some(used),
        total_bytes: limit.or(host_total),
        limited: limit.is_some(),
    })
}

fn read_cgroup_v1_memory(host_total: Option<u64>, containerized: bool) -> Option<MemoryReading> {
    let cgroup_path = cgroup_v1_path("memory", "memory.usage_in_bytes")?;
    let used = read_u64_file(&cgroup_path.join("memory.usage_in_bytes"))?;
    let limit = read_memory_max(&cgroup_path.join("memory.limit_in_bytes"));
    let should_use = containerized || limit.is_some();
    if !should_use {
        return None;
    }

    Some(MemoryReading {
        scope: if containerized { "container" } else { "cgroup" },
        used_bytes: Some(used),
        total_bytes: limit.or(host_total),
        limited: limit.is_some(),
    })
}

fn read_host_memory(host_total: Option<u64>) -> MemoryReading {
    let meminfo = read_trimmed("/proc/meminfo");
    let parsed = meminfo.as_deref().and_then(parse_meminfo_bytes);
    let total = parsed.and_then(|info| info.total_bytes).or(host_total);
    let used = parsed.and_then(|info| match (info.total_bytes, info.available_bytes) {
        (Some(total), Some(available)) => Some(total.saturating_sub(available)),
        _ => None,
    });

    MemoryReading {
        scope: "host",
        used_bytes: used,
        total_bytes: total,
        limited: false,
    }
}

fn read_cpu_reading() -> Option<CpuReading> {
    let containerized = is_containerized();
    if let Some(reading) = read_cgroup_v2_cpu(containerized) {
        return Some(reading);
    }
    if let Some(reading) = read_cgroup_v1_cpu(containerized) {
        return Some(reading);
    }
    read_host_cpu()
}

fn read_cgroup_v2_cpu(containerized: bool) -> Option<CpuReading> {
    let cgroup_path = cgroup_v2_path()?;
    let usage_nanos = read_cgroup_v2_cpu_usage_nanos(&cgroup_path.join("cpu.stat"))?;
    let quota = read_cpu_max(&cgroup_path.join("cpu.max"));
    let capacity = cgroup_cpu_capacity(quota, read_cpuset_cores(&cgroup_path), containerized)?;
    if !containerized && quota.is_none() {
        return None;
    }

    Some(CpuReading::Cgroup {
        usage_nanos,
        capacity_cores: capacity,
    })
}

fn read_cgroup_v1_cpu(containerized: bool) -> Option<CpuReading> {
    let usage_path = cgroup_v1_path("cpuacct", "cpuacct.usage")
        .or_else(|| cgroup_v1_path("cpu", "cpuacct.usage"))?;
    let quota_path =
        cgroup_v1_path("cpu", "cpu.cfs_quota_us").unwrap_or_else(|| usage_path.clone());
    let cpuset_path = cgroup_v1_path("cpuset", "cpuset.cpus").unwrap_or_else(|| usage_path.clone());
    let usage_nanos = read_u64_file(&usage_path.join("cpuacct.usage"))?;
    let quota =
        read_cgroup_v1_cpu_quota(&quota_path).or_else(|| read_cgroup_v1_cpu_quota(&usage_path));
    let capacity = cgroup_cpu_capacity(quota, read_cpuset_cores(&cpuset_path), containerized)?;
    if !containerized && quota.is_none() {
        return None;
    }

    Some(CpuReading::Cgroup {
        usage_nanos,
        capacity_cores: capacity,
    })
}

fn read_host_cpu() -> Option<CpuReading> {
    let stat = read_trimmed("/proc/stat")?;
    let (total_ticks, idle_ticks) = parse_proc_stat_cpu(&stat)?;
    Some(CpuReading::Host {
        total_ticks,
        idle_ticks,
        capacity_cores: default_cpu_capacity(),
    })
}

fn cgroup_cpu_capacity(
    quota_cores: Option<f64>,
    cpuset_cores: Option<f64>,
    _containerized: bool,
) -> Option<f64> {
    let fallback = default_cpu_capacity();
    let capacity = match (quota_cores, cpuset_cores) {
        (Some(quota), Some(cpuset)) => quota.min(cpuset),
        (Some(quota), None) => quota,
        (None, Some(cpuset)) => cpuset,
        (None, None) => fallback,
    };
    (capacity > 0.0).then_some(capacity)
}

fn read_cgroup_v2_cpu_usage_nanos(path: &Path) -> Option<u64> {
    let raw = read_trimmed(path)?;
    for line in raw.lines() {
        let mut parts = line.split_whitespace();
        if parts.next() == Some("usage_usec") {
            return parts.next()?.parse::<u64>().ok().map(|value| value * 1_000);
        }
    }
    None
}

fn read_cpu_max(path: &Path) -> Option<f64> {
    let raw = read_trimmed(path)?;
    parse_cpu_max(&raw)
}

fn parse_cpu_max(raw: &str) -> Option<f64> {
    let mut parts = raw.split_whitespace();
    let quota = parts.next()?;
    let period = parts.next()?.parse::<f64>().ok()?;
    if quota == "max" || period <= 0.0 {
        return None;
    }
    let quota = quota.parse::<f64>().ok()?;
    (quota > 0.0).then_some(quota / period)
}

fn read_cgroup_v1_cpu_quota(path: &Path) -> Option<f64> {
    let quota = read_i64_file(&path.join("cpu.cfs_quota_us"))?;
    let period = read_i64_file(&path.join("cpu.cfs_period_us"))?;
    if quota <= 0 || period <= 0 {
        return None;
    }
    Some(quota as f64 / period as f64)
}

fn read_memory_max(path: &Path) -> Option<u64> {
    let raw = read_trimmed(path)?;
    parse_memory_max(&raw)
}

fn parse_memory_max(raw: &str) -> Option<u64> {
    let trimmed = raw.trim();
    if trimmed == "max" {
        return None;
    }
    let value = trimmed.parse::<u64>().ok()?;
    (value < HUGE_CGROUP_V1_LIMIT).then_some(value)
}

#[derive(Clone, Copy, Debug)]
struct MemInfo {
    total_bytes: Option<u64>,
    available_bytes: Option<u64>,
}

fn read_host_memory_total_bytes() -> Option<u64> {
    let raw = read_trimmed("/proc/meminfo")?;
    parse_meminfo_bytes(&raw)?.total_bytes
}

fn parse_meminfo_bytes(raw: &str) -> Option<MemInfo> {
    let mut total = None;
    let mut available = None;

    for line in raw.lines() {
        if let Some(value) = parse_meminfo_kb(line, "MemTotal:") {
            total = Some(value * 1024);
        } else if let Some(value) = parse_meminfo_kb(line, "MemAvailable:") {
            available = Some(value * 1024);
        }
    }

    if total.is_none() && available.is_none() {
        return None;
    }

    Some(MemInfo {
        total_bytes: total,
        available_bytes: available,
    })
}

fn parse_meminfo_kb(line: &str, key: &str) -> Option<u64> {
    let rest = line.strip_prefix(key)?.trim();
    rest.split_whitespace().next()?.parse::<u64>().ok()
}

fn parse_proc_stat_cpu(raw: &str) -> Option<(u64, u64)> {
    let line = raw.lines().find(|line| line.starts_with("cpu "))?;
    let values = line
        .split_whitespace()
        .skip(1)
        .filter_map(|part| part.parse::<u64>().ok())
        .collect::<Vec<_>>();
    if values.len() < 4 {
        return None;
    }

    let idle = values[3] + values.get(4).copied().unwrap_or(0);
    let total = values.iter().copied().sum();
    Some((total, idle))
}

fn percent(used: Option<u64>, total: Option<u64>) -> Option<f64> {
    let used = used?;
    let total = total?;
    if total == 0 {
        return None;
    }
    Some(((used as f64 / total as f64) * 100.0).clamp(0.0, 100.0))
}

fn cgroup_v2_path() -> Option<PathBuf> {
    let raw = read_trimmed("/proc/self/cgroup")?;
    for line in raw.lines() {
        let mut parts = line.splitn(3, ':');
        if parts.next() == Some("0") && parts.next() == Some("") {
            return Some(join_cgroup_path(
                CGROUP_V2_ROOT,
                parts.next().unwrap_or("/"),
            ));
        }
    }
    None
}

fn cgroup_v1_path(controller: &str, required_file: &str) -> Option<PathBuf> {
    let raw = read_trimmed("/proc/self/cgroup")?;
    for line in raw.lines() {
        let mut parts = line.splitn(3, ':');
        let _hierarchy = parts.next()?;
        let controllers = parts.next()?;
        let path = parts.next().unwrap_or("/");
        if !controllers.split(',').any(|item| item == controller) {
            continue;
        }

        for base in cgroup_v1_bases(controller) {
            let candidate = join_cgroup_path(base, path);
            if candidate.join(required_file).exists() {
                return Some(candidate);
            }
        }
    }
    None
}

fn cgroup_v1_bases(controller: &str) -> &'static [&'static str] {
    match controller {
        "cpu" | "cpuacct" => &[
            "/sys/fs/cgroup/cpu,cpuacct",
            "/sys/fs/cgroup/cpuacct",
            "/sys/fs/cgroup/cpu",
        ],
        "memory" => &["/sys/fs/cgroup/memory"],
        "cpuset" => &["/sys/fs/cgroup/cpuset"],
        _ => &[],
    }
}

fn join_cgroup_path(base: &str, cgroup_path: &str) -> PathBuf {
    let mut out = PathBuf::from(base);
    let trimmed = cgroup_path.trim_start_matches('/');
    if !trimmed.is_empty() {
        out.push(trimmed);
    }
    out
}

fn read_cpuset_cores(path: &Path) -> Option<f64> {
    let raw = read_trimmed(path.join("cpuset.cpus.effective"))
        .or_else(|| read_trimmed(path.join("cpuset.cpus")))?;
    count_cpuset_cpus(&raw).map(|count| count as f64)
}

fn count_cpuset_cpus(raw: &str) -> Option<u64> {
    let mut total = 0_u64;
    for part in raw.trim().split(',').filter(|part| !part.is_empty()) {
        if let Some((start, end)) = part.split_once('-') {
            let start = start.trim().parse::<u64>().ok()?;
            let end = end.trim().parse::<u64>().ok()?;
            if end < start {
                return None;
            }
            total = total.saturating_add(end - start + 1);
        } else {
            part.trim().parse::<u64>().ok()?;
            total = total.saturating_add(1);
        }
    }
    (total > 0).then_some(total)
}

fn is_containerized() -> bool {
    Path::new("/.dockerenv").exists()
        || cgroup_text_mentions_container("/proc/self/cgroup")
        || cgroup_text_mentions_container("/proc/1/cgroup")
}

fn cgroup_text_mentions_container(path: &str) -> bool {
    let Some(raw) = read_trimmed(path) else {
        return false;
    };
    raw.contains("docker")
        || raw.contains("kubepods")
        || raw.contains("containerd")
        || raw.contains("libpod")
        || raw.contains("podman")
}

fn read_trimmed(path: impl AsRef<Path>) -> Option<String> {
    fs::read_to_string(path)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn read_u64_file(path: &Path) -> Option<u64> {
    read_trimmed(path)?.parse::<u64>().ok()
}

fn read_i64_file(path: &Path) -> Option<i64> {
    read_trimmed(path)?.parse::<i64>().ok()
}

fn default_cpu_capacity() -> f64 {
    std::thread::available_parallelism()
        .map(|value| value.get() as f64)
        .unwrap_or(1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_cpu_max_returns_quota_cores() {
        assert_eq!(parse_cpu_max("200000 100000"), Some(2.0));
    }

    #[test]
    fn parse_cpu_max_returns_none_when_unlimited() {
        assert_eq!(parse_cpu_max("max 100000"), None);
    }

    #[test]
    fn parse_memory_max_returns_none_for_unlimited_values() {
        assert_eq!(parse_memory_max("max"), None);
        assert_eq!(parse_memory_max(&(1_u64 << 61).to_string()), None);
    }

    #[test]
    fn parse_meminfo_bytes_reads_total_and_available() {
        let parsed = parse_meminfo_bytes(
            "MemTotal:       2048 kB\nMemFree:        1000 kB\nMemAvailable:   1536 kB\n",
        );

        assert_eq!(
            parsed.map(|info| (info.total_bytes, info.available_bytes)),
            Some((Some(2_097_152), Some(1_572_864)))
        );
    }

    #[test]
    fn parse_proc_stat_cpu_reads_total_and_idle_ticks() {
        assert_eq!(
            parse_proc_stat_cpu("cpu  10 20 30 40 5 1 2 3 0 0\n"),
            Some((111, 45))
        );
    }

    #[test]
    fn count_cpuset_cpus_handles_ranges_and_singletons() {
        assert_eq!(count_cpuset_cpus("0-3,8,10-11"), Some(7));
    }

    #[test]
    fn percent_clamps_to_valid_range() {
        assert_eq!(percent(Some(150), Some(100)), Some(100.0));
    }
}
