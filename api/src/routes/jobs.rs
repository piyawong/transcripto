use std::path::Path as FsPath;

use axum::Json;
use axum::body::Body;
use axum::extract::{Path, Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use futures::StreamExt;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;
use tokio_util::io::ReaderStream;
use uuid::Uuid;

use crate::AppState;
use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::jobs::{self, JobDetail};
use crate::storage::{self, Get};

const EXTENSIONS: &[&str] = &["mp4", "m4v", "mov", "mkv", "webm", "avi", "mp3", "m4a", "wav", "aac", "ogg", "flac"];

pub async fn list(State(st): State<AppState>, CurrentUser(u): CurrentUser) -> AppResult<Json<Value>> {
    let jobs = jobs::list_for_user(&st.db, u.id).await?;
    Ok(Json(json!({ "jobs": jobs })))
}

#[derive(Deserialize)]
pub struct SearchReq {
    #[serde(default)]
    q: String,
}

pub async fn search(State(st): State<AppState>, CurrentUser(u): CurrentUser, Query(req): Query<SearchReq>) -> AppResult<Json<Value>> {
    let q: String = req.q.trim().chars().take(100).collect();
    if q.is_empty() {
        return Ok(Json(json!({ "matches": [] })));
    }
    let matches = jobs::search_transcripts(&st.db, u.id, &q).await?;
    Ok(Json(json!({ "matches": matches })))
}

#[derive(Deserialize)]
pub struct CreateReq {
    name: String,
    size_bytes: i64,
}

pub async fn create(State(st): State<AppState>, CurrentUser(u): CurrentUser, Json(req): Json<CreateReq>) -> AppResult<Json<Value>> {
    let name = req.name.trim();
    let ext = FsPath::new(name).extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase()).unwrap_or_default();
    if name.is_empty() || !EXTENSIONS.contains(&ext.as_str()) {
        return Err(AppError::BadRequest(format!("“{name}” ไม่ใช่ไฟล์วิดีโอ เลือกไฟล์ MP4, MOV, MKV หรือ WEBM")));
    }
    if req.size_bytes <= 0 {
        return Err(AppError::BadRequest(format!("“{name}” เป็นไฟล์ว่าง")));
    }
    if req.size_bytes as u64 > st.cfg.max_upload_bytes {
        return Err(AppError::TooLarge(format!("“{name}” ใหญ่เกิน 2 GB ลองตัดวิดีโอเป็นช่วงสั้นลงแล้วอัปโหลดใหม่")));
    }
    let id = Uuid::new_v4();
    // Later changes to the settings don't change how this job is transcribed, even on retry.
    let keyterms = crate::settings::keyterms(&st.db, &st.cfg.default_keyterms, u.id).await?.terms;
    let job = sqlx::query_as::<_, jobs::Job>(
        "INSERT INTO jobs (id, user_id, name, size_bytes, source_ext, status, keyterms)
         VALUES ($1, $2, $3, $4, $5, 'uploading', $6) RETURNING *",
    )
    .bind(id)
    .bind(u.id)
    .bind(name.chars().take(200).collect::<String>())
    .bind(req.size_bytes)
    .bind(&ext)
    .bind(&keyterms)
    .fetch_one(&st.db)
    .await?;
    Ok(Json(json!(job.view(0))))
}

