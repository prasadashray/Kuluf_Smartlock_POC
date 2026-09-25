import pg from 'pg';
import { toJsonSafe } from '../logging/logger.js';

// numeric -> number, int8 -> number (all our int8 values are far below 2^53)
pg.types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));
pg.types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)));

const JSONB = new Set(['parsed', 'params', 'reply_parsed', 'extras']);
const HAS_UPDATED_AT = new Set(['devices', 'commands']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function prep(col, v) {
  if (JSONB.has(col) && v !== null && v !== undefined) return JSON.stringify(toJsonSafe(v));
  return v;
}

export class PgStore {
  kind = 'postgres';

  constructor(databaseUrl) {
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  }

  async ping() {
    await this.pool.query('SELECT 1');
  }

  async close() {
    await this.pool.end();
  }

  async insert(table, obj) {
    const cols = Object.keys(obj).filter((k) => obj[k] !== undefined);
    const vals = cols.map((c) => prep(c, obj[c]));
    const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`;
    return (await this.pool.query(sql, vals)).rows[0];
  }

  async update(table, id, patch) {
    const cols = Object.keys(patch).filter((k) => patch[k] !== undefined);
    if (!cols.length) return this.one(`SELECT * FROM ${table} WHERE id = $1`, [id]);
    const sets = cols.map((c, i) => `${c} = $${i + 2}`);
    if (HAS_UPDATED_AT.has(table)) sets.push('updated_at = now()');
    const sql = `UPDATE ${table} SET ${sets.join(', ')} WHERE id = $1 RETURNING *`;
    return (await this.pool.query(sql, [id, ...cols.map((c) => prep(c, patch[c]))])).rows[0] ?? null;
  }

  async one(sql, params) {
    return (await this.pool.query(sql, params)).rows[0] ?? null;
  }

  async many(sql, params) {
    return (await this.pool.query(sql, params)).rows;
  }

  // ---- devices ----
  getDeviceById(id) { return UUID_RE.test(id) ? this.one('SELECT * FROM devices WHERE id = $1', [id]) : null; }
  getDeviceByTerminalId(t) { return this.one('SELECT * FROM devices WHERE terminal_id = $1', [t]); }
  getDeviceByLockId(l) { return this.one('SELECT * FROM devices WHERE lock_id = $1', [l]); }
  async findDevice(ref) {
    return (await this.getDeviceById(ref)) ?? (await this.getDeviceByTerminalId(String(ref).padStart(12, '0'))) ?? (await this.getDeviceByLockId(ref));
  }
  createDevice(f) { return this.insert('devices', f); }
  updateDevice(id, patch) { return this.update('devices', id, patch); }
  listDevices() { return this.many('SELECT * FROM devices ORDER BY created_at'); }

  // ---- sessions ----
  createSession(f) { return this.insert('sessions', f); }
  updateSession(id, patch) { return this.update('sessions', id, patch); }
  listSessions(deviceId, limit = 20) { return this.many('SELECT * FROM sessions WHERE device_id = $1 ORDER BY connected_at DESC LIMIT $2', [deviceId, limit]); }

  // ---- message log ----
  insertMessage(m) { return this.insert('message_log', m); }
  listMessages(deviceId, { limit = 100, direction = null, msgId = null } = {}) {
    return this.many(
      `SELECT * FROM message_log WHERE device_id = $1 AND ($2::text IS NULL OR direction = $2) AND ($3::int IS NULL OR msg_id = $3)
       ORDER BY id DESC LIMIT $4`,
      [deviceId, direction, msgId, limit],
    );
  }
  listUnattributedMessages({ limit = 100 } = {}) {
    return this.many('SELECT * FROM message_log WHERE device_id IS NULL ORDER BY id DESC LIMIT $1', [limit]);
  }

  // ---- locations ----
  insertLocation(l) { return this.insert('locations', l); }
  listLocations(deviceId, { limit = 200 } = {}) {
    return this.many('SELECT * FROM locations WHERE device_id = $1 ORDER BY received_at DESC, id LIMIT $2', [deviceId, limit]);
  }
  latestLocation(deviceId, { positionedOnly = true } = {}) {
    return this.one(
      `SELECT * FROM locations WHERE device_id = $1 AND ($2::boolean = false OR positioned) ORDER BY received_at DESC LIMIT 1`,
      [deviceId, positionedOnly],
    );
  }

  // ---- alarms ----
  insertAlarm(a) { return this.insert('alarms', a); }
  listAlarms(deviceId, { limit = 200, activeOnly = false } = {}) {
    return this.many(
      `SELECT * FROM alarms WHERE device_id = $1 AND ($2::boolean = false OR cleared_at IS NULL) ORDER BY raised_at DESC LIMIT $3`,
      [deviceId, activeOnly, limit],
    );
  }
  activeAlarms(deviceId) { return this.listAlarms(deviceId, { activeOnly: true, limit: 1000 }); }
  clearAlarm(id, { clearedAt, clearedBy }) {
    return this.update('alarms', id, { cleared_at: clearedAt, cleared_by: clearedBy, processing_status: 'cleared' });
  }

  // ---- commands ----
  insertCommand(c) { return this.insert('commands', c); }
  updateCommand(id, patch) { return this.update('commands', id, patch); }
  getCommand(id) { return UUID_RE.test(id) ? this.one('SELECT * FROM commands WHERE id = $1', [id]) : null; }
  listCommands(deviceId, { limit = 100 } = {}) {
    return this.many('SELECT * FROM commands WHERE device_id = $1 ORDER BY requested_at DESC LIMIT $2', [deviceId, limit]);
  }
  findCommandByBusinessSerial(deviceId, serial, { statuses }) {
    return this.one(
      `SELECT * FROM commands WHERE device_id = $1 AND business_serial = $2 AND status = ANY($3)
       AND requested_at > now() - interval '1 day' ORDER BY requested_at DESC LIMIT 1`,
      [deviceId, serial, statuses],
    );
  }
  async failOpenCommands(reason) {
    return this.many(
      `UPDATE commands SET status = 'timeout', outcome = COALESCE(outcome, 'timeout'), error = $1, updated_at = now()
       WHERE status IN ('pending', 'sent', 'acknowledged') RETURNING id`,
      [reason],
    );
  }
}
