use axum::Json;
use axum::extract::State;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::AppState;
use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::settings::{self, MAX_CHARS, MAX_TERMS};

async fn view(st: &AppState, user_id: uuid::Uuid) -> AppResult<Json<Value>> {
    let k = settings::keyterms(&st.db, &st.cfg.default_keyterms, user_id).await?;
    Ok(Json(json!({
        "terms": k.terms,
        "is_default": k.is_default,
        "updated_at": k.updated_at,
        "default_terms": st.cfg.default_keyterms,
        "max_terms": MAX_TERMS,
        "max_chars": MAX_CHARS,
    })))
}

pub async fn get_keyterms(
    State(st): State<AppState>,
    CurrentUser(u): CurrentUser,
) -> AppResult<Json<Value>> {
    view(&st, u.id).await
}

#[derive(Deserialize)]
pub struct KeytermsReq {
    terms: Vec<String>,
}

pub async fn reset_keyterms(
    State(st): State<AppState>,
    CurrentUser(u): CurrentUser,
) -> AppResult<Json<Value>> {
    settings::reset_keyterms(&st.db, u.id).await?;
    view(&st, u.id).await
}

/// Replaces the user's list. Applies to jobs created afterwards; existing jobs keep the terms they were created with.
pub async fn put_keyterms(
    State(st): State<AppState>,
    CurrentUser(u): CurrentUser,
    Json(req): Json<KeytermsReq>,
) -> AppResult<Json<Value>> {
    if req.terms.len() > MAX_TERMS * 4 {
        return Err(AppError::BadRequest(format!("ใส่คำได้ไม่เกิน {MAX_TERMS} คำ")));
    }
    let terms = settings::normalize(&req.terms).map_err(AppError::BadRequest)?;
    settings::save_keyterms(&st.db, u.id, &terms).await?;
    view(&st, u.id).await
}
