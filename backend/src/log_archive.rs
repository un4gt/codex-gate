use std::fs::{self, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

use flate2::Compression;
use flate2::write::GzEncoder;
use serde::Serialize;

use crate::types::RequestLogRow;
use crate::util;

#[derive(Clone, Debug)]
pub struct ArchiveWriteResult {
    pub path: PathBuf,
    pub index_path: PathBuf,
    pub row_count: usize,
    pub file_size_bytes: u64,
    pub uncompressed_bytes: u64,
    pub min_time_ms: Option<i64>,
    pub max_time_ms: Option<i64>,
    pub compressed: bool,
}

#[derive(Debug, Serialize)]
struct ArchiveIndexEntry {
    created_at_ms: i64,
    relative_path: String,
    row_count: usize,
    file_size_bytes: u64,
    uncompressed_bytes: u64,
    min_time_ms: Option<i64>,
    max_time_ms: Option<i64>,
    compressed: bool,
}

pub async fn archive_request_logs_jsonl(
    base_dir: &str,
    rows: &[RequestLogRow],
    compress: bool,
) -> Result<Option<ArchiveWriteResult>, String> {
    if rows.is_empty() {
        return Ok(None);
    }

    let base_dir = PathBuf::from(base_dir);
    let rows = rows.to_vec();
    tokio::task::spawn_blocking(move || archive_request_logs_jsonl_sync(&base_dir, &rows, compress))
        .await
        .map_err(|e| format!("archive task join error: {e}"))?
}

fn archive_request_logs_jsonl_sync(
    base_dir: &Path,
    rows: &[RequestLogRow],
    compress: bool,
) -> Result<Option<ArchiveWriteResult>, String> {
    if rows.is_empty() {
        return Ok(None);
    }

    let date = util::today_yyyymmdd_utc();
    let dir = base_dir.join(&date);
    fs::create_dir_all(&dir).map_err(|e| format!("create archive dir {}: {e}", dir.display()))?;

    let extension = if compress { "jsonl.gz" } else { "jsonl" };
    let path = dir.join(format!(
        "request_logs_{}_{}.{}",
        util::now_ms(),
        util::new_ulid(),
        extension
    ));

    let file = fs::File::create(&path)
        .map_err(|e| format!("create archive file {}: {e}", path.display()))?;
    let mut uncompressed_bytes = 0_u64;

    if compress {
        let writer = BufWriter::new(file);
        let mut encoder = GzEncoder::new(writer, Compression::fast());
        for row in rows {
            let line = serde_json::to_string(row)
                .map_err(|e| format!("serialize request log {}: {e}", row.id))?;
            encoder
                .write_all(line.as_bytes())
                .map_err(|e| format!("write archive file {}: {e}", path.display()))?;
            encoder
                .write_all(b"\n")
                .map_err(|e| format!("write newline to archive file {}: {e}", path.display()))?;
            uncompressed_bytes = uncompressed_bytes.saturating_add(line.len() as u64 + 1);
        }
        let mut writer = encoder
            .finish()
            .map_err(|e| format!("finish gzip archive file {}: {e}", path.display()))?;
        writer
            .flush()
            .map_err(|e| format!("flush archive file {}: {e}", path.display()))?;
    } else {
        let mut writer = BufWriter::new(file);
        for row in rows {
            let line = serde_json::to_string(row)
                .map_err(|e| format!("serialize request log {}: {e}", row.id))?;
            writer
                .write_all(line.as_bytes())
                .map_err(|e| format!("write archive file {}: {e}", path.display()))?;
            writer
                .write_all(b"\n")
                .map_err(|e| format!("write newline to archive file {}: {e}", path.display()))?;
            uncompressed_bytes = uncompressed_bytes.saturating_add(line.len() as u64 + 1);
        }
        writer
            .flush()
            .map_err(|e| format!("flush archive file {}: {e}", path.display()))?;
    }

    let file_size_bytes = fs::metadata(&path)
        .map_err(|e| format!("stat archive file {}: {e}", path.display()))?
        .len();

    let min_time_ms = rows.iter().map(|row| row.time_ms).min();
    let max_time_ms = rows.iter().map(|row| row.time_ms).max();
    let index_path = append_archive_index(
        base_dir,
        &ArchiveIndexEntry {
            created_at_ms: util::now_ms(),
            relative_path: relative_archive_path(base_dir, &path),
            row_count: rows.len(),
            file_size_bytes,
            uncompressed_bytes,
            min_time_ms,
            max_time_ms,
            compressed: compress,
        },
    )?;

    Ok(Some(ArchiveWriteResult {
        path,
        index_path,
        row_count: rows.len(),
        file_size_bytes,
        uncompressed_bytes,
        min_time_ms,
        max_time_ms,
        compressed: compress,
    }))
}

fn append_archive_index(base_dir: &Path, entry: &ArchiveIndexEntry) -> Result<PathBuf, String> {
    fs::create_dir_all(base_dir)
        .map_err(|e| format!("create archive base dir {}: {e}", base_dir.display()))?;
    let index_path = base_dir.join("_index.jsonl");
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&index_path)
        .map_err(|e| format!("open archive index {}: {e}", index_path.display()))?;
    let mut writer = BufWriter::new(file);
    let line =
        serde_json::to_string(entry).map_err(|e| format!("serialize archive index entry: {e}"))?;
    writer
        .write_all(line.as_bytes())
        .map_err(|e| format!("write archive index {}: {e}", index_path.display()))?;
    writer
        .write_all(b"\n")
        .map_err(|e| format!("write archive index newline {}: {e}", index_path.display()))?;
    writer
        .flush()
        .map_err(|e| format!("flush archive index {}: {e}", index_path.display()))?;
    Ok(index_path)
}

fn relative_archive_path(base_dir: &Path, path: &Path) -> String {
    path.strip_prefix(base_dir)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}
