//! The AI steps, independent of the database (docs/rust-implementation/README.md):
//! ① ElevenLabs speech-to-text → lines, ② Gemini change list → corrected segments, ③ Gemini meeting minutes.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use futures::StreamExt;
use serde_json::{Value, json};

use crate::config::Config;
use crate::correct::{self, Corrections, Window};
use crate::elevenlabs::{self, ElevenLabs};
use crate::gemini::{self, Gemini, Usage};
use crate::lines::{self, Line};
use crate::minutes::{self, Checks, MeetingMinutes};
use crate::transcript::{self, Segment, Speaker};

/// Correction windows (README 5.6): 30 minutes of lines each, ±1 minute of context, 3 requests at a time.
const WINDOW_SECONDS: i64 = 1800;
const TAIL_SECONDS: i64 = 300;
const CONTEXT_SECONDS: i64 = 60;
const CONCURRENCY: usize = 3;

#[derive(Clone)]
pub enum Ai {
    Live { stt: ElevenLabs, gemini: Gemini, correct_model: String, summary_model: String },
    /// Replays docs/rust-implementation/fixtures (no network, no cost) for tests.
    Fixture(PathBuf),
}

impl Ai {
    pub fn from_config(cfg: &Config) -> Result<Ai> {
        if let Some(dir) = &cfg.fixture_dir {
            tracing::warn!("AI_FIXTURE_DIR set: replaying {} instead of calling ElevenLabs and Gemini", dir.display());
            return Ok(Ai::Fixture(dir.clone()));
        }
        let eleven = cfg.elevenlabs_api_key.clone().ok_or_else(|| anyhow!("ELEVENLABS_API_KEY is not set (or set AI_FIXTURE_DIR for test mode)"))?;
        let gemini = cfg.gemini_api_key.clone().ok_or_else(|| anyhow!("GEMINI_API_KEY is not set (or set AI_FIXTURE_DIR for test mode)"))?;
        Ok(Ai::Live {
            stt: ElevenLabs::new(eleven),
            gemini: Gemini::new(gemini),
            correct_model: cfg.correct_model.clone(),
            summary_model: cfg.summary_model.clone(),
        })
    }

    pub fn is_fixture(&self) -> bool {
        matches!(self, Ai::Fixture(_))
    }

    fn fixture(&self, name: &str) -> Option<PathBuf> {
        match self {
            Ai::Fixture(dir) => Some(dir.join(name)),
            Ai::Live { .. } => None,
        }
    }
}

// ---- Expected durations, used only for progress and ETA (measured on the 17-minute clip, 2026-09-15) ----

/// ElevenLabs: 82–109 s for 1029 s of audio, including the upload.
pub fn stt_seconds(duration: f64) -> f64 {
    15.0 + duration * 0.09
}

/// Gemini Pro correction: 96 s for 17 minutes, 132 s for 11 minutes (thinking varies); windows run 3 at a time.
pub fn correct_seconds(duration: f64) -> f64 {
    let windows = correct::plan_windows(duration as i64, WINDOW_SECONDS, TAIL_SECONDS).len().min(CONCURRENCY) as f64;
    30.0 + duration * 0.12 / windows
}

/// Gemini Pro minutes: 65 s for 17 minutes.
pub fn summary_seconds(duration: f64) -> f64 {
    25.0 + duration * 0.04
}

fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

// ---- ① Speech to text ----

pub struct SttOutput {
    /// The response as returned, stored as stt.json.
    pub raw: Value,
    pub meta: Value,
}

/// `terms`: the job's keyterms (already validated: at most 1000, each at most 50 characters).
pub async fn speech_to_text(ai: &Ai, audio: &Path, duration: f64, terms: &[String]) -> Result<SttOutput> {
    let started = Instant::now();
    let raw = match ai {
        Ai::Fixture(_) => {
            tokio::time::sleep(Duration::from_millis(2000)).await;
            let path = ai.fixture("elevenlabs-response.json").unwrap();
            let mut raw: Value = serde_json::from_str(&tokio::fs::read_to_string(&path).await.context("reading fixture STT response")?)?;
            // The fixture is 17 minutes long; keep only the words inside the uploaded file.
            if let Some(words) = raw["words"].as_array_mut() {
                words.retain(|w| w["start"].as_f64().unwrap_or(0.0) < duration);
            }
            raw["audio_duration_secs"] = json!(duration);
            raw
        }
        Ai::Live { stt, .. } => stt.transcribe(audio, duration, terms).await?,
    };
    let mut meta = stt_meta(ai, &raw, terms.len())?;
    meta["elapsed_seconds"] = json!(round1(started.elapsed().as_secs_f64()));
    Ok(SttOutput { raw, meta })
}

