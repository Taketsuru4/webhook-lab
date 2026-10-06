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
