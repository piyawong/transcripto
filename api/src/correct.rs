//! Step ② of the pipeline: Gemini proposes an audited change list and this module applies it.
//! Port of bench/correct.py. The Rust pipeline additionally trusts safe Gemini name edits, while
//! golden tests keep checking the shared non-name correction behavior against the Python fixtures.
//!
//! The model never rewrites the transcript: an edit is applied only if its `original` text is found in the line
//! with that timestamp (or a unique line within 30 s) and it passes `rejection`. Speaker labels and times are
//! never touched, so line i of the corrected transcript is still line i of the ElevenLabs transcript.

use std::collections::BTreeMap;
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::minutes::{normalize_stamp, seconds};

pub const MAX_ORIGINAL_CHARS: usize = 40;
const PARTICLES: [&str; 4] = ["ครับ", "ค่ะ", "คะ", "ฮะ"];
pub const NEEDS_CONFIRMATION: &str = "ชื่อคน รอคนยืนยันก่อนแก้";
pub const NEEDS_LANGUAGE_CONFIRMATION: &str = "เปลี่ยนคำภาษาอังกฤษ รอคนยืนยันก่อนแก้";
pub const UNKNOWN_ROLE: &str = "ไม่ทราบ";

pub const PROMPT: &str = r###"You are proofreading a Thai meeting transcript produced by speech recognition (ElevenLabs Scribe).
The recognizer writes what it hears literally, so unclear speech sometimes comes out as similar-sounding but wrong words
(e.g. "พลังเม็ด" where the context clearly means "ตารางเมตร"). It also writes numbers as Thai words.

Transcript lines look like "[MM:SS] ผู้พูด N: text". A glossary of names and terms used in this meeting is provided.

Return a list of edits. Never rewrite whole lines.

Edit kinds:
1. correction: a word or short phrase that is clearly a mis-hearing. The surrounding context makes the intended words obvious
   AND the replacement sounds similar to what was written. Use the glossary for names and terms.
2. number: a Thai number word that denotes a quantity, percentage, amount, duration, date, ordinal, or grade level. Convert it to digits:
   ร้อยเปอร์เซ็นต์ → 100%, สองปีสิบเดือน → 2 ปี 10 เดือน, เจ็ดพันหรือแปดพัน → 7,000 หรือ 8,000, ป.หนึ่ง → ป.1, ยี่สิบสามสิบแห่ง → 20-30 แห่ง.
   Convert every occurrence, one edit each. Keep repeated words: สองสองคน → 2 2 คน.
   Do not convert words that are not quantities: สามารถ, อันหนึ่ง or คนหนึ่ง meaning "a / one of", สองจิตสองใจ and other idioms.
3. name: the replacement changes a person's name or nickname (e.g. คุณแคลร์ → คุณแพร). These are shown to a person to confirm,
   so propose them only when the sound is close and the context shows it is the same person.

