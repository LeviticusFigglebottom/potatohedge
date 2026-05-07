import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from './db.js';
import { log } from './log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

(async () => {
  const dir = path.resolve(__dirname, '..', 'migrations');
  await runMigrations(dir);
  log.info('migrations done');
  process.exit(0);
})().catch((e) => {
  log.error('migrate failed', { error: (e as Error).message });
  process.exit(1);
});
