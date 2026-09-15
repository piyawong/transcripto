//! ElevenLabs word timings → "[MM:SS] ผู้พูด N: text" lines. Port of `words_to_lines` in bench/transcribe.py;
//! the rendered text must match it byte for byte (golden test: docs/rust-implementation/fixtures/lines.expected.txt).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Word {
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub start: Option<f64>,
    #[serde(default)]
    pub end: Option<f64>,
    /// "word", "spacing" or "audio_event"; only "spacing" is treated specially.
    #[serde(default, rename = "type")]
    pub kind: Option<String>,
    #[serde(default)]
    pub speaker_id: Option<String>,
    #[serde(default)]
    pub speaker: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Line {
    pub start: f64,
    /// End of the line's last word (the rendered text has no end time; the UI uses it for highlighting).
    pub end: f64,
    /// "ผู้พูด N", numbered in order of first appearance; None when the response has no speakers.
    pub speaker: Option<String>,
    pub text: String,
}

impl Line {
    pub fn render(&self) -> String {
        match &self.speaker {
            Some(s) => format!("[{}] {s}: {}", stamp(self.start), self.text),
            None => format!("[{}] {}", stamp(self.start), self.text),
        }
    }
}

/// Seconds as "MM:SS", truncated; minutes go past 99 for long files ("180:05").
pub fn stamp(seconds: f64) -> String {
    let s = seconds.max(0.0) as u64;
    format!("{:02}:{:02}", s / 60, s % 60)
}

/// Python's `x or default`: a missing value and 0.0 both fall back.
fn or_else(v: Option<f64>, default: f64) -> f64 {
    v.filter(|x| *x != 0.0).unwrap_or(default)
}

/// For Thai, ElevenLabs "words" are fragments of a syllable, so a line may only be cut after a spacing token:
/// at the first pause after `soft` seconds, or at `hard` seconds. After `max` seconds it is cut anywhere.
/// A new line always starts when the speaker changes.
pub fn words_to_lines(words: &[Word], soft: f64, hard: f64, max: f64) -> Vec<Line> {
    struct Current {
        start: f64,
        speaker: Option<String>,
        text: String,
    }
    let finish = |c: Current, end: f64| Line { start: c.start, end: end.max(c.start), speaker: c.speaker, text: c.text.trim().to_string() };

    let mut labels: HashMap<String, String> = HashMap::new();
    let mut lines = Vec::new();
    let mut current: Option<Current> = None;
    let mut prev_end = 0.0;
    let mut after_spacing = false;

    for w in words {
        let start = or_else(w.start, prev_end);
        if w.kind.as_deref() == Some("spacing") {
            if let Some(c) = current.as_mut() {
                c.text.push_str(&w.text);
            }
            after_spacing = true;
            continue;
        }
        let speaker = w.speaker_id.as_ref().or(w.speaker.as_ref()).map(|id| {
            let n = labels.len() + 1;
            labels.entry(id.clone()).or_insert_with(|| format!("ผู้พูด {n}")).clone()
        });
        let elapsed = current.as_ref().map_or(0.0, |c| start - c.start);
        let paused = start - prev_end >= 0.3;
        let at_boundary = after_spacing && (elapsed >= hard || (elapsed >= soft && paused));
        let new_line = match &current {
            None => true,
            Some(c) => speaker != c.speaker || at_boundary || elapsed >= max,
        };
        if new_line {
            if let Some(c) = current.take() {
                lines.push(finish(c, prev_end));
            }
            current = Some(Current { start, speaker, text: String::new() });
        }
        let c = current.as_mut().expect("current line");
        // Thai words join without spaces, but adjacent English words or numbers need one.
        if c.text.chars().next_back().is_some_and(|x| x.is_ascii_alphanumeric()) && w.text.chars().next().is_some_and(|x| x.is_ascii_alphanumeric()) {
            c.text.push(' ');
        }
        c.text.push_str(&w.text);
        prev_end = or_else(w.end, start);
        after_spacing = false;
    }
    if let Some(c) = current {
        lines.push(finish(c, prev_end));
    }
    lines
}

/// The transcript file: one rendered line per row and a trailing newline.
pub fn render(lines: &[Line]) -> String {
    let mut out: String = lines.iter().map(Line::render).collect::<Vec<_>>().join("\n");
    out.push('\n');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(text: &str, start: f64, end: f64, kind: &str, speaker: &str) -> Word {
        Word { text: text.into(), start: Some(start), end: Some(end), kind: Some(kind.into()), speaker_id: Some(speaker.into()), speaker: None }
    }

    #[test]
    fn matches_python_on_the_fixture() {
        if crate::testdata::missing() {
            return;
        }
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../docs/rust-implementation/fixtures/");
        let raw: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(format!("{dir}elevenlabs-response.json")).unwrap()).unwrap();
        let words: Vec<Word> = serde_json::from_value(raw["words"].clone()).unwrap();
        let lines = words_to_lines(&words, 15.0, 25.0, 60.0);
        let expected = std::fs::read_to_string(format!("{dir}lines.expected.txt")).unwrap();
        assert_eq!(render(&lines), expected);
        assert_eq!(lines.len(), 73);
        assert!(lines.windows(2).all(|p| p[0].start <= p[1].start));
        assert!(lines.iter().all(|l| l.end >= l.start));
    }

    #[test]
    fn speakers_in_order_of_appearance_and_ascii_spacing() {
        let words = [
            w("B2B", 1.0, 1.5, "word", "speaker_7"),
            w("Lotus", 1.5, 2.0, "word", "speaker_7"),
            w(" ", 2.0, 2.1, "spacing", "speaker_7"),
            w("ครับ", 2.1, 2.5, "word", "speaker_2"),
        ];
        let lines = words_to_lines(&words, 15.0, 25.0, 60.0);
        assert_eq!(render(&lines), "[00:01] ผู้พูด 1: B2B Lotus\n[00:02] ผู้พูด 2: ครับ\n");
        assert_eq!(lines[0].end, 2.0);
    }

    #[test]
    fn zero_start_falls_back_like_python() {
        let mut a = w("ก", 5.0, 6.0, "word", "s");
        let mut b = w("ข", 0.0, 0.0, "word", "t");
        b.start = Some(0.0);
        a.speaker_id = Some("s".into());
        let lines = words_to_lines(&[a, b], 15.0, 25.0, 60.0);
        assert_eq!(lines[1].start, 6.0, "0.0 start uses the previous end");
        assert_eq!(stamp(10865.0), "181:05");
    }
}