Rules:
- original must be copied exactly from the line with that timestamp, and be as short as possible (a few words).
- Do not change filler words, repetitions, grammar, word order, or polite particles (ครับ, ค่ะ, คะ, นะคะ).
- Do not change names that are used consistently or match the glossary. Do not "improve" wording that is already plausible.
- Do not convert English words or Thai transliterations of English words either way (e.g. เอเย่นต์, ออนไลน์, San Yuan Li).
- If a span is garbled and the intended words cannot be recovered with confidence, do not guess: list it in unclear.
- speakers: for each speaker label, give the role or name only if it is stated or clearly implied in the transcript
  (e.g. someone is invited to speak by title, or addressed by name right before speaking); otherwise ไม่ทราบ."###;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EditKind {
    Correction,
    Number,
    Name,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Edit {
    pub timestamp: String,
    pub original: String,
    pub replacement: String,
    pub kind: EditKind,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Unclear {
    pub timestamp: String,
    pub text: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SpeakerRole {
    pub label: String,
    pub role: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Corrections {
    #[serde(default)]
    pub edits: Vec<Edit>,
    #[serde(default)]
    pub unclear: Vec<Unclear>,
    #[serde(default)]
    pub speakers: Vec<SpeakerRole>,
}

/// The exact `responseSchema` google-genai builds from the Pydantic Corrections model
/// (copied from fixtures/gemini-correct-request.json).
pub fn schema() -> Value {
    serde_json::from_str(include_str!("correct_schema.json")).expect("correct_schema.json")
}

pub fn request_body(glossary: &[String], lines: &[String]) -> Value {
    let terms: Vec<String> = glossary.iter().map(|t| format!("- {t}")).collect();
    let content = format!("ชื่อและคำศัพท์ในการประชุมนี้:\n{}\n\nTRANSCRIPT:\n{}", terms.join("\n"), lines.join("\n"));
    crate::minutes::json_request(PROMPT, &content, schema())
}

static LINE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(\[(\d{1,3}:\d{2})\]\s*(?:ผู้พูด\s*\d+\s*[:：]\s*)?)(.*)$").unwrap());
static DIGIT_ANY_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\d").unwrap());
// A Thai number word directly followed by a unit is almost always a quantity; used only to report leftovers.
static LEFTOVER_NUMBER_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"(?:หนึ่ง|สอง|สาม|สี่|ห้า|หก|เจ็ด|แปด|เก้า|สิบ|ยี่สิบ|ร้อย|พัน|หมื่น|แสน|ล้าน)+\s?",
        r"(?:เปอร์เซ็นต์|ตารางเมตร|ชั่วโมง|สัปดาห์|อาทิตย์|เดือน|นาที|สาขา|เมือง|ครั้ง|แห่ง|บาท|วิธี|ราย|ปี|วัน|คน|เขต)"
    ))
    .unwrap()
});

/// Why an edit must not be applied automatically, or None if it may be.
pub fn rejection(edit: &Edit) -> Option<String> {
    if edit.original.is_empty() || edit.original == edit.replacement {
        return Some("ไม่มีการเปลี่ยนแปลง".into());
    }
    if edit.original.chars().count() > MAX_ORIGINAL_CHARS {
        return Some(format!("ข้อความเดิมยาวเกิน {MAX_ORIGINAL_CHARS} ตัวอักษร (ป้องกันการเขียนใหม่ทั้งประโยค)"));
    }
    if PARTICLES.iter().any(|p| edit.original.matches(p).count() != edit.replacement.matches(p).count()) {
        return Some("เปลี่ยนคำลงท้าย ครับ/ค่ะ".into());
    }
    if edit.kind == EditKind::Number && !DIGIT_ANY_RE.is_match(&edit.replacement) {
        return Some("แก้ตัวเลขแต่ผลลัพธ์ไม่มีตัวเลข".into());
    }
    None
}

/// The proofreader is explicitly not allowed to translate or replace English spellings. Keep
/// these edits out of the automatic pass and let the owner verify the audio instead.
pub fn changes_english(edit: &Edit) -> bool {
    if edit.kind != EditKind::Correction {
        return false;
    }
    let letters = |text: &str| text.chars().filter(char::is_ascii_alphabetic).collect::<String>().to_ascii_lowercase();
    let before = letters(&edit.original);
    let after = letters(&edit.replacement);
    (!before.is_empty() || !after.is_empty()) && before != after
}

fn thai_letter(c: char) -> bool {
    ('\u{0E01}'..='\u{0E4F}').contains(&c)
}

/// Puts a space between digits and Thai letters at the edges of a replacement ("ตั้ง5 50%" → "ตั้ง 5 50%").
/// `before` / `after` are the characters next to the replaced span.
pub fn pad_digits(before: Option<char>, replacement: &str, after: Option<char>) -> String {
    let (Some(first), Some(last)) = (replacement.chars().next(), replacement.chars().next_back()) else {
        return replacement.to_string();
    };
    let digit = |c: char| c.is_ascii_digit();
    let mut out = replacement.to_string();
    if let Some(b) = before
        && ((thai_letter(b) && digit(first)) || ((digit(b) || b == '%') && thai_letter(first)))
    {
        out.insert(0, ' ');
    }
    if let Some(a) = after
        && (((digit(last) || last == '%') && thai_letter(a)) || (thai_letter(last) && digit(a)))
    {
        out.push(' ');
    }
    out
}

