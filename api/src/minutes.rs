//! Meeting minutes (ported from bench/summarize.py): prompt, JSON schema, citation checks, plain-text render.

use std::collections::BTreeSet;
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub const PROMPT: &str = include_str!("minutes_prompt.txt");

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
pub struct ReportSection {
    pub heading: String,
    #[serde(default)]
    pub paragraphs: Vec<String>,
    #[serde(default)]
    pub items: Vec<String>,
    #[serde(default)]
    pub numbered: bool,
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
    pub report_sections: Vec<ReportSection>,
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
    pub assigned_on: Option<String>,
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

/// Extend the original wire schema; serde defaults keep stored v1 summaries readable.
pub fn schema() -> Value {
    let mut schema: Value = serde_json::from_str(include_str!("minutes_schema.json")).expect("minutes_schema.json");
    let segment = &mut schema["properties"]["segments"]["items"];
    segment["properties"]["report_sections"] = json!({
        "type": "ARRAY",
        "description": "Full report organized by subheading, paragraphs and detailed lists. Empty for advice/discussion.",
        "items": {
            "type": "OBJECT",
            "properties": {
                "heading": {"type": "STRING"},
                "paragraphs": {"type": "ARRAY", "items": {"type": "STRING"}},
                "items": {"type": "ARRAY", "items": {"type": "STRING"}},
                "numbered": {"type": "BOOLEAN"}
            },
            "required": ["heading", "paragraphs", "items", "numbered"]
        }
    });
    segment["required"].as_array_mut().unwrap().push(json!("report_sections"));
    segment["property_ordering"].as_array_mut().unwrap().push(json!("report_sections"));
    let action = &mut schema["properties"]["action_items"]["items"];
    action["properties"]["assigned_on"] = json!({
        "type": "STRING", "nullable": true,
        "description": "Explicit original assignment date; distinct from deadline. Never infer the year."
    });
    action["required"].as_array_mut().unwrap().push(json!("assigned_on"));
    action["property_ordering"].as_array_mut().unwrap().push(json!("assigned_on"));
    schema
}

/// The body google-genai sends for `generate_content(contents=transcript, system_instruction=PROMPT, response_schema=...)`
/// (fixtures/gemini-summary-request.json).
pub fn request_body(transcript: &str) -> Value {
    json_request(PROMPT, transcript, schema())
}

/// Long meetings get a second reading of each section from the original transcript.
/// Preserve the initial chronology, including deliberate omission of historical read-backs.
pub fn expand_sections(transcript: &str) -> bool {
    let times: Vec<i64> = transcript.lines().filter(|l| l.starts_with('[')).map(seconds).filter(|t| *t >= 0).collect();
    matches!((times.first(), times.last()), (Some(first), Some(last)) if last - first >= 2700)
}

pub fn section_input(transcript: &str, segments: &[MinutesSegment], index: usize) -> anyhow::Result<String> {
    let segment = &segments[index];
    let start = seconds(&segment.start);
    let stop = segments.get(index + 1).map(|s| seconds(&s.start));
    anyhow::ensure!(start >= 0 && stop.is_none_or(|t| t > start), "summary sections must have increasing timestamps");
    let mut selected = Vec::new();
    let mut in_line = false;
    for line in transcript.split("\n## ผู้พูด").next().unwrap_or(transcript).lines() {
        if line.starts_with('[') {
            let t = seconds(line);
            in_line = t >= start && stop.is_none_or(|stop| t < stop);
        }
        if in_line { selected.push(line); }
    }
    anyhow::ensure!(!selected.is_empty(), "summary section has no source lines");
    let speakers = transcript.split_once("\n## ผู้พูด").map(|(_, s)| s).unwrap_or("");
    Ok(format!(
        "อ่านช่วงนี้ใหม่จากต้นฉบับเพื่อเขียนสาระครบทุกหัวข้อ ไม่ใช่ย่อร่างเดิม\nหัวข้อเบื้องต้น: {}\nผู้พูดเบื้องต้น: {}\nชนิดเบื้องต้น: {:?}\n\n{}\n\n## ผู้พูด{}",
        segment.subject, segment.speaker, segment.kind, selected.join("\n"), speakers
    ))
}

pub fn expansion_request(content: &str, kind: SegmentKind) -> Value {
    let mut segment_schema = schema()["properties"]["segments"]["items"].clone();
    segment_schema["properties"]["kind"]["enum"] = json!([kind]);
    let system = format!("{PROMPT}\n{}", include_str!("minutes_expansion_prompt.txt"));
    json_request(&system, content, json!({
        "type": "OBJECT",
        "properties": {
            "segment": segment_schema,
            "needs_confirmation": schema()["properties"]["needs_confirmation"]
        },
        "required": ["segment", "needs_confirmation"]
    }))
}

#[derive(Debug, Deserialize)]
pub struct ExpandedSection {
    pub segment: MinutesSegment,
    pub needs_confirmation: Vec<Check>,
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
    STAMP_RE
        .captures(v)
        .map(|c| format!("{:02}:{}", int(&c[1]), &c[2]))
}

pub fn seconds(stamp: &str) -> i64 {
    STAMP_RE
        .captures(stamp)
        .map(|c| int(&c[1]) * 60 + int(&c[2]))
        .unwrap_or(-1)
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
        self.unmatched_citations.is_empty()
            && self.quotes_not_in_transcript.is_empty()
            && self.quotes_outside_segment.is_empty()
    }
}