/// Run metadata of a speech-to-text response (also for one stored by an earlier attempt).
pub fn stt_meta(ai: &Ai, raw: &Value, terms: usize) -> Result<Value> {
    let parsed = elevenlabs::parse(raw)?;
    let seconds = parsed.audio_duration_secs.unwrap_or(0.0);
    Ok(json!({
        "model_id": if ai.is_fixture() { "fixture" } else { elevenlabs::MODEL },
        "keyterms": terms,
        "language_code": parsed.language_code,
        "language_probability": parsed.language_probability,
        "audio_seconds": seconds,
        "words": parsed.words.len(),
        "cost_usd": if ai.is_fixture() { 0.0 } else { elevenlabs::cost_usd(seconds, terms > 0) },
    }))
}

/// Lines of the transcript from a stored ElevenLabs response (the same grouping as bench/transcribe.py).
pub fn lines_from_stt(raw: &Value) -> Result<Vec<Line>> {
    let parsed = elevenlabs::parse(raw)?;
    let lines = lines::words_to_lines(&parsed.words, 15.0, 25.0, 60.0);
    if lines.iter().all(|l| l.text.is_empty()) {
        bail!("NO_SPEECH");
    }
    Ok(lines)
}

// ---- ② Correction ----

pub struct CorrectOutput {
    pub segments: Vec<Segment>,
    pub speakers: Vec<Speaker>,
    /// Merged Corrections, the result of every edit, leftover number words and speaker-role conflicts.
    pub corrections: Value,
    /// Plain-text change log (render_changes).
    pub changes_text: String,
    pub meta: Value,
}

/// Corrections from one request, or None when the answer was cut off (MAX_TOKENS) and the window must be split.
type Answer = (Option<Corrections>, Usage);

async fn request_corrections(ai: &Ai, glossary: &[String], lines: &[String]) -> Result<Answer> {
    match ai {
        Ai::Fixture(_) => {
            tokio::time::sleep(Duration::from_millis(1500)).await;
            let raw = tokio::fs::read_to_string(ai.fixture("correct-pro.corrections.json").unwrap()).await.context("reading fixture corrections")?;
            Ok((Some(serde_json::from_str(&raw)?), Usage::default()))
        }
        Ai::Live { gemini, correct_model, .. } => {
            let g = gemini.generate(correct_model, &correct::request_body(glossary, lines)).await.context("Gemini correction")?;
            match g.finish_reason.as_deref() {
                Some("STOP") => Ok((Some(g.json().context("Gemini correction")?), g.usage)),
                Some("MAX_TOKENS") => Ok((None, g.usage)),
                other => bail!("Gemini correction stopped early ({})", other.unwrap_or("no finish reason")),
            }
        }
    }
}