/// Applies edits in place, in the order given. Returns None for an applied edit or the reason it was not applied.
pub fn apply_edits(lines: &mut [String], edits: &[Edit]) -> Vec<Option<String>> {
    // Parsed once from the text before any edit; the prefix (time + label) is never changed.
    let parsed: Vec<Option<(usize, String)>> =
        lines.iter().map(|l| LINE_RE.captures(l).map(|c| (c.get(1).unwrap().end(), c[2].to_string()))).collect();
    let mut results = Vec::with_capacity(edits.len());
    for edit in edits {
        let mut reason = rejection(edit);
        if reason.is_none() {
            let stamp = normalize_stamp(&edit.timestamp);
            let has = |i: usize, prefix: usize| lines[i][prefix..].contains(edit.original.as_str());
            let same: Vec<usize> = parsed
                .iter()
                .enumerate()
                .filter_map(|(i, p)| p.as_ref().map(|p| (i, p)))
                .filter(|(i, (prefix, st))| normalize_stamp(st) == stamp && has(*i, *prefix))
                .map(|(i, _)| i)
                .collect();
            let near: Vec<usize> = match &stamp {
                None => Vec::new(),
                Some(s) => parsed
                    .iter()
                    .enumerate()
                    .filter_map(|(i, p)| p.as_ref().map(|p| (i, p)))
                    .filter(|(i, (prefix, st))| (seconds(st) - seconds(s)).abs() <= 30 && has(*i, *prefix))
                    .map(|(i, _)| i)
                    .collect(),
            };
            let target = same.first().copied().or(if near.len() == 1 { Some(near[0]) } else { None });
            match target {
                None => reason = Some("ไม่พบข้อความเดิมในบรรทัดนั้น (หรือพบหลายที่)".into()),
                Some(i) => {
                    let prefix_len = parsed[i].as_ref().unwrap().0;
                    let line = &lines[i];
                    let (prefix, body) = line.split_at(prefix_len);
                    let start = body.find(edit.original.as_str()).expect("checked above");
                    let end = start + edit.original.len();
                    let replacement = pad_digits(body[..start].chars().next_back(), &edit.replacement, body[end..].chars().next());
                    lines[i] = format!("{prefix}{}{replacement}{}", &body[..start], &body[end..]);
                }
            }
        }
        results.push(reason);
    }
    results
}

/// "[MM:SS] สองคน" for every Thai number word + unit still left in the text; reported, never changed.
pub fn leftover_numbers(lines: &[String]) -> Vec<String> {
    let mut found = Vec::new();
    for line in lines {
        if let Some(c) = LINE_RE.captures(line) {
            found.extend(LEFTOVER_NUMBER_RE.find_iter(&c[3]).map(|m| format!("[{}] {}", &c[2], m.as_str())));
        }
    }
    found
}

