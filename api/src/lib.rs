pub mod auth;
pub mod config;
pub mod correct;
pub mod elevenlabs;
pub mod error;
pub mod gemini;
pub mod jobs;
pub mod lines;
pub mod media;
pub mod minutes;
pub mod pipeline;
pub mod routes;
pub mod settings;
pub mod storage;
pub mod transcript;
pub mod worker;

/// The golden fixtures contain a real meeting, so they stay out of the public repository;
/// tests that need them return early when docs/rust-implementation/fixtures is absent.
#[cfg(test)]
pub(crate) mod testdata {
    pub const DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../docs/rust-implementation/fixtures/");

    pub fn missing() -> bool {
        let missing = !std::path::Path::new(DIR).join("elevenlabs-response.json").exists();
        if missing {
            eprintln!("skipped: golden fixtures not found in {DIR}");
        }
        missing
    }
}

use std::sync::Arc;

use config::Config;
use sqlx::PgPool;
use storage::Storage;

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub cfg: Arc<Config>,
    pub storage: Storage,
}