/// Raw request body = file bytes. Streams to the job's scratch directory (memory stays flat for 2 GB uploads), checks the
/// size, stores the file in object storage, and only then queues the job. The scratch copy is left for the worker.
pub async fn upload(State(st): State<AppState>, CurrentUser(u): CurrentUser, Path(id): Path<Uuid>, req: Request) -> AppResult<Json<Value>> {
    let job = jobs::get_owned(&st.db, id, u.id).await?.ok_or(AppError::NotFound)?;
    if job.status != jobs::STATUS_UPLOADING {
        return Err(AppError::Conflict("งานนี้อัปโหลดไฟล์ไปแล้ว".into()));
    }
    let dir = st.cfg.work_dir(id);
    tokio::fs::create_dir_all(&dir).await?;
    let part = dir.join(format!("{}.{}.part", storage::SOURCE, job.source_ext));
    let mut file = tokio::fs::File::create(&part).await?;
    let mut stream = req.into_body().into_data_stream();
    let mut written: u64 = 0;
    let limit = st.cfg.max_upload_bytes;

    let outcome: Result<(), AppError> = async {
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| AppError::BadRequest(format!("การอัปโหลดถูกขัดจังหวะ ({e})")))?;
            written += chunk.len() as u64;
            if written > limit {
                return Err(AppError::TooLarge("ไฟล์ใหญ่เกิน 2 GB".into()));
            }
            file.write_all(&chunk).await?;
        }
        file.flush().await?;
        // A proxy that cuts the body short still ends the request cleanly; don't process a truncated file.
        if written > 0 && written != job.size_bytes as u64 {
            return Err(AppError::BadRequest(format!("ได้รับไฟล์ไม่ครบ ({written} จาก {} ไบต์) ลองอัปโหลดใหม่อีกครั้ง", job.size_bytes)));
        }
        Ok(())
    }
    .await;
    drop(file);

    if let Err(e) = outcome {
        let _ = tokio::fs::remove_file(&part).await;
        sqlx::query("UPDATE jobs SET status = 'failed', error = 'อัปโหลดไม่สำเร็จ ลองอัปโหลดไฟล์ใหม่อีกครั้ง', updated_at = now() WHERE id = $1 AND status = 'uploading'")
            .bind(id)
            .execute(&st.db)
            .await?;
        return Err(e);
    }
    if written == 0 {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(AppError::BadRequest("ไม่ได้รับข้อมูลไฟล์".into()));
    }
    let dest = dir.join(format!("{}.{}", storage::SOURCE, job.source_ext));
    tokio::fs::rename(&part, &dest).await?;
    let key = storage::source_key(id, &job.source_ext);
    if let Err(e) = st.storage.put_file(&key, &dest, storage::content_type(&job.source_ext)).await {
        let _ = tokio::fs::remove_dir_all(&dir).await;
        sqlx::query("UPDATE jobs SET status = 'failed', error = 'บันทึกไฟล์ไม่สำเร็จ ลองอัปโหลดใหม่อีกครั้ง', updated_at = now() WHERE id = $1 AND status = 'uploading'")
            .bind(id)
            .execute(&st.db)
            .await?;
        return Err(AppError::Internal(e));
    }
    let r = sqlx::query(
        "UPDATE jobs SET status = 'processing', stage = 0, stage_pct = 0, size_bytes = $2, attempts = 0, updated_at = now()
         WHERE id = $1 AND status = 'uploading'",
    )
    .bind(id)
    .bind(written as i64)
    .execute(&st.db)
    .await?;
    if r.rows_affected() == 0 {
        // Cancelled while the file was being stored.
        let _ = tokio::fs::remove_dir_all(&dir).await;
        let _ = st.storage.delete_prefix(&storage::key(id, "")).await;
        return Err(AppError::NotFound);
    }
    let job = jobs::get_owned(&st.db, id, u.id).await?.ok_or(AppError::NotFound)?;
    Ok(Json(json!(job.view(0))))
}

pub async fn detail(State(st): State<AppState>, CurrentUser(u): CurrentUser, Path(id): Path<Uuid>) -> AppResult<Json<JobDetail>> {
    let job = jobs::get_owned(&st.db, id, u.id).await?.ok_or(AppError::NotFound)?;
    let segments = jobs::segments(&st.db, id).await?;
    let (has_changes,): (bool,) = sqlx::query_as("SELECT changes_text IS NOT NULL FROM jobs WHERE id = $1").bind(id).fetch_one(&st.db).await?;
    Ok(Json(JobDetail {
        job: job.view(segments.len() as i64),
        summary_stale: jobs::summary_stale(&job, &segments),
        segments,
        has_changes,
        transcript_meta: job.transcript_meta.clone(),
        summary: job.summary.clone(),
        summary_text: job.summary_text.clone(),
        summary_meta: job.summary_meta.clone(),
    }))
}