/// Corrects the transcript as an audited change list. Short transcripts go in one request exactly like the POC;
/// long ones in overlapping windows (README 5.6). `on_progress` receives 0..1 as windows finish.
/// `glossary`: the job's keyterms, listed in the prompt as names and terms of the meeting.
pub async fn correct(ai: &Ai, lines: &[Line], glossary: &[String], source_name: &str, on_progress: impl Fn(f64) + Send + Sync) -> Result<CorrectOutput> {
    let started = Instant::now();
    let model = match ai {
        Ai::Fixture(_) => "fixture",
        Ai::Live { correct_model, .. } => correct_model.as_str(),
    };
    let text: Vec<String> = lines.iter().map(Line::render).collect();
    let secs = correct::line_seconds(&text);
    let last = secs.iter().copied().max().unwrap_or(0).max(0);
    let planned = correct::plan_windows(last, WINDOW_SECONDS, TAIL_SECONDS);
    let whole = planned.len() == 1;

    let mut pending: Vec<(Window, u8)> = planned.iter().map(|w| (*w, 0)).collect();
    let mut done: Vec<(Window, u8, Corrections)> = Vec::new();
    let mut usage = Usage::default();
    let mut calls = 0usize;
    let expected = AtomicUsize::new(pending.len());
    let finished = Arc::new(AtomicUsize::new(0));

    while !pending.is_empty() {
        let round = std::mem::take(&mut pending);
        let results: Vec<(Window, u8, Result<Answer>)> = futures::stream::iter(round.into_iter().map(|(w, depth)| {
            // The single planned window sends everything, unfiltered, like the POC.
            let sent = if whole && depth == 0 { text.clone() } else { correct::window_lines(&text, &secs, w, CONTEXT_SECONDS) };
            let (finished, expected, on_progress) = (finished.clone(), &expected, &on_progress);
            async move {
                let r = request_corrections(ai, glossary, &sent).await;
                let n = finished.fetch_add(1, Ordering::SeqCst) + 1;
                on_progress((n as f64 / expected.load(Ordering::SeqCst).max(1) as f64).min(1.0));
                (w, depth, r)
            }
        }))
        .buffer_unordered(CONCURRENCY)
        .collect()
        .await;

        for (w, depth, r) in results {
            let (answer, u) = r?;
            calls += 1;
            usage.add(&u);
            match answer {
                Some(c) => done.push((w, depth, c)),
                None => match w.halves(last).filter(|_| depth < 2) {
                    Some((a, b)) => {
                        tracing::warn!("correction window {}-{} s hit MAX_TOKENS, splitting", w.start, w.end.min(last + 1));
                        expected.fetch_add(2, Ordering::SeqCst);
                        pending.push((a, depth + 1));
                        pending.push((b, depth + 1));
                    }
                    None => bail!("USER: ข้อความยาวเกินกว่าจะตรวจแก้ได้ ลองตัดวิดีโอเป็นช่วงสั้นลงแล้วอัปโหลดใหม่"),
                },
            }
        }
    }

    done.sort_by_key(|(w, _, _)| w.start);
    let windows = done.len();
    let (merged, conflicts) = if whole && windows == 1 && done[0].1 == 0 {
        (done.pop().unwrap().2, Vec::new())
    } else {
        correct::merge_windows(done.into_iter().map(|(w, _, c)| correct::keep_own(c, w)).collect())
    };

    let mut fixed = text.clone();
    let results = correct::apply_edits(&mut fixed, &merged.edits);
    let leftovers = correct::leftover_numbers(&fixed);
    let changes_text = correct::render_changes(source_name, model, &merged.edits, &results, &merged, &leftovers);
    let (segments, speakers) = transcript::build(lines, &fixed, &merged.speakers);
    if segments.is_empty() {
        bail!("NO_SPEECH");
    }

    let applied = |k: correct::EditKind| merged.edits.iter().zip(&results).filter(|(e, r)| r.is_none() && e.kind == k).count();
    let to_confirm = results.iter().filter(|r| r.as_deref() == Some(correct::NEEDS_CONFIRMATION)).count();
    let meta = json!({
        "model_id": model,
        "calls": calls,
        "windows": windows,
        "tokens_in": usage.tokens_in,
        "tokens_out": usage.tokens_out,
        "tokens_thinking": usage.tokens_thinking,
        "cost_usd": gemini::cost_usd(model, &usage),
        "elapsed_seconds": round1(started.elapsed().as_secs_f64()),
        "edits_proposed": merged.edits.len(),
        "applied_correction": applied(correct::EditKind::Correction),
        "applied_number": applied(correct::EditKind::Number),
        "names_to_confirm": to_confirm,
        "rejected": results.iter().filter(|r| r.is_some()).count() - to_confirm,
        "unclear": merged.unclear.len(),
        "leftover_numbers": leftovers.len(),
        "speaker_conflicts": conflicts.len(),
    });
    let corrections = json!({
        "corrections": merged,
        "results": results,
        "leftover_numbers": leftovers,
        "speaker_conflicts": conflicts,
    });
    Ok(CorrectOutput { segments, speakers, corrections, changes_text, meta })
}

