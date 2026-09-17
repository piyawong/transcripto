use axum::Json;
use axum::extract::State;
use axum_extra::extract::cookie::CookieJar;
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::AppState;
use crate::auth::{self, CurrentUser, User};
use crate::error::{AppError, AppResult};

pub async fn me(CurrentUser(u): CurrentUser) -> Json<Value> {
    Json(json!({ "user": u }))
}

#[derive(Deserialize)]
pub struct LoginReq {
    email: String,
    password: String,
    #[serde(default)]
    remember: bool,
}

pub async fn login(
    State(st): State<AppState>,
    jar: CookieJar,
    Json(req): Json<LoginReq>,
) -> AppResult<(CookieJar, Json<Value>)> {
    let email = req.email.trim().to_lowercase();
    let row: Option<(Uuid, Option<String>)> =
        sqlx::query_as("SELECT id, password_hash FROM users WHERE lower(email) = $1")
            .bind(&email)
            .fetch_optional(&st.db)
            .await?;
    let user_id = match row {
        Some((id, Some(hash))) if auth::verify_password(&req.password, &hash) => id,
        _ => return Err(AppError::BadRequest("อีเมลหรือรหัสผ่านไม่ถูกต้อง".into())),
    };
    let cookie = auth::start_session(&st, user_id, req.remember).await?;
    let user =
        sqlx::query_as::<_, User>("SELECT id, email, name, created_at FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_one(&st.db)
            .await?;
    Ok((jar.add(cookie), Json(json!({ "user": user }))))
}

pub async fn logout(
    State(st): State<AppState>,
    jar: CookieJar,
) -> AppResult<(CookieJar, Json<Value>)> {
    if let Some(c) = jar.get(auth::SESSION_COOKIE) {
        sqlx::query("DELETE FROM sessions WHERE token_hash = $1")
            .bind(auth::token_hash(c.value()))
            .execute(&st.db)
            .await?;
    }
    Ok((
        jar.add(auth::clear_cookie(&st)),
        Json(json!({ "ok": true })),
    ))
}
