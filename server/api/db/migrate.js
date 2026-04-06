import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { createPool } from './pool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function main() {
  const config = loadConfig();
  const pool = createPool(config);
  const client = await pool.connect();

  try {
    await ensureMigrationsTable(client);

    const dir = path.join(__dirname, 'migrations');
    const entries = await fs.readdir(dir);
    const files = entries.filter((name) => name.endsWith('.sql')).sort();

    for (const fileName of files) {
      const version = fileName;
      const alreadyApplied = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [version]);
      if (alreadyApplied.rowCount > 0) continue;

      const sql = await fs.readFile(path.join(dir, fileName), 'utf8');
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [version]);
      await client.query('COMMIT');
      // eslint-disable-next-line no-console
      console.log(`Applied migration: ${version}`);
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exitCode = 1;
});
