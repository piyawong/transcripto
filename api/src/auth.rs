//! Password hashing, cookie sessions, and the `CurrentUser` extractor.

use argon2::password_hash::phc::PasswordHash;
use argon2::password_hash::{PasswordHasher, PasswordVerifier};
use argon2::Argon2;
use axum::extract::{FromRef, FromRequestParts};
use axum::http::request::Parts;
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use base64::Engine;
use chrono::{DateTime, Duration, Utc};
use serde::Serialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::AppState;
use crate::error::{AppError, AppResult};

pub const SESSION_COOKIE: &str = "tp_session";

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct User {
    pub id: Uuid,
    pub email: String,
    pub name: String,
    pub created_at: DateTime<Utc>,
}

pub fn hash_password(pw: &str) -> anyhow::Result<String> {
    Argon2::default()
        .hash_password_with_salt(pw.as_bytes(), Uuid::new_v4().as_bytes())
        .map(|h| h.to_string())
        .map_err(|e| anyhow::anyhow!("hash: {e}"))
}

pub fn verify_password(pw: &str, hash: &str) -> bool {
    PasswordHash::new(hash).map(|h| Argon2::default().verify_password(pw.as_bytes(), &h).is_ok()).unwrap_or(false)
}

/// 244 bits of randomness from the OS RNG, URL-safe.
pub fn random_token() -> String {
    let mut bytes = Vec::with_capacity(32);
    bytes.extend_from_slice(Uuid::new_v4().as_bytes());
    bytes.extend_from_slice(Uuid::new_v4().as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

pub fn token_hash(token: &str) -> String {
    Sha256::digest(token.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// Creates a session row and returns the cookie to set.
pub async fn start_session(st: &AppState, user_id: Uuid, remember: bool) -> AppResult<Cookie<'static>> {
    let token = random_token();
    let ttl = if remember { Duration::days(30) } else { Duration::hours(12) };
    sqlx::query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)")
        .bind(token_hash(&token))
        .bind(user_id)
        .bind(Utc::now() + ttl)
        .execute(&st.db)
        .await?;
    let mut c = Cookie::build((SESSION_COOKIE, token))
        .path("/")
        .http_only(true)
        .same_site(SameSite::Lax)
        .secure(st.cfg.cookie_secure);
    if remember {
        c = c.max_age(cookie_time(ttl));
    }
    Ok(c.build())
}

fn cookie_time(d: Duration) -> cookie::time::Duration {
    cookie::time::Duration::seconds(d.num_seconds())
}

pub fn clear_cookie(st: &AppState) -> Cookie<'static> {
    Cookie::build((SESSION_COOKIE, ""))
        .path("/")
        .http_only(true)
        .same_site(SameSite::Lax)
        .secure(st.cfg.cookie_secure)
        .max_age(cookie::time::Duration::ZERO)
        .build()
}

pub struct CurrentUser(pub User);

impl<S> FromRequestParts<S> for CurrentUser
where
    AppState: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let st = AppState::from_ref(state);
        let jar = CookieJar::from_headers(&parts.headers);
        let token = jar.get(SESSION_COOKIE).map(|c| c.value().to_string()).ok_or(AppError::Unauthorized)?;
        let user = sqlx::query_as::<_, User>(
            "SELECT u.id, u.email, u.name, u.created_at
             FROM sessions s JOIN users u ON u.id = s.user_id
             WHERE s.token_hash = $1 AND s.expires_at > now()",
        )
        .bind(token_hash(&token))
        .fetch_optional(&st.db)
        .await?
        .ok_or(AppError::Unauthorized)?;
        Ok(CurrentUser(user))
    }
}

/// The only account for now (no signup). Its password comes from ADMIN_PASSWORD and is used only when the account is created.
pub const ADMIN_EMAIL: &str = "admin@transcripto.app";
const ADMIN_NAME: &str = "ผู้ดูแลระบบ";

pub async fn seed_admin(st: &AppState) -> anyhow::Result<()> {
    let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM users WHERE email = $1)").bind(ADMIN_EMAIL).fetch_one(&st.db).await?;
    if exists {
        return Ok(());
    }
    let Some(password) = &st.cfg.admin_password else {
        anyhow::bail!("ADMIN_PASSWORD is required to create the admin account {ADMIN_EMAIL} (set it in .env)");
    };
    let r = sqlx::query("INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, $4) ON CONFLICT (email) DO NOTHING")
        .bind(Uuid::new_v4())
        .bind(ADMIN_EMAIL)
        .bind(ADMIN_NAME)
        .bind(hash_password(password)?)
        .execute(&st.db)
        .await?;
    if r.rows_affected() > 0 {
        tracing::info!("seeded admin user {ADMIN_EMAIL}");
    }
    Ok(())
}