/// The plain-text change log (`<name>.changes-<model>.txt` in the POC).
pub fn render_changes(name: &str, model_id: &str, edits: &[Edit], results: &[Option<String>], c: &Corrections, leftovers: &[String]) -> String {
    let pairs: Vec<(&Edit, Option<&str>)> = edits.iter().zip(results.iter().map(|r| r.as_deref())).collect();
    let applied: Vec<&Edit> = pairs.iter().filter(|(_, r)| r.is_none()).map(|(e, _)| *e).collect();
    let to_confirm: Vec<&Edit> = pairs.iter().filter(|(_, r)| *r == Some(NEEDS_CONFIRMATION)).map(|(e, _)| *e).collect();
    let rejected: Vec<(&Edit, &str)> =
        pairs.iter().filter_map(|(e, r)| r.filter(|r| *r != NEEDS_CONFIRMATION).map(|r| (*e, r))).collect();
    let count = |k: EditKind| applied.iter().filter(|e| e.kind == k).count();
    let line = |e: &Edit| format!("[{}] {} -> {} ({})", e.timestamp, e.original, e.replacement, e.reason);

    let mut out = vec![
        format!("ผลตรวจแก้ข้อความ {name} ด้วย {model_id}"),
        format!(
            "แก้แล้ว {} จุด (แก้จากบริบท {} · ตัวเลข {} · ชื่อบุคคล {}) · รอยืนยันจากข้อมูลเดิม {} · ไม่ได้แก้ {} · ถอดเพี้ยนจนแก้ไม่ได้ {} · ตัวเลขที่ยังไม่แปลง {}",
            applied.len(),
            count(EditKind::Correction),
            count(EditKind::Number),
            count(EditKind::Name),
            to_confirm.len(),
            rejected.len(),
            c.unclear.len(),
            leftovers.len()
        ),
    ];
    for (kind, title) in [
        (EditKind::Correction, "แก้จากบริบท"),
        (EditKind::Number, "แปลงเป็นตัวเลข"),
        (EditKind::Name, "แก้ชื่อบุคคลตามผล Gemini"),
    ] {
        let items: Vec<String> = applied.iter().filter(|e| e.kind == kind).map(|e| line(e)).collect();
        if !items.is_empty() {
            out.push(String::new());
            out.push(title.into());
            out.extend(items);
        }
    }
    if !to_confirm.is_empty() {
        out.push(String::new());
        out.push("ชื่อคนที่เสนอให้แก้ (ยังไม่ได้แก้ รอคนยืนยัน)".into());
        out.extend(to_confirm.iter().map(|e| line(e)));
    }
    if !rejected.is_empty() {
        out.push(String::new());
        out.push("ไม่ได้แก้ (สคริปต์ปฏิเสธ)".into());
        out.extend(rejected.iter().map(|(e, r)| format!("[{}] {} -> {} เหตุผล: {r}", e.timestamp, e.original, e.replacement)));
    }
    if !c.unclear.is_empty() {
        out.push(String::new());
        out.push("ช่วงที่ถอดเพี้ยนจนแก้ไม่ได้ ควรฟังเสียง".into());
        out.extend(c.unclear.iter().map(|u| format!("[{}] {} ({})", u.timestamp, u.text, u.reason)));
    }
    if !leftovers.is_empty() {
        out.push(String::new());
        out.push("คำบอกจำนวนที่ยังไม่ได้แปลงเป็นตัวเลข".into());
        out.extend(leftovers.iter().cloned());
    }
    out.push(String::new());
    out.push("ผู้พูด".into());
    out.extend(c.speakers.iter().map(|s| format!("{}: {}", s.label, s.role)));
    let mut text = out.join("\n");
    text.push('\n');
    text
}

/// Corrected transcript file: lines, a blank line, "## ผู้พูด" and one "label: role" per speaker.
pub fn render_corrected(lines: &[String], speakers: &[SpeakerRole]) -> String {
    let mut out: Vec<String> = lines.to_vec();
    out.push(String::new());
    out.push("## ผู้พูด".into());
    out.extend(speakers.iter().map(|s| format!("{}: {}", s.label, s.role)));
    let mut text = out.join("\n");
    text.push('\n');
    text
}

// ---- Long files (README 5.6): overlapping windows sent in parallel, each keeping only its own edits ----

/// A part of the transcript that owns lines whose start second is in `[start, end)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Window {
    pub start: i64,
    pub end: i64,
}

impl Window {
    pub fn owns(&self, second: i64) -> bool {
        self.start <= second && second < self.end
    }

    /// Two halves, or None when the window is already short. `last` is the last line's start second.
    pub fn halves(&self, last: i64) -> Option<(Window, Window)> {
        let end = self.end.min(last + 1);
        if end - self.start < 240 {
            return None;
        }
        let mid = self.start + (end - self.start) / 2;
        Some((Window { start: self.start, end: mid }, Window { start: mid, end: self.end }))
    }
}

