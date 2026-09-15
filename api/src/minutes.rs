//! Meeting minutes (ported from bench/summarize.py): prompt, JSON schema, citation checks, plain-text render.

use std::collections::BTreeSet;
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub const PROMPT: &str = r###"You are writing detailed meeting minutes in Thai for executives who did not attend, based on an automatically generated transcript.

Transcript lines look like "[MM:SS] ผู้พูด N: text" (a line may end with its end time in parentheses). The transcript may end with a "## ผู้พูด" section mapping speaker labels to roles.
It came from speech recognition, so some words, names, and numbers may be wrong.

Split the meeting into segments in chronological order:
- report: someone presents or reports on a subject.
- advice: an executive, especially ประธานอาวุโส, gives advice, comments, or directives.
- discussion: a back-and-forth of questions and answers.
Start a new segment when the speaker or their purpose or subject changes. Very short interjections belong to the surrounding segment or to a discussion segment. Do not create segments for greetings or for chairing (inviting the next speaker) unless they contain substance.

For every segment:
- details: be thorough. Cover everything of substance in the order it was said: context, facts, numbers, names, problems, causes, plans, examples, and reasons. Write one complete, specific Thai sentence per point. Do not merge distinct points or reduce them to generic statements.
- For advice segments, write each piece of advice or directive as its own point, including the reasoning or examples given and what the speaker wants done. Set responds_to to the subject of the report it responds to, if any.
- quotes: for advice segments, 1-3 short key phrases copied verbatim from the transcript that capture the main advice or directive, each with the start time of its line. Other segments may have none.

Rules:
- Use only information in the transcript. Do not add outside knowledge or assumptions.
- Attribute segments to the role or name when known (e.g. ประธานอาวุโส, คุณเบน), otherwise to the speaker label.
- Keep numbers exactly as stated. Keep English terms and proper names as written.
- Copy MM:SS times exactly from the transcript.
- Plain text only inside every field: no Markdown, asterisks, or bullet symbols.
- action_items: directives and follow-ups that were requested. Fill owner and due only when explicitly stated.
- If a name, number, or statement looks mis-transcribed or ambiguous, keep it as written and list it in needs_confirmation."###;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SegmentKind {
    Report,
    Advice,
    Discussion,
}

