//! Per-user settings: the keyterms sent to ElevenLabs, which are also the glossary of the correction step.

use std::collections::HashSet;

use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

/// ElevenLabs limits (docs/rust-implementation/README.md section 1).
pub const MAX_TERMS: usize = 1000;
pub const MAX_CHARS: usize = 50;

/// Cleans a list typed by a user: trims and collapses spaces, drops blanks and repeats (ignoring letter case).
/// Terms that are too long, or too many terms, are an error with a message for the user; nothing is dropped silently.
pub fn normalize(terms: &[String]) -> Result<Vec<String>, String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for t in terms {
        let t = t.split_whitespace().collect::<Vec<_>>().join(" ");
        if !t.is_empty() && seen.insert(t.to_lowercase()) {
            out.push(t);
        }
    }
    let long: Vec<String> = out.iter().filter(|t| t.chars().count() > MAX_CHARS).map(|t| format!("“{t}”")).collect();
    if !long.is_empty() {
        let more = if long.len() > 3 { format!(" และอีก {} คำ", long.len() - 3) } else { String::new() };
        return Err(format!("คำต้องยาวไม่เกิน {MAX_CHARS} ตัวอักษร: {}{more}", long[..long.len().min(3)].join(", ")));
    }
    if out.len() > MAX_TERMS {
        return Err(format!("ใส่คำได้ไม่เกิน {MAX_TERMS} คำ (ตอนนี้ {} คำ)", out.len()));
    }
    Ok(out)
}

pub struct Keyterms {
    pub terms: Vec<String>,
    /// The user never saved their own list, so the defaults apply.
    pub is_default: bool,
    pub updated_at: Option<DateTime<Utc>>,
}

pub async fn keyterms(db: &PgPool, defaults: &[String], user_id: Uuid) -> sqlx::Result<Keyterms> {
    let row: Option<(Vec<String>, DateTime<Utc>)> =
        sqlx::query_as("SELECT keyterms, updated_at FROM user_settings WHERE user_id = $1").bind(user_id).fetch_optional(db).await?;
    Ok(match row {
        Some((terms, at)) => Keyterms { terms, is_default: false, updated_at: Some(at) },
        None => Keyterms { terms: defaults.to_vec(), is_default: true, updated_at: None },
    })
}

pub async fn save_keyterms(db: &PgPool, user_id: Uuid, terms: &[String]) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO user_settings (user_id, keyterms) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET keyterms = EXCLUDED.keyterms, updated_at = now()",
    )
    .bind(user_id)
    .bind(terms)
    .execute(db)
    .await?;
    Ok(())
}

/// Back to the defaults: the user follows api/keyterms.txt again, including later changes to it.
pub async fn reset_keyterms(db: &PgPool, user_id: Uuid) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM user_settings WHERE user_id = $1").bind(user_id).execute(db).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn cleans_and_dedupes() {
        assert_eq!(normalize(&s(&["  CP   ALL ", "", "cp all", "Lotus", "\tเจิ้งต้า\n", "Lotus"])).unwrap(), s(&["CP ALL", "Lotus", "เจิ้งต้า"]));
        assert_eq!(normalize(&[]).unwrap(), Vec::<String>::new());
    }

    #[test]
    fn rejects_long_terms_and_too_many() {
        let ok = "ก".repeat(50);
        assert_eq!(normalize(std::slice::from_ref(&ok)).unwrap(), vec![ok]);
        let err = normalize(&s(&["สั้น", &"ข".repeat(51)])).unwrap_err();
        assert!(err.starts_with("คำต้องยาวไม่เกิน 50 ตัวอักษร: “ขขข"), "{err}");
        let many: Vec<String> = (0..1001).map(|i| format!("term {i}")).collect();
        assert_eq!(normalize(&many).unwrap_err(), "ใส่คำได้ไม่เกิน 1000 คำ (ตอนนี้ 1001 คำ)");
        assert_eq!(normalize(&many[..1000]).unwrap().len(), 1000);
    }
}