/// One window for a transcript up to `size + tail` seconds long (sent whole, exactly like the POC);
/// otherwise windows of `size` seconds, where a last window shorter than `tail` is folded into the one before.
/// The first window starts at 0 and the last one is open-ended, so every line has exactly one owner.
pub fn plan_windows(last_second: i64, size: i64, tail: i64) -> Vec<Window> {
    if last_second < size + tail {
        return vec![Window { start: 0, end: i64::MAX }];
    }
    let mut n = last_second / size + 1;
    if last_second - (n - 1) * size < tail {
        n -= 1;
    }
    (0..n).map(|k| Window { start: k * size, end: if k == n - 1 { i64::MAX } else { (k + 1) * size } }).collect()
}

/// Start second of each line (as written in its "[MM:SS]"), -1 when it has none.
pub fn line_seconds(lines: &[String]) -> Vec<i64> {
    lines.iter().map(|l| LINE_RE.captures(l).map_or(-1, |c| seconds(&c[2]))).collect()
}

/// Lines to send for a window: its own lines plus `context` seconds on each side.
pub fn window_lines(lines: &[String], secs: &[i64], w: Window, context: i64) -> Vec<String> {
    let from = w.start.saturating_sub(context);
    let to = w.end.saturating_add(context);
    lines.iter().zip(secs).filter(|(_, s)| from <= **s && **s < to).map(|(l, _)| l.clone()).collect()
}

/// Keeps only edits and unclear spans inside the window's own range: an edit applied twice would change a second
/// occurrence of the same words in the line.
pub fn keep_own(c: Corrections, w: Window) -> Corrections {
    Corrections {
        edits: c.edits.into_iter().filter(|e| w.owns(seconds(&e.timestamp))).collect(),
        unclear: c.unclear.into_iter().filter(|u| w.owns(seconds(&u.timestamp))).collect(),
        speakers: c.speakers,
    }
}

