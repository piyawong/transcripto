pub mod auth;
pub mod jobs;
pub mod settings;

use axum::Router;
use axum::extract::DefaultBodyLimit;
use axum::routing::{get, patch, post, put};
use serde_json::json;
use tower_http::trace::TraceLayer;

use crate::AppState;

pub fn router(st: AppState) -> Router {
    let upload_limit = st.cfg.max_upload_bytes as usize + 1024 * 1024;
    Router::new()
        .route("/api/health", get(|| async { axum::Json(json!({ "ok": true })) }))
        .route("/api/auth/me", get(auth::me))
        .route("/api/auth/login", post(auth::login))
        .route("/api/auth/logout", post(auth::logout))
        .route("/api/settings/keyterms", get(settings::get_keyterms).put(settings::put_keyterms).delete(settings::reset_keyterms))
        .route("/api/jobs", get(jobs::list).post(jobs::create))
        .route("/api/jobs/search", get(jobs::search))
        .route("/api/jobs/{id}", get(jobs::detail).delete(jobs::delete))
        .route("/api/jobs/{id}/file", put(jobs::upload).layer(DefaultBodyLimit::max(upload_limit)))
        .route("/api/jobs/{id}/retry", post(jobs::retry))
        .route("/api/jobs/{id}/summary/retry", post(jobs::retry_summary))
        .route("/api/jobs/{id}/summary.txt", get(jobs::summary_txt))
        .route("/api/jobs/{id}/changes.txt", get(jobs::changes_txt))
        .route("/api/jobs/{id}/speakers/{idx}", patch(jobs::rename_speaker))
        .route("/api/jobs/{id}/segments/{idx}", patch(jobs::edit_segment))
        .route("/api/jobs/{id}/media", get(jobs::media))
        .route("/api/jobs/{id}/audio", get(jobs::audio))
        .route("/api/jobs/{id}/thumbnail", get(jobs::thumbnail))
        .layer(TraceLayer::new_for_http())
        .with_state(st)
}
