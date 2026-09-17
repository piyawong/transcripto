//! Jobs created from a link: yt-dlp reads the page (YouTube, Google Drive, Facebook, … or a direct file link), picks a
//! rendition browsers can play and downloads it into the job's scratch directory. The worker then stores it as the job's
//! source, exactly like an uploaded file.

use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use reqwest::Url;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::{Child, Command};

pub const MAX_URL_LEN: usize = 4096;
/// ≤720p H.264 + AAC in MP4 first: plays in every browser and keeps a 3-hour meeting far below 2 GB.
const FORMAT_SORT: &str = "res:720,vcodec:h264,acodec:aac,ext:mp4:m4a";
const INSPECT_TIMEOUT: Duration = Duration::from_secs(120);
const PROGRESS: &str = "TRANSCRIPTO_PROGRESS";
const FILE: &str = "TRANSCRIPTO_FILE";

/// Checks the shape of a pasted link: http(s), a host, no user name or password.
pub fn parse_url(input: &str) -> Result<Url, String> {
    let input = input.trim();
    if input.is_empty() {
        return Err("วางลิงก์ของวิดีโอก่อน".into());
    }
    if input.len() > MAX_URL_LEN {
        return Err("ลิงก์ยาวเกินไป".into());
    }
    let url = Url::parse(input).map_err(|_| "ลิงก์ไม่ถูกต้อง ต้องขึ้นต้นด้วย https:// หรือ http://".to_string())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none_or(str::is_empty) {
        return Err("ลิงก์ไม่ถูกต้อง ต้องขึ้นต้นด้วย https:// หรือ http://".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("ลิงก์ต้องไม่มีชื่อผู้ใช้หรือรหัสผ่าน".into());
    }
    Ok(url)
}

/// Addresses a link may not lead to: this machine, private networks, cloud metadata endpoints.
pub fn is_blocked(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_multicast()
                || v4.is_documentation()
                || a == 0
                || (a == 100 && (64..128).contains(&b)) // carrier-grade NAT
        }
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => is_blocked(IpAddr::V4(v4)),
            None => v6.is_loopback() || v6.is_unspecified() || v6.is_multicast() || v6.is_unique_local() || v6.is_unicast_link_local(),
        },
    }
}

/// Every address the host resolves to must be public. This covers the link itself; redirects followed inside yt-dlp are
/// not checked (the app has a single admin account, so this is a guard against mistakes, not a sandbox).
pub async fn check_host(url: &Url, allow_private: bool) -> Result<(), String> {
    if allow_private {
        return Ok(());
    }
    let host = url.host_str().unwrap_or_default();
    let addrs: Vec<IpAddr> = match host.trim_start_matches('[').trim_end_matches(']').parse::<IpAddr>() {
        Ok(ip) => vec![ip],
        Err(_) => tokio::net::lookup_host((host, url.port_or_known_default().unwrap_or(443)))
            .await
            .map_err(|_| format!("ไม่พบเว็บไซต์ {host} ตรวจลิงก์อีกครั้ง"))?
            .map(|a| a.ip())
            .collect(),
    };
    if addrs.is_empty() {
        return Err(format!("ไม่พบเว็บไซต์ {host} ตรวจลิงก์อีกครั้ง"));
    }
    if addrs.into_iter().any(is_blocked) {
        return Err("ลิงก์นี้ชี้ไปที่เครือข่ายภายใน ใช้ลิงก์ที่เปิดได้จากอินเทอร์เน็ต".into());
    }
    Ok(())
}