/// Same checks as summarize.py: citations exist, quotes are verbatim, quotes sit inside their segment.
pub fn check(m: &MeetingMinutes, transcript: &str) -> Checks {
    let known: BTreeSet<String> = STAMP_RE
        .find_iter(transcript)
        .filter_map(|x| normalize_stamp(x.as_str()))
        .collect();
    // Segment end times are left out: models often derive them (next segment start minus 1s).
    let mut cited: Vec<&str> = m.segments.iter().map(|s| s.start.as_str()).collect();
    cited.extend(
        m.segments
            .iter()
            .flat_map(|s| s.quotes.iter().map(|q| q.timestamp.as_str())),
    );
    cited.extend(
        m.action_items
            .iter()
            .flat_map(|a| a.timestamps.iter().map(String::as_str)),
    );
    cited.extend(
        m.needs_confirmation
            .iter()
            .flat_map(|c| c.timestamps.iter().map(String::as_str)),
    );
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
    Checks {
        unmatched_citations: unmatched.into_iter().collect(),
        quotes_not_in_transcript: not_in,
        quotes_outside_segment: outside,
    }
}

fn heading(s: &MinutesSegment) -> String {
    match s.kind {
        SegmentKind::Report => format!("วาระ: {}", s.subject.trim_start_matches("วาระ:").trim()),
        SegmentKind::Advice => format!("ข้อชี้แนะจาก{}", s.speaker),
        SegmentKind::Discussion => format!("ประเด็นถาม-ตอบ: {}", s.subject),
    }
}

