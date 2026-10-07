import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { it } from 'node:test';
import { openDatabase } from '../server/database.js';
import { runMigrations } from '../server/migrations.js';

it('upgrades an existing capture database and restores full identities without losing bodies', async () => {
  const database = await openDatabase({
    url: process.env.TEST_DATABASE_URL || null,
    dataDir: ':memory:',
  });
  const schema = `upgrade_${randomUUID().replaceAll('-', '')}`;
  const labId = randomUUID();
  const prefix = 'a'.repeat(200);
  try {
    await database.transaction(async (tx) => {
      await tx.query(`CREATE SCHEMA ${schema}`);
      await tx.query(`SET LOCAL search_path TO ${schema}`);
      const sql = await readFile(new URL('../server/schema.sql', import.meta.url), 'utf8');
      for (const statement of sql.split(';').filter((part) => part.trim()))
        await tx.query(statement);
      await tx.query('INSERT INTO labs (id, name, token) VALUES ($1, $2, $3)', [
        labId,
        'Legacy',
        'legacy',
      ]);
      for (const suffix of ['1', '2']) {
        const body = JSON.stringify({ id: `${prefix}${suffix}`, type: 'exact.event' });
        await tx.query(
          `INSERT INTO captured_requests
          (id, lab_id, event_id, event_type, headers, raw_body_base64, content_type, size_bytes)
          VALUES ($1, $2, $3, 'old.type', '{}'::jsonb, $4, 'application/json', $5)`,
          [
            randomUUID(),
            labId,
            prefix,
            Buffer.from(body).toString('base64'),
            Buffer.byteLength(body),
          ],
        );
      }
      const scopedDatabase = { transaction: (callback) => callback(tx) };
      await runMigrations(scopedDatabase);
      await runMigrations(scopedDatabase);
      const { rows } = await tx.query('SELECT * FROM captured_requests ORDER BY event_id');
      assert.deepEqual(
        rows.map((row) => row.event_id),
        [`${prefix}1`, `${prefix}2`],
      );
      assert.ok(rows.every((row) => row.event_type === 'exact.event'));
      for (const row of rows) {
        assert.deepEqual(JSON.parse(Buffer.from(row.raw_body_base64, 'base64').toString()), {
          id: row.event_id,
          type: 'exact.event',
        });
      }
      assert.equal(
        (await tx.query('SELECT count(*)::int AS count FROM schema_migrations')).rows[0].count,
        5,
      );
      await tx.query(`DROP SCHEMA ${schema} CASCADE`);
    });
  } finally {
    await database.close();
  }
});
