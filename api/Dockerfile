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

FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/transcripto-api /usr/local/bin/transcripto-api
ENV BIND=0.0.0.0:8010 WORK_DIR=/tmp/transcripto-work
EXPOSE 8010
CMD ["transcripto-api"]
