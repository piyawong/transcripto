//! Background worker: claims jobs from Postgres (`FOR UPDATE SKIP LOCKED`) and runs the pipeline.
//!
//! Stages: 0 extract audio · 1 speech-to-text (ElevenLabs) + correction (Gemini) · 2 summary (Gemini).
//! Media lives in object storage; the worker copies what it needs into a scratch directory and deletes it afterwards.
//! A retry resumes from the stored stage: extracted audio and the ElevenLabs response are reused, never paid twice.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use serde_json::json;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::AppState;
use crate::jobs::{self, Job, SpeakerView};
use crate::pipeline::{self, Ai};
use crate::storage;
use crate::{media, transcript};

/// A lock older than 90 s (18 missed heartbeats) is considered abandoned; see `claim`.
const HEARTBEAT: Duration = Duration::from_secs(5);
/// Share of the transcription stage's progress bar taken by speech-to-text; correction fills the rest.
const STT_SHARE: f64 = 0.55;

pub fn spawn(st: AppState, ai: Ai) {
    for n in 0..st.cfg.workers.max(1) {
        let st = st.clone();
        let ai = ai.clone();
        let id = format!("worker-{}-{n}", &Uuid::new_v4().to_string()[..8]);
        tokio::spawn(async move {
            tracing::info!("{id} started");
            loop {
                match claim(&st, &id).await {
                    Ok(Some(job)) => {
                        let job_id = job.id;
                        if let Err(e) = run(&st, &ai, &id, job).await {
                            tracing::error!("{id}: job {job_id}: {e:#}");
                        }
                        // Everything the worker needs is in object storage; the scratch copy is not kept.
                        let _ = tokio::fs::remove_dir_all(st.cfg.work_dir(job_id)).await;
                    }
                    Ok(None) => tokio::time::sleep(Duration::from_millis(800)).await,
                    Err(e) => {
                        tracing::error!("{id}: claim failed: {e:#}");
                        tokio::time::sleep(Duration::from_secs(3)).await;
                    }
                }
            }
        });
    }
    let st2 = st.clone();
    tokio::spawn(async move {
        loop {
            // Uploads abandoned mid-way (browser closed) would otherwise stay "uploading" forever.
            let stale: Vec<(Uuid,)> = sqlx::query_as(
                "UPDATE jobs SET status = 'failed', error = 'อัปโหลดไม่เสร็จ ลองอัปโหลดไฟล์ใหม่อีกครั้ง', updated_at = now()
                 WHERE status = 'uploading' AND updated_at < now() - interval '6 hours' RETURNING id",
            )
            .fetch_all(&st2.db)
            .await
            .unwrap_or_default();
            for (id,) in stale {
                let _ = tokio::fs::remove_dir_all(st2.cfg.work_dir(id)).await;
            }
            tokio::time::sleep(Duration::from_secs(600)).await;
        }
    });
}

async fn claim(st: &AppState, worker: &str) -> Result<Option<Job>> {
    let job = sqlx::query_as::<_, Job>(
        "UPDATE jobs SET locked_by = $1, locked_at = now(), attempts = attempts + 1
         WHERE id = (
            SELECT id FROM jobs
            WHERE (status = 'processing' OR (status = 'done' AND summary_status = 'pending'))
              AND (locked_at IS NULL OR locked_at < now() - interval '90 seconds')
            ORDER BY created_at
            FOR UPDATE SKIP LOCKED
            LIMIT 1)
         RETURNING *",
    )
    .bind(worker)
    .fetch_optional(&st.db)
    .await?;
    Ok(job)
}

/// Progress of the current stage, published by the heartbeat.
#[derive(Clone, Default)]
struct Beat {
    pct: f64,
    eta: Option<f64>,
    /// A step without real progress: the bar moves from `from` to `to` over the expected time.
    timed: Option<Timed>,
}

#[derive(Clone)]
struct Timed {
    started: Instant,
    expected: f64,
    from: f64,
    to: f64,
    /// Expected seconds of the steps after this one.
    later: f64,
}

impl Beat {
    fn timed(expected: f64, from: f64, to: f64, later: f64) -> Beat {
        Beat { pct: from, eta: Some(expected + later), timed: Some(Timed { started: Instant::now(), expected, from, to, later }) }
    }