pub async fn delete(State(st): State<AppState>, CurrentUser(u): CurrentUser, Path(id): Path<Uuid>) -> AppResult<Json<Value>> {
    let r = sqlx::query("DELETE FROM jobs WHERE id = $1 AND user_id = $2").bind(id).bind(u.id).execute(&st.db).await?;
    if r.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    let _ = tokio::fs::remove_dir_all(st.cfg.work_dir(id)).await;
    if let Err(e) = st.storage.delete_prefix(&storage::key(id, "")).await {
        tracing::error!("deleting media of job {id}: {e:#}");
    }
    Ok(Json(json!({ "ok": true })))
}

pub async fn retry(State(st): State<AppState>, CurrentUser(u): CurrentUser, Path(id): Path<Uuid>) -> AppResult<Json<Value>> {
    let job = jobs::get_owned(&st.db, id, u.id).await?.ok_or(AppError::NotFound)?;
    if job.status != jobs::STATUS_FAILED {
        return Err(AppError::Conflict("งานนี้ไม่ได้อยู่ในสถานะไม่สำเร็จ".into()));
    }
    if !st.storage.exists(&storage::source_key(id, &job.source_ext)).await? {
        return Err(AppError::Conflict("ไม่มีไฟล์ต้นฉบับของงานนี้แล้ว กรุณาอัปโหลดใหม่".into()));
    }
    sqlx::query(
        "UPDATE jobs SET status = 'processing', error = NULL, stage_pct = 0, attempts = 0, locked_by = NULL, locked_at = NULL, updated_at = now()
         WHERE id = $1",
    )
    .bind(id)
    .execute(&st.db)
    .await?;
    let job = jobs::get_owned(&st.db, id, u.id).await?.ok_or(AppError::NotFound)?;
    let n = jobs::segment_count(&st.db, id).await?;
    Ok(Json(json!(job.view(n))))
}