// ---- ③ Meeting minutes ----

#[derive(Debug, Clone)]
pub struct SummaryOutput {
    pub minutes: MeetingMinutes,
    pub text: String,
    pub checks: Checks,
    pub meta: Value,
}

/// One request for the whole transcript (README 6.4 v1): an answer cut off at MAX_TOKENS is an error, never used.
pub async fn summarize(ai: &Ai, transcript_text: &str, source_name: &str) -> Result<SummaryOutput> {
    let started = Instant::now();
    let (minutes, model, finish, usage) = match ai {
        Ai::Fixture(_) => {
            tokio::time::sleep(Duration::from_millis(1500)).await;
            let raw = tokio::fs::read_to_string(ai.fixture("summary-pro.minutes.json").unwrap()).await.context("reading fixture minutes")?;
            (serde_json::from_str::<MeetingMinutes>(&raw)?, "fixture", Some("STOP".to_string()), Usage::default())
        }
        Ai::Live { gemini, summary_model, .. } => {
            let g = gemini.generate(summary_model, &minutes::request_body(transcript_text)).await.context("Gemini summary")?;
            match g.finish_reason.as_deref() {
                Some("STOP") => {}
                Some("MAX_TOKENS") => bail!("USER: การประชุมนี้ยาวเกินกว่าจะสรุปได้ในครั้งเดียว (ยังไม่รองรับการสรุปทีละช่วง)"),
                other => bail!("Gemini summary stopped early ({})", other.unwrap_or("no finish reason")),
            }
            let m: MeetingMinutes = g.json().context("Gemini summary")?;
            (m, summary_model.as_str(), g.finish_reason.clone(), g.usage)
        }
    };
    let checks = minutes::check(&minutes, transcript_text);
    let text = minutes::render_text(&minutes, source_name, model);
    let meta = json!({
        "model_id": model,
        "finish_reason": finish,
        "tokens_in": usage.tokens_in,
        "tokens_out": usage.tokens_out,
        "tokens_thinking": usage.tokens_thinking,
        "cost_usd": gemini::cost_usd(model, &usage),
        "elapsed_seconds": round1(started.elapsed().as_secs_f64()),
        "detail_points": minutes.segments.iter().map(|s| s.details.len()).sum::<usize>(),
        "checks": checks,
    });
    Ok(SummaryOutput { minutes, text, checks, meta })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn estimates_grow_with_duration() {
        assert!((stt_seconds(1029.0) - 107.6).abs() < 1.0);
        assert!(correct_seconds(1029.0) < correct_seconds(2000.0));
        assert!(correct_seconds(10_800.0) < 10_800.0 * 0.095, "long files run windows in parallel");
        assert!(summary_seconds(1029.0) > 60.0);
    }

    #[tokio::test]
    async fn fixture_pipeline_end_to_end() {
        if crate::testdata::missing() {
            return;
        }
        let ai = Ai::Fixture(PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../docs/rust-implementation/fixtures")));
        let terms = elevenlabs::keyterms(include_str!("../keyterms.txt"));
        let stt = speech_to_text(&ai, Path::new("unused.wav"), 150.0, &terms).await.unwrap();
        let lines = lines_from_stt(&stt.raw).unwrap();
        assert!(lines.iter().all(|l| l.start < 150.0));
        let out = correct(&ai, &lines, &terms, "demo.mp4", |_| {}).await.unwrap();
        assert_eq!(out.segments.len(), lines.len());
        assert!(out.changes_text.starts_with("ผลตรวจแก้ข้อความ demo.mp4 ด้วย fixture\n"));
        let text = transcript::transcript_for_summary(&out.segments, &out.speakers);
        let s = summarize(&ai, &text, "demo.mp4").await.unwrap();
        assert!(s.text.contains("สรุปอัตโนมัติด้วย fixture จาก demo.mp4"));
    }
}