    fn now(&self) -> (f64, Option<f64>) {
        match &self.timed {
            Some(t) => {
                let el = t.started.elapsed().as_secs_f64();
                let frac = (el / t.expected.max(1.0)).min(0.95);
                (t.from + (t.to - t.from) * frac, Some((t.expected - el).max(3.0) + t.later))
            }
            None => (self.pct, self.eta),
        }
    }
}

async fn run(st: &AppState, ai: &Ai, worker: &str, job: Job) -> Result<()> {
    if job.attempts > 4 {
        fail(st, job.id, worker, "ประมวลผลไม่สำเร็จหลายครั้ง ลองกด “ลองอีกครั้ง”").await?;
        return Ok(());
    }
    let cancel = CancellationToken::new();
    let beat = Arc::new(Mutex::new(Beat::default()));

    // Heartbeat: keeps the lock fresh, publishes progress, and notices if the job was deleted.
    let hb = {
        let (st, cancel, beat, worker, id) = (st.clone(), cancel.clone(), beat.clone(), worker.to_string(), job.id);
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = cancel.cancelled() => break,
                    _ = tokio::time::sleep(HEARTBEAT) => {}
                }
                let (pct, eta) = beat.lock().unwrap().now();
                let r = sqlx::query(
                    "UPDATE jobs SET locked_at = now(), stage_pct = GREATEST(stage_pct, $3), eta_sec = COALESCE($4, eta_sec), updated_at = now()
                     WHERE id = $1 AND locked_by = $2",
                )
                .bind(id)
                .bind(&worker)
                .bind(pct as f32)
                .bind(eta)
                .execute(&st.db)
                .await;
                if matches!(r, Ok(ref r) if r.rows_affected() == 0) {
                    tracing::info!("job {id} was removed or reassigned; stopping");
                    cancel.cancel();
                    break;
                }
            }
        })
    };

    let work = process(st, ai, worker, job.clone(), beat.clone());
    let result = tokio::select! {
        r = work => Some(r),
        _ = cancel.cancelled() => None,
    };
    cancel.cancel();
    let _ = hb.await;

    match result {
        None => Ok(()),
        Some(Ok(())) => Ok(()),
        Some(Err(e)) => {
            let msg = format!("{e:#}");
            // Problems with the user's file are expected outcomes, not server errors.
            if msg.contains("NO_AUDIO") || msg.contains("NO_SPEECH") || msg.contains("USER:") {
                tracing::warn!("job {} rejected: {msg}", job.id);
            } else {
                tracing::error!("job {} failed: {msg}", job.id);
            }
            fail(st, job.id, worker, &user_message(&e)).await?;
            Ok(())
        }
    }
}

fn user_message(e: &anyhow::Error) -> String {
    let s = format!("{e:#}");
    if s.contains("NO_AUDIO") || s.contains("NO_SPEECH") {
        "ไม่พบเสียงพูดในไฟล์ แทร็กเสียงอาจถูกปิดไว้ตอนบันทึก".into()
    } else if let Some(m) = s.split("USER:").nth(1) {
        m.trim().to_string()
    } else if s.contains("ffprobe") || s.contains("ffmpeg") {
        "อ่านไฟล์วิดีโอไม่ได้ ไฟล์อาจเสียหายหรือเป็นรูปแบบที่ไม่รองรับ".into()
    } else if s.contains("object storage") {
        "เชื่อมต่อที่เก็บไฟล์ไม่ได้ ลองกด “ลองอีกครั้ง” ในอีกสักครู่".into()
    } else if s.contains("ELEVENLABS_API_KEY") || s.contains("ElevenLabs API error 401") {
        "ยังไม่ได้ตั้งค่าบริการถอดเสียง (ELEVENLABS_API_KEY)".into()
    } else if s.contains("GEMINI_API_KEY") {
        "ยังไม่ได้ตั้งค่าบริการตรวจแก้และสรุป (GEMINI_API_KEY)".into()
    } else if s.contains("HTTP 429") || s.contains("error 429") || s.contains("quota") {
        "บริการ AI มีผู้ใช้งานมากหรือโควตาเต็ม ลองอีกครั้งในอีกสักครู่".into()
    } else if s.contains("ElevenLabs") {
        "บริการถอดเสียงตอบกลับผิดพลาด ลองกด “ลองอีกครั้ง”".into()
    } else if s.contains("Gemini") || s.contains("generateContent") {
        "บริการตรวจแก้และสรุปตอบกลับผิดพลาด ลองกด “ลองอีกครั้ง”".into()
    } else {
        "ประมวลผลไม่สำเร็จ ลองกด “ลองอีกครั้ง”".into()
    }
}

