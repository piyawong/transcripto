use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use sqlx::postgres::PgPoolOptions;
use transcripto_api::config::Config;
use transcripto_api::pipeline::Ai;
use transcripto_api::storage::Storage;
use transcripto_api::{AppState, auth, routes, worker};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("LOG_LEVEL")
                .unwrap_or_else(|_| "info,sqlx=warn,tower_http=info".into()),
        )
        .init();
    let cfg = Config::from_env();

    let db = PgPoolOptions::new()
        .max_connections(20)
        .connect(&cfg.database_url)
        .await
        .with_context(|| "connecting to Postgres (docker compose -p transcripto up -d db)")?;
    sqlx::migrate!().run(&db).await.context("running migrations")?;

    let ai = Ai::from_config(&cfg)?;

    let storage = Storage::new(&cfg.s3);
    let mut tries = 0;
    while let Err(e) = storage.ensure_bucket().await {
        tries += 1;
        if tries >= 15 {
            return Err(e.context(format!("object storage at {} (docker compose -p transcripto up -d minio)", cfg.s3.endpoint)));
        }
        tracing::warn!("waiting for object storage: {e:#}");
        tokio::time::sleep(Duration::from_secs(2)).await;
    }

    // Scratch files of jobs interrupted by a restart; the worker downloads what it needs again.
    if let Ok(mut entries) = tokio::fs::read_dir(&cfg.work_dir).await {
        while let Ok(Some(e)) = entries.next_entry().await {
            let _ = tokio::fs::remove_dir_all(e.path()).await;
        }
    }

    let st = AppState { db, cfg: Arc::new(cfg), storage };
    auth::seed_admin(&st).await?;
    worker::spawn(st.clone(), ai);

    let listener = tokio::net::TcpListener::bind(&st.cfg.bind).await?;
    tracing::info!("api listening on http://{}", st.cfg.bind);
    axum::serve(listener, routes::router(st)).with_graceful_shutdown(async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await?;
    Ok(())
}
