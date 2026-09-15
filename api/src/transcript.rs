//! Transcript segments and speakers as stored in the database, built from the corrected ElevenLabs lines.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::correct::{SpeakerRole, UNKNOWN_ROLE};
use crate::lines::Line;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Segment {
    pub start: f64,
    pub end: f64,
    /// Index into the job's speaker list.
    pub speaker: usize,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Speaker {
    /// Label in the transcript, e.g. "ผู้พูด 2".
    pub label: String,
    /// Display name; starts as the role found by the correction step, or the label.
    pub name: String,
    #[serde(default)]
    pub role: Option<String>,
}

/// `corrected[i]` is `lines[i]` rendered and then edited; the "[MM:SS] ผู้พูด N: " prefix is never edited, so the
/// corrected text is whatever follows it. Speakers are listed in order of first appearance.
pub fn build(lines: &[Line], corrected: &[String], roles: &[SpeakerRole]) -> (Vec<Segment>, Vec<Speaker>) {
    let mut speakers: Vec<Speaker> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut segments = Vec::with_capacity(lines.len());
    for (line, fixed) in lines.iter().zip(corrected) {
        let prefix = line.render().len() - line.text.len();
        let text = fixed.get(prefix..).unwrap_or(&line.text).trim();
        if text.is_empty() {
            continue;
        }
        // Without diarization every line belongs to one speaker.
        let label = line.speaker.clone().unwrap_or_else(|| "ผู้พูด 1".to_string());
        let idx = *index.entry(label.clone()).or_insert_with(|| {
            let role = roles
                .iter()
                .find(|r| r.label.trim() == label)
                .map(|r| r.role.trim().to_string())
                .filter(|r| !r.is_empty() && r != UNKNOWN_ROLE);
            let name = role.clone().filter(|r| r.chars().count() <= 40).unwrap_or_else(|| label.clone());
            speakers.push(Speaker { label: label.clone(), name, role });
            speakers.len() - 1
        });
        segments.push(Segment { start: round2(line.start), end: round2(line.end.max(line.start + 0.2)), speaker: idx, text: text.to_string() });
    }
    (segments, speakers)
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

/// "MM:SS" with minutes allowed past 59, as in the transcripts.
pub fn mmss(t: f64) -> String {
    crate::lines::stamp(t)
}

/// The corrected transcript in the file format of the POC ("[MM:SS] ผู้พูด N: text" + "## ผู้พูด"), used as the
/// input to the summary. A name the user typed replaces the role found by the correction step.
pub fn transcript_for_summary(segments: &[Segment], speakers: &[Speaker]) -> String {
    let mut out = String::new();
    for s in segments {
        let label = speakers.get(s.speaker).map(|x| x.label.as_str()).unwrap_or("ผู้พูด ?");
        out.push_str(&format!("[{}] {}: {}\n", mmss(s.start), label, s.text));
    }
    out.push_str("\n## ผู้พูด\n");
    for s in speakers {
        let who = if s.name != s.label { s.name.clone() } else { s.role.clone().unwrap_or_else(|| UNKNOWN_ROLE.into()) };
        out.push_str(&format!("{}: {}\n", s.label, who));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::correct::{self, Corrections};
    use crate::lines::{self, Word};

    const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../docs/rust-implementation/fixtures/");

    #[test]
    fn segments_follow_corrected_lines() {
        if crate::testdata::missing() {
            return;
        }
        let raw: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(format!("{FIXTURES}elevenlabs-response.json")).unwrap()).unwrap();
        let words: Vec<Word> = serde_json::from_value(raw["words"].clone()).unwrap();
        let lines = lines::words_to_lines(&words, 15.0, 25.0, 60.0);
        let mut text: Vec<String> = lines.iter().map(|l| l.render()).collect();
        let c: Corrections = serde_json::from_str(&std::fs::read_to_string(format!("{FIXTURES}correct-pro.corrections.json")).unwrap()).unwrap();
        let results = correct::apply_edits(&mut text, &c.edits);
        assert!(results.iter().filter(|r| r.is_none()).count() > 30, "most edits still apply to the 73-line transcript");

        let (segs, spk) = build(&lines, &text, &c.speakers);
        assert_eq!(segs.len(), lines.len());
        assert_eq!(spk.len(), 5);
        assert_eq!(spk[2].name, "ประธานอาวุโส");
        assert_eq!(spk[0].name, "ผู้พูด 1");
        assert!(segs.iter().all(|s| s.end > s.start));
        // Rendering the segments gives back the corrected lines.
        let rendered = transcript_for_summary(&segs, &spk);
        for (a, b) in rendered.lines().zip(&text) {
            assert_eq!(a, b);
        }
        assert!(rendered.contains("7,000 หรือ 8,000 ตารางเมตร"));
    }
}