async fn fail(st: &AppState, id: Uuid, worker: &str, msg: &str) -> Result<()> {
    // A failure during the summary step keeps the transcript: the job is done, only the summary failed.
    sqlx::query(
        "UPDATE jobs SET
            status = CASE WHEN stage >= 2 OR status = 'done' THEN 'done' ELSE 'failed' END,
            error = CASE WHEN stage >= 2 OR status = 'done' THEN NULL ELSE $2 END,
            summary_status = CASE WHEN stage >= 2 OR status = 'done' THEN 'failed' ELSE summary_status END,
            summary_error = CASE WHEN stage >= 2 OR status = 'done' THEN $2 ELSE summary_error END,
            finished_at = CASE WHEN stage >= 2 OR status = 'done' THEN COALESCE(finished_at, now()) ELSE finished_at END,
            locked_by = NULL, locked_at = NULL, eta_sec = NULL, updated_at = now()
         WHERE id = $1 AND locked_by = $3",
    )
    .bind(id)
    .bind(msg)
    .bind(worker)
    .execute(&st.db)
    .await?;
    Ok(())
}

async fn process(st: &AppState, ai: &Ai, worker: &str, mut job: Job, beat: Arc<Mutex<Beat>>) -> Result<()> {
    if job.status == jobs::STATUS_DONE {
        // Summary retry on a finished job.
        return summary_step(st, ai, worker, &job, &beat).await;
    }
    let dir = st.cfg.work_dir(job.id);
    tokio::fs::create_dir_all(&dir).await?;
    let source = dir.join(format!("{}.{}", storage::SOURCE, job.source_ext));
    let audio = dir.join(storage::AUDIO);
    let audio_key = storage::key(job.id, storage::AUDIO);

    // Audio is extracted again only if this job never got that far (a retry after a later step reuses it).
    let have_audio = job.stage > jobs::STAGE_EXTRACT && job.duration_sec.is_some() && (audio.exists() || st.storage.exists(&audio_key).await?);
    if !have_audio {
        set_stage(st, job.id, worker, jobs::STAGE_EXTRACT, None).await?;
        if !source.exists() && !st.storage.download(&storage::source_key(job.id, &job.source_ext), &source).await? {
            anyhow::bail!("USER: ไม่พบไฟล์ต้นฉบับ กรุณาอัปโหลดใหม่");
        }
        let probe = media::probe(&source).await?;
        if !probe.has_audio {
            anyhow::bail!("NO_AUDIO");
        }
        if probe.duration > st.cfg.max_duration_sec {
            anyhow::bail!("USER: วิดีโอยาวเกิน {} ชั่วโมง ตัดเป็นช่วงสั้นลงแล้วอัปโหลดใหม่", st.cfg.max_duration_sec / 3600.0);
        }
        let d = probe.duration;
        let after_extract = pipeline::stt_seconds(d) + pipeline::correct_seconds(d) + pipeline::summary_seconds(d);
        let extract_seconds = 3.0 + d * 0.01;
        sqlx::query("UPDATE jobs SET duration_sec = $2, has_video = $3, eta_sec = $4, updated_at = now() WHERE id = $1")
            .bind(job.id)
            .bind(d)
            .bind(probe.has_video)
            .bind(extract_seconds + after_extract)
            .execute(&st.db)
            .await?;
        if probe.has_video {
            let thumb = dir.join(storage::THUMB);
            let made = match media::thumbnail(&source, &thumb, d).await {
                Ok(()) => st.storage.put_file(&storage::key(job.id, storage::THUMB), &thumb, "image/jpeg").await.map(|_| true),
                Err(e) => {
                    tracing::warn!("thumbnail for {}: {e:#}", job.id);
                    Ok(false)
                }
            };
            if made? {
                sqlx::query("UPDATE jobs SET has_thumb = true WHERE id = $1").bind(job.id).execute(&st.db).await?;
            }
        }
        let b = beat.clone();
        media::extract_audio(&source, &audio, d, move |p| {
            let mut g = b.lock().unwrap();
            g.pct = p;
            g.eta = Some(extract_seconds * (1.0 - p) + after_extract);
        })
        .await?;
        st.storage.put_file(&audio_key, &audio, "audio/wav").await?;
        // The source is not needed locally any more; it can be large.
        let _ = tokio::fs::remove_file(&source).await;
        *beat.lock().unwrap() = Beat::default();
        job.duration_sec = Some(d);
        job.stage = jobs::STAGE_TRANSCRIBE;
    }

    if job.stage == jobs::STAGE_TRANSCRIBE {
        set_stage(st, job.id, worker, jobs::STAGE_TRANSCRIBE, None).await?;
        let d = job.duration_sec.unwrap_or(0.0);
        let (correct_s, summary_s) = (pipeline::correct_seconds(d), pipeline::summary_seconds(d));

        // The terms copied from the owner's settings when the job was created (older jobs: the current settings).
        let terms = match &job.keyterms {
            Some(t) => t.clone(),
            None => crate::settings::keyterms(&st.db, &st.cfg.default_keyterms, job.user_id).await?.terms,
        };

        // ① ElevenLabs, unless an earlier attempt already stored its response.
        let stt_key = storage::key(job.id, storage::STT);
        let (raw, stt_meta) = match st.storage.get_bytes(&stt_key).await? {
            Some(bytes) => {
                let raw: serde_json::Value = serde_json::from_slice(&bytes).context("reading stored stt.json")?;
                let mut meta = pipeline::stt_meta(ai, &raw, terms.len())?;
                meta["reused"] = json!(true);
                (raw, meta)
            }
            None => {
                *beat.lock().unwrap() = Beat::timed(pipeline::stt_seconds(d), 0.0, STT_SHARE, correct_s + summary_s);
                if !ai.is_fixture() && !audio.exists() && !st.storage.download(&audio_key, &audio).await? {
                    anyhow::bail!("USER: ไม่พบไฟล์เสียงที่แยกไว้ กรุณาอัปโหลดใหม่");
                }
                let out = pipeline::speech_to_text(ai, &audio, d, &terms).await?;
                st.storage.put_bytes(&stt_key, serde_json::to_vec(&out.raw)?, "application/json").await?;
                (out.raw, out.meta)
            }
        };
        let lines = pipeline::lines_from_stt(&raw)?;

        // ② Gemini change list, applied by the script.
        *beat.lock().unwrap() = Beat::timed(correct_s, STT_SHARE, 1.0, summary_s);
        let b = beat.clone();
        let out = pipeline::correct(ai, &lines, &terms, &job.name, move |frac| {
            let mut g = b.lock().unwrap();
            if let Some(t) = g.timed.as_mut() {
                // Finished windows move the start of the timed bar forward.
                t.from = t.from.max(STT_SHARE + (1.0 - STT_SHARE) * frac * 0.95);
            }
        })
        .await?;

        let total_talk: f64 = out.segments.iter().map(|s| s.end - s.start).sum::<f64>().max(1.0);
        let speakers: Vec<SpeakerView> = out
            .speakers
            .iter()
            .enumerate()
            .map(|(i, s)| {
                let talk: f64 = out.segments.iter().filter(|g| g.speaker == i).map(|g| g.end - g.start).sum();
                SpeakerView { label: s.label.clone(), name: s.name.clone(), role: s.role.clone(), talk_sec: talk, pct: talk / total_talk }
            })
            .collect();
        let stt_cost = stt_meta["cost_usd"].as_f64().unwrap_or(0.0);
        let meta = json!({
            "stt": stt_meta,
            "correct": out.meta,
            "lines": out.segments.len(),
            "cost_usd": ((stt_cost + out.meta["cost_usd"].as_f64().unwrap_or(0.0)) * 10_000.0).round() / 10_000.0,
        });

        let mut tx = st.db.begin().await?;
        sqlx::query("DELETE FROM segments WHERE job_id = $1").bind(job.id).execute(&mut *tx).await?;
        for (i, s) in out.segments.iter().enumerate() {
            sqlx::query("INSERT INTO segments (job_id, idx, start_sec, end_sec, speaker, text) VALUES ($1, $2, $3, $4, $5, $6)")
                .bind(job.id)
                .bind(i as i32)
                .bind(s.start)
                .bind(s.end)
                .bind(s.speaker as i32)
                .bind(&s.text)
                .execute(&mut *tx)
                .await?;
        }
        let r = sqlx::query(
            "UPDATE jobs SET speakers = $2, transcript_meta = $3, corrections = $4, changes_text = $5, stage = 2, stage_pct = 0,
                 summary_status = 'running', eta_sec = $6, attempts = 0, updated_at = now()
             WHERE id = $1 AND locked_by = $7",
        )
        .bind(job.id)
        .bind(sqlx::types::Json(&speakers))
        .bind(&meta)
        .bind(&out.corrections)
        .bind(&out.changes_text)
        .bind(summary_s)
        .bind(worker)
        .execute(&mut *tx)
        .await?;
        if r.rows_affected() == 0 {
            tx.rollback().await?;
            return Ok(());
        }
        tx.commit().await?;
        job.speakers = sqlx::types::Json(speakers);
        job.stage = jobs::STAGE_SUMMARY;
    }

    summary_step(st, ai, worker, &job, &beat).await
}

