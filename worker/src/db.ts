import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';
import { loadConfig } from './config.js';
import { log } from './log.js';

let pool: Pool | undefined;

export function getPool(): Pool {
  if (pool) return pool;
  const cfg = loadConfig();
  pool = new Pool({
    connectionString: cfg.DATABASE_URL,
    ssl: cfg.DATABASE_URL.includes('sslmode=disable')
      ? false
      : { rejectUnauthorized: false },
    max: 4,
  });
  pool.on('error', (err) => log.error('pg pool error', { error: err.message }));
  return pool;
}

export async function withTx<T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function runMigrations(migrationsDir: string): Promise<void> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  for (const f of files) {
    const { rowCount } = await getPool().query(
      'SELECT 1 FROM schema_migrations WHERE filename = $1',
      [f],
    );
    if (rowCount && rowCount > 0) continue;
    const sql = await readFile(path.join(migrationsDir, f), 'utf8');
    log.info('applying migration', { filename: f });
    await withTx(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [f]);
    });
  }
}
