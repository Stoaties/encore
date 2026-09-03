import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createDb, runMigrations } from './db/index.js';
import { JellyfinClient } from './jellyfin/client.js';
import { MusicBrainzClient } from './musicbrainz/client.js';
import { EventBus } from './events.js';
import { SlskdClient } from './slskd/client.js';
import { AcquisitionWorker } from './acquisition/worker.js';
import { importJobHandler } from './imports/service.js';
import { buildApp } from './app.js';

const config = loadConfig();
const { db, pool } = createDb(config.databaseUrl);

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));
await runMigrations(db, migrationsFolder);

const jellyfin = new JellyfinClient(config.jellyfinUrl);
const mb = new MusicBrainzClient({ db, userAgent: config.musicbrainzUserAgent });
const events = new EventBus();
const slskd = new SlskdClient(config.slskdUrl, config.slskdApiKey);
const app = await buildApp({ config, db, jellyfin, mb, events });
void mb.pruneCache().catch(() => {});

const worker = new AcquisitionWorker({
  db,
  config,
  jellyfin,
  mb,
  slskd,
  events,
  imports: importJobHandler({ db, config, mb, jellyfin, events }),
  log: {
    info: (m) => app.log.info(m),
    warn: (m) => app.log.warn(m),
    error: (m) => app.log.error(m),
  },
});
await worker.start();

const shutdown = async (signal: string) => {
  app.log.info(`${signal} received, shutting down`);
  worker.stop();
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: config.port, host: '0.0.0.0' });
