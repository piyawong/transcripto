FROM rust:1-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
# Dependencies in their own layer: a code change rebuilds only this crate (about a minute instead of ten).
RUN mkdir src && echo "fn main() {}" > src/main.rs && touch src/lib.rs \
 && cargo build --release --bin transcripto-api && rm -rf src
COPY migrations migrations
COPY keyterms.txt keyterms.txt
COPY src src
# COPY keeps the files' old mtimes, which can look older than the placeholder build.
RUN touch src/main.rs src/lib.rs && cargo build --release --bin transcripto-api

# yt-dlp (jobs created from a link) and deno, which yt-dlp needs for YouTube. Pinned with checksums; to update, change the
# versions and take the sums from the releases' SHA2-256SUMS / .sha256sum files.
FROM debian:bookworm-slim AS tools
ARG TARGETARCH
ARG YT_DLP_VERSION=2026.08.19
ARG DENO_VERSION=2.9.6
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip && rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
      amd64) ytdlp=yt-dlp_linux; ytdlp_sum=58162f9bfdc27458ea47bfcb311cf47028f17d8154a8bf7d689861d46399230a; \
             deno=deno-x86_64-unknown-linux-gnu.zip; deno_sum=394f07f4da2bebe6ce6f1e7ce0fa16429b29b08c35e3fac3fe25972676dff4b2 ;; \
      arm64) ytdlp=yt-dlp_linux_aarch64; ytdlp_sum=b16e4dab368a816cd05d477d698a605a6ae87ccee1c8ffd38fa21d7254141fcc; \
             deno=deno-aarch64-unknown-linux-gnu.zip; deno_sum=9a46afc6c392c7cd2ff71a31558935545b46408d0e87f7a86908c712721c046e ;; \
      *) echo "unsupported architecture ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /usr/local/bin/yt-dlp "https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/${ytdlp}"; \
    echo "${ytdlp_sum}  /usr/local/bin/yt-dlp" | sha256sum -c -; \
    curl -fsSL -o /tmp/deno.zip "https://github.com/denoland/deno/releases/download/v${DENO_VERSION}/${deno}"; \
    echo "${deno_sum}  /tmp/deno.zip" | sha256sum -c -; \
    unzip /tmp/deno.zip -d /usr/local/bin; \
    chmod +x /usr/local/bin/yt-dlp /usr/local/bin/deno

FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=tools /usr/local/bin/yt-dlp /usr/local/bin/deno /usr/local/bin/
COPY --from=build /src/target/release/transcripto-api /usr/local/bin/transcripto-api
RUN yt-dlp --version && deno --version
ENV BIND=0.0.0.0:8010 WORK_DIR=/tmp/transcripto-work
EXPOSE 8010
CMD ["transcripto-api"]