/// Job name before the page has been read: the file name in the link, else the site.
pub fn provisional_name(url: &Url) -> String {
    let file = url.path_segments().and_then(|mut s| s.next_back()).map(percent_decode).unwrap_or_default();
    if file.contains('.') && !file.starts_with('.') {
        return file;
    }
    url.host_str().unwrap_or_default().trim_start_matches("www.").to_string()
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = |c: u8| (c as char).to_digit(16);
        if b[i] == b'%'
            && i + 2 < b.len()
            && let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2]))
        {
            out.push((h * 16 + l) as u8);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// What the link points at, read without downloading it.
#[derive(Debug)]
pub struct Source {
    pub title: Option<String>,
    pub duration: Option<f64>,
    /// Size of the chosen rendition (video + audio) when the site reports it.
    pub bytes: Option<u64>,
    /// yt-dlp's page data, handed back to it for the download so the page isn't read twice.
    pub info_json: PathBuf,
}

/// `yt-dlp -J`: reads the page and rejects what can't become a job (playlists, live streams, too long or too large).
pub async fn inspect(bin: &str, url: &Url, dir: &Path, max_bytes: u64, max_duration: f64) -> Result<Source> {
    let mut cmd = yt_dlp(bin);
    cmd.args(["-J", "--flat-playlist", "-S", FORMAT_SORT]).arg(url.as_str()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut proc = spawn(cmd)?;
    let (mut out, mut err) = (proc.child.stdout.take().context("yt-dlp stdout")?, proc.child.stderr.take().context("yt-dlp stderr")?);
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    let run = async {
        let (a, b) = tokio::join!(out.read_to_end(&mut stdout), err.read_to_end(&mut stderr));
        a?;
        b?;
        proc.child.wait().await
    };
    let status = match tokio::time::timeout(INSPECT_TIMEOUT, run).await {
        Ok(status) => status.context("running yt-dlp")?,
        Err(_) => bail!("USER: เว็บต้นทางตอบช้าเกินไป ลองกด “ลองอีกครั้ง” ในอีกสักครู่"),
    };
    proc.exited();
    if !status.success() {
        let stderr = String::from_utf8_lossy(&stderr);
        tracing::warn!("yt-dlp -J {}: {}", redact(url), tail(&stderr));
        bail!("USER: {}", user_error(&stderr));
    }
    let info: Value = serde_json::from_slice(&stdout).context("reading yt-dlp -J output")?;
    let mut source = check_info(&info, max_bytes, max_duration).map_err(|m| anyhow!("USER: {m}"))?;
    source.info_json = dir.join("info.json");
    tokio::fs::write(&source.info_json, &stdout).await?;
    Ok(source)
}

/// The checks `inspect` applies to yt-dlp's page data.
pub fn check_info(info: &Value, max_bytes: u64, max_duration: f64) -> Result<Source, String> {
    if matches!(info["_type"].as_str(), Some("playlist" | "multi_video")) {
        return Err("ลิงก์นี้เป็นเพลย์ลิสต์หรือมีหลายวิดีโอ วางลิงก์ของวิดีโอทีละรายการ".into());
    }
    if info["is_live"].as_bool() == Some(true) || matches!(info["live_status"].as_str(), Some("is_live" | "is_upcoming" | "post_live")) {
        return Err("วิดีโอนี้กำลังถ่ายทอดสดหรือยังไม่พร้อม รอให้ถ่ายทอดจบแล้วลองใหม่".into());
    }
    let duration = info["duration"].as_f64().filter(|d| d.is_finite() && *d > 0.0);
    if let Some(d) = duration
        && d > max_duration
    {
        return Err(format!("วิดีโอยาวเกิน {} ชั่วโมง ตัดเป็นช่วงสั้นลงแล้วอัปโหลดใหม่", max_duration / 3600.0));
    }
    let size = |f: &Value| f["filesize"].as_f64().or_else(|| f["filesize_approx"].as_f64()).filter(|s| s.is_finite() && *s > 0.0);
    let bytes = match info["requested_formats"].as_array() {
        Some(parts) => parts.iter().map(size).sum::<Option<f64>>(),
        None => size(info),
    }
    .map(|b| b as u64);
    if let Some(b) = bytes
        && b > max_bytes
    {
        return Err("วิดีโอมีขนาดเกิน 2 GB ตัดเป็นช่วงสั้นลงแล้วอัปโหลดใหม่".into());
    }
    let title = info["title"].as_str().map(|t| t.split_whitespace().collect::<Vec<_>>().join(" ")).filter(|t| !t.is_empty());
    Ok(Source { title, duration, bytes, info_json: PathBuf::new() })
}

/// Download progress: bytes so far, the expected total when known, and yt-dlp's estimate of the seconds left.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Progress {
    pub bytes: u64,
    pub total: Option<u64>,
    pub eta: Option<f64>,
}

/// Downloads the inspected rendition into `dir` and returns the file. Video and audio often come as two files that
/// yt-dlp merges; progress covers both.
pub async fn download(bin: &str, source: &Source, dir: &Path, max_bytes: u64, mut on_progress: impl FnMut(Progress)) -> Result<PathBuf> {
    let mut cmd = yt_dlp(bin);
    cmd.arg("--load-info-json")
        .arg(&source.info_json)
        .args(["-S", FORMAT_SORT, "--merge-output-format", "mp4", "--max-filesize", &max_bytes.to_string()])
        // A stream with a fragment that never arrives must fail, not become a transcript with a gap in it.
        .args(["--socket-timeout", "30", "--retries", "5", "--fragment-retries", "10", "--abort-on-unavailable-fragments", "--no-mtime"])
        .arg("-o")
        .arg(dir.join("source.%(ext)s"))
        .args(["--newline", "--progress", "--progress-template"])
        .arg(format!(
            "download:{PROGRESS} %(progress.status)s %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.eta)s %(info.format_id)s"
        ))
        .args(["--print", &format!("after_move:{FILE} %(filepath)s")])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut proc = spawn(cmd)?;
    let stdout = proc.child.stdout.take().context("yt-dlp stdout")?;
    let mut stderr = proc.child.stderr.take().context("yt-dlp stderr")?;
    let errors = tokio::spawn(async move {
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf).await;
        String::from_utf8_lossy(&buf).into_owned()
    });

    let mut tally = Tally::default();
    let mut file = None;
    let mut too_large = false;
    let mut lines = BufReader::new(stdout).lines();
    while let Some(line) = lines.next_line().await? {
        if let Some(path) = line.strip_prefix(FILE).map(str::trim) {
            file = Some(PathBuf::from(path));
        } else if let Some(p) = tally.update(&line, source.bytes) {
            if p.bytes > max_bytes {
                too_large = true;
                break;
            }
            on_progress(p);
        }
    }
    if too_large {
        drop(proc);
        bail!("USER: วิดีโอมีขนาดเกิน 2 GB ตัดเป็นช่วงสั้นลงแล้วอัปโหลดใหม่");
    }
    let status = proc.child.wait().await.context("running yt-dlp")?;
    proc.exited();
    let stderr = errors.await.unwrap_or_default();
    if !status.success() {
        tracing::warn!("yt-dlp download: {}", tail(&stderr));
        bail!("USER: {}", user_error(&stderr));
    }
    let Some(file) = file.filter(|f| f.starts_with(dir) && f.is_file()) else {
        // --max-filesize skips a too-large file and still exits 0.
        if stderr.contains("larger than max-filesize") || stderr.contains("File is larger") {
            bail!("USER: วิดีโอมีขนาดเกิน 2 GB ตัดเป็นช่วงสั้นลงแล้วอัปโหลดใหม่");
        }
        tracing::warn!("yt-dlp finished without a file: {}", tail(&stderr));
        bail!("USER: {}", user_error(&stderr));
    };
    if tokio::fs::metadata(&file).await?.len() > max_bytes {
        bail!("USER: วิดีโอมีขนาดเกิน 2 GB ตัดเป็นช่วงสั้นลงแล้วอัปโหลดใหม่");
    }
    Ok(file)
}

