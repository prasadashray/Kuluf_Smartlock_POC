// TCP server: the terminal is the client (§4.1). Malformed data from a device must never crash the process.
import net from 'node:net';
import { Session } from './session.js';

export class TcpListener {
  constructor({ cfg, store, sessions, handler, messageLog, logger }) {
    this.cfg = cfg;
    this.store = store;
    this.sessions = sessions;
    this.handler = handler;
    this.messageLog = messageLog;
    this.log = logger.child({ scope: 'tcp' });
    this.server = net.createServer((socket) => this.onConnection(socket));
    this.server.on('error', (e) => this.log.error(`server error: ${e.message}`));
    this.sweeper = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.cfg.tcp.port, this.cfg.tcp.host, () => {
        this.server.off('error', reject);
        const addr = this.server.address();
        this.log.info(`TT808ELOCK TCP listener on ${addr.address}:${addr.port}`);
        this.sweeper = setInterval(() => this.sweep(), 5000);
        resolve(addr);
      });
    });
  }

  get port() {
    return this.server.address()?.port;
  }

  async stop() {
    clearInterval(this.sweeper);
    const open = [...this.sessions.all];
    for (const s of open) s.close('server_shutdown');
    await new Promise((resolve) => this.server.close(() => resolve()));
    const timeout = new Promise((resolve) => setTimeout(resolve, 5000));
    await Promise.race([Promise.all(open.map((s) => s.finished)), timeout]);
  }

  onConnection(socket) {
    const session = new Session(socket, { maxFrameLength: this.cfg.tcp.maxFrameLength });
    session.onQueueError = (e) => this.log.error(`session ${session.remoteLabel} processing error: ${e.stack || e.message}`);
    this.sessions.add(session);
    this.log.info(`connection from ${session.remoteLabel}`);
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 60_000);

    session.enqueue(async () => {
      try {
        const row = await this.store.createSession({ remote_address: session.remoteAddress, remote_port: session.remotePort, connected_at: session.connectedAt });
        session.dbId = row.id;
      } catch (e) {
        this.log.error(`could not persist session: ${e.message}`);
      }
    });

    socket.on('data', (chunk) => {
      this.messageLog.chunk(session, 'rx', chunk);
      let items;
      try {
        items = session.decoder.push(chunk);
      } catch (e) {
        this.log.error(`frame decoder failure on ${session.remoteLabel}: ${e.message}`);
        return;
      }
      for (const item of items) session.enqueue(() => this.handler.handleItem(session, item));
    });
    socket.on('error', (e) => {
      session.closeReason ??= `socket_error:${e.code || e.message}`;
      this.log.warn(`socket error ${session.remoteLabel}: ${e.message}`);
    });
    socket.on('close', () => {
      session.closed = true;
      if (session.decoder.pendingBytes) this.log.warn(`${session.remoteLabel} closed with ${session.decoder.pendingBytes} unframed byte(s) buffered`);
      session.enqueue(() => this.handler.onDisconnect(session)).finally(() => session.markFinished());
    });
  }

  /** §5.3: no message within the configured period => connection considered broken; mark offline and close. */
  sweep() {
    const limit = this.cfg.device.offlineTimeoutS * 1000;
    const now = Date.now();
    for (const s of this.sessions.all) {
      if (!s.closed && now - s.lastRxAt > limit) {
        this.log.warn(`no data from ${s.terminalId ?? s.remoteLabel} for ${Math.round((now - s.lastRxAt) / 1000)}s - closing (DEVICE_OFFLINE_TIMEOUT_S=${this.cfg.device.offlineTimeoutS})`);
        s.close('heartbeat_timeout');
      }
    }
  }
}
