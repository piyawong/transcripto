//! Re-run the real summary pipeline on a saved job without repeating speech recognition.
//! Usage: summarize_job <job-id> <new-output-directory> [--publish]
//! Publish an already-reviewed run without another model call: --publish-saved
//! The original summary and exact transcript are saved before any model call.
use anyhow::{Context, Result, ensure};
use serde_json::json;
use std::path::PathBuf;
use transcripto_api::{config::Config, jobs, minutes, pipeline::{self, Ai}};
use uuid::Uuid;

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    ensure!(args.len() >= 3, "usage: summarize_job <job-id> <new-output-directory> [--publish]");
    let id = Uuid::parse_str(&args[1])?;
    let out = PathBuf::from(&args[2]);
    let saved = args.iter().any(|s| s == "--publish-saved");
    if !saved {
        std::fs::create_dir(&out).context("use a new output directory to preserve previous runs")?;
    }
    let cfg = Config::from_env();
    let pool = sqlx::PgPool::connect(&cfg.database_url).await?;
    let job: jobs::Job = sqlx::query_as("SELECT * FROM jobs WHERE id = $1").bind(id).fetch_one(&pool).await?;
    ensure!(job.status == "done" && matches!(job.summary_status.as_str(), "done" | "failed"), "job must be idle");
    let segments = jobs::segments(&pool, id).await?;
    let transcript = jobs::summary_input(&segments, &job.speakers.0);
    let mut result = if saved {
        ensure!(std::fs::read_to_string(out.join("transcript.txt"))? == transcript, "saved transcript differs from job");
        let before: serde_json::Value = serde_json::from_slice(&std::fs::read(out.join("before.json"))?)?;
        ensure!(before["summary"] == json!(job.summary), "job summary changed since this run");
        let m: minutes::MeetingMinutes = serde_json::from_slice(&std::fs::read(out.join("summary.json"))?)?;
        let meta = serde_json::from_slice(&std::fs::read(out.join("meta.json"))?)?;
        pipeline::SummaryOutput { text: minutes::render_text(&m, &job.name, ""), checks: minutes::check(&m, &transcript), minutes: m, meta }
    } else {
        std::fs::write(out.join("transcript.txt"), &transcript)?;
        std::fs::write(out.join("before.json"), serde_json::to_vec_pretty(&json!({
            "job_id": id, "summary": job.summary, "summary_text": job.summary_text, "summary_meta": job.summary_meta
        }))?)?;
        println!("Summarizing {id}: {} transcript lines", segments.len());
        let ai = Ai::from_config(&cfg)?;
        ensure!(!ai.is_fixture(), "live validation requires real Gemini, not fixtures");
        pipeline::summarize(&ai, &transcript, &job.name).await?
    };
    result.meta["transcript_hash"] = json!(jobs::text_hash(&transcript));
    result.meta["checks"] = json!(result.checks);
    std::fs::write(out.join("summary.txt"), &result.text)?;
    std::fs::write(out.join("summary.json"), serde_json::to_vec_pretty(&result.minutes)?)?;
    std::fs::write(out.join("meta.json"), serde_json::to_vec_pretty(&result.meta)?)?;
    println!("Saved {} chars; metadata: {}", result.text.chars().count(), result.meta);
    if saved || args.iter().any(|s| s == "--publish") {
        ensure!(result.checks.is_clean(), "citation checks failed; result saved but not published");
        let current: jobs::Job = sqlx::query_as("SELECT * FROM jobs WHERE id = $1").bind(id).fetch_one(&pool).await?;
        let current_segments = jobs::segments(&pool, id).await?;
        ensure!(current.updated_at == job.updated_at && jobs::summary_input(&current_segments, &current.speakers.0) == transcript,
            "job changed during generation; result saved but not published");
        let changed = sqlx::query("UPDATE jobs SET summary = $2, summary_text = $3, summary_meta = $4,
            summary_status = 'done', summary_error = NULL, updated_at = now()
            WHERE id = $1 AND updated_at = $5 AND status = 'done' AND summary_status IN ('done', 'failed') AND locked_by IS NULL")
            .bind(id).bind(serde_json::to_value(&result.minutes)?).bind(&result.text).bind(&result.meta)
            .bind(job.updated_at).execute(&pool).await?;
        ensure!(changed.rows_affected() == 1, "job changed; result saved but not published");
        println!("Published summary to job {id}");
    }
    Ok(())
}