/// Sums the progress lines of the files one download is made of.
#[derive(Debug, Default)]
struct Tally {
    finished: u64,
    format: String,
    current: u64,
}

impl Tally {
    fn update(&mut self, line: &str, expected: Option<u64>) -> Option<Progress> {
        let mut it = line.strip_prefix(PROGRESS)?.split_whitespace();
        let (status, done, total, estimate, eta) = (it.next()?, num(it.next()?), num(it.next()?), num(it.next()?), num(it.next()?));
        let format = it.collect::<Vec<_>>().join(" ");
        if format != self.format {
            // A new file started without a "finished" line for the previous one.
            self.finished += self.current;
            self.current = 0;
            self.format = format;
        }
        let file_total = total.or(estimate);
        if status == "finished" {
            self.finished += done.or(file_total).unwrap_or(self.current as f64) as u64;
            self.current = 0;
            self.format.clear();
        } else {
            self.current = done.unwrap_or(0.0) as u64;
        }
        let bytes = self.finished + self.current;
        // The page's size covers every file; the server's covers the files so far. Google Drive reports a few MB for
        // a 600 MB video, so the larger one wins.
        let so_far = if status == "finished" { Some(self.finished) } else { file_total.map(|t| self.finished + t as u64) };
        let total = expected.max(so_far).map(|t| t.max(bytes));
        Some(Progress { bytes, total, eta: eta.filter(|_| status != "finished") })
    }
}

