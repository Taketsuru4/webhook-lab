CREATE TABLE IF NOT EXISTS labs (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  token TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every HTTP request is retained, including duplicate provider event IDs.
-- Base64 preserves the original bytes without assuming the body is UTF-8.
CREATE TABLE IF NOT EXISTS captured_requests (
  id UUID PRIMARY KEY,
  lab_id UUID NOT NULL REFERENCES labs(id),
  event_id TEXT,
  event_type TEXT NOT NULL,
  headers JSONB NOT NULL,
  raw_body_base64 TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS requests_lab_received_idx
  ON captured_requests (lab_id, received_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS requests_lab_event_idx
  ON captured_requests (lab_id, event_id);
