import { loadConfig } from './config/index.js';
import { createLogger } from './logging/logger.js';
import { PgStore } from './db/pg-store.js';
import { MemoryStore } from './db/memory-store.js';
import { migrate } from './db/migrate.js';
import { createPlatform } from './platform.js';

const cfg = loadConfig();
const logger = createLogger({ level: cfg.logging.level, bindings: { scope: 'main' } });

let store;
if (cfg.db.enabled) {
  if (!cfg.db.url) {
    logger.error('DATABASE_URL is not set. Set it (see .env.example) or run with DB_ENABLED=false for capture-only mode.');
    process.exit(1);
  }
  await migrate(cfg.db.url, { log: (m) => logger.info(m) });
  store = new PgStore(cfg.db.url);
  await store.ping();
} else {
  logger.warn('DB_ENABLED=false: using in-memory store (nothing persisted except the capture file)');
  store = new MemoryStore();
}

logger.info(`device timezone offset ${cfg.device.tzOffsetMinutes} min, auth mode ${cfg.auth.mode}, business frame LEN=${cfg.business.lenMode} CRC=${cfg.business.crcAlgo}/${cfg.business.crcRange} (enforce=${cfg.business.crcEnforce})`);
if (cfg.logging.captureFile) logger.info(`raw traffic capture: ${cfg.logging.captureFile}`);

const platform = await createPlatform({ cfg, store, logger: createLogger({ level: cfg.logging.level }) });

let stopping = false;
async function shutdown(sig) {
  if (stopping) return;
  stopping = true;
  logger.info(`${sig} received, shutting down`);
  await platform.stop();
  await store.close();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (e) => logger.error(`unhandled rejection: ${e?.stack || e}`));