fn num(s: &str) -> Option<f64> {
    s.parse::<f64>().ok().filter(|v| v.is_finite() && *v >= 0.0)
}

fn yt_dlp(bin: &str) -> Command {
    let mut cmd = Command::new(bin);
    // No user or system config and no plugins: the arguments here are the whole behaviour.
    cmd.args(["--ignore-config", "--no-plugin-dirs", "--no-playlist", "--no-warnings"]).stdin(Stdio::null()).kill_on_drop(true);
    cmd
}

/// A running yt-dlp in its own process group, so ffmpeg and deno started by it stop with it when the job is cancelled.
struct Proc {
    child: Child,
    group: Option<i32>,
}

impl Proc {
    fn exited(&mut self) {
        self.group = None;
    }
}

impl Drop for Proc {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(pgid) = self.group.take() {
            // SAFETY: plain syscall on the group this struct created; no memory is involved.
            unsafe {
                libc::killpg(pgid, libc::SIGKILL);
            }
        }
    }
}

fn spawn(mut cmd: Command) -> Result<Proc> {
    #[cfg(unix)]
    cmd.process_group(0);
    let child = cmd.spawn().context("running yt-dlp (is yt-dlp installed? set YT_DLP_BIN)")?;
    let group = child.id().map(|id| id as i32);
    Ok(Proc { child, group })
}

/// A message for the user from yt-dlp's error output.
pub fn user_error(stderr: &str) -> String {
    let s = stderr.to_lowercase();
    let has = |xs: &[&str]| xs.iter().any(|x| s.contains(x));
    if has(&["not a bot"]) {
        "YouTube ไม่ให้เซิร์ฟเวอร์ดาวน์โหลดวิดีโอนี้ (ขอยืนยันว่าไม่ใช่บอท) ดาวน์โหลดไฟล์มาอัปโหลดเองแทน".into()
    } else if has(&["unsupported url", "no video formats found", "no media found"]) {
        "ไม่พบวิดีโอในลิงก์นี้ ตรวจว่าเป็นลิงก์ของวิดีโอ หรือดาวน์โหลดไฟล์มาอัปโหลดเอง".into()
    } else if has(&["drm"]) {
        "วิดีโอนี้มีการป้องกันลิขสิทธิ์ (DRM) ดาวน์โหลดไม่ได้".into()
    } else if has(&["private video", "sign in", "log in", "login", "members-only", "http error 401", "http error 403", "permission"]) {
        "เข้าถึงวิดีโอไม่ได้ ลิงก์อาจต้องเข้าสู่ระบบหรือไม่ได้เปิดให้ทุกคนดู ตั้งค่าให้ทุกคนที่มีลิงก์ดูได้ หรือดาวน์โหลดไฟล์มาอัปโหลดเอง".into()
    } else if has(&["http error 404", "video unavailable", "not available", "has been removed", "does not exist"]) {
        "ไม่พบวิดีโอ ลิงก์อาจผิด ถูกลบ หรือหมดอายุแล้ว".into()
    } else if has(&["timed out", "connection", "network is unreachable", "name or service not known", "nodename nor servname"]) {
        "เชื่อมต่อเว็บต้นทางไม่ได้ ลองกด “ลองอีกครั้ง” ในอีกสักครู่".into()
    } else {
        // A site yt-dlp has trouble with: its own words are the best clue for the admin.
        let detail = stderr.lines().rev().find_map(|l| l.trim().strip_prefix("ERROR:")).map(|l| l.trim().chars().take(200).collect::<String>());
        match detail {
            Some(d) if !d.is_empty() => format!("ดาวน์โหลดจากลิงก์ไม่สำเร็จ ({d}) ลองกด “ลองอีกครั้ง” หรือดาวน์โหลดไฟล์มาอัปโหลดเอง"),
            _ => "ดาวน์โหลดจากลิงก์ไม่สำเร็จ ลองกด “ลองอีกครั้ง” หรือดาวน์โหลดไฟล์มาอัปโหลดเอง".into(),
        }
    }
}

