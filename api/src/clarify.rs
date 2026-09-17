//! Human verification between Gemini correction and meeting-minutes generation.
//!
//! Questions are deterministic projections of the correction result.  The model may suggest a
//! spelling or identify an unclear span, but only exact-text, line-scoped edits selected by the
//! owner can change the stored transcript.

use std::collections::{HashMap, HashSet};

use anyhow::{Result, anyhow, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::correct::{
    Corrections, Edit, EditKind, NEEDS_CONFIRMATION, NEEDS_LANGUAGE_CONFIRMATION,
};
use crate::jobs::{MAX_SEGMENT_CHARS, SegmentRow, SpeakerView};
use crate::lines::TimedToken;
use crate::minutes::{Check, seconds};

pub const MAX_QUESTIONS: usize = 15;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum QuestionKind {
    NameSpelling,
    SpeakerIdentity,
    WordOrTerm,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Evidence {
    pub line: i32,
    pub start: f64,
    pub end: f64,
    pub timestamp: String,
    pub text: String,
    #[serde(default)]
    pub approximate: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Target {
    Text { line: i32, original: String },
    TextGroup { edits: Vec<TextTarget> },
    Speaker { index: usize },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextTarget {
    pub line: i32,
    pub original: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextEffect {
    pub line: i32,
    pub original: String,
    pub replacement: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpeakerEffect {
    pub index: usize,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuestionOption {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub edits: Vec<TextEffect>,
    #[serde(default)]
    pub speaker: Option<SpeakerEffect>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Question {
    pub id: String,
    pub kind: QuestionKind,
    pub source: String,
    pub impact: String,
    pub impact_reason: String,
    pub prompt: String,
    #[serde(default = "one")]
    pub occurrence_count: usize,
    pub evidence: Vec<Evidence>,
    pub options: Vec<QuestionOption>,
    pub recommended_option_id: Option<String>,
    pub target: Option<Target>,
    pub custom_label: Option<String>,
}

const fn one() -> usize {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClarificationSet {
    pub version: u32,
    pub base_revision: i32,
    pub questions: Vec<Question>,
    #[serde(default)]
    pub omitted: Vec<Check>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Decision {
    Select,
    Keep,
    Skip,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Answer {
    pub question_id: String,
    pub decision: Decision,
    #[serde(default)]
    pub option_id: Option<String>,
    #[serde(default)]
    pub value: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Answers {
    #[serde(default)]
    pub answers: Vec<Answer>,
}

fn same_answer(left: &Answer, right: &Answer) -> bool {
    left.decision == right.decision
        && left.option_id == right.option_id
        && left.value.as_deref().map(str::trim) == right.value.as_deref().map(str::trim)
}

fn canonical_name(value: &str) -> String {
    let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let without_title = ["นางสาว", "คุณหญิง", "คุณ", "นาย", "นาง", "ดร."]
        .iter()
        .find_map(|title| value.strip_prefix(title))
        .unwrap_or(&value);
    without_title.trim().to_lowercase()
}

/// Gemini occasionally includes the surrounding sentence in a name edit. When the changed span
/// follows a Thai title, keep only `คุณ<name>` (or the equivalent title) and leave the shared
/// sentence context outside the effect. Edits without a reliable title boundary stay untouched.
fn minimize_name_pair(original: &str, replacement: &str) -> (String, String) {
    if original == replacement || original.is_empty() || replacement.is_empty() {
        return (original.into(), replacement.into());
    }
    let mut prefix = 0;
    for (left, right) in original.chars().zip(replacement.chars()) {
        if left != right {
            break;
        }
        prefix += left.len_utf8();
    }
    let mut suffix = 0;
    for (left, right) in original[prefix..]
        .chars()
        .rev()
        .zip(replacement[prefix..].chars().rev())
    {
        if left != right {
            break;
        }
        suffix += left.len_utf8();
    }
    let shared_prefix = &original[..prefix];
    let start = ["นางสาว", "คุณหญิง", "คุณ", "นาย", "นาง", "ดร."]
        .iter()
        .filter_map(|title| shared_prefix.rfind(title))
        .max();
    let Some(start) = start else {
        return (original.into(), replacement.into());
    };
    let original_end = original.len().saturating_sub(suffix);
    let replacement_end = replacement.len().saturating_sub(suffix);
    if start >= original_end || start >= replacement_end {
        return (original.into(), replacement.into());
    }
    (
        original[start..original_end].into(),
        replacement[start..replacement_end].into(),
    )
}

fn minimize_name_edit(edit: &Edit) -> Edit {
    let (original, replacement) = minimize_name_pair(&edit.original, &edit.replacement);
    Edit {
        original,
        replacement,
        ..edit.clone()
    }
}

fn first_accept_effect(question: &Question) -> Option<&TextEffect> {
    question
        .options
        .iter()
        .find(|option| option.id == "accept")?
        .edits
        .first()
}

fn question_matches_edit(question: &Question, kind: &QuestionKind, edit: &Edit) -> bool {
    if &question.kind != kind {
        return false;
    }
    let Some(effect) = first_accept_effect(question) else {
        return false;
    };
    match kind {
        QuestionKind::NameSpelling => {
            canonical_name(&effect.replacement) == canonical_name(&edit.replacement)
        }
        _ => effect.original == edit.original && effect.replacement == edit.replacement,
    }
}

fn questions_share_group(left: &Question, right: &Question) -> bool {
    let Some(effect) = first_accept_effect(right) else {
        return false;
    };
    let edit = Edit {
        timestamp: String::new(),
        original: effect.original.clone(),
        replacement: effect.replacement.clone(),
        kind: EditKind::Correction,
        reason: String::new(),
    };
    question_matches_edit(left, &right.kind, &edit)
}

fn refresh_group_copy(question: &mut Question) {
    let Some(option) = question
        .options
        .iter_mut()
        .find(|option| option.id == "accept")
    else {
        return;
    };
    let Some(effect) = option.edits.first() else {
        return;
    };
    let original = effect.original.clone();
    let replacement = effect.replacement.clone();
    if question.kind == QuestionKind::NameSpelling {
        if question.occurrence_count > 1 {
            let name = canonical_name(&replacement);
            question.prompt = format!(
                "ชื่อที่ Gemini พบทั้ง {} จุดนี้คือ “{}” ใช่หรือไม่",
                question.occurrence_count, name
            );
            option.label = format!("ยืนยันเป็น {} ทั้ง {} จุด", name, question.occurrence_count);
        } else {
            question.prompt = format!("ควรแก้ “{}” เป็น “{}” หรือไม่", original, replacement);
            option.label = format!("แก้เป็น {}", replacement);
        }
    } else if question.occurrence_count > 1 {
        option.label = format!("แก้ทั้ง {} จุดเป็น {}", question.occurrence_count, replacement);
    }
}

fn normalize_stored_name_question(question: &mut Question) {
    if question.kind != QuestionKind::NameSpelling {
        return;
    }
    let Some(option) = question
        .options
        .iter_mut()
        .find(|option| option.id == "accept")
    else {
        return;
    };
    for effect in &mut option.edits {
        (effect.original, effect.replacement) =
            minimize_name_pair(&effect.original, &effect.replacement);
    }
    question.target = Some(Target::TextGroup {
        edits: option
            .edits
            .iter()
            .map(|effect| TextTarget {
                line: effect.line,
                original: effect.original.clone(),
            })
            .collect(),
    });
    refresh_group_copy(question);
}

/// Normalize stored clarification sets as they are read. This also upgrades reviews created
/// before repeated edit questions were grouped, preserving a shared answer when the old answers
/// agree. Conflicting old answers deliberately leave the merged question unanswered.
pub fn coalesce(set: ClarificationSet, answers: Answers) -> (ClarificationSet, Answers) {
    let ClarificationSet {
        version,
        base_revision,
        questions,
        omitted,
    } = set;
    let mut merged: Vec<Question> = Vec::new();
    let mut id_map: HashMap<String, String> = HashMap::new();

    for mut question in questions {
        normalize_stored_name_question(&mut question);
        let existing = merged
            .iter()
            .position(|candidate| questions_share_group(candidate, &question));
        let Some(index) = existing else {
            id_map.insert(question.id.clone(), question.id.clone());
            merged.push(question);
            continue;
        };

        let kept = &mut merged[index];
        id_map.insert(question.id, kept.id.clone());
        kept.occurrence_count += question.occurrence_count.max(1);
        for evidence in question.evidence {
            if !kept.evidence.iter().any(|item| item.line == evidence.line) {
                kept.evidence.push(evidence);
            }
        }
        let kept_option = kept
            .options
            .iter_mut()
            .find(|option| option.id == "accept")
            .expect("group key requires accept option");
        let incoming = question
            .options
            .into_iter()
            .find(|option| option.id == "accept")
            .expect("group key requires accept option");
        for effect in incoming.edits {
            if !kept_option.edits.iter().any(|item| {
                item.line == effect.line
                    && item.original == effect.original
                    && item.replacement == effect.replacement
            }) {
                kept_option.edits.push(effect);
            }
        }
        kept.target = Some(Target::TextGroup {
            edits: kept_option
                .edits
                .iter()
                .map(|effect| TextTarget {
                    line: effect.line,
                    original: effect.original.clone(),
                })
                .collect(),
        });
        refresh_group_copy(kept);
    }

    let mut answer_by_id: HashMap<String, Answer> = HashMap::new();
    let mut conflicts = HashSet::new();
    for mut answer in answers.answers {
        let Some(kept_id) = id_map.get(&answer.question_id) else {
            continue;
        };
        answer.question_id = kept_id.clone();
        if let Some(existing) = answer_by_id.get(kept_id) {
            if !same_answer(existing, &answer) {
                conflicts.insert(kept_id.clone());
            }
        } else {
            answer_by_id.insert(kept_id.clone(), answer);
        }
    }
    for id in conflicts {
        answer_by_id.remove(&id);
    }
    let answers = Answers {
        answers: merged
            .iter()
            .filter_map(|question| answer_by_id.remove(&question.id))
            .collect(),
    };
    (
        ClarificationSet {
            version,
            base_revision,
            questions: merged,
            omitted,
        },
        answers,
    )
}

fn token_bounds(segment: &SegmentRow, needle: &str) -> Option<(f64, f64)> {
    let tokens: Vec<TimedToken> = serde_json::from_value(segment.tokens.clone()?).ok()?;
    let raw = tokens
        .iter()
        .map(|token| token.text.as_str())
        .collect::<String>();
    if raw.matches(needle).count() != 1
        || tokens.iter().any(|token| {
            !token.start.is_finite() || !token.end.is_finite() || token.end <= token.start
        })
        || tokens
            .windows(2)
            .any(|pair| pair[1].start < pair[0].start || pair[1].end < pair[0].end)
    {
        return None;
    }
    let from = raw.find(needle)?;
    let to = from + needle.len();
    let mut cursor = 0;
    let mut matched = Vec::new();
    for token in tokens {
        let next = cursor + token.text.len();
        if next > from && cursor < to {
            matched.push(token);
        }
        cursor = next;
    }
    let first = matched.first()?;
    let last = matched.last()?;
    (last.end >= first.start).then_some(((first.start - 2.0).max(0.0), last.end + 2.0))
}

fn evidence_for(
    segments: &[SegmentRow],
    timestamp: &str,
    needle: Option<&str>,
) -> Option<Evidence> {
    let at = seconds(timestamp) as f64;
    let (line, segment) = segments
        .iter()
        .enumerate()
        .filter(|(_, s)| needle.is_none_or(|n| s.text.contains(n)))
        .min_by(|(_, a), (_, b)| {
            (a.start_sec - at)
                .abs()
                .total_cmp(&(b.start_sec - at).abs())
        })?;
    if (segment.start_sec - at).abs() > 30.0 {
        return None;
    }
    let exact = needle.and_then(|text| token_bounds(segment, text));
    Some(Evidence {
        line: line as i32,
        start: exact.map_or_else(|| (segment.start_sec - 2.0).max(0.0), |(start, _)| start),
        end: exact.map_or(segment.end_sec + 2.0, |(_, end)| end),
        timestamp: timestamp.to_string(),
        text: segment.text.clone(),
        approximate: exact.is_none(),
    })
}

struct EditQuestionCopy<'a> {
    id_prefix: &'a str,
    impact: &'a str,
    impact_reason: &'a str,
    prompt: String,
    custom_label: &'a str,
    recommended: bool,
}

/// Add a question for one held edit. Name proposals converge on the same intended name even when
/// Gemini copied different sentence context; other terms require the same original→replacement.
/// Effects remain line-scoped, so accepting a group cannot touch unrelated lines.
fn add_edit_question(
    questions: &mut Vec<Question>,
    kind: QuestionKind,
    edit: &Edit,
    evidence: Evidence,
    copy: EditQuestionCopy<'_>,
) {
    if edit.original.is_empty() || edit.original == edit.replacement {
        return;
    }
    if let Some(question) = questions
        .iter_mut()
        .find(|question| question_matches_edit(question, &kind, edit))
    {
        question.occurrence_count += 1;
        if !question
            .evidence
            .iter()
            .any(|item| item.line == evidence.line)
        {
            question.evidence.push(evidence.clone());
        }
        let option = &mut question.options[0];
        if !option
            .edits
            .iter()
            .any(|effect| effect.line == evidence.line && effect.original == edit.original)
        {
            option.edits.push(TextEffect {
                line: evidence.line,
                original: edit.original.clone(),
                replacement: edit.replacement.clone(),
            });
        }
        if let Some(Target::TextGroup { edits }) = &mut question.target
            && !edits
                .iter()
                .any(|target| target.line == evidence.line && target.original == edit.original)
        {
            edits.push(TextTarget {
                line: evidence.line,
                original: edit.original.clone(),
            });
        }
        refresh_group_copy(question);
        return;
    }

    let effect = TextEffect {
        line: evidence.line,
        original: edit.original.clone(),
        replacement: edit.replacement.clone(),
    };
    let mut question = Question {
        id: format!("{}-{}", copy.id_prefix, questions.len() + 1),
        kind,
        source: "gemini_correction".into(),
        impact: copy.impact.into(),
        impact_reason: copy.impact_reason.into(),
        prompt: copy.prompt,
        occurrence_count: 1,
        evidence: vec![evidence],
        options: vec![QuestionOption {
            id: "accept".into(),
            label: format!("แก้เป็น {}", edit.replacement),
            edits: vec![effect.clone()],
            speaker: None,
        }],
        recommended_option_id: copy.recommended.then(|| "accept".into()),
        target: Some(Target::TextGroup {
            edits: vec![TextTarget {
                line: effect.line,
                original: effect.original,
            }],
        }),
        custom_label: Some(copy.custom_label.into()),
    };
    refresh_group_copy(&mut question);
    questions.push(question);
}

/// Build at most 15 high-signal questions from the Gemini correction output. Inferred speaker
/// names are removed from `speakers` until the owner explicitly accepts them.
pub fn build(
    corrections: &Value,
    segments: &[SegmentRow],
    speakers: &mut [SpeakerView],
    base_revision: i32,
) -> Result<ClarificationSet> {
    let merged: Corrections = serde_json::from_value(
        corrections
            .get("corrections")
            .cloned()
            .unwrap_or(Value::Null),
    )?;
    let results: Vec<Option<String>> = serde_json::from_value(
        corrections
            .get("results")
            .cloned()
            .unwrap_or(Value::Array(vec![])),
    )?;
    let mut questions = Vec::new();

    for (edit, result) in merged.edits.iter().zip(results.iter()) {
        if edit.kind != EditKind::Name || result.as_deref() != Some(NEEDS_CONFIRMATION) {
            continue;
        }
        let edit = minimize_name_edit(edit);
        let Some(ev) = evidence_for(segments, &edit.timestamp, Some(&edit.original)) else {
            continue;
        };
        add_edit_question(
            &mut questions,
            QuestionKind::NameSpelling,
            &edit,
            ev,
            EditQuestionCopy {
                id_prefix: "name",
                impact: "high",
                impact_reason: "ชื่อบุคคลจะถูกใช้ต่อในสรุปและรายการงาน",
                prompt: format!("ควรแก้ “{}” เป็น “{}” หรือไม่", edit.original, edit.replacement),
                custom_label: "พิมพ์ชื่อที่ถูกต้อง",
                recommended: true,
            },
        );
    }

    for (edit, result) in merged.edits.iter().zip(results.iter()) {
        if result.as_deref() != Some(NEEDS_LANGUAGE_CONFIRMATION) {
            continue;
        }
        let Some(ev) = evidence_for(segments, &edit.timestamp, Some(&edit.original)) else {
            continue;
        };
        add_edit_question(
            &mut questions,
            QuestionKind::WordOrTerm,
            edit,
            ev,
            EditQuestionCopy {
                id_prefix: "term",
                impact: "medium",
                impact_reason: "Gemini เสนอให้เปลี่ยนคำภาษาอังกฤษหรือคำทับศัพท์ ซึ่งต้องฟังเสียงยืนยันก่อน",
                prompt: format!("พูดว่า “{}” หรือ “{}”", edit.original, edit.replacement),
                custom_label: "พิมพ์คำที่ได้ยิน",
                recommended: false,
            },
        );
    }

    for unclear in &merged.unclear {
        let Some(ev) = evidence_for(segments, &unclear.timestamp, Some(&unclear.text))
            .or_else(|| evidence_for(segments, &unclear.timestamp, None))
        else {
            continue;
        };
        let target = ev
            .text
            .matches(&unclear.text)
            .count()
            .eq(&1)
            .then(|| Target::Text {
                line: ev.line,
                original: unclear.text.clone(),
            });
        questions.push(Question {
            id: format!("unclear-{}", questions.len() + 1),
            kind: QuestionKind::WordOrTerm,
            source: "gemini_correction".into(),
            impact: "medium".into(),
            impact_reason: unclear.reason.clone(),
            prompt: format!(
                "Gemini ฟังความหมายของช่วง “{}” ไม่ชัด คำที่ถูกต้องคืออะไร",
                unclear.text
            ),
            occurrence_count: 1,
            evidence: vec![ev],
            options: vec![],
            recommended_option_id: None,
            target,
            custom_label: Some("พิมพ์ข้อความที่ได้ยิน".into()),
        });
    }

    for (index, speaker) in speakers.iter_mut().enumerate() {
        let Some(proposed) = speaker.role.clone().filter(|r| !r.trim().is_empty()) else {
            continue;
        };
        let proposed = proposed.trim().to_string();
        if proposed.chars().count() > 40 {
            speaker.role = None;
            speaker.name = speaker.label.clone();
            continue;
        }
        if proposed == speaker.label || proposed == crate::correct::UNKNOWN_ROLE {
            speaker.role = None;
            speaker.name = speaker.label.clone();
            continue;
        }
        let Some((line, segment)) = segments
            .iter()
            .enumerate()
            .find(|(_, s)| s.speaker == index as i32)
        else {
            continue;
        };
        let timestamp = crate::transcript::mmss(segment.start_sec);
        let ev = Evidence {
            line: line as i32,
            start: (segment.start_sec - 2.0).max(0.0),
            end: segment.end_sec + 2.0,
            timestamp,
            text: segment.text.clone(),
            approximate: true,
        };
        questions.push(Question {
            id: format!("speaker-{}", index + 1),
            kind: QuestionKind::SpeakerIdentity,
            source: "gemini_correction".into(),
            impact: "high".into(),
            impact_reason: "ชื่อหรือบทบาทผู้พูดจะถูกใช้ระบุว่าใครพูดและใครรับผิดชอบงาน".into(),
            prompt: format!("{} คือ “{}” ใช่หรือไม่", speaker.label, proposed),
            occurrence_count: 1,
            evidence: vec![ev],
            options: vec![QuestionOption {
                id: "accept".into(),
                label: format!("ใช่ — {}", proposed),
                edits: vec![],
                speaker: Some(SpeakerEffect {
                    index,
                    name: proposed,
                }),
            }],
            recommended_option_id: Some("accept".into()),
            target: Some(Target::Speaker { index }),
            custom_label: Some("พิมพ์ชื่อหรือบทบาทที่ถูกต้อง".into()),
        });
        // Do not let an inferred identity enter the summary unless the owner accepts it.
        speaker.name = speaker.label.clone();
        speaker.role = None;
    }

    questions.sort_by_key(|question| match question.impact.as_str() {
        "high" => 0,
        "medium" => 1,
        _ => 2,
    });
    let omitted = if questions.len() > MAX_QUESTIONS {
        questions[MAX_QUESTIONS..]
            .iter()
            .map(|q| Check {
                text: q.prompt.clone(),
                timestamps: q.evidence.iter().map(|e| e.timestamp.clone()).collect(),
            })
            .collect()
    } else {
        vec![]
    };
    questions.truncate(MAX_QUESTIONS);
    Ok(ClarificationSet {
        version: 1,
        base_revision,
        questions,
        omitted,
    })
}

pub fn validate_answers(set: &ClarificationSet, answers: &Answers) -> Result<()> {
    let by_id: HashMap<&str, &Question> =
        set.questions.iter().map(|q| (q.id.as_str(), q)).collect();
    let mut seen = HashSet::new();
    for answer in &answers.answers {
        ensure!(
            seen.insert(answer.question_id.as_str()),
            "มีคำตอบซ้ำสำหรับคำถามเดียวกัน"
        );
        let q = by_id
            .get(answer.question_id.as_str())
            .ok_or_else(|| anyhow!("ไม่พบคำถาม {}", answer.question_id))?;
        if answer.decision == Decision::Select {
            let option = answer
                .option_id
                .as_deref()
                .ok_or_else(|| anyhow!("ยังไม่ได้เลือกคำตอบ"))?;
            if option == "custom" {
                ensure!(q.target.is_some(), "คำถามนี้ไม่รองรับคำตอบแบบพิมพ์เอง");
                let value = answer.value.as_deref().unwrap_or("").trim();
                ensure!(!value.is_empty(), "คำตอบที่พิมพ์เองต้องไม่ว่าง");
                let limit = match &q.target {
                    Some(Target::Speaker { .. }) => 40,
                    _ => MAX_SEGMENT_CHARS,
                };
                ensure!(value.chars().count() <= limit, "คำตอบยาวเกิน {limit} ตัวอักษร");
            } else {
                ensure!(
                    q.options.iter().any(|o| o.id == option),
                    "ตัวเลือกไม่ตรงกับคำถาม"
                );
            }
        }
    }
    Ok(())
}

fn replace_exact(text: &str, original: &str, replacement: &str) -> Result<String> {
    ensure!(!original.is_empty(), "ข้อความต้นฉบับต้องไม่ว่าง");
    let already_correct: Vec<_> = if original == replacement {
        vec![]
    } else {
        text.match_indices(replacement)
            .map(|(start, value)| start..start + value.len())
            .collect()
    };
    let targets: Vec<_> = text
        .match_indices(original)
        .filter(|(start, value)| {
            let end = *start + value.len();
            !already_correct
                .iter()
                .any(|correct| *start >= correct.start && end <= correct.end)
        })
        .map(|(start, value)| start..start + value.len())
        .collect();
    ensure!(
        !targets.is_empty(),
        "ข้อความต้นฉบับเปลี่ยนไปแล้ว กรุณาโหลดคำถามใหม่"
    );
    let mut replaced = String::with_capacity(text.len());
    let mut cursor = 0;
    for target in targets {
        replaced.push_str(&text[cursor..target.start]);
        replaced.push_str(replacement);
        cursor = target.end;
    }
    replaced.push_str(&text[cursor..]);
    ensure!(
        replaced.chars().count() <= MAX_SEGMENT_CHARS,
        "ข้อความหลังแก้ไขยาวเกิน {MAX_SEGMENT_CHARS} ตัวอักษร"
    );
    Ok(replaced)
}

/// Apply a complete answer set to in-memory rows. Missing answers are skipped and returned as
/// unresolved checks. The caller writes all rows in one database transaction.
pub fn apply(
    set: &ClarificationSet,
    answers: &Answers,
    segments: &mut [SegmentRow],
    speakers: &mut [SpeakerView],
) -> Result<Vec<Check>> {
    validate_answers(set, answers)?;
    let selected: HashMap<&str, &Answer> = answers
        .answers
        .iter()
        .map(|a| (a.question_id.as_str(), a))
        .collect();
    let mut unresolved = set.omitted.clone();

    for q in &set.questions {
        let Some(answer) = selected.get(q.id.as_str()) else {
            unresolved.push(Check {
                text: q.prompt.clone(),
                timestamps: q.evidence.iter().map(|e| e.timestamp.clone()).collect(),
            });
            continue;
        };
        match answer.decision {
            Decision::Keep => {}
            Decision::Skip | Decision::Unknown => unresolved.push(Check {
                text: q.prompt.clone(),
                timestamps: q.evidence.iter().map(|e| e.timestamp.clone()).collect(),
            }),
            Decision::Select => {
                let option_id = answer.option_id.as_deref().unwrap_or_default();
                if option_id == "custom" {
                    let value = answer
                        .value
                        .as_deref()
                        .unwrap_or("")
                        .split_whitespace()
                        .collect::<Vec<_>>()
                        .join(" ");
                    match q
                        .target
                        .as_ref()
                        .ok_or_else(|| anyhow!("คำถามนี้ไม่มีตำแหน่งแก้ไข"))?
                    {
                        Target::Text { line, original } => {
                            let row = segments
                                .get_mut(*line as usize)
                                .ok_or_else(|| anyhow!("ไม่พบบรรทัดที่ต้องแก้"))?;
                            row.text = replace_exact(&row.text, original, &value)?;
                        }
                        Target::TextGroup { edits } => {
                            for edit in edits {
                                let row = segments
                                    .get_mut(edit.line as usize)
                                    .ok_or_else(|| anyhow!("ไม่พบบรรทัดที่ต้องแก้"))?;
                                row.text = replace_exact(&row.text, &edit.original, &value)?;
                            }
                        }
                        Target::Speaker { index } => {
                            let speaker = speakers
                                .get_mut(*index)
                                .ok_or_else(|| anyhow!("ไม่พบผู้พูดที่ต้องแก้"))?;
                            speaker.name = value;
                        }
                    }
                } else {
                    let option = q
                        .options
                        .iter()
                        .find(|o| o.id == option_id)
                        .ok_or_else(|| anyhow!("ไม่พบตัวเลือก"))?;
                    for edit in &option.edits {
                        let row = segments
                            .get_mut(edit.line as usize)
                            .ok_or_else(|| anyhow!("ไม่พบบรรทัดที่ต้องแก้"))?;
                        row.text = replace_exact(&row.text, &edit.original, &edit.replacement)?;
                    }
                    if let Some(effect) = &option.speaker {
                        let speaker = speakers
                            .get_mut(effect.index)
                            .ok_or_else(|| anyhow!("ไม่พบผู้พูดที่ต้องแก้"))?;
                        speaker.name = effect.name.clone();
                    }
                }
            }
        }
    }
    Ok(unresolved)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_answer_changes_only_its_line_and_unknown_is_carried_forward() {
        let q = Question {
            id: "q1".into(),
            kind: QuestionKind::NameSpelling,
            source: "test".into(),
            impact: "high".into(),
            impact_reason: "x".into(),
            prompt: "ชื่ออะไร".into(),
            occurrence_count: 1,
            evidence: vec![Evidence {
                line: 0,
                start: 1.0,
                end: 4.0,
                timestamp: "00:02".into(),
                text: "คุณแบงค์".into(),
                approximate: false,
            }],
            options: vec![QuestionOption {
                id: "accept".into(),
                label: "เบน".into(),
                edits: vec![TextEffect {
                    line: 0,
                    original: "แบงค์".into(),
                    replacement: "เบน".into(),
                }],
                speaker: None,
            }],
            recommended_option_id: None,
            target: Some(Target::Text {
                line: 0,
                original: "แบงค์".into(),
            }),
            custom_label: Some("ชื่อ".into()),
        };
        let set = ClarificationSet {
            version: 1,
            base_revision: 1,
            questions: vec![q],
            omitted: vec![],
        };
        let mut segments = vec![SegmentRow {
            start_sec: 2.0,
            end_sec: 3.0,
            speaker: 0,
            text: "คุณแบงค์พูด".into(),
            tokens: None,
        }];
        let mut speakers = vec![SpeakerView {
            label: "ผู้พูด 1".into(),
            name: "ผู้พูด 1".into(),
            role: None,
            talk_sec: 1.0,
            pct: 1.0,
        }];
        let answers = Answers {
            answers: vec![Answer {
                question_id: "q1".into(),
                decision: Decision::Select,
                option_id: Some("accept".into()),
                value: None,
            }],
        };
        assert!(
            apply(&set, &answers, &mut segments, &mut speakers)
                .unwrap()
                .is_empty()
        );
        assert_eq!(segments[0].text, "คุณเบนพูด");

        let unresolved = apply(&set, &Answers::default(), &mut segments, &mut speakers).unwrap();
        assert_eq!(unresolved[0].text, "ชื่ออะไร");
    }

    #[test]
    fn repeated_name_proposals_become_one_answer_and_change_every_target_line() {
        let corrections = serde_json::json!({
            "corrections": {
                "edits": [
                    {
                        "timestamp": "00:02",
                        "original": "รวมทั้งคุณธานินต้องมาเรียนรู้",
                        "replacement": "รวมทั้งคุณธานินทร์ต้องมาเรียนรู้",
                        "kind": "name",
                        "reason": "ชื่อบุคคล"
                    },
                    {
                        "timestamp": "00:12",
                        "original": "ธานิน",
                        "replacement": "ธานินทร์",
                        "kind": "name",
                        "reason": "ชื่อบุคคล"
                    },
                    {
                        "timestamp": "00:22",
                        "original": "คุณคณิต",
                        "replacement": "คุณธานินทร์",
                        "kind": "name",
                        "reason": "บุคคลเดียวกัน"
                    }
                ],
                "unclear": [],
                "speakers": []
            },
            "results": [NEEDS_CONFIRMATION, NEEDS_CONFIRMATION, NEEDS_CONFIRMATION]
        });
        let mut segments = vec![
            SegmentRow {
                start_sec: 2.0,
                end_sec: 4.0,
                speaker: 0,
                text: "รวมทั้งคุณธานินต้องมาเรียนรู้กับคุณธานินทร์".into(),
                tokens: None,
            },
            SegmentRow {
                start_sec: 12.0,
                end_sec: 14.0,
                speaker: 0,
                text: "ตามที่คุณธานินแจ้ง".into(),
                tokens: None,
            },
            SegmentRow {
                start_sec: 22.0,
                end_sec: 24.0,
                speaker: 0,
                text: "คุณคณิตตอบคำถาม".into(),
                tokens: None,
            },
        ];
        let mut speakers = vec![];
        let set = build(&corrections, &segments, &mut speakers, 4).unwrap();

        assert_eq!(set.questions.len(), 1);
        assert_eq!(set.questions[0].occurrence_count, 3);
        assert_eq!(set.questions[0].evidence.len(), 3);
        assert_eq!(set.questions[0].options[0].edits.len(), 3);
        assert_eq!(set.questions[0].options[0].label, "ยืนยันเป็น ธานินทร์ ทั้ง 3 จุด");
        assert_eq!(set.questions[0].options[0].edits[0].original, "คุณธานิน");

        let answers = Answers {
            answers: vec![Answer {
                question_id: set.questions[0].id.clone(),
                decision: Decision::Select,
                option_id: Some("accept".into()),
                value: None,
            }],
        };
        assert!(
            apply(&set, &answers, &mut segments, &mut speakers)
                .unwrap()
                .is_empty()
        );
        assert_eq!(segments[0].text, "รวมทั้งคุณธานินทร์ต้องมาเรียนรู้กับคุณธานินทร์");
        assert_eq!(segments[1].text, "ตามที่คุณธานินทร์แจ้ง");
        assert_eq!(segments[2].text, "คุณธานินทร์ตอบคำถาม");
    }

    #[test]
    fn coalesce_upgrades_legacy_questions_and_preserves_matching_answers() {
        let question = |id: &str, line: i32, timestamp: &str| Question {
            id: id.into(),
            kind: QuestionKind::NameSpelling,
            source: "test".into(),
            impact: "high".into(),
            impact_reason: "ชื่อบุคคล".into(),
            prompt: "ควรแก้ ธานิน เป็น ธานินทร์ หรือไม่".into(),
            occurrence_count: 1,
            evidence: vec![Evidence {
                line,
                start: line as f64,
                end: line as f64 + 2.0,
                timestamp: timestamp.into(),
                text: "คุณธานิน".into(),
                approximate: true,
            }],
            options: vec![QuestionOption {
                id: "accept".into(),
                label: "แก้เป็น ธานินทร์".into(),
                edits: vec![TextEffect {
                    line,
                    original: "ธานิน".into(),
                    replacement: "ธานินทร์".into(),
                }],
                speaker: None,
            }],
            recommended_option_id: Some("accept".into()),
            target: Some(Target::Text {
                line,
                original: "ธานิน".into(),
            }),
            custom_label: Some("ชื่อ".into()),
        };
        let set = ClarificationSet {
            version: 1,
            base_revision: 8,
            questions: vec![
                question("name-1", 2, "00:02"),
                question("name-2", 8, "00:08"),
            ],
            omitted: vec![],
        };
        let selected = |id: &str| Answer {
            question_id: id.into(),
            decision: Decision::Select,
            option_id: Some("accept".into()),
            value: None,
        };

        let (set, answers) = coalesce(
            set,
            Answers {
                answers: vec![selected("name-1"), selected("name-2")],
            },
        );
        assert_eq!(set.questions.len(), 1);
        assert_eq!(set.questions[0].occurrence_count, 2);
        assert_eq!(set.questions[0].options[0].edits.len(), 2);
        assert_eq!(answers.answers.len(), 1);
        assert_eq!(answers.answers[0].question_id, "name-1");
    }
}
