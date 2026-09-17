use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct Config {
    pub database_url: String,
    pub bind: String,
    /// Scratch space for files being processed; media is kept in object storage.
    pub work_dir: PathBuf,
    pub s3: S3Config,
    pub elevenlabs_api_key: Option<String>,
    pub gemini_api_key: Option<String>,
    pub correct_model: String,
    pub summary_model: String,
    /// Keyterms for users who never saved their own list (Settings page); jobs snapshot the list at creation.
    pub default_keyterms: Vec<String>,
    /// Test mode: replay docs/rust-implementation/fixtures instead of calling ElevenLabs and Gemini.
    pub fixture_dir: Option<PathBuf>,
    pub workers: usize,
    pub cookie_secure: bool,
    /// Password of the seeded admin account; required only when that account does not exist yet.
    pub admin_password: Option<String>,
    pub max_upload_bytes: u64,
    pub max_duration_sec: f64,
    /// yt-dlp, which downloads videos for jobs created from a link (it needs deno in PATH for YouTube).
    pub yt_dlp_bin: String,
    /// Lets links point at localhost and private networks. Only for local testing.
    pub url_import_allow_private: bool,
}

#[derive(Debug, Clone)]
pub struct S3Config {
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub access_key: String,
    pub secret_key: String,
}

fn var(k: &str) -> Option<String> {
    std::env::var(k).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

fn flag(k: &str, default: bool) -> bool {
    var(k).map(|v| matches!(v.as_str(), "1" | "true" | "yes" | "on")).unwrap_or(default)
}

pub const DEFAULT_MODEL: &str = "gemini-3.1-pro-preview";

impl Config {
    pub fn from_env() -> Self {
        // .env next to the binary's cwd, then the project-root files used by bench/ (never overrides real env).
        for f in [".env", "../.env", "../.env.test"] {
            let _ = dotenvy::from_filename(f);
        }
        let work_dir = var("WORK_DIR").map(PathBuf::from).unwrap_or_else(|| std::env::temp_dir().join("transcripto-work"));
        std::fs::create_dir_all(&work_dir).expect("create WORK_DIR");
        let keyterms_text = match var("KEYTERMS_FILE") {
            Some(path) => std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("reading KEYTERMS_FILE {path}: {e}")),
            None => include_str!("../keyterms.txt").to_string(),
        };
        Self {
            database_url: var("DATABASE_URL")
                .unwrap_or_else(|| "postgres://transcripto:transcripto@localhost:5440/transcripto".into()),
            bind: var("BIND").unwrap_or_else(|| "127.0.0.1:8010".into()),
            work_dir: work_dir.canonicalize().expect("canonicalize WORK_DIR"),
            s3: S3Config {
                endpoint: var("S3_ENDPOINT").unwrap_or_else(|| "http://127.0.0.1:9010".into()),
                region: var("S3_REGION").unwrap_or_else(|| "us-east-1".into()),
                bucket: var("S3_BUCKET").unwrap_or_else(|| "transcripto-media".into()),
                // Same development defaults as docker-compose.yml; set real credentials in production.
                access_key: var("S3_ACCESS_KEY").unwrap_or_else(|| "transcripto".into()),
                secret_key: var("S3_SECRET_KEY").unwrap_or_else(|| "transcripto-dev-secret".into()),
            },
            elevenlabs_api_key: var("ELEVENLABS_API_KEY"),
            gemini_api_key: var("GEMINI_API_KEY").or_else(|| var("GOOGLE_API_KEY")),
            correct_model: var("CORRECT_MODEL").unwrap_or_else(|| DEFAULT_MODEL.into()),
            summary_model: var("SUMMARY_MODEL").unwrap_or_else(|| DEFAULT_MODEL.into()),
            default_keyterms: crate::elevenlabs::keyterms(&keyterms_text),
            fixture_dir: var("AI_FIXTURE_DIR").map(PathBuf::from),
            workers: var("WORKERS").and_then(|v| v.parse().ok()).unwrap_or(2),
            cookie_secure: flag("COOKIE_SECURE", false),
            admin_password: var("ADMIN_PASSWORD"),
            max_upload_bytes: var("MAX_UPLOAD_BYTES").and_then(|v| v.parse().ok()).unwrap_or(2 * 1024 * 1024 * 1024),
            max_duration_sec: var("MAX_DURATION_SEC").and_then(|v| v.parse().ok()).unwrap_or(5.0 * 3600.0),
            yt_dlp_bin: var("YT_DLP_BIN").unwrap_or_else(|| "yt-dlp".into()),
            url_import_allow_private: flag("URL_IMPORT_ALLOW_PRIVATE", false),
        }
    }

    /// Local scratch directory of a job (deleted when the worker finishes with it).
    pub fn work_dir(&self, id: uuid::Uuid) -> PathBuf {
        self.work_dir.join(id.to_string())
    }
}