async fn summary_step(st: &AppState, ai: &Ai, worker: &str, job: &Job, beat: &Arc<Mutex<Beat>>) -> Result<()> {
    let expected = pipeline::summary_seconds(job.duration_sec.unwrap_or(0.0));
    *beat.lock().unwrap() = Beat::timed(expected, 0.0, 1.0, 0.0);
    sqlx::query("UPDATE jobs SET summary_status = 'running', summary_error = NULL, stage = 2, eta_sec = $3 WHERE id = $1 AND locked_by = $2")
        .bind(job.id)
        .bind(worker)
        .bind(expected)
        .execute(&st.db)
        .await?;
    let segs = jobs::segments(&st.db, job.id).await?;
    let segments: Vec<transcript::Segment> = segs
        .iter()
        .map(|s| transcript::Segment { start: s.start_sec, end: s.end_sec, speaker: s.speaker as usize, text: s.text.clone() })
        .collect();
    let speakers: Vec<transcript::Speaker> =
        job.speakers.0.iter().map(|s| transcript::Speaker { label: s.label.clone(), name: s.name.clone(), role: s.role.clone() }).collect();
    let text = transcript::transcript_for_summary(&segments, &speakers);

    let out = pipeline::summarize(ai, &text, &job.name).await.context("summary")?;
    if !out.checks.is_clean() {
        tracing::warn!("summary for {} has citation issues: {:?}", job.id, out.checks);
    }
    sqlx::query(
        "UPDATE jobs SET status = 'done', stage = 2, stage_pct = 1, summary_status = 'done', summary = $2, summary_text = $3,
             summary_meta = $4, summary_error = NULL, error = NULL, eta_sec = NULL, locked_by = NULL, locked_at = NULL, attempts = 0,
             finished_at = COALESCE(finished_at, now()), updated_at = now()
         WHERE id = $1 AND locked_by = $5",
    )
    .bind(job.id)
    .bind(serde_json::to_value(&out.minutes)?)
    .bind(&out.text)
    .bind(json!(out.meta))
    .bind(worker)
    .execute(&st.db)
    .await?;
    Ok(())
}

async fn set_stage(st: &AppState, id: Uuid, worker: &str, stage: i32, eta: Option<f64>) -> Result<()> {
    sqlx::query(
        "UPDATE jobs SET stage = $2, stage_pct = CASE WHEN stage = $2 THEN stage_pct ELSE 0 END, eta_sec = COALESCE($4, eta_sec), updated_at = now()
         WHERE id = $1 AND locked_by = $3",
    )
    .bind(id)
    .bind(stage)
    .bind(worker)
    .bind(eta)
    .execute(&st.db)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timed_beat_moves_within_its_range() {
        let b = Beat::timed(100.0, 0.55, 1.0, 60.0);
        let (pct, eta) = b.now();
        assert!((0.55..0.56).contains(&pct));
        assert!(eta.unwrap() > 150.0);
        assert!(user_message(&anyhow::anyhow!("ElevenLabs API error 401 Unauthorized: x")).contains("ELEVENLABS_API_KEY"));
        assert!(user_message(&anyhow::anyhow!("summary: USER: ยาวเกิน")).starts_with("ยาวเกิน"));
    }
}
