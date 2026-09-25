const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger({ level = 'info', bindings = {}, sink = console } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const scope = bindings.scope ? `[${bindings.scope}]` : '';
  const emit = (lvl, msg, fields) => {
    if (LEVELS[lvl] < threshold) return;
    const ts = new Date().toISOString();
    const extra = fields && Object.keys(fields).length ? ` ${safeStringify(fields)}` : '';
    const line = `${ts} ${lvl.toUpperCase().padEnd(5)} ${scope} ${msg}${extra}`;
    (lvl === 'error' ? sink.error : lvl === 'warn' ? sink.warn : sink.log).call(sink, line);
  };
  return {
    level,
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (b) => createLogger({ level, bindings: { ...bindings, ...b }, sink }),
  };
}

export const silentLogger = createLogger({ level: 'error', sink: { log() {}, warn() {}, error() {} } });

/** JSON serialisation that renders Buffers as hex and tolerates BigInt / cycles. */
export function toJsonSafe(value) {
  const seen = new WeakSet();
  const walk = (v) => {
    if (v === null || v === undefined) return v;
    if (Buffer.isBuffer(v)) return v.toString('hex').toUpperCase();
    if (v instanceof Uint8Array) return Buffer.from(v).toString('hex').toUpperCase();
    if (typeof v === 'bigint') return v.toString();
    if (v instanceof Date) return v.toISOString();
    if (typeof v !== 'object') return v;
    if (seen.has(v)) return '[circular]';
    seen.add(v);
    if (Array.isArray(v)) return v.map(walk);
    const out = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = walk(x);
    return out;
  };
  return walk(value);
}

export function safeStringify(v) {
  try {
    return JSON.stringify(toJsonSafe(v));
  } catch {
    return String(v);
  }
}
