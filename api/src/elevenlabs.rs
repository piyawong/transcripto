//! Step ① of the pipeline: ElevenLabs Scribe v2 speech-to-text with diarization and word timestamps.
//! Same request as `scribe()` in bench/transcribe.py (README section 2).

use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::lines::Word;

const URL: &str = "https://api.elevenlabs.io/v1/speech-to-text";
pub const MODEL: &str = "scribe_v2";
/// USD per audio hour, diarization included; keyterms add 20% (elevenlabs.io/pricing/api, checked 2026-09-15).
const PRICE_PER_HOUR: f64 = 0.22;
const KEYTERMS_SURCHARGE: f64 = 1.2;

#[derive(Clone)]
pub struct ElevenLabs {
    http: reqwest::Client,
    key: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SttResponse {
    #[serde(default)]
    pub words: Vec<Word>,
    #[serde(default)]
    pub audio_duration_secs: Option<f64>,
    #[serde(default)]
    pub language_code: Option<String>,
    #[serde(default)]
    pub language_probability: Option<f64>,
}

/// Keyterms file: one per line, skipping blank lines and "#" comments, at most 50 characters each and 1000 terms.
pub fn keyterms(text: &str) -> Vec<String> {
    text.lines()
        .filter(|l| !l.trim().is_empty() && !l.starts_with('#'))
        .map(|l| l.trim().to_string())
        .filter(|t| t.chars().count() <= 50)
        .take(1000)
        .collect()
}

pub fn cost_usd(audio_seconds: f64, with_keyterms: bool) -> f64 {
    let c = audio_seconds / 3600.0 * PRICE_PER_HOUR * if with_keyterms { KEYTERMS_SURCHARGE } else { 1.0 };
    (c * 10_000.0).round() / 10_000.0
}

impl ElevenLabs {
    pub fn new(key: String) -> Self {
        let http = reqwest::Client::builder().connect_timeout(Duration::from_secs(20)).build().expect("reqwest client");
        Self { http, key }
    }

    /// Sends the whole file (never chunks: speaker ids would restart in every chunk). Returns the raw JSON response,
    /// which the caller stores so a retry of a later step does not pay for transcription again.
    pub async fn transcribe(&self, audio: &Path, duration: f64, keyterms: &[String]) -> Result<Value> {
        // A 17-minute clip took 82–109 s. Leave room for a 3-hour upload and queueing; a timed-out request is not
        // retried because it would upload hundreds of MB again.
        let timeout = Duration::from_secs_f64(900.0 + duration * 0.3);
        let mut delay = Duration::from_secs(10);
        for attempt in 1..=3 {
            let last = attempt == 3;
            let mut form = reqwest::multipart::Form::new()
                .text("model_id", MODEL)
                // Force Thai: a Chinese accent could otherwise be auto-detected as Chinese.
                .text("language_code", "tha")
                .text("diarize", "true")
                .text("timestamps_granularity", "word");
            for t in keyterms {
                // Repeated fields, one per term (what httpx sends for a list).
                form = form.text("keyterms", t.clone());
            }
            let part = reqwest::multipart::Part::file(audio).await.context("opening audio for ElevenLabs")?.mime_str("audio/wav")?;
            form = form.part("file", part);

            let sent = self.http.post(URL).header("xi-api-key", &self.key).timeout(timeout).multipart(form).send().await;
            match sent {
                Ok(r) if r.status().is_success() => {
                    return r.json::<Value>().await.context("reading ElevenLabs response");
                }
                Ok(r) if !last && (r.status().as_u16() == 429 || r.status().is_server_error()) => {
                    tracing::warn!("ElevenLabs: HTTP {} (attempt {attempt}), retrying", r.status());
                }
                Ok(r) => {
                    let status = r.status();
                    let body: String = r.text().await.unwrap_or_default().chars().take(500).collect();
                    bail!("ElevenLabs API error {status}: {body}");
                }
                Err(e) if !last && e.is_connect() => {
                    tracing::warn!("ElevenLabs: {e} (attempt {attempt}), retrying");
                }
                Err(e) => return Err(anyhow!(e.without_url()).context("ElevenLabs request failed")),
            }
            tokio::time::sleep(delay).await;
            delay *= 3;
        }
        unreachable!()
    }
}

pub fn parse(raw: &Value) -> Result<SttResponse> {
    serde_json::from_value(raw.clone()).context("ElevenLabs response did not have the expected shape")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keyterms_rules() {
        let long = "ก".repeat(51);
        let t = keyterms(&format!("# comment\n\nLotus\n  CP ALL  \n{long}\n"));
        assert_eq!(t, vec!["Lotus".to_string(), "CP ALL".to_string()]);
        assert_eq!(keyterms(include_str!("../keyterms.txt")).len(), 16);
        assert_eq!(cost_usd(1029.0, true), 0.0755);
    }
}
