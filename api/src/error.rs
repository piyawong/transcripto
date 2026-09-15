use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;

/// API error; the message is shown to the user as-is, so keep it in Thai.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    BadRequest(String),
    #[error("กรุณาเข้าสู่ระบบ")]
    Unauthorized,
    #[error("{0}")]
    Forbidden(String),
    #[error("ไม่พบข้อมูลที่ต้องการ")]
    NotFound,
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    TooLarge(String),
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        match e {
            sqlx::Error::RowNotFound => AppError::NotFound,
            other => AppError::Internal(other.into()),
        }
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Internal(e.into())
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = match &self {
            AppError::BadRequest(_) => StatusCode::BAD_REQUEST,
            AppError::Unauthorized => StatusCode::UNAUTHORIZED,
            AppError::Forbidden(_) => StatusCode::FORBIDDEN,
            AppError::NotFound => StatusCode::NOT_FOUND,
            AppError::Conflict(_) => StatusCode::CONFLICT,
            AppError::TooLarge(_) => StatusCode::PAYLOAD_TOO_LARGE,
            AppError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };
        let message = match &self {
            AppError::Internal(e) => {
                tracing::error!("internal error: {e:#}");
                "เกิดข้อผิดพลาดในระบบ ลองใหม่อีกครั้ง".to_string()
            }
            other => other.to_string(),
        };
        (status, Json(json!({ "error": message }))).into_response()
    }
}

pub type AppResult<T> = Result<T, AppError>;
