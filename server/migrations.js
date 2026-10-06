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
