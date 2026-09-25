// Minimal REST API. Commands always go through CommandService and the live TCP session; the API never reports a lock
// operation as successful before the device's operation reply has been received.
import express from 'express';
import { ServiceError } from '../services/errors.js';
import { KEY_FORMATS, encodeKey } from '../protocol/index.js';

function maskKey(k) {
  if (!k) return null;
  const s = String(k);
  return s.length <= 4 ? '*'.repeat(s.length) : `${s.slice(0, 2)}${'*'.repeat(s.length - 4)}${s.slice(-2)}`;
}

export function presentDevice(d, sessions) {
  if (!d) return null;
  const live = sessions.getByDeviceId(d.id);
  const { current_key: key, ...rest } = d;
  return {
    ...rest,
    current_key_masked: maskKey(key),
    has_key: Boolean(key),
    online: Boolean(live),
    session_authenticated: live ? live.authenticated : false,
    session_remote: live ? live.remoteLabel : null,
  };
}

export function presentCommand(c) {
  if (!c) return null;
  const params = c.params ? { ...c.params, key: maskKey(c.params.key) } : c.params;
  return {
    ...c,
    params,
    succeeded: c.status === 'completed' && c.outcome === 'success',
    final: !['pending', 'sent', 'acknowledged'].includes(c.status),
  };
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function createApi({ cfg, store, sessions, commands, handler }) {
  const app = express();
  app.use(express.json({ limit: '64kb' }));

  app.use((req, res, next) => {
    if (cfg.api.corsOrigin) {
      res.setHeader('Access-Control-Allow-Origin', cfg.api.corsOrigin);
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    if (cfg.api.token) {
      const auth = req.get('authorization') ?? '';
      if (auth !== `Bearer ${cfg.api.token}`) return res.status(401).json({ error: 'UNAUTHORIZED' });
    }
    return next();
  });

  const device = async (req) => {
    const d = await store.findDevice(req.params.id);
    if (!d) throw new ServiceError(404, 'DEVICE_NOT_FOUND', `No device ${req.params.id}`);
    return d;
  };
  const limit = (req, def = 100, max = 1000) => Math.min(Math.max(Number(req.query.limit) || def, 1), max);

  app.get('/api/health', wrap(async (req, res) => {
    let db = store.kind === 'memory' ? 'memory (not persisted)' : 'ok';
    try {
      await store.ping();
    } catch (e) {
      db = `error: ${e.message}`;
    }
    res.json({ ok: !db.startsWith('error'), db, store: store.kind, tcpPort: cfg.tcp.port, liveSessions: sessions.all.size, time: new Date().toISOString() });
  }));

  app.get('/api/sessions', (req, res) => res.json(sessions.list()));

  app.get('/api/devices', wrap(async (req, res) => {
    res.json((await store.listDevices()).map((d) => presentDevice(d, sessions)));
  }));

  app.get('/api/devices/:id', wrap(async (req, res) => {
    const d = await device(req);
    res.json({
      ...presentDevice(d, sessions),
      latest_location: await store.latestLocation(d.id, { positionedOnly: true }),
      latest_report: await store.latestLocation(d.id, { positionedOnly: false }),
      active_alarms: await store.activeAlarms(d.id),
    });
  }));

  app.get('/api/devices/:id/status', wrap(async (req, res) => {
    const d = await device(req);
    const live = sessions.getByDeviceId(d.id);
    const loc = await store.latestLocation(d.id, { positionedOnly: false });
    res.json({
      device_id: d.id,
      terminal_id: d.terminal_id,
      lock_id: d.lock_id,
      online: Boolean(live),
      authenticated: live ? live.authenticated : false,
      connection_status: d.connection_status,
      last_seen_at: d.last_seen_at,
      last_heartbeat_at: d.last_heartbeat_at,
      last_disconnected_at: d.last_disconnected_at,
      last_disconnect_reason: d.last_disconnect_reason,
      lock: { code: d.lock_status_code, state: d.lock_state, label: d.lock_status_label, at: d.lock_status_at },
      battery: { voltage_code: d.battery_voltage_code, volts: d.battery_voltage_v, percent: d.battery_percent, mv: d.battery_mv, at: d.battery_at },
      latest_location: loc,
      active_alarms: await store.activeAlarms(d.id),
    });
  }));

  app.patch('/api/devices/:id', wrap(async (req, res) => {
    const d = await device(req);
    const allowed = ['lock_id', 'current_key', 'key_format', 'display_name'];
    const patch = {};
    for (const k of allowed) if (req.body?.[k] !== undefined) patch[k] = req.body[k] === '' ? null : req.body[k];
    if (patch.lock_id && !/^\d{8}$/.test(patch.lock_id)) throw new ServiceError(400, 'BAD_LOCK_ID', 'lock_id must be 8 digits');
    if (patch.key_format && !KEY_FORMATS.includes(patch.key_format)) throw new ServiceError(400, 'BAD_KEY_FORMAT', `key_format must be one of ${KEY_FORMATS}`);
    if (patch.current_key) {
      try {
        encodeKey(patch.current_key, patch.key_format ?? d.key_format);
      } catch (e) {
        throw new ServiceError(400, 'BAD_KEY', e.message);
      }
    }
    res.json(presentDevice(await store.updateDevice(d.id, patch), sessions));
  }));

  app.get('/api/devices/:id/locations', wrap(async (req, res) => {
    res.json(await store.listLocations((await device(req)).id, { limit: limit(req, 200, 5000) }));
  }));

  app.get('/api/devices/:id/alarms', wrap(async (req, res) => {
    res.json(await store.listAlarms((await device(req)).id, { limit: limit(req, 200), activeOnly: req.query.active === 'true' }));
  }));

  app.get('/api/devices/:id/commands', wrap(async (req, res) => {
    res.json((await store.listCommands((await device(req)).id, { limit: limit(req) })).map(presentCommand));
  }));

  app.get('/api/devices/:id/messages', wrap(async (req, res) => {
    const d = await device(req);
    const msgId = req.query.msgId ? Number(req.query.msgId) : null;
    res.json(await store.listMessages(d.id, { limit: limit(req), direction: req.query.direction ?? null, msgId }));
  }));

  app.get('/api/devices/:id/sessions', wrap(async (req, res) => {
    res.json(await store.listSessions((await device(req)).id, limit(req, 20, 200)));
  }));

  app.get('/api/devices/:id/events', wrap(async (req, res) => {
    const d = await device(req);
    const n = limit(req, 100, 500);
    const [cmds, alarms, locs] = await Promise.all([store.listCommands(d.id, { limit: n }), store.listAlarms(d.id, { limit: n }), store.listLocations(d.id, { limit: n })]);
    const events = [
      ...cmds.map((c) => ({ time: c.replied_at ?? c.requested_at, kind: 'command', summary: `${c.command_type}: ${c.status}${c.result_label ? ` - ${c.result_label} (${c.result_code_hex})` : ''}`, data: presentCommand(c) })),
      ...alarms.flatMap((a) => [
        { time: a.raised_at, kind: 'alarm', summary: `ALARM ${a.alarm_type} (${a.source}${a.raw_value ? ` ${a.raw_value}` : ''})`, data: a },
        ...(a.cleared_at ? [{ time: a.cleared_at, kind: 'alarm_cleared', summary: `cleared ${a.alarm_type} by ${a.cleared_by}`, data: a }] : []),
      ]),
      ...locs.map((l) => ({ time: l.received_at, kind: 'location', summary: `${l.source} ${l.positioned ? `${l.latitude}, ${l.longitude} ${l.speed_kmh} km/h` : 'no GPS fix'}`, data: l })),
    ].sort((x, y) => new Date(y.time) - new Date(x.time)).slice(0, n);
    res.json(events);
  }));

  const commandRoute = (type) => wrap(async (req, res) => {
    const b = req.body ?? {};
    const cmd = await commands.execute({
      deviceRef: req.params.id, type, key: b.key, keyFormat: b.keyFormat ?? b.key_format, lockId: b.lockId ?? b.lock_id,
      gate: b.gate, bill: b.bill, lineCode: b.lineCode ?? b.line_code, requestedBy: b.requestedBy ?? 'api',
    });
    if (req.query.wait === 'true') {
      const final = await commands.waitFor(cmd.id, (cfg.commands.timeoutS + 5) * 1000);
      return res.status(200).json(presentCommand(final));
    }
    return res.status(202).json(presentCommand(cmd));
  });
  app.post('/api/devices/:id/seal', commandRoute('seal'));
  app.post('/api/devices/:id/unseal', commandRoute('unseal'));
  app.post('/api/devices/:id/clear-alarm', commandRoute('clear_alarm'));

  app.get('/api/commands/:commandId', wrap(async (req, res) => {
    const c = await store.getCommand(req.params.commandId);
    if (!c) throw new ServiceError(404, 'COMMAND_NOT_FOUND', 'No such command');
    res.json(presentCommand(c));
  }));

  const diag = (kind) => wrap(async (req, res) => {
    const d = await device(req);
    const r = await handler.request(d.id, kind, req.body ?? {}, Number(req.query.timeoutMs) || 15000);
    res.json(r);
  });
  app.post('/api/devices/:id/diagnostics/query-params', diag('query_params'));
  app.post('/api/devices/:id/diagnostics/query-location', diag('query_location'));
  app.post('/api/devices/:id/diagnostics/time-sync', diag('time_sync'));
  app.post('/api/devices/:id/diagnostics/text', diag('text'));

  app.get('/api/messages/unattributed', wrap(async (req, res) => res.json(await store.listUnattributedMessages({ limit: limit(req) }))));

  app.use((req, res) => res.status(404).json({ error: 'NOT_FOUND' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ServiceError) {
      const details = err.details?.command ? { command: presentCommand(err.details.command) } : err.details;
      return res.status(err.status).json({ error: err.code, message: err.message, ...(details ? { details } : {}) });
    }
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'BAD_JSON', message: err.message });
    console.error(err);
    return res.status(500).json({ error: 'INTERNAL', message: err.message });
  });
  return app;
}
