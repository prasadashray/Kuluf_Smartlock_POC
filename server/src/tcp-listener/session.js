import { randomUUID } from 'node:crypto';
import { FrameDecoder, encodePacket } from '../protocol/index.js';

/** One TCP connection. Frames are processed strictly in arrival order through `enqueue`. */
export class Session {
  constructor(socket, { maxFrameLength }) {
    this.id = randomUUID();
    this.dbId = null;
    this.socket = socket;
    this.remoteAddress = socket.remoteAddress;
    this.remotePort = socket.remotePort;
    this.remoteLabel = `${socket.remoteAddress}:${socket.remotePort}`;
    this.decoder = new FrameDecoder({ maxFrameLength });
    this.connectedAt = new Date();
    this.lastRxAt = Date.now();
    this.terminalId = null;
    this.terminalRaw = null; // 6 header bytes exactly as received; echoed in every reply
    this.device = null;
    this.authenticated = false;
    this.serial = 0;
    this.counters = { rxFrames: 0, txFrames: 0, rxErrors: 0 };
    this.closed = false;
    this.closeReason = null;
    this.queue = Promise.resolve();
    // Resolves once disconnect processing (DB updates) has finished.
    this.finished = new Promise((resolve) => { this.markFinished = resolve; });
  }

  enqueue(fn) {
    this.queue = this.queue.then(fn).catch((e) => this.onQueueError?.(e));
    return this.queue;
  }

  nextSerial() {
    const s = this.serial;
    this.serial = (this.serial + 1) & 0xffff;
    return s;
  }

  /** Encode and write one platform message. Returns the serial and bytes for logging/correlation. */
  write(msgId, body) {
    if (this.closed || this.socket.destroyed) throw new Error('Session is closed');
    const serial = this.nextSerial();
    if (!this.terminalRaw) throw new Error('Terminal not identified yet');
    const { frame, unescaped } = encodePacket({ msgId, terminalId: this.terminalRaw, serial, body });
    this.socket.write(frame);
    this.counters.txFrames++;
    return { serial, frame, unescaped };
  }

  close(reason) {
    if (this.closed) return;
    this.closeReason ??= reason;
    this.socket.destroy();
  }
}
