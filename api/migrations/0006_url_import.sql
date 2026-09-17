-- Jobs created from a link: the worker downloads the video (yt-dlp) before the usual steps.
-- `downloading` stays true until the file is in object storage; the job is 'processing' meanwhile.
ALTER TABLE jobs ADD COLUMN source_url text;
ALTER TABLE jobs ADD COLUMN downloading boolean NOT NULL DEFAULT false;
