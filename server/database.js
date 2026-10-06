import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { runMigrations } from './migrations.js';

export async function openDatabase({
  url = process.env.DATABASE_URL,
  dataDir = process.env.DATA_DIR || '.data/postgres',
} = {}) {
  let database;
  if (url) {
    const pool = new pg.Pool({ connectionString: url, max: 5 });
    database = {
      mode: 'postgres',
      query: (sql, params = []) => pool.query(sql, params),
      async transaction(callback) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await callback({ query: (sql, params = []) => client.query(sql, params) });
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    };
  } else {
    if (dataDir !== ':memory:') await mkdir(resolve(dataDir), { recursive: true });
    const instance = new PGlite(dataDir === ':memory:' ? undefined : resolve(dataDir));
    await instance.waitReady;
    database = {
      mode: 'embedded',
      query: (sql, params = []) => instance.query(sql, params),
      transaction: (callback) =>
        instance.transaction((tx) =>
          callback({ query: (sql, params = []) => tx.query(sql, params) }),
        ),
      close: () => instance.close(),
    };
  }
  try {
    await runMigrations(database);
    return database;
  } catch (error) {
    await database.close();
    throw error;
  }
}
