//! CLI: run the pipeline on a local file without the database or object storage (README section 9 smoke test).
//!
//!   cargo run --bin transcribe_file -- <video-or-audio> <out-dir> [--seconds N] [--stt <stt.json>]
//!
//! Writes audio.wav, stt.json (ElevenLabs response), transcript.txt, corrected.txt, changes.txt, summary.json and
//! summary.txt. `--stt` reuses a saved ElevenLabs response instead of calling the API again.

use std::path::PathBuf;

use transcripto_api::config::Config;
use transcripto_api::pipeline::{self, Ai};
use transcripto_api::{lines, media, transcript};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().with_env_filter("info").init();
    let args: Vec<String> = std::env::args().collect();
    anyhow::ensure!(args.len() >= 3, "usage: transcribe_file <input> <out-dir> [--seconds N] [--stt stt.json]");
    let input = PathBuf::from(&args[1]);
    let out = PathBuf::from(&args[2]);
    let opt = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    std::fs::create_dir_all(&out)?;

    let cfg = Config::from_env();
    let ai = Ai::from_config(&cfg)?;

    let probe = media::probe(&input).await?;
    let audio = out.join("audio.wav");
    media::extract_audio(&input, &audio, probe.duration, |_| {}).await?;
    let mut duration = probe.duration;
    if let Some(s) = opt("--seconds").and_then(|v| v.parse::<f64>().ok()).filter(|s| *s < duration) {
        let cut = out.join("audio_cut.wav");
        media::cut_wav(&audio, &cut, 0.0, s).await?;
        std::fs::rename(&cut, &audio)?;
        duration = s;
    }
    println!("audio {duration:.1}s");

    let raw = match opt("--stt") {
        Some(path) => serde_json::from_str(&std::fs::read_to_string(path)?)?,
        None => {
            let stt = pipeline::speech_to_text(&ai, &audio, duration, &cfg.default_keyterms).await?;
            println!("stt: {}", serde_json::to_string_pretty(&stt.meta)?);
            stt.raw
        }
    };
    std::fs::write(out.join("stt.json"), serde_json::to_string_pretty(&raw)?)?;
    let ls = pipeline::lines_from_stt(&raw)?;
    std::fs::write(out.join("transcript.txt"), lines::render(&ls))?;

    let name = input.file_name().and_then(|n| n.to_str()).unwrap_or("input").to_string();
    let c = pipeline::correct(&ai, &ls, &cfg.default_keyterms, &name, |p| tracing::info!("correction {:.0}%", p * 100.0)).await?;
    let text = transcript::transcript_for_summary(&c.segments, &c.speakers);
    std::fs::write(out.join("corrected.txt"), &text)?;
    std::fs::write(out.join("changes.txt"), &c.changes_text)?;
    std::fs::write(out.join("corrections.json"), serde_json::to_string_pretty(&c.corrections)?)?;
    println!("correct: {}", serde_json::to_string_pretty(&c.meta)?);

    let s = pipeline::summarize(&ai, &text, &name).await?;
    std::fs::write(out.join("summary.txt"), &s.text)?;
    std::fs::write(out.join("summary.json"), serde_json::to_string_pretty(&s.minutes)?)?;
    println!("summary: {}", serde_json::to_string_pretty(&s.meta)?);
    Ok(())
}
