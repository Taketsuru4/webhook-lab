import { readFile } from 'node:fs/promises';
import { describeBody } from './capture.js';

const migrations = [
  {
    version: 1,
    name: 'initial_capture_schema',
    async up(tx) {
      const sql = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
      for (const statement of sql.split(';').filter((part) => part.trim())) {
        await tx.query(statement);
      }
    },
  },
  {
    version: 2,
    name: 'complete_event_identity',
    async up(tx) {
      await tx.query('DROP INDEX IF EXISTS requests_lab_event_idx');
      let cursor = null;
      while (true) {
        const { rows } = await tx.query(
          `SELECT id, raw_body_base64 FROM captured_requests
           WHERE ($1::uuid IS NULL OR id > $1::uuid) ORDER BY id LIMIT 200`,
          [cursor],
        );
        if (!rows.length) break;
        for (const row of rows) {
          const metadata = describeBody(Buffer.from(row.raw_body_base64, 'base64'));
          await tx.query(
            'UPDATE captured_requests SET event_id = $2, event_type = $3 WHERE id = $1',
            [row.id, metadata.eventId, metadata.eventType],
          );
        }
        cursor = rows.at(-1).id;
      }
      // The digest only narrows candidates; queries also compare the full ID.
      await tx.query(
        'CREATE INDEX requests_lab_event_hash_idx ON captured_requests (lab_id, md5(event_id))',
      );
    },
  },
  {
    version: 3,
    name: 'local_replay_and_mock_receiver',
    async up(tx) {
      await tx.query(`CREATE TABLE mock_receivers (
        lab_id UUID PRIMARY KEY REFERENCES labs(id) ON DELETE CASCADE,
        fail_first INTEGER NOT NULL DEFAULT 0 CHECK (fail_first BETWEEN 0 AND 10),
        delay_ms INTEGER NOT NULL DEFAULT 0 CHECK (delay_ms BETWEEN 0 AND 5000),
        received_count INTEGER NOT NULL DEFAULT 0 CHECK (received_count >= 0)
      )`);
      await tx.query(`CREATE TABLE replay_runs (
        id UUID PRIMARY KEY, lab_id UUID NOT NULL REFERENCES labs(id) ON DELETE CASCADE,
        capture_id UUID NOT NULL REFERENCES captured_requests(id) ON DELETE CASCADE,
        state TEXT NOT NULL DEFAULT 'running' CHECK (state IN ('running','succeeded','failed','timeout','interrupted')),
        timeout_ms INTEGER NOT NULL CHECK (timeout_ms BETWEEN 100 AND 10000),
        started_at TIMESTAMPTZ NOT NULL DEFAULT now(), finished_at TIMESTAMPTZ,
        duration_ms INTEGER, http_status INTEGER, response_body_base64 TEXT NOT NULL DEFAULT '',
        response_content_type TEXT, response_truncated BOOLEAN NOT NULL DEFAULT false, error TEXT
      )`);
      await tx.query(
        'CREATE INDEX replays_capture_time_idx ON replay_runs (lab_id, capture_id, started_at DESC, id DESC)',
      );
      await tx.query(
        "CREATE INDEX replays_running_idx ON replay_runs (lab_id, started_at) WHERE state = 'running'",
      );
      await tx.query(`CREATE TABLE mock_receipts (
        id UUID PRIMARY KEY, lab_id UUID NOT NULL REFERENCES labs(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL, raw_body_base64 TEXT NOT NULL, size_bytes INTEGER NOT NULL,
        content_type TEXT, http_status INTEGER NOT NULL,
        received_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
      await tx.query('CREATE INDEX receipts_lab_run_idx ON mock_receipts (lab_id, run_id)');
    },
  },
  {
    version: 4,
    name: 'transactional_receiver_idempotency',
    async up(tx) {
      await tx.query(
        'ALTER TABLE mock_receivers ADD COLUMN idempotency_enabled BOOLEAN NOT NULL DEFAULT false',
      );
      await tx.query("ALTER TABLE mock_receipts ADD COLUMN outcome TEXT NOT NULL DEFAULT 'legacy'");
      await tx.query('ALTER TABLE mock_receipts ADD COLUMN event_id TEXT');
      await tx.query('ALTER TABLE mock_receipts ADD COLUMN effect_id UUID');
      await tx.query(`CREATE TABLE mock_effects (
        id UUID PRIMARY KEY, lab_id UUID NOT NULL REFERENCES labs(id) ON DELETE CASCADE,
        first_receipt_id UUID NOT NULL REFERENCES mock_receipts(id) ON DELETE CASCADE,
        event_id TEXT, key_hash TEXT, body_hash TEXT NOT NULL,
        processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (lab_id, key_hash)
      )`);
      // PostgreSQL permits multiple NULL keys for intentionally unguarded demo actions.
      await tx.query(
        'CREATE INDEX effects_lab_time_idx ON mock_effects (lab_id, processed_at DESC)',
      );
    },
  },
  {
    version: 5,
    name: 'durable_local_delivery_jobs',
    async up(tx) {
      await tx.query(`CREATE TABLE delivery_jobs (
        id UUID PRIMARY KEY, lab_id UUID NOT NULL REFERENCES labs(id) ON DELETE CASCADE,
        capture_id UUID NOT NULL REFERENCES captured_requests(id) ON DELETE CASCADE,
        state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','waiting_retry','succeeded','failed','cancelled')),
        max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 5),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        timeout_ms INTEGER NOT NULL CHECK (timeout_ms BETWEEN 100 AND 10000),
        retry_delay_ms INTEGER NOT NULL CHECK (retry_delay_ms BETWEEN 250 AND 5000),
        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(), lease_started_at TIMESTAMPTZ,
        cancel_requested BOOLEAN NOT NULL DEFAULT false, last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), finished_at TIMESTAMPTZ
      )`);
      await tx.query(
        "CREATE UNIQUE INDEX one_active_job_per_lab_idx ON delivery_jobs (lab_id) WHERE state IN ('queued','running','waiting_retry')",
      );
      await tx.query(
        "CREATE INDEX jobs_due_idx ON delivery_jobs (next_attempt_at, id) WHERE state IN ('queued','waiting_retry')",
      );
      await tx.query(
        'CREATE INDEX jobs_capture_time_idx ON delivery_jobs (lab_id, capture_id, created_at DESC, id DESC)',
      );
      await tx.query(
        'ALTER TABLE replay_runs ADD COLUMN delivery_job_id UUID REFERENCES delivery_jobs(id) ON DELETE CASCADE',
      );
      await tx.query('ALTER TABLE replay_runs ADD COLUMN attempt_number INTEGER');
      await tx.query(
        'CREATE UNIQUE INDEX attempts_job_number_idx ON replay_runs (delivery_job_id, attempt_number)',
      );
    },
  },
];

export async function runMigrations(database) {
  await database.transaction(async (tx) => {
    // Serialize startup migrations across PostgreSQL application processes.
    await tx.query('SELECT pg_advisory_xact_lock(7404310)');
    await tx.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const { rows } = await tx.query('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map((row) => row.version));
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      await migration.up(tx);
      await tx.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [
        migration.version,
        migration.name,
      ]);
    }
  });
}
