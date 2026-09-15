//! Minimal Gemini REST client (generateContent with a JSON response schema).
//! There is no official Rust SDK, so this mirrors what google-genai does in bench/*.py.

use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;

const BASE: &str = "https://generativelanguage.googleapis.com";

#[derive(Clone)]
pub struct Gemini {
    http: reqwest::Client,
    key: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Usage {
    pub tokens_in: u64,
    pub tokens_out: u64,
    pub tokens_thinking: u64,
}

impl Usage {
    pub fn add(&mut self, other: &Usage) {
        self.tokens_in += other.tokens_in;
        self.tokens_out += other.tokens_out;
        self.tokens_thinking += other.tokens_thinking;
    }
}

#[derive(Debug, Clone)]
pub struct Generated {
    pub text: String,
    pub finish_reason: Option<String>,
    pub usage: Usage,
}

/// USD per 1M tokens (input, output). Thinking tokens are billed as output.
/// From ai.google.dev/gemini-api/docs/pricing, checked 2026-09-15 (same table as bench/).
pub fn price(model: &str) -> (f64, f64) {
    match model {
        m if m.starts_with("gemini-3.1-pro") => (2.00, 12.00),
        m if m.starts_with("gemini-3.8-flash") => (0.75, 3.75),
        _ => (0.0, 0.0),
    }
}

pub fn cost_usd(model: &str, u: &Usage) -> f64 {
    let (pin, pout) = price(model);
    let c = (u.tokens_in as f64 * pin + (u.tokens_out + u.tokens_thinking) as f64 * pout) / 1e6;
    (c * 10_000.0).round() / 10_000.0
}

impl Gemini {
    pub fn new(key: String) -> Self {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(20))
            // Correcting a 17-minute transcript took 96 s; a 30-minute window with thinking can take several minutes.
            .timeout(Duration::from_secs(20 * 60))
            .build()
            .expect("reqwest client");
        Self { http, key }
    }

    /// POST models/{model}:generateContent with a raw request body. The caller checks `finish_reason`:
    /// anything but STOP (e.g. MAX_TOKENS) means the text is incomplete and must not be used.
    pub async fn generate(&self, model: &str, body: &Value) -> Result<Generated> {
        let resp = self
            .with_retry("generateContent", || async {
                self.http
                    .post(format!("{BASE}/v1beta/models/{model}:generateContent"))
                    .header("x-goog-api-key", &self.key)
                    .json(body)
                    .send()
                    .await
            })
            .await?;
        let v: Value = resp.json().await.context("parsing generateContent response")?;
        parse_response(&v)
    }

    /// Retries transient failures (network, 429, 5xx) with exponential backoff.
    async fn with_retry<F, Fut>(&self, what: &str, mut f: F) -> Result<reqwest::Response>
    where
        F: FnMut() -> Fut,
        Fut: std::future::Future<Output = reqwest::Result<reqwest::Response>>,
    {
        let mut delay = Duration::from_secs(4);
        for attempt in 1..=4 {
            let last = attempt == 4;
            match f().await {
                Ok(r) if r.status().is_success() => return Ok(r),
                Ok(r) if !last && (r.status().as_u16() == 429 || r.status().is_server_error()) => {
                    tracing::warn!("{what}: HTTP {} (attempt {attempt}), retrying", r.status());
                }
                Ok(r) => return check(r, what).await,
                Err(e) if !last && (e.is_timeout() || e.is_connect() || e.is_request()) => {
                    tracing::warn!("{what}: {e} (attempt {attempt}), retrying");
                }
                Err(e) => return Err(anyhow!(e).context(format!("{what} failed"))),
            }
            tokio::time::sleep(delay).await;
            delay *= 3;
        }
        unreachable!()
    }
}

/// Reads a generateContent response like `response.text` in the SDK: the text of every non-thought part.
pub fn parse_response(v: &Value) -> Result<Generated> {
    let Some(cand) = v["candidates"].get(0) else {
        let feedback = v.get("promptFeedback").map(|f| f.to_string()).unwrap_or_else(|| "no candidates".into());
        bail!("Gemini returned no candidates ({feedback})");
    };
    let text = cand["content"]["parts"]
        .as_array()
        .map(|parts| {
            parts.iter().filter(|p| !p["thought"].as_bool().unwrap_or(false)).filter_map(|p| p["text"].as_str()).collect::<String>()
        })
        .unwrap_or_default();
    let usage = &v["usageMetadata"];
    let n = |k: &str| usage[k].as_u64().unwrap_or(0);
    Ok(Generated {
        text,
        finish_reason: cand["finishReason"].as_str().map(str::to_string),
        usage: Usage { tokens_in: n("promptTokenCount"), tokens_out: n("candidatesTokenCount"), tokens_thinking: n("thoughtsTokenCount") },
    })
}

impl Generated {
    pub fn is_complete(&self) -> bool {
        self.finish_reason.as_deref() == Some("STOP")
    }

    /// Parses the JSON answer; tolerates a ```json fence around it.
    pub fn json<T: serde::de::DeserializeOwned>(&self) -> Result<T> {
        let t = self.text.trim();
        let t = t.strip_prefix("```json").or_else(|| t.strip_prefix("```")).unwrap_or(t);
        let t = t.strip_suffix("```").unwrap_or(t).trim();
        serde_json::from_str(t).map_err(|e| anyhow!("Gemini JSON did not match the schema: {e}"))
    }
}

async fn check(resp: reqwest::Response, what: &str) -> Result<reqwest::Response> {
    if resp.status().is_success() {
        return Ok(resp);
    }
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    let msg = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().map(str::to_string))
        .unwrap_or_else(|| body.chars().take(300).collect());
    bail!("{what}: HTTP {status}: {msg}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_saved_response() {
        if crate::testdata::missing() {
            return;
        }
        let raw = std::fs::read_to_string(format!("{}gemini-correct-response.json", crate::testdata::DIR)).unwrap();
        let g = parse_response(&serde_json::from_str(&raw).unwrap()).unwrap();
        assert!(g.is_complete());
        assert_eq!((g.usage.tokens_in, g.usage.tokens_out, g.usage.tokens_thinking), (646, 271, 495));
        let c: crate::correct::Corrections = g.json().unwrap();
        assert!(!c.edits.is_empty());
        assert!(parse_response(&serde_json::json!({ "promptFeedback": { "blockReason": "SAFETY" } })).is_err());
    }
}