impl SegmentKind {
    pub fn label(self) -> &'static str {
        match self {
            SegmentKind::Report => "รายงาน",
            SegmentKind::Advice => "ข้อชี้แนะ",
            SegmentKind::Discussion => "ถาม-ตอบ",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Quote {
    pub text: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MinutesSegment {
    pub kind: SegmentKind,
    pub speaker: String,
    pub subject: String,
    #[serde(default)]
    pub responds_to: Option<String>,
    pub start: String,
    pub end: String,
    #[serde(default)]
    pub details: Vec<String>,
    #[serde(default)]
    pub quotes: Vec<Quote>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionItem {
    pub task: String,
    #[serde(default)]
    pub requested_by: Option<String>,
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default)]
    pub due: Option<String>,
    #[serde(default)]
    pub timestamps: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Check {
    pub text: String,
    #[serde(default)]
    pub timestamps: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Participant {
    pub speaker: String,
    pub role: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingMinutes {
    pub title: String,
    #[serde(default)]
    pub participants: Vec<Participant>,
    pub overview: String,
    #[serde(default)]
    pub segments: Vec<MinutesSegment>,
    #[serde(default)]
    pub action_items: Vec<ActionItem>,
    #[serde(default)]
    pub needs_confirmation: Vec<Check>,
}

/// The exact `responseSchema` google-genai builds from the Pydantic MeetingMinutes model in bench/summarize.py
/// (dumped from the SDK), so the model sees the same schema as in the POC.
pub fn schema() -> Value {
    serde_json::from_str(include_str!("minutes_schema.json")).expect("minutes_schema.json")
}

/// The body google-genai sends for `generate_content(contents=transcript, system_instruction=PROMPT, response_schema=...)`
/// (fixtures/gemini-summary-request.json).
pub fn request_body(transcript: &str) -> Value {
    json_request(PROMPT, transcript, schema())
}

pub fn json_request(system: &str, content: &str, schema: Value) -> Value {
    json!({
        "contents": [{ "parts": [{ "text": content }], "role": "user" }],
        "systemInstruction": { "parts": [{ "text": system }], "role": "user" },
        "generationConfig": {
            "maxOutputTokens": 65536,
            "responseMimeType": "application/json",
            "responseSchema": schema,
        },
    })
}

static STAMP_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(\d{1,3}):(\d{2})").unwrap());
static LINE_PREFIX_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^\[\d{1,3}:\d{2}\]\s*(ผู้พูด\s*\d+\s*[:：])?").unwrap());
static END_MARK_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\(\d{1,3}:\d{2}\)").unwrap());
static WS_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());

/// Python's `int()` on a `\d+` match: ASCII and Thai digits (the only scripts a Thai transcript uses).
fn int(digits: &str) -> i64 {
    digits.chars().fold(0, |n, c| {
        let d = match c {
            '0'..='9' => c as i64 - '0' as i64,
            '\u{0E50}'..='\u{0E59}' => c as i64 - 0x0E50,
            _ => 0,
        };
        n * 10 + d
    })
}

/// "[0:16]" → "00:16"; None when there is no MM:SS in the value.
pub fn normalize_stamp(v: &str) -> Option<String> {
    STAMP_RE.captures(v).map(|c| format!("{:02}:{}", int(&c[1]), &c[2]))
}

pub fn seconds(stamp: &str) -> i64 {
    STAMP_RE.captures(stamp).map(|c| int(&c[1]) * 60 + int(&c[2])).unwrap_or(-1)
}

fn squash(t: &str) -> String {
    WS_RE.replace_all(t, "").to_string()
}

fn spoken_text(transcript: &str) -> String {
    let t = LINE_PREFIX_RE.replace_all(transcript, "");
    squash(&END_MARK_RE.replace_all(&t, ""))
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Checks {
    pub unmatched_citations: Vec<String>,
    pub quotes_not_in_transcript: Vec<String>,
    pub quotes_outside_segment: Vec<String>,
}

impl Checks {
    pub fn is_clean(&self) -> bool {
        self.unmatched_citations.is_empty() && self.quotes_not_in_transcript.is_empty() && self.quotes_outside_segment.is_empty()
    }
}

/// Same checks as summarize.py: citations exist, quotes are verbatim, quotes sit inside their segment.
pub fn check(m: &MeetingMinutes, transcript: &str) -> Checks {
    let known: BTreeSet<String> = STAMP_RE.find_iter(transcript).filter_map(|x| normalize_stamp(x.as_str())).collect();
    // Segment end times are left out: models often derive them (next segment start minus 1s).
    let mut cited: Vec<&str> = m.segments.iter().map(|s| s.start.as_str()).collect();
    cited.extend(m.segments.iter().flat_map(|s| s.quotes.iter().map(|q| q.timestamp.as_str())));
    cited.extend(m.action_items.iter().flat_map(|a| a.timestamps.iter().map(String::as_str)));
    cited.extend(m.needs_confirmation.iter().flat_map(|c| c.timestamps.iter().map(String::as_str)));
    let unmatched: BTreeSet<String> = cited
        .iter()
        .map(|s| normalize_stamp(s).unwrap_or_else(|| s.to_string()))
        .filter(|s| !known.contains(s))
        .collect();

    let flat = spoken_text(transcript);
    let not_in = m
        .segments
        .iter()
        .flat_map(|s| s.quotes.iter())
        .filter(|q| !flat.contains(&squash(&q.text)))
        .map(|q| q.text.clone())
        .collect();

    let mut outside = Vec::new();
    for (i, seg) in m.segments.iter().enumerate() {
        let limit = match m.segments.get(i + 1) {
            Some(next) => seconds(&next.start),
            None => seconds(&seg.end).max(seconds(&seg.start)),
        };
        for q in &seg.quotes {
            let t = seconds(&q.timestamp);
            if !(seconds(&seg.start) <= t && t <= limit) {
                outside.push(format!("{} {}", q.timestamp, q.text));
            }
        }
    }
    Checks { unmatched_citations: unmatched.into_iter().collect(), quotes_not_in_transcript: not_in, quotes_outside_segment: outside }
}

fn heading(s: &MinutesSegment) -> String {
    match s.kind {
        SegmentKind::Report => format!("{} รายงานเรื่อง{}", s.speaker, s.subject),
        SegmentKind::Advice => format!("{} ให้ข้อชี้แนะเรื่อง{}", s.speaker, s.subject),
        SegmentKind::Discussion => format!("ถาม-ตอบเรื่อง{} ({})", s.subject, s.speaker),
    }
}

/// Plain-text minutes, line for line the same layout as render_text() in summarize.py.
pub fn render_text(m: &MeetingMinutes, source_name: &str, model_id: &str) -> String {
    let mut out: Vec<String> = vec![m.title.clone(), String::new(), m.overview.clone(), String::new(), "ผู้เข้าร่วม".into()];
    out.extend(m.participants.iter().map(|p| format!("- {}: {}", p.speaker, p.role)));

    out.push(String::new());
    out.push("ลำดับการประชุม".into());
    for (i, s) in m.segments.iter().enumerate() {
        out.push(format!("{}. {}-{} {}: {} - {}", i + 1, s.start, s.end, s.kind.label(), s.speaker, s.subject));
    }

    for (i, s) in m.segments.iter().enumerate() {
        let mut when = format!("เวลา {}-{}", s.start, s.end);
        if let Some(r) = s.responds_to.as_deref().filter(|r| !r.is_empty()) {
            when.push_str(&format!(" (ต่อจากการรายงานเรื่อง{r})"));
        }
        out.push(String::new());
        out.push(format!("{}. {}", i + 1, heading(s)));
        out.push(when);
        out.extend(s.details.iter().map(|d| format!("- {d}")));
        if !s.quotes.is_empty() {
            out.push("คำพูดสำคัญ:".into());
            out.extend(s.quotes.iter().map(|q| format!("\"{}\" ({})", q.text, q.timestamp)));
        }
    }

    out.push(String::new());
    out.push("ข้อสั่งการ / สิ่งที่ต้องดำเนินการ".into());
    for (i, a) in m.action_items.iter().enumerate() {
        let dash = |v: &Option<String>| v.clone().filter(|x| !x.is_empty()).unwrap_or_else(|| "-".into());
        out.push(format!("{}. {}", i + 1, a.task));
        out.push(format!(
            "   ผู้สั่งการ: {} / ผู้รับผิดชอบ: {} / กำหนด: {} / อ้างอิง: {}",
            dash(&a.requested_by),
            dash(&a.owner),
            dash(&a.due),
            a.timestamps.join(", ")
        ));
    }
    if m.action_items.is_empty() {
        out.push("- ไม่มี".into());
    }

    if !m.needs_confirmation.is_empty() {
        out.push(String::new());
        out.push("ประเด็นที่ควรตรวจสอบกับเสียงจริง".into());
        out.extend(m.needs_confirmation.iter().map(|c| format!("- {} ({})", c.text, c.timestamps.join(", "))));
    }

    out.push(String::new());
    out.push(format!("สรุปอัตโนมัติด้วย {model_id} จาก {source_name} (เวลาอ้างอิงนับจากต้นไฟล์เสียงที่ถอด)"));
    out.push(String::new());
    out.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../docs/rust-implementation/fixtures/");

    fn fixture(name: &str) -> String {
        std::fs::read_to_string(format!("{FIXTURES}{name}")).unwrap()
    }

    #[test]
    fn checks_and_render_match_python() {
        if crate::testdata::missing() {
            return;
        }
        let transcript = fixture("correct-pro.expected.txt");
        for (short, model_id) in [("pro", "gemini-3.1-pro-preview"), ("flash", "gemini-3.8-flash")] {
            let m: MeetingMinutes = serde_json::from_str(&fixture(&format!("summary-{short}.minutes.json"))).unwrap();
            let expected: Value = serde_json::from_str(&fixture(&format!("summary-{short}.expected-checks.json"))).unwrap();
            assert_eq!(serde_json::to_value(check(&m, &transcript)).unwrap(), expected, "{short} checks");
            let text = render_text(&m, "scribe-v2-keyterms.corrected-gemini-3.1-pro.txt", model_id);
            assert_eq!(text, fixture(&format!("summary-{short}.expected.txt")), "{short} render");
        }
    }

    #[test]
    fn request_body_matches_sdk() {
        if crate::testdata::missing() {
            return;
        }
        let expected: Value = serde_json::from_str(&fixture("gemini-summary-request.json")).unwrap();
        let body = request_body("[00:00] ผู้พูด 1: ...\n[00:16] ผู้พูด 3: ...\n\n## ผู้พูด\nผู้พูด 3: ประธานอาวุโส");
        assert_eq!(body, expected);
    }

    #[test]
    fn stamps_like_python() {
        assert_eq!(normalize_stamp("[0:16]").as_deref(), Some("00:16"));
        assert_eq!(normalize_stamp("๑:๑๖").as_deref(), Some("01:๑๖"));
        assert_eq!(normalize_stamp("ไม่มี"), None);
        assert_eq!(seconds("180:05"), 10805);
        assert_eq!(seconds("?"), -1);
    }
}