pub async fn retry_summary(State(st): State<AppState>, CurrentUser(u): CurrentUser, Path(id): Path<Uuid>) -> AppResult<Json<Value>> {
    let r = sqlx::query(
        "UPDATE jobs SET summary_status = 'pending', summary_error = NULL, attempts = 0, updated_at = now()
         WHERE id = $1 AND user_id = $2 AND status = 'done' AND summary_status IN ('failed', 'done')",
    )
    .bind(id)
    .bind(u.id)
    .execute(&st.db)
    .await?;
    if r.rows_affected() == 0 {
        return Err(AppError::Conflict("สรุปใหม่ได้เมื่อถอดเสียงเสร็จแล้วเท่านั้น".into()));
    }
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct RenameReq {
    name: String,
}

pub async fn rename_speaker(
    State(st): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path((id, idx)): Path<(Uuid, usize)>,
    Json(req): Json<RenameReq>,
) -> AppResult<Json<Value>> {
    let name: String = req.name.trim().chars().take(40).collect();
    if name.is_empty() {
        return Err(AppError::BadRequest("ชื่อผู้พูดต้องไม่ว่าง".into()));
    }
    let mut tx = st.db.begin().await?;
    let job = sqlx::query_as::<_, jobs::Job>("SELECT * FROM jobs WHERE id = $1 AND user_id = $2 FOR UPDATE")
        .bind(id)
        .bind(u.id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(AppError::NotFound)?;
    let mut speakers = job.speakers.0;
    let sp = speakers.get_mut(idx).ok_or(AppError::NotFound)?;
    let old = std::mem::replace(&mut sp.name, name.clone());
    // The name usually comes from the transcript itself (someone addressed by name), so the text follows the rename.
    // The placeholder label ("ผู้พูด 2") is not something anyone said, in either direction.
    let mut changed = Vec::new();
    let mut replaced = 0;
    if old != name && old != sp.label && name != sp.label {
        let rows: Vec<(i32, String)> = sqlx::query_as("SELECT idx, text FROM segments WHERE job_id = $1 AND strpos(text, $2) > 0 ORDER BY idx")
            .bind(id)
            .bind(&old)
            .fetch_all(&mut *tx)
            .await?;
        for (i, text) in rows {
            replaced += text.matches(old.as_str()).count();
            let text = text.replace(old.as_str(), &name);
            sqlx::query("UPDATE segments SET text = $3 WHERE job_id = $1 AND idx = $2").bind(id).bind(i).bind(&text).execute(&mut *tx).await?;
            changed.push(json!({ "idx": i, "text": text }));
        }
    }
    sqlx::query("UPDATE jobs SET speakers = $2, updated_at = now() WHERE id = $1")
        .bind(id)
        .bind(sqlx::types::Json(&speakers))
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    let stale = stale_now(&st, id, u.id).await?;
    Ok(Json(json!({ "speakers": speakers, "replaced": replaced, "changed": changed, "summary_stale": stale })))
}

#[derive(Deserialize)]
pub struct EditSegmentReq {
    text: String,
}

/// Saves a user's correction of one transcript line. Line breaks become spaces: every line of the summary input is
/// "[MM:SS] ผู้พูด N: text".
pub async fn edit_segment(
    State(st): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path((id, idx)): Path<(Uuid, i32)>,
    Json(req): Json<EditSegmentReq>,
) -> AppResult<Json<Value>> {
    let text = req.text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        return Err(AppError::BadRequest("ข้อความต้องไม่ว่าง".into()));
    }
    if text.chars().count() > jobs::MAX_SEGMENT_CHARS {
        return Err(AppError::BadRequest(format!("ข้อความยาวได้ไม่เกิน {} ตัวอักษร", jobs::MAX_SEGMENT_CHARS)));
    }
    let job = jobs::get_owned(&st.db, id, u.id).await?.ok_or(AppError::NotFound)?;
    if job.stage < jobs::STAGE_SUMMARY {
        return Err(AppError::Conflict("แก้ข้อความได้เมื่อถอดเสียงเสร็จแล้ว".into()));
    }
    let r = sqlx::query("UPDATE segments SET text = $3 WHERE job_id = $1 AND idx = $2").bind(id).bind(idx).bind(&text).execute(&st.db).await?;
    if r.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    sqlx::query("UPDATE jobs SET updated_at = now() WHERE id = $1").bind(id).execute(&st.db).await?;
    let stale = stale_now(&st, id, u.id).await?;
    Ok(Json(json!({ "text": text, "summary_stale": stale })))
}

async fn stale_now(st: &AppState, id: Uuid, user_id: Uuid) -> AppResult<bool> {
    let job = jobs::get_owned(&st.db, id, user_id).await?.ok_or(AppError::NotFound)?;
    let segments = jobs::segments(&st.db, id).await?;
    Ok(jobs::summary_stale(&job, &segments))
}

/// Streams an object from storage with HTTP range support, so the browser can seek in a 2 GB video without
/// downloading it: HEAD, `Accept-Ranges`, 206 + `Content-Range`, 416 for a range outside the file, `If-Range`.
async fn serve(st: &AppState, key: &str, headers: &HeaderMap, content_type: &str) -> AppResult<Response> {
    let mut range = headers.get(header::RANGE).and_then(|v| v.to_str().ok()).filter(|r| r.starts_with("bytes=") && !r.contains(','));
    // A client resuming with If-Range wants the range only if the file is unchanged; without an ETag to compare we
    // can't tell, so fetch first and fall back to the whole file on mismatch.
    let if_range = headers.get(header::IF_RANGE).and_then(|v| v.to_str().ok()).map(str::to_string);
    let mut got = st.storage.get(key, range).await?;
    if let (Some(want), Get::Found(f)) = (&if_range, &got)
        && range.is_some()
        && f.etag.as_deref() != Some(want.as_str())
        && f.last_modified.as_deref() != Some(want.as_str())
    {
        range = None;
        got = st.storage.get(key, None).await?;
    }
    match got {
        Get::NotFound => Err(AppError::NotFound),
        Get::BadRange { total } => Ok((
            StatusCode::RANGE_NOT_SATISFIABLE,
            [(header::CONTENT_RANGE, format!("bytes */{}", total.unwrap_or(0))), (header::ACCEPT_RANGES, "bytes".to_string())],
        )
            .into_response()),
        Get::Found(f) => {
            let partial = range.is_some() && f.content_range.is_some();
            let mut resp = Response::new(Body::from_stream(ReaderStream::new(f.body.into_async_read())));
            *resp.status_mut() = if partial { StatusCode::PARTIAL_CONTENT } else { StatusCode::OK };
            let h = resp.headers_mut();
            h.insert(header::CONTENT_TYPE, HeaderValue::from_str(content_type).unwrap_or(HeaderValue::from_static("application/octet-stream")));
            h.insert(header::CONTENT_LENGTH, HeaderValue::from(f.len));
            h.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
            h.insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=3600"));
            if partial && let Some(v) = f.content_range.as_deref().and_then(|v| HeaderValue::from_str(v).ok()) {
                h.insert(header::CONTENT_RANGE, v);
            }
            if let Some(v) = f.etag.as_deref().and_then(|v| HeaderValue::from_str(v).ok()) {
                h.insert(header::ETAG, v);
            }
            if let Some(v) = f.last_modified.as_deref().and_then(|v| HeaderValue::from_str(v).ok()) {
                h.insert(header::LAST_MODIFIED, v);
            }
            Ok(resp)
        }
    }
}

pub async fn media(State(st): State<AppState>, CurrentUser(u): CurrentUser, Path(id): Path<Uuid>, headers: HeaderMap) -> AppResult<Response> {
    let job = jobs::get_owned(&st.db, id, u.id).await?.ok_or(AppError::NotFound)?;
    serve(&st, &storage::source_key(id, &job.source_ext), &headers, storage::content_type(&job.source_ext)).await
}

pub async fn audio(State(st): State<AppState>, CurrentUser(u): CurrentUser, Path(id): Path<Uuid>, headers: HeaderMap) -> AppResult<Response> {
    jobs::get_owned(&st.db, id, u.id).await?.ok_or(AppError::NotFound)?;
    serve(&st, &storage::key(id, storage::AUDIO), &headers, "audio/wav").await
}

pub async fn thumbnail(State(st): State<AppState>, CurrentUser(u): CurrentUser, Path(id): Path<Uuid>, headers: HeaderMap) -> AppResult<Response> {
    jobs::get_owned(&st.db, id, u.id).await?.ok_or(AppError::NotFound)?;
    serve(&st, &storage::key(id, storage::THUMB), &headers, "image/jpeg").await
}

/// Plain-text log of the correction step: applied edits, names waiting for a person to confirm, unclear spans.
pub async fn changes_txt(State(st): State<AppState>, CurrentUser(u): CurrentUser, Path(id): Path<Uuid>) -> AppResult<Response> {
    let job = jobs::get_owned(&st.db, id, u.id).await?.ok_or(AppError::NotFound)?;
    let (text,): (Option<String>,) = sqlx::query_as("SELECT changes_text FROM jobs WHERE id = $1").bind(id).fetch_one(&st.db).await?;
    let text = text.ok_or(AppError::NotFound)?;
    Ok(text_download(&job.name, "บันทึกการตรวจแก้", text))
}

fn text_download(job_name: &str, what: &str, text: String) -> Response {
    let base: String = job_name.rsplit_once('.').map(|(b, _)| b.to_string()).unwrap_or(job_name.to_string());
    let filename = format!("{base} - {what}.txt");
    let disposition = format!("attachment; filename=\"{}.txt\"; filename*=UTF-8''{}", if what == "สรุปการประชุม" { "summary" } else { "changes" }, urlencode(&filename));
    ([(header::CONTENT_TYPE, "text/plain; charset=utf-8".to_string()), (header::CONTENT_DISPOSITION, disposition)], text).into_response()
}

pub async fn summary_txt(State(st): State<AppState>, CurrentUser(u): CurrentUser, Path(id): Path<Uuid>) -> AppResult<Response> {
    let job = jobs::get_owned(&st.db, id, u.id).await?.ok_or(AppError::NotFound)?;
    let text = job.summary_text.ok_or(AppError::NotFound)?;
    Ok(text_download(&job.name, "สรุปการประชุม", text))
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}
