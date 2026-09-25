// Wires the platform together. Used by src/index.js and by the integration tests (with a MemoryStore and port 0).
import { EventEmitter } from 'node:events';
import { createLogger } from './logging/logger.js';
import { CaptureWriter } from './logging/capture.js';
import { MessageLogger } from './services/message-log.js';
import { TelemetryService } from './services/telemetry-service.js';
import { CommandService } from './services/command-service.js';
import { ProtocolHandler } from './services/protocol-handler.js';
import { SessionManager } from './tcp-listener/session-manager.js';
import { TcpListener } from './tcp-listener/server.js';
import { createApi } from './api/app.js';

export async function createPlatform({ cfg, store, logger = createLogger({ level: cfg.logging.level }), startApi = true }) {
  const events = new EventEmitter();
  events.setMaxListeners(100);
  const capture = cfg.logging.captureFile ? new CaptureWriter(cfg.logging.captureFile) : null;
  const sessions = new SessionManager({ logger });
  const messageLog = new MessageLogger({ cfg, store, capture, logger });
  const telemetry = new TelemetryService({ store, logger, events });
  const handler = new ProtocolHandler({ cfg, store, sessions, messageLog, telemetry, logger, events });
  const commands = new CommandService({ cfg, store, sessions, telemetry, logger, events, send: (...a) => handler.send(...a) });
  handler.commands = commands;
  await commands.recoverAfterRestart();

  const listener = new TcpListener({ cfg, store, sessions, handler, messageLog, logger });
  await listener.start();

  let httpServer = null;
  if (startApi) {
    const app = createApi({ cfg, store, sessions, commands, handler });
    httpServer = await new Promise((resolve, reject) => {
      const srv = app.listen(cfg.api.port, cfg.api.host, () => resolve(srv));
      srv.once('error', reject);
    });
    const a = httpServer.address();
    logger.child({ scope: 'api' }).info(`REST API on http://${a.address}:${a.port}/api`);
  }

  return {
    cfg, store, events, sessions, messageLog, telemetry, handler, commands, listener, httpServer, capture,
    get tcpPort() { return listener.port; },
    get apiPort() { return httpServer?.address()?.port; },
    async stop() {
      await listener.stop();
      if (httpServer) await new Promise((r) => httpServer.close(() => r()));
      for (const e of commands.pending.values()) clearTimeout(e.timer);
      await capture?.close();
    },
  };
}
