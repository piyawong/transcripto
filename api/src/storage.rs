//! Media in S3-compatible object storage (MinIO in docker-compose.yml), under `jobs/<id>/`:
//! `source.<ext>` (the upload), `audio.wav`, `thumb.jpg` and `stt.json` (raw ElevenLabs response).

use std::path::Path;

use anyhow::{Context, Result, anyhow};
use aws_sdk_s3::Client;
use aws_sdk_s3::config::{BehaviorVersion, Credentials, Region, RequestChecksumCalculation, ResponseChecksumValidation};
use aws_sdk_s3::error::{ProvideErrorMetadata, SdkError};
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::types::{Delete, ObjectIdentifier};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

use crate::config::S3Config;

pub const SOURCE: &str = "source";
pub const AUDIO: &str = "audio.wav";
pub const THUMB: &str = "thumb.jpg";
pub const STT: &str = "stt.json";

#[derive(Clone)]
pub struct Storage {
    client: Client,
    bucket: String,
}

/// A (possibly partial) object being streamed to a client.
pub struct Fetched {
    pub body: ByteStream,
    pub len: u64,
    /// `bytes a-b/total` when a range was served.
    pub content_range: Option<String>,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
}

pub enum Get {
    Found(Fetched),
    NotFound,
    /// The requested range is outside the object; `total` is its size.
    BadRange { total: Option<u64> },
}

pub fn key(job: Uuid, name: &str) -> String {
    format!("jobs/{job}/{name}")
}

pub fn source_key(job: Uuid, ext: &str) -> String {
    key(job, &format!("{SOURCE}.{ext}"))
}

fn status<E>(e: &SdkError<E>) -> Option<u16> {
    e.raw_response().map(|r| r.status().as_u16())
}

impl Storage {
    pub fn new(cfg: &S3Config) -> Self {
        let conf = aws_sdk_s3::Config::builder()
            .behavior_version(BehaviorVersion::latest())
            .endpoint_url(&cfg.endpoint)
            .region(Region::new(cfg.region.clone()))
            .credentials_provider(Credentials::new(&cfg.access_key, &cfg.secret_key, None, None, "transcripto"))
            // MinIO serves buckets by path (http://host:9000/bucket/key), not as subdomains.
            .force_path_style(true)
            // Checksums only where S3 requires them: ranged downloads can't be validated against a whole-object checksum.
            .request_checksum_calculation(RequestChecksumCalculation::WhenRequired)
            .response_checksum_validation(ResponseChecksumValidation::WhenRequired)
            .build();
        Self { client: Client::from_conf(conf), bucket: cfg.bucket.clone() }
    }

    pub async fn ensure_bucket(&self) -> Result<()> {
        if self.client.head_bucket().bucket(&self.bucket).send().await.is_ok() {
            return Ok(());
        }
        match self.client.create_bucket().bucket(&self.bucket).send().await {
            Ok(_) => {
                tracing::info!("created bucket {}", self.bucket);
                Ok(())
            }
            Err(e) if matches!(e.code(), Some("BucketAlreadyOwnedByYou" | "BucketAlreadyExists")) => Ok(()),
            Err(e) => Err(anyhow!("object storage: cannot create bucket {}: {}", self.bucket, e.message().unwrap_or(&format!("{e:?}")))),
        }
    }

    pub async fn put_file(&self, key: &str, path: &Path, content_type: &str) -> Result<()> {
        let body = ByteStream::from_path(path).await.with_context(|| format!("reading {}", path.display()))?;
        self.client
            .put_object()
            .bucket(&self.bucket)
            .key(key)
            .content_type(content_type)
            .body(body)
            .send()
            .await
            .map_err(|e| anyhow!("object storage: upload {key}: {}", e.message().map(str::to_string).unwrap_or_else(|| format!("{e:?}"))))?;
        Ok(())
    }

    pub async fn put_bytes(&self, key: &str, bytes: Vec<u8>, content_type: &str) -> Result<()> {
        self.client
            .put_object()
            .bucket(&self.bucket)
            .key(key)
            .content_type(content_type)
            .body(ByteStream::from(bytes))
            .send()
            .await
            .map_err(|e| anyhow!("object storage: upload {key}: {}", e.message().map(str::to_string).unwrap_or_else(|| format!("{e:?}"))))?;
        Ok(())
    }

