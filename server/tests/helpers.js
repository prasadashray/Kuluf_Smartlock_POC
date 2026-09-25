import net from 'node:net';
import { loadConfig } from '../src/config/index.js';
import { createLogger } from '../src/logging/logger.js';
import { MemoryStore } from '../src/db/memory-store.js';
import { createPlatform } from '../src/platform.js';
import { SimulatedDevice } from '../../simulator/device.js';
import { FrameDecoder, decodePacket, decodeBody, encodePacket } from '../src/protocol/index.js';

export function testConfig(overrides = {}) {
  return loadConfig({
    tcp: { host: '127.0.0.1', port: 0 },
    api: { host: '127.0.0.1', port: 0, token: '' },
    auth: { mode: 'accept_all', registration: 'issue_code', requireAuthForCommands: true, allowedCodes: [] },
    timeSync: { enabled: true, delayMs: 20 },
    commands: { timeoutS: 3, defaultKeyFormat: 'rf10', defaultGate: 0, defaultBill: '0', defaultLineCode: 0 },
    device: { tzOffsetMinutes: 480, offlineTimeoutS: 300 },
    business: { lenMode: 'after_len', crcAlgo: 'crc8_maxim', crcRange: 'from_len', crcEnforce: false, replyToLockUpload: false },
    logging: { level: process.env.TEST_LOG_LEVEL ?? 'error', protocolVerbose: false, messageLogDb: true, logRawChunks: false, captureFile: null },
    ...overrides,
  });
}

export async function startPlatform(overrides = {}, store = new MemoryStore()) {
  const cfg = testConfig(overrides);
  const platform = await createPlatform({ cfg, store, logger: createLogger({ level: cfg.logging.level }) });
  const base = `http://127.0.0.1:${platform.apiPort}/api`;
  const api = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return { platform, store, cfg, api };
}

export async function startDevice(platform, opts = {}) {
  const dev = new SimulatedDevice({
    host: '127.0.0.1',
    port: platform.tcpPort,
    heartbeatS: 0,
    locationS: 0,
    replyDelayMs: 50,
    business: { lenMode: platform.cfg.business.lenMode, crcAlgo: platform.cfg.business.crcAlgo, crcRange: platform.cfg.business.crcRange },
    ...opts,
  });
  await dev.connect();
  return dev;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitUntil(fn, { timeout = 3000, interval = 20, message = 'condition' } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${message}`);
    await sleep(interval);
  }
}

/** Raw protocol client for malformed-input tests. */
export async function rawClient(port) {
  const socket = net.createConnection({ host: '127.0.0.1', port });
  await new Promise((r) => socket.once('connect', r));
  const decoder = new FrameDecoder();
  const received = [];
  socket.on('data', (c) => {
    for (const it of decoder.push(c)) {
      if (it.type !== 'frame') continue;
      const p = decodePacket(it.data);
      if (p.ok) received.push({ header: p.header, body: decodeBody(p.header.msgId, p.body, { direction: 'downlink' }) });
    }
  });
  let serial = 0;
  return {
    socket,
    received,
    sendRaw: (buf) => socket.write(buf),
    send: (msgId, body = Buffer.alloc(0), terminalId = '000012345678') => socket.write(encodePacket({ msgId, terminalId, serial: serial++, body }).frame),
    close: () => socket.destroy(),
  };
}
