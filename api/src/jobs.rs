//! Job rows and their JSON views.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use uuid::Uuid;

pub const STATUS_UPLOADING: &str = "uploading";
pub const STATUS_PROCESSING: &str = "processing";
pub const STATUS_DONE: &str = "done";
pub const STATUS_FAILED: &str = "failed";

pub const STAGE_EXTRACT: i32 = 0;
pub const STAGE_TRANSCRIBE: i32 = 1;
pub const STAGE_SUMMARY: i32 = 2;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Job {
    pub id: Uuid,
    pub user_id: Uuid,
    pub name: String,
    pub size_bytes: i64,
    pub source_ext: String,
    pub status: String,
    pub stage: i32,
    pub stage_pct: f32,
    pub eta_sec: Option<f64>,
    pub error: Option<String>,
    pub duration_sec: Option<f64>,
    pub has_video: Option<bool>,
    pub has_thumb: bool,
    pub speakers: sqlx::types::Json<Vec<SpeakerView>>,
    pub transcript_meta: Option<Value>,
    pub summary_status: String,
    pub summary: Option<Value>,
    pub summary_text: Option<String>,
    pub summary_meta: Option<Value>,
    pub summary_error: Option<String>,
    /// Keyterms copied from the owner's settings when the job was created.
    pub keyterms: Option<Vec<String>>,
    pub attempts: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SpeakerView {
    pub label: String,
    pub name: String,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub talk_sec: f64,
    #[serde(default)]
    pub pct: f64,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct SegmentRow {
    #[serde(rename = "start")]
    pub start_sec: f64,
    #[serde(rename = "end")]
    pub end_sec: f64,
    pub speaker: i32,
    pub text: String,
}

#[derive(Debug, Serialize)]
pub struct JobView {
    pub id: Uuid,
    pub name: String,
    pub size_bytes: i64,
    pub status: String,
    pub stage: i32,
    pub stage_pct: f32,
    pub eta_sec: Option<f64>,
    pub error: Option<String>,
    pub duration_sec: Option<f64>,
    pub has_video: Option<bool>,
    pub has_thumb: bool,
    pub speakers: Vec<SpeakerView>,
    pub segment_count: i64,
    pub summary_status: String,
    pub summary_error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
pub struct JobDetail {
    #[serde(flatten)]
    pub job: JobView,
    pub segments: Vec<SegmentRow>,
    /// Whether the correction log (changes.txt) exists; jobs transcribed before the ElevenLabs pipeline have none.
    pub has_changes: bool,
    pub transcript_meta: Option<Value>,
    pub summary: Option<Value>,
    pub summary_text: Option<String>,
    pub summary_meta: Option<Value>,
    /// The transcript was edited or a speaker renamed after the summary was made.
    pub summary_stale: bool,
}

/// Longest text of one transcript line a user may save.
pub const MAX_SEGMENT_CHARS: usize = 2000;

/// The text the summary step sends to Gemini for these segments and speakers.
pub fn summary_input(segments: &[SegmentRow], speakers: &[SpeakerView]) -> String {
    let segs: Vec<crate::transcript::Segment> = segments
        .iter()
        .map(|s| crate::transcript::Segment { start: s.start_sec, end: s.end_sec, speaker: s.speaker as usize, text: s.text.clone() })
        .collect();
    let people: Vec<crate::transcript::Speaker> =
        speakers.iter().map(|s| crate::transcript::Speaker { label: s.label.clone(), name: s.name.clone(), role: s.role.clone() }).collect();
    crate::transcript::transcript_for_summary(&segs, &people)
}

/// Stored in summary_meta.transcript_hash so later edits can be detected.
pub fn text_hash(text: &str) -> String {
    Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// A finished summary was made from a different transcript than the stored one. Summaries made before the hash
/// was recorded are never reported stale.
pub fn summary_stale(job: &Job, segments: &[SegmentRow]) -> bool {
    job.summary_status == STATUS_DONE
        && job
            .summary_meta
            .as_ref()
            .and_then(|m| m.get("transcript_hash"))
            .and_then(Value::as_str)
            .is_some_and(|h| h != text_hash(&summary_input(segments, &job.speakers.0)))
}

impl Job {
    pub fn view(&self, segment_count: i64) -> JobView {
        JobView {
            id: self.id,
            name: self.name.clone(),
            size_bytes: self.size_bytes,
            status: self.status.clone(),
            stage: self.stage,
            stage_pct: self.stage_pct,
            eta_sec: self.eta_sec,
            error: self.error.clone(),
            duration_sec: self.duration_sec,
            has_video: self.has_video,
            has_thumb: self.has_thumb,
            speakers: self.speakers.0.clone(),
            segment_count,
            summary_status: self.summary_status.clone(),
            summary_error: self.summary_error.clone(),
            created_at: self.created_at,
            updated_at: self.updated_at,
            finished_at: self.finished_at,
        }
    }
}

pub async fn get_owned(db: &PgPool, id: Uuid, user_id: Uuid) -> sqlx::Result<Option<Job>> {
    sqlx::query_as::<_, Job>("SELECT * FROM jobs WHERE id = $1 AND user_id = $2").bind(id).bind(user_id).fetch_optional(db).await
}

pub async fn segment_count(db: &PgPool, id: Uuid) -> sqlx::Result<i64> {
    let (n,): (i64,) = sqlx::query_as("SELECT count(*) FROM segments WHERE job_id = $1").bind(id).fetch_one(db).await?;
    Ok(n)
}

pub async fn list_for_user(db: &PgPool, user_id: Uuid) -> sqlx::Result<Vec<JobView>> {
    #[derive(sqlx::FromRow)]
    struct Row {
        #[sqlx(flatten)]
        job: Job,
        segment_count: i64,
    }
    let rows = sqlx::query_as::<_, Row>(
        "SELECT j.*, (SELECT count(*) FROM segments s WHERE s.job_id = j.id) AS segment_count
         FROM jobs j WHERE j.user_id = $1 ORDER BY j.created_at DESC LIMIT 200",
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(|r| r.job.view(r.segment_count)).collect())
}

/// Jobs whose transcript contains `q` (case-insensitive substring; Thai has no word boundaries to index on),
/// with the first matching line so the library can show where it was said.
#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct TranscriptMatch {
    pub id: Uuid,
    pub hits: i64,
    pub start: f64,
    pub text: String,
}

pub async fn search_transcripts(db: &PgPool, user_id: Uuid, q: &str) -> sqlx::Result<Vec<TranscriptMatch>> {
    let pattern = format!("%{}%", q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
    sqlx::query_as::<_, TranscriptMatch>(
        "SELECT s.job_id AS id, count(*) AS hits,
                (array_agg(s.start_sec ORDER BY s.idx))[1] AS start,
                (array_agg(s.text ORDER BY s.idx))[1] AS text
         FROM segments s JOIN jobs j ON j.id = s.job_id
         WHERE j.user_id = $1 AND s.text ILIKE $2 ESCAPE '\\'
         GROUP BY s.job_id",
    )
    .bind(user_id)
    .bind(pattern)
    .fetch_all(db)
    .await
}

pub async fn segments(db: &PgPool, id: Uuid) -> sqlx::Result<Vec<SegmentRow>> {
    sqlx::query_as::<_, SegmentRow>("SELECT start_sec, end_sec, speaker, text FROM segments WHERE job_id = $1 ORDER BY idx")
        .bind(id)
        .fetch_all(db)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summary_input_follows_edits_and_renames() {
        let seg = |text: &str| SegmentRow { start_sec: 16.0, end_sec: 20.0, speaker: 0, text: text.into() };
        let mut people = vec![SpeakerView { label: "ผู้พูด 1".into(), name: "ผู้พูด 1".into(), role: None, talk_sec: 4.0, pct: 1.0 }];
        let before = summary_input(&[seg("สวัสดีครับ")], &people);
        assert_eq!(before, "[00:16] ผู้พูด 1: สวัสดีครับ\n\n## ผู้พูด\nผู้พูด 1: ไม่ทราบ\n");
        assert_ne!(text_hash(&before), text_hash(&summary_input(&[seg("สวัสดีค่ะ")], &people)));
        people[0].name = "คุณเอ".into();
        assert!(summary_input(&[seg("สวัสดีครับ")], &people).ends_with("ผู้พูด 1: คุณเอ\n"));
    }
}
