//! ffprobe / ffmpeg helpers.

use std::path::Path;
use std::process::Stdio;

use anyhow::{Context, Result, bail};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

#[derive(Debug, Clone)]
pub struct Probe {
    pub duration: f64,
    pub has_audio: bool,
    pub has_video: bool,
}

pub async fn probe(path: &Path) -> Result<Probe> {
    let out = Command::new("ffprobe")
        .args(["-v", "error", "-print_format", "json", "-show_format", "-show_streams"])
        .arg(path)
        .output()
        .await
        .context("running ffprobe (is ffmpeg installed?)")?;
    if !out.status.success() {
        bail!("ffprobe: {}", String::from_utf8_lossy(&out.stderr).trim());
    }
    let v: Value = serde_json::from_slice(&out.stdout)?;
    let streams = v["streams"].as_array().cloned().unwrap_or_default();
    let kind = |k: &str| streams.iter().any(|s| s["codec_type"] == k);
    // Cover art in audio files shows up as a single-frame "video" stream.
    let has_video = streams.iter().any(|s| s["codec_type"] == "video" && s["disposition"]["attached_pic"].as_i64() != Some(1));
    let duration = v["format"]["duration"]
        .as_str()
        .and_then(|d| d.parse::<f64>().ok())
        .or_else(|| streams.iter().filter_map(|s| s["duration"].as_str()?.parse::<f64>().ok()).reduce(f64::max))
        .unwrap_or(0.0);
    Ok(Probe { duration, has_audio: kind("audio"), has_video })
}

/// Extracts 16 kHz mono PCM WAV. `on_progress` receives 0..1.
pub async fn extract_audio(src: &Path, dst: &Path, duration: f64, mut on_progress: impl FnMut(f64)) -> Result<()> {
    let mut child = Command::new("ffmpeg")
        .args(["-hide_banner", "-nostats", "-loglevel", "error", "-y", "-i"])
        .arg(src)
        .args(["-vn", "-sn", "-dn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-progress", "pipe:1"])
        .arg(dst)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .context("running ffmpeg")?;
    let stdout = child.stdout.take().unwrap();
    let mut lines = BufReader::new(stdout).lines();
    while let Some(line) = lines.next_line().await? {
        if let Some(us) = line.strip_prefix("out_time_us=").or_else(|| line.strip_prefix("out_time_ms="))
            && let (Ok(us), true) = (us.trim().parse::<f64>(), duration > 0.0)
        {
            on_progress((us / 1e6 / duration).clamp(0.0, 1.0));
        }
    }
    let out = child.wait_with_output().await?;
    if !out.status.success() {
        bail!("ffmpeg: {}", String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(())
}

pub async fn thumbnail(src: &Path, dst: &Path, duration: f64) -> Result<()> {
    let at = if duration > 0.0 { (duration / 3.0).min(1.5) } else { 0.0 };
    let out = Command::new("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-y", "-ss", &format!("{at:.2}"), "-i"])
        .arg(src)
        .args(["-frames:v", "1", "-vf", "scale=544:-2", "-q:v", "4"])
        .arg(dst)
        .output()
        .await?;
    if !out.status.success() {
        bail!("ffmpeg thumbnail: {}", String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(())
}

/// Cuts [start, start+len) out of a PCM WAV (sample accurate because PCM has no inter-frame coding).
pub async fn cut_wav(src: &Path, dst: &Path, start: f64, len: f64) -> Result<()> {
    let out = Command::new("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-y", "-ss", &format!("{start:.3}"), "-t", &format!("{len:.3}"), "-i"])
        .arg(src)
        .args(["-c:a", "pcm_s16le"])
        .arg(dst)
        .output()
        .await?;
    if !out.status.success() {
        bail!("ffmpeg cut: {}", String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(())
}