/// Merges per-window results (in time order). Per label: the one role other than ไม่ทราบ, several joined with
/// " / " (returned as conflicts for a person to confirm), or ไม่ทราบ. Labels are ordered by their number.
pub fn merge_windows(parts: Vec<Corrections>) -> (Corrections, Vec<String>) {
    let mut merged = Corrections::default();
    let mut roles: BTreeMap<(u32, String), Vec<String>> = BTreeMap::new();
    for part in parts {
        merged.edits.extend(part.edits);
        merged.unclear.extend(part.unclear);
        for s in part.speakers {
            let n = s.label.chars().filter(char::is_ascii_digit).collect::<String>().parse().unwrap_or(u32::MAX);
            let entry = roles.entry((n, s.label.trim().to_string())).or_default();
            let role = s.role.trim().to_string();
            if !role.is_empty() && role != UNKNOWN_ROLE && !entry.contains(&role) {
                entry.push(role);
            }
        }
    }
    let mut conflicts = Vec::new();
    for ((_, label), found) in roles {
        let role = if found.is_empty() { UNKNOWN_ROLE.to_string() } else { found.join(" / ") };
        if found.len() > 1 {
            conflicts.push(format!("{label}: {role}"));
        }
        merged.speakers.push(SpeakerRole { label, role });
    }
    (merged, conflicts)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../docs/rust-implementation/fixtures/");

    fn fixture(name: &str) -> String {
        std::fs::read_to_string(format!("{FIXTURES}{name}")).unwrap()
    }

    fn golden(short: &str, model_id: &str) {
        let mut lines: Vec<String> = fixture("correct.input.txt").lines().map(String::from).collect();
        let c: Corrections = serde_json::from_str(&fixture(&format!("correct-{short}.corrections.json"))).unwrap();
        // Historical Python fixtures held names for manual confirmation. Preserve that baseline
        // for all other edit kinds, then separately assert Rust's automatic-name behavior below.
        let non_names: Vec<Edit> = c.edits.iter().filter(|edit| edit.kind != EditKind::Name).cloned().collect();
        let results = apply_edits(&mut lines, &non_names);
        let leftovers = leftover_numbers(&lines);
        assert_eq!(render_corrected(&lines, &c.speakers), fixture(&format!("correct-{short}.expected.txt")));
        let log = render_changes("scribe-v2-keyterms.txt", model_id, &non_names, &results, &c, &leftovers);
        assert!(log.starts_with(&format!("ผลตรวจแก้ข้อความ scribe-v2-keyterms.txt ด้วย {model_id}")));

        let mut automatic_lines: Vec<String> = fixture("correct.input.txt").lines().map(String::from).collect();
        let automatic_results = apply_edits(&mut automatic_lines, &c.edits);
        let applied_names = c.edits.iter().zip(&automatic_results).filter(|(edit, result)| edit.kind == EditKind::Name && result.is_none()).count();
        if c.edits.iter().any(|edit| edit.kind == EditKind::Name) {
            assert!(applied_names > 0);
            assert!(render_changes("scribe-v2-keyterms.txt", model_id, &c.edits, &automatic_results, &c, &leftovers)
                .contains("แก้ชื่อบุคคลตามผล Gemini"));
        }
    }

    #[test]
    fn apply_edits_matches_python_pro() {
        if crate::testdata::missing() {
            return;
        }
        golden("pro", "gemini-3.1-pro-preview");
    }

    #[test]
    fn apply_edits_and_leftovers_match_python_flash() {
        if crate::testdata::missing() {
            return;
        }
        golden("flash", "gemini-3.8-flash");
    }

    #[test]
    fn request_body_matches_sdk() {
        if crate::testdata::missing() {
            return;
        }
        let expected: Value = serde_json::from_str(&fixture("gemini-correct-request.json")).unwrap();
        let body = request_body(&["Lotus".into(), "...".into()], &["[00:00] ผู้พูด 1: ...".into(), "[00:16] ผู้พูด 3: ...".into()]);
        assert_eq!(body, expected);
    }

    #[test]
    fn pad_digits_table() {
        assert_eq!(pad_digits(Some('ง'), "5", Some(' ')), " 5");
        assert_eq!(pad_digits(Some('0'), "ตารางเมตร", Some('ท')), " ตารางเมตร");
        assert_eq!(pad_digits(Some('ด'), "100%", Some('ย')), " 100% ");
        assert_eq!(pad_digits(Some('.'), "1", Some('ถ')), "1 ");
        assert_eq!(pad_digits(None, "2 คน", None), "2 คน");
        assert_eq!(pad_digits(Some('ก'), "", Some('ข')), "");
    }

    #[test]
    fn rejections_in_order() {
        let e = |o: &str, r: &str, k| Edit { timestamp: "00:01".into(), original: o.into(), replacement: r.into(), kind: k, reason: String::new() };
        assert_eq!(rejection(&e("a", "a", EditKind::Name)).as_deref(), Some("ไม่มีการเปลี่ยนแปลง"));
        assert!(rejection(&e("ธานิน", "ธานินทร์", EditKind::Name)).is_none());
        assert_eq!(rejection(&e("สอง", "สอง", EditKind::Number)).as_deref(), Some("ไม่มีการเปลี่ยนแปลง"));
        assert!(rejection(&e(&"ก".repeat(41), "x", EditKind::Correction)).unwrap().starts_with("ข้อความเดิมยาวเกิน 40"));
        assert!(rejection(&e(&"ก".repeat(40), "x", EditKind::Correction)).is_none());
        assert_eq!(rejection(&e("สองครับ", "2", EditKind::Number)).as_deref(), Some("เปลี่ยนคำลงท้าย ครับ/ค่ะ"));
        assert_eq!(rejection(&e("สอง", "สองๆ", EditKind::Number)).as_deref(), Some("แก้ตัวเลขแต่ผลลัพธ์ไม่มีตัวเลข"));
        assert!(rejection(&e("สอง", "๒", EditKind::Number)).is_none(), "Thai digits count as digits, as in Python");
        assert!(changes_english(&e("Qingcha", "ฉางซา", EditKind::Correction)));
        assert!(!changes_english(&e("Qingcha", "Qingcha", EditKind::Correction)));
        assert!(!changes_english(&e("ห้าสิบ", "50", EditKind::Number)));
    }

    #[test]
    fn near_match_only_when_unique() {
        let mut lines = vec!["[00:10] ผู้พูด 1: มีสองคน".to_string(), "[00:20] ผู้พูด 2: สองคนเหมือนกัน".to_string()];
        let e = |ts: &str| Edit { timestamp: ts.into(), original: "สองคน".into(), replacement: "2 คน".into(), kind: EditKind::Number, reason: "r".into() };
        let r = apply_edits(&mut lines, &[e("00:15"), e("0:20")]);
        assert_eq!(r[0].as_deref(), Some("ไม่พบข้อความเดิมในบรรทัดนั้น (หรือพบหลายที่)"));
        assert_eq!(r[1], None);
        assert_eq!(lines[1], "[00:20] ผู้พูด 2: 2 คนเหมือนกัน");
        assert_eq!(lines[0], "[00:10] ผู้พูด 1: มีสองคน");
    }

    #[test]
    fn windows_cover_every_line_once() {
        assert_eq!(plan_windows(1020, 1800, 300), vec![Window { start: 0, end: i64::MAX }]);
        assert_eq!(plan_windows(2099, 1800, 300).len(), 1);
        let w = plan_windows(10_799, 1800, 300);
        assert_eq!(w.len(), 6);
        assert_eq!(w[5], Window { start: 9000, end: i64::MAX });
        let w = plan_windows(9100, 1800, 300);
        assert_eq!(w.len(), 5, "a 100 s tail folds into the last window");
        for s in [0, 1799, 1800, 9099, 20_000] {
            assert_eq!(w.iter().filter(|x| x.owns(s)).count(), 1, "second {s}");
        }
        let (a, b) = w[4].halves(9100).unwrap();
        assert_eq!((a.start, a.end, b.end), (7200, 8150, i64::MAX));
        assert!(Window { start: 0, end: 200 }.halves(10_000).is_none());
    }

    #[test]
    fn window_context_and_ownership() {
        let lines: Vec<String> = [0, 1700, 1790, 1810, 1900, 3700].iter().map(|s| format!("[{:02}:{:02}] ผู้พูด 1: x{s}", s / 60, s % 60)).collect();
        let secs = line_seconds(&lines);
        let w = Window { start: 1800, end: 3600 };
        let sent = window_lines(&lines, &secs, w, 60);
        assert_eq!(sent.len(), 3, "1790 (context), 1810, 1900");
        let c = Corrections {
            edits: [("29:50", "x"), ("30:10", "y"), ("60:00", "z")]
                .iter()
                .map(|(t, o)| Edit { timestamp: (*t).into(), original: (*o).into(), replacement: "1".into(), kind: EditKind::Number, reason: String::new() })
                .collect(),
            unclear: vec![Unclear { timestamp: "29:59".into(), text: "t".into(), reason: String::new() }],
            speakers: vec![],
        };
        let kept = keep_own(c, w);
        assert_eq!(kept.edits.len(), 1);
        assert_eq!(kept.edits[0].timestamp, "30:10");
        assert!(kept.unclear.is_empty());
    }

    #[test]
    fn merge_speaker_roles() {
        let sp = |l: &str, r: &str| SpeakerRole { label: l.into(), role: r.into() };
        let a = Corrections { speakers: vec![sp("ผู้พูด 10", "ไม่ทราบ"), sp("ผู้พูด 2", "ประธานอาวุโส"), sp("ผู้พูด 1", "ไม่ทราบ")], ..Default::default() };
        let b = Corrections { speakers: vec![sp("ผู้พูด 2", "ประธานอาวุโส"), sp("ผู้พูด 1", "คุณเบน"), sp("ผู้พูด 10", "คุณแบงค์")], ..Default::default() };
        let c = Corrections { speakers: vec![sp("ผู้พูด 10", "คุณเบน")], ..Default::default() };
        let (m, conflicts) = merge_windows(vec![a, b, c]);
        assert_eq!(m.speakers, vec![sp("ผู้พูด 1", "คุณเบน"), sp("ผู้พูด 2", "ประธานอาวุโส"), sp("ผู้พูด 10", "คุณแบงค์ / คุณเบน")]);
        assert_eq!(conflicts, vec!["ผู้พูด 10: คุณแบงค์ / คุณเบน".to_string()]);
    }
}