/// The link without its query, for logs (signed links carry tokens there).
pub fn redact(url: &Url) -> String {
    format!("{}://{}{}", url.scheme(), url.host_str().unwrap_or_default(), url.path())
}

fn tail(s: &str) -> &str {
    let s = s.trim();
    let mut start = s.len().saturating_sub(1500);
    while !s.is_char_boundary(start) {
        start += 1;
    }
    &s[start..]
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const GB2: u64 = 2 * 1024 * 1024 * 1024;

    #[test]
    fn links_must_be_http_with_a_host_and_no_credentials() {
        assert!(parse_url(" https://www.youtube.com/watch?v=abc ").is_ok());
        assert!(parse_url("http://example.com/a.mp4").is_ok());
        for bad in ["", "youtube.com/watch?v=abc", "ftp://example.com/a.mp4", "file:///etc/passwd", "https://user:pw@example.com/a.mp4", "javascript:alert(1)"] {
            assert!(parse_url(bad).is_err(), "{bad}");
        }
        assert!(parse_url(&format!("https://example.com/{}", "a".repeat(MAX_URL_LEN))).is_err());
    }

    #[test]
    fn internal_addresses_are_blocked() {
        for ip in ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "::1", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1"] {
            assert!(is_blocked(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["8.8.8.8", "142.250.72.14", "100.128.0.1", "2001:4860:4860::8888", "::ffff:8.8.8.8"] {
            assert!(!is_blocked(ip.parse().unwrap()), "{ip}");
        }
    }

    #[tokio::test]
    async fn host_check_covers_literals_and_obfuscated_forms() {
        for link in ["http://127.0.0.1:3010/x.mp4", "http://[::1]/x.mp4", "http://2130706433/x.mp4", "http://0x7f.1/x.mp4", "http://localhost/x.mp4"] {
            let url = parse_url(link).unwrap();
            assert!(check_host(&url, false).await.is_err(), "{link}");
            assert!(check_host(&url, true).await.is_ok(), "{link}");
        }
    }

    #[test]
    fn provisional_name_prefers_the_file_name() {
        let n = |s: &str| provisional_name(&parse_url(s).unwrap());
        assert_eq!(n("https://files.example.com/meet/%E0%B8%9B%E0%B8%A3%E0%B8%B0%E0%B8%8A%E0%B8%B8%E0%B8%A1.mp4?sig=x"), "ประชุม.mp4");
        assert_eq!(n("https://www.youtube.com/watch?v=abc"), "youtube.com");
        assert_eq!(n("https://drive.google.com/file/d/123/view"), "drive.google.com");
        assert_eq!(n("https://example.com/100%"), "example.com");
    }

    #[test]
    fn page_data_is_checked_before_downloading() {
        let video = json!({"_type": "video", "title": "  ประชุม \n ครั้งที่ 5 ", "duration": 3600.0, "live_status": "not_live",
            "requested_formats": [{"filesize": 400_000_000}, {"filesize_approx": 60_000_000.0}]});
        let s = check_info(&video, GB2, 10_800.0).unwrap();
        assert_eq!(s.title.as_deref(), Some("ประชุม ครั้งที่ 5"));
        assert_eq!(s.bytes, Some(460_000_000));
        assert_eq!(s.duration, Some(3600.0));

        // a direct file: nothing known up front
        let file = check_info(&json!({"_type": "video", "title": "demo", "duration": null}), GB2, 10_800.0).unwrap();
        assert_eq!((file.duration, file.bytes), (None, None));
        // one part without a size: the total is unknown
        assert_eq!(check_info(&json!({"requested_formats": [{"filesize": 5}, {}]}), GB2, 10_800.0).unwrap().bytes, None);

        assert!(check_info(&json!({"_type": "playlist", "entries": []}), GB2, 10_800.0).unwrap_err().contains("เพลย์ลิสต์"));
        assert!(check_info(&json!({"live_status": "is_live"}), GB2, 10_800.0).unwrap_err().contains("ถ่ายทอดสด"));
        assert!(check_info(&json!({"live_status": "is_upcoming"}), GB2, 10_800.0).is_err());
        assert!(check_info(&json!({"live_status": "was_live", "duration": 10_800.0}), GB2, 10_800.0).is_ok());
        assert!(check_info(&json!({"duration": 10_801.0}), GB2, 10_800.0).unwrap_err().contains("3 ชั่วโมง"));
        assert!(check_info(&json!({"filesize_approx": GB2 + 1}), GB2, 10_800.0).unwrap_err().contains("2 GB"));
    }

    #[test]
    fn progress_adds_up_video_and_audio() {
        let mut t = Tally::default();
        let line = |s: &str| format!("{PROGRESS} {s}");
        assert_eq!(t.update("[download] something else", Some(1000)), None);
        assert_eq!(t.update(&line("downloading 100 700 NA 12 133"), Some(1000)), Some(Progress { bytes: 100, total: Some(1000), eta: Some(12.0) }));
        assert_eq!(t.update(&line("finished 700 700 NA NA 133"), Some(1000)).unwrap().bytes, 700);
        assert_eq!(t.update(&line("downloading 50 300 NA 1 140"), Some(1000)).unwrap().bytes, 750);
        assert_eq!(t.update(&line("finished 300 300 NA NA 140"), Some(1000)), Some(Progress { bytes: 1000, total: Some(1000), eta: None }));

        // no size from the page: the files so far, as the server reports them
        let mut t = Tally::default();
        assert_eq!(t.update(&line("downloading 10 NA 90.5 NA hls-720p"), None).unwrap().total, Some(90));
        let mut t = Tally::default();
        t.update(&line("finished 700 700 NA NA 133"), None);
        assert_eq!(t.update(&line("downloading 5 300 NA NA 140"), None).unwrap().total, Some(1000));
        // a page size far below the real file (Google Drive) does not pin the bar at the end
        let mut t = Tally::default();
        assert_eq!(t.update(&line("downloading 1000000 611000000 NA 300 22"), Some(3_259_352)).unwrap().total, Some(611_000_000));
        // malformed numbers are ignored, not trusted
        assert_eq!(Tally::default().update(&line("downloading NaN -5 NA NA x"), None).unwrap(), Progress { bytes: 0, total: None, eta: None });
    }

    #[test]
    fn yt_dlp_errors_become_user_messages() {
        assert!(user_error("ERROR: [generic] Unsupported URL: https://example.com").contains("ไม่พบวิดีโอในลิงก์นี้"));
        assert!(user_error("ERROR: [youtube] abc: Private video. Sign in if you've been granted access").contains("เข้าถึงวิดีโอไม่ได้"));
        assert!(user_error("ERROR: [youtube] abc: Sign in to confirm you’re not a bot").contains("บอท"));
        assert!(user_error("ERROR: unable to download video data: HTTP Error 404: Not Found").contains("ไม่พบวิดีโอ"));
        assert_eq!(user_error("WARNING: x\nERROR: [foo] 12: something new\n"), "ดาวน์โหลดจากลิงก์ไม่สำเร็จ ([foo] 12: something new) ลองกด “ลองอีกครั้ง” หรือดาวน์โหลดไฟล์มาอัปโหลดเอง");
        assert!(user_error("").starts_with("ดาวน์โหลดจากลิงก์ไม่สำเร็จ ลองกด"));
        assert_eq!(redact(&parse_url("https://x.com/v.mp4?token=secret").unwrap()), "https://x.com/v.mp4");
    }
}
