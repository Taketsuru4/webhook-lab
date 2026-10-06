import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

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
      close: () => pool.end(),
    };
  } else {
    if (dataDir !== ':memory:') await mkdir(resolve(dataDir), { recursive: true });
    const instance = new PGlite(dataDir === ':memory:' ? undefined : resolve(dataDir));
    await instance.waitReady;
    database = {
      mode: 'embedded',
      query: (sql, params = []) => instance.query(sql, params),
      close: () => instance.close(),
    };
  }
  try {
    const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
    // Both drivers support the same SQL. Separate statements for PGlite's query API.
    for (const statement of schema.split(';').filter((part) => part.trim())) {
      await database.query(statement);
    }
    return database;
  } catch (error) {
    await database.close();
    throw error;
  }
}
