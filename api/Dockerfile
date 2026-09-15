FROM rust:1-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY migrations migrations
COPY keyterms.txt keyterms.txt
COPY src src
RUN cargo build --release --bin transcripto-api

FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/transcripto-api /usr/local/bin/transcripto-api
ENV BIND=0.0.0.0:8010 WORK_DIR=/tmp/transcripto-work
EXPOSE 8010
CMD ["transcripto-api"]
