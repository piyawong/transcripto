CREATE TABLE users (
    id            uuid PRIMARY KEY,
    email         text NOT NULL UNIQUE,
    name          text NOT NULL,
    password_hash text,
    google_sub    text UNIQUE,
    quota_minutes integer NOT NULL DEFAULT 600,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
    token_hash text PRIMARY KEY,
    user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE password_resets (
    token_hash text PRIMARY KEY,
    user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    used_at    timestamptz
);

-- stage: 0 แยกเสียงจากวิดีโอ, 1 ถอดความและแยกผู้พูด, 2 สรุปการประชุม (upload happens before stage 0)
CREATE TABLE jobs (
    id              uuid PRIMARY KEY,
    user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name            text NOT NULL,
    size_bytes      bigint NOT NULL,
    source_ext      text NOT NULL,
    lang            text NOT NULL,
    speaker_hint    integer,
    status          text NOT NULL CHECK (status IN ('uploading', 'processing', 'done', 'failed')),
    stage           integer NOT NULL DEFAULT 0,
    stage_pct       real NOT NULL DEFAULT 0,
    eta_sec         double precision,
    error           text,
    duration_sec    double precision,
    has_video       boolean,
    has_thumb       boolean NOT NULL DEFAULT false,
    speakers        jsonb NOT NULL DEFAULT '[]',
    transcript_meta jsonb,
    summary_status  text NOT NULL DEFAULT 'waiting' CHECK (summary_status IN ('waiting', 'pending', 'running', 'done', 'failed')),
    summary         jsonb,
    summary_text    text,
    summary_meta    jsonb,
    summary_error   text,
    locked_by       text,
    locked_at       timestamptz,
    attempts        integer NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    finished_at     timestamptz
);
CREATE INDEX jobs_user_created ON jobs (user_id, created_at DESC);
CREATE INDEX jobs_queue ON jobs (created_at) WHERE status = 'processing' OR summary_status = 'pending';

CREATE TABLE segments (
    job_id    uuid NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
    idx       integer NOT NULL,
    start_sec double precision NOT NULL,
    end_sec   double precision NOT NULL,
    speaker   integer NOT NULL,
    text      text NOT NULL,
    PRIMARY KEY (job_id, idx)
);