    pub async fn exists(&self, key: &str) -> Result<bool> {
        match self.client.head_object().bucket(&self.bucket).key(key).send().await {
            Ok(_) => Ok(true),
            Err(e) if status(&e) == Some(404) => Ok(false),
            Err(e) => Err(anyhow!("object storage: head {key}: {e:?}")),
        }
    }

    /// Whole object in memory (only for small objects such as stt.json); None when it does not exist.
    pub async fn get_bytes(&self, key: &str) -> Result<Option<Vec<u8>>> {
        match self.client.get_object().bucket(&self.bucket).key(key).send().await {
            Ok(o) => Ok(Some(o.body.collect().await.context("reading object")?.into_bytes().to_vec())),
            Err(e) if status(&e) == Some(404) => Ok(None),
            Err(e) => Err(anyhow!("object storage: get {key}: {e:?}")),
        }
    }

    /// Streams an object to a local file (via a temporary name). Returns false when the object does not exist.
    pub async fn download(&self, key: &str, dest: &Path) -> Result<bool> {
        let o = match self.client.get_object().bucket(&self.bucket).key(key).send().await {
            Ok(o) => o,
            Err(e) if status(&e) == Some(404) => return Ok(false),
            Err(e) => return Err(anyhow!("object storage: get {key}: {e:?}")),
        };
        let tmp = dest.with_extension("download");
        let mut file = tokio::fs::File::create(&tmp).await?;
        let mut reader = o.body.into_async_read();
        tokio::io::copy_buf(&mut reader, &mut file).await.with_context(|| format!("downloading {key}"))?;
        file.flush().await?;
        drop(file);
        tokio::fs::rename(&tmp, dest).await?;
        Ok(true)
    }

    /// `range` is an HTTP Range header value (a single `bytes=` range), passed through to the store.
    pub async fn get(&self, key: &str, range: Option<&str>) -> Result<Get> {
        let mut req = self.client.get_object().bucket(&self.bucket).key(key);
        if let Some(r) = range {
            req = req.range(r);
        }
        match req.send().await {
            Ok(o) => Ok(Get::Found(Fetched {
                len: o.content_length.unwrap_or(0).max(0) as u64,
                content_range: o.content_range.clone(),
                etag: o.e_tag.clone(),
                last_modified: o.last_modified.and_then(|t| t.fmt(aws_sdk_s3::primitives::DateTimeFormat::HttpDate).ok()),
                body: o.body,
            })),
            Err(e) if status(&e) == Some(404) => Ok(Get::NotFound),
            Err(e) if status(&e) == Some(416) => {
                let total = self.client.head_object().bucket(&self.bucket).key(key).send().await.ok().and_then(|h| h.content_length).map(|n| n.max(0) as u64);
                Ok(Get::BadRange { total })
            }
            Err(e) => Err(anyhow!("object storage: get {key}: {e:?}")),
        }
    }

    /// Deletes every object under `prefix` (e.g. "jobs/<id>/").
    pub async fn delete_prefix(&self, prefix: &str) -> Result<()> {
        let mut token: Option<String> = None;
        loop {
            let page = self
                .client
                .list_objects_v2()
                .bucket(&self.bucket)
                .prefix(prefix)
                .set_continuation_token(token.clone())
                .send()
                .await
                .map_err(|e| anyhow!("object storage: list {prefix}: {e:?}"))?;
            let ids: Vec<ObjectIdentifier> =
                page.contents().iter().filter_map(|o| o.key()).filter_map(|k| ObjectIdentifier::builder().key(k).build().ok()).collect();
            if !ids.is_empty() {
                let delete = Delete::builder().set_objects(Some(ids)).quiet(true).build()?;
                self.client
                    .delete_objects()
                    .bucket(&self.bucket)
                    .delete(delete)
                    .send()
                    .await
                    .map_err(|e| anyhow!("object storage: delete {prefix}: {e:?}"))?;
            }
            match page.next_continuation_token() {
                Some(t) if page.is_truncated() == Some(true) => token = Some(t.to_string()),
                _ => return Ok(()),
            }
        }
    }
}

/// Content type for an uploaded file by extension (what browsers need to pick a player).
pub fn content_type(ext: &str) -> &'static str {
    match ext {
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "webm" => "video/webm",
        "avi" => "video/x-msvideo",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "wav" => "audio/wav",
        "aac" => "audio/aac",
        "ogg" => "audio/ogg",
        "flac" => "audio/flac",
        _ => "application/octet-stream",
    }
}