/// Plain-text minutes in the same report → presenter → details → advice flow used by formal Thai minutes.
/// Timestamps stay in the structured JSON for the interactive UI; quotes stay there for audit checks.
pub fn render_text(m: &MeetingMinutes, _source_name: &str, _model_id: &str) -> String {
    let mut out: Vec<String> = vec![m.title.clone()];
    if !m.overview.trim().is_empty() {
        out.extend([String::new(), m.overview.clone()]);
    }

    for s in &m.segments {
        out.push(String::new());
        out.push(heading(s));
        if matches!(s.kind, SegmentKind::Report | SegmentKind::Discussion) {
            out.push(format!("โดย {}", s.speaker));
        }
        match s.kind {
            SegmentKind::Report => out.extend(s.details.iter().cloned()),
            SegmentKind::Advice | SegmentKind::Discussion => {
                out.extend(s.details.iter().map(|d| format!("- {d}")));
            }
        }
        for section in &s.report_sections {
            out.push(String::new());
            if !section.heading.trim().is_empty() {
                out.push(section.heading.clone());
            }
            out.extend(section.paragraphs.iter().cloned());
            for (i, item) in section.items.iter().enumerate() {
                out.push(if section.numbered { format!("{}. {item}", i + 1) } else { format!("- {item}") });
            }
        }
    }

    out.push(String::new());
    let requesters: BTreeSet<&str> = m
        .action_items
        .iter()
        .filter_map(|a| a.requested_by.as_deref())
        .filter(|x| !x.is_empty())
        .collect();
    let all_attributed = m.action_items.iter().all(|a| a.requested_by.as_deref().is_some_and(|x| !x.trim().is_empty()));
    let action_heading = match requesters.iter().copied().collect::<Vec<_>>().as_slice() {
        [requester] if all_attributed => format!("สรุปงานที่{requester}มอบหมาย"),
        _ => "สรุปงานที่ได้รับมอบหมาย".into(),
    };
    out.push(action_heading);
    let mut previous_group = None;
    for a in &m.action_items {
        let owner = a.owner.as_deref().filter(|x| !x.is_empty());
        let group = (owner, a.assigned_on.as_deref(), a.requested_by.as_deref());
        if previous_group != Some(group) {
            out.push(String::new());
            match owner {
                Some(owner) => out.push(format!("ฝาก{owner}")),
                None => out.push("งานที่ต้องดำเนินการ".into()),
            }
            if let Some(date) = a.assigned_on.as_deref().filter(|s| !s.trim().is_empty()) {
                out.last_mut().unwrap().push_str(&format!(" เมื่อวันที่ {date}"));
            }
            if !all_attributed || requesters.len() != 1 {
                if let Some(requester) = a.requested_by.as_deref().filter(|s| !s.is_empty()) {
                    out.push(format!("ผู้มอบหมาย: {requester}"));
                }
            }
            previous_group = Some(group);
        }
        out.push(format!("- {}", a.task));
        if let Some(due) = a.due.as_deref().filter(|x| !x.is_empty()) {
            out.push(format!("  กำหนด: {due}"));
        }
    }
    if m.action_items.is_empty() {
        out.push("- ไม่มี".into());
    }

    if !m.needs_confirmation.is_empty() {
        out.push(String::new());
        out.push("ประเด็นที่ควรตรวจสอบกับเสียงจริง".into());
        out.extend(
            m.needs_confirmation
                .iter()
                .map(|c| format!("- {} ({})", c.text, c.timestamps.join(", "))),
        );
    }

    out.push(String::new());
    out.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURES: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../docs/rust-implementation/fixtures/"
    );

    fn fixture(name: &str) -> String {
        std::fs::read_to_string(format!("{FIXTURES}{name}")).unwrap()
    }

    #[test]
    fn legacy_summaries_keep_details_and_citation_checks() {
        if crate::testdata::missing() {
            return;
        }
        let transcript = fixture("correct-pro.expected.txt");
        for (short, model_id) in [
            ("pro", "gemini-3.1-pro-preview"),
            ("flash", "gemini-3.8-flash"),
        ] {
            let m: MeetingMinutes =
                serde_json::from_str(&fixture(&format!("summary-{short}.minutes.json"))).unwrap();
            let expected: Value =
                serde_json::from_str(&fixture(&format!("summary-{short}.expected-checks.json")))
                    .unwrap();
            assert_eq!(
                serde_json::to_value(check(&m, &transcript)).unwrap(),
                expected,
                "{short} checks"
            );
            let text = render_text(
                &m,
                "scribe-v2-keyterms.corrected-gemini-3.1-pro.txt",
                model_id,
            );
            for s in &m.segments {
                for detail in &s.details {
                    assert!(text.contains(detail), "{short}: lost a legacy detail");
                }
            }
            for action in &m.action_items {
                assert!(text.contains(&action.task), "{short}: lost an assignment");
            }
            assert!(!text.contains("ลำดับการประชุม"));
        }
    }

    #[test]
    fn request_includes_nested_reports_and_separate_assignment_dates() {
        let body =
            request_body("[00:00] ผู้พูด 1: ...\n[00:16] ผู้พูด 3: ...\n\n## ผู้พูด\nผู้พูด 3: ประธานอาวุโส");
        assert_eq!(body["systemInstruction"]["parts"][0]["text"], PROMPT);
        let schema = &body["generationConfig"]["responseSchema"];
        assert_eq!(schema["properties"]["segments"]["items"]["properties"]["report_sections"]["type"], "ARRAY");
        assert_eq!(schema["properties"]["action_items"]["items"]["properties"]["assigned_on"]["nullable"], true);
        let expansion = expansion_request("[10:00] ผู้พูด 1: ข้อเสนอแนะ", SegmentKind::Advice);
        assert_eq!(expansion["generationConfig"]["responseSchema"]["properties"]["segment"]["properties"]["kind"]["enum"], json!(["advice"]));
    }

    #[test]
    fn render_preserves_report_hierarchy_and_unassigned_dated_tasks() {
        let m: MeetingMinutes = serde_json::from_value(json!({
            "title": "ประชุมทดสอบ", "overview": "",
            "segments": [{
                "kind": "report", "subject": "ผลดำเนินงาน", "speaker": "คุณเอ และคุณบี",
                "start": "01:00", "end": "10:00",
                "report_sections": [
                    {"heading": "ผลจริงและเป้าหมาย", "paragraphs": ["ผลจริง 42,000 คน เป้า 32,000 คน"], "items": [], "numbered": false},
                    {"heading": "แผนพัฒนา", "paragraphs": [], "items": ["ขยายร้านค้า 5 แห่ง", "เพิ่มที่จอดรถ 1,200 คัน"], "numbered": true}
                ]
            }],
            "action_items": [
                {"task": "รายงานปัญหา", "owner": null, "requested_by": null},
                {"task": "ทดสอบ 4 สาขา", "owner": "คุณเอ", "requested_by": "ประธาน", "assigned_on": "9 กรกฎาคม", "due": "สัปดาห์หน้า"},
                {"task": "เพิ่มเป็น 5 สาขา", "owner": "คุณเอ", "requested_by": "ประธาน", "assigned_on": "13 สิงหาคม", "due": null}
            ]
        })).unwrap();
        let text = render_text(&m, "source", "test");
        assert!(text.contains("วาระ: ผลดำเนินงาน\nโดย คุณเอ และคุณบี\n\nผลจริงและเป้าหมาย\nผลจริง 42,000 คน เป้า 32,000 คน"));
        assert!(text.contains("แผนพัฒนา\n1. ขยายร้านค้า 5 แห่ง\n2. เพิ่มที่จอดรถ 1,200 คัน"));
        assert!(text.contains("สรุปงานที่ได้รับมอบหมาย\n\nงานที่ต้องดำเนินการ\n- รายงานปัญหา"));
        assert!(text.contains("ฝากคุณเอ เมื่อวันที่ 9 กรกฎาคม"));
        assert!(text.contains("ฝากคุณเอ เมื่อวันที่ 13 สิงหาคม"));
        assert!(text.contains("กำหนด: สัปดาห์หน้า"));
        assert!(!text.contains("กำหนด: 9 กรกฎาคม"));
        assert!(text.contains("ผู้มอบหมาย: ประธาน"));
    }

    #[test]
    fn expansion_slices_source_without_repeating_previous_meeting_or_next_section() {
        let m: MeetingMinutes = serde_json::from_value(json!({
            "title": "test", "overview": "", "segments": [
                {"kind": "report", "speaker": "A", "subject": "one", "start": "01:00", "end": "29:59"},
                {"kind": "advice", "speaker": "B", "subject": "two", "start": "30:00", "end": "50:00"}
            ]
        })).unwrap();
        let transcript = "[00:00] ผู้พูด 1: historical\n[01:00] ผู้พูด 1: first report\ncontinuation\n[29:00] ผู้พูด 1: last report line\n[30:00] ผู้พูด 2: advice\n[50:00] ผู้พูด 2: final\n\n## ผู้พูด\nผู้พูด 1: A\nผู้พูด 2: B";
        assert!(expand_sections(transcript));
        let first = section_input(transcript, &m.segments, 0).unwrap();
        assert!(!first.contains("historical"));
        assert!(first.contains("continuation"));
        assert!(first.contains("last report line"));
        assert!(!first.contains("[30:00]"));
        assert!(first.contains("ผู้พูด 2: B"));
        let last = section_input(transcript, &m.segments, 1).unwrap();
        assert!(!last.contains("last report line"));
        assert!(last.contains("[50:00] ผู้พูด 2: final"));
        assert!(!expand_sections("[00:00] A: short\n[01:00] B: end"));
        let mut invalid = m.segments.clone();
        invalid[1].start = "01:00".into();
        assert!(section_input(transcript, &invalid, 0).is_err());
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
