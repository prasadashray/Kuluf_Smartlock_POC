// In-memory implementation of the store interface. Used by integration tests and by "capture-only" runs (DB_ENABLED=false)
// so that the listener can record first hardware traffic even without PostgreSQL.
import { randomUUID } from 'node:crypto';
import { toJsonSafe } from '../logging/logger.js';

const now = () => new Date().toISOString();
const clone = (o) => (o ? structuredClone(o) : o);

export class MemoryStore {
  kind = 'memory';

  constructor() {
    this.devices = [];
    this.sessions = [];
    this.messages = [];
    this.locations = [];
    this.alarms = [];
    this.commands = [];
    this.messageSeq = 0;
  }

  async ping() {}
  async close() {}

  // ---- devices ----
  async getDeviceById(id) { return clone(this.devices.find((d) => d.id === id) ?? null); }
  async getDeviceByTerminalId(t) { return clone(this.devices.find((d) => d.terminal_id === t) ?? null); }
  async getDeviceByLockId(l) { return clone(this.devices.find((d) => d.lock_id === l) ?? null); }
  async findDevice(ref) {
    return (await this.getDeviceById(ref)) ?? (await this.getDeviceByTerminalId(String(ref).padStart(12, '0'))) ?? (await this.getDeviceByLockId(ref));
  }
  async createDevice(f) {
    if (f.terminal_id && this.devices.some((d) => d.terminal_id === f.terminal_id)) throw new Error('duplicate terminal_id');
    const d = { id: randomUUID(), key_format: 'rf10', connection_status: 'offline', authenticated: false, created_at: now(), updated_at: now(), ...f };
    this.devices.push(d);
    return clone(d);
  }
  async updateDevice(id, patch) {
    const d = this.devices.find((x) => x.id === id);
    if (!d) return null;
    if (patch.lock_id && this.devices.some((x) => x.id !== id && x.lock_id === patch.lock_id)) throw new Error('duplicate lock_id');
    Object.assign(d, strip(patch), { updated_at: now() });
    return clone(d);
  }
  async listDevices() { return clone(this.devices); }

  // ---- sessions ----
  async createSession(f) {
    const s = { id: randomUUID(), connected_at: now(), rx_frames: 0, tx_frames: 0, rx_errors: 0, ...f };
    this.sessions.push(s);
    return clone(s);
  }
  async updateSession(id, patch) {
    const s = this.sessions.find((x) => x.id === id);
    if (s) Object.assign(s, strip(patch));
    return clone(s ?? null);
  }
  async listSessions(deviceId, limit = 20) {
    return clone(this.sessions.filter((s) => s.device_id === deviceId).reverse().slice(0, limit));
  }

  // ---- message log ----
  async insertMessage(m) {
    const row = { id: ++this.messageSeq, created_at: now(), ...strip(m), parsed: m.parsed ? toJsonSafe(m.parsed) : null };
    this.messages.push(row);
    return clone(row);
  }
  async listMessages(deviceId, { limit = 100, direction = null, msgId = null } = {}) {
    return clone(this.messages.filter((m) => m.device_id === deviceId && (!direction || m.direction === direction) && (msgId === null || m.msg_id === msgId)).reverse().slice(0, limit));
  }
  async listUnattributedMessages({ limit = 100 } = {}) {
    return clone(this.messages.filter((m) => !m.device_id).reverse().slice(0, limit));
  }

  // ---- locations ----
  async insertLocation(l) {
    const row = { id: randomUUID(), received_at: now(), ...strip(l), extras: l.extras ? toJsonSafe(l.extras) : null };
    this.locations.push(row);
    return clone(row);
  }
  async listLocations(deviceId, { limit = 200 } = {}) {
    return clone(this.locations.filter((l) => l.device_id === deviceId).reverse().slice(0, limit));
  }
  async latestLocation(deviceId, { positionedOnly = true } = {}) {
    const all = this.locations.filter((l) => l.device_id === deviceId && (!positionedOnly || l.positioned));
    return clone(all[all.length - 1] ?? null);
  }

  // ---- alarms ----
  async insertAlarm(a) {
    const row = { id: randomUUID(), created_at: now(), processing_status: 'active', cleared_at: null, ...strip(a) };
    this.alarms.push(row);
    return clone(row);
  }
  async listAlarms(deviceId, { limit = 200, activeOnly = false } = {}) {
    return clone(this.alarms.filter((a) => a.device_id === deviceId && (!activeOnly || !a.cleared_at)).reverse().slice(0, limit));
  }
  async activeAlarms(deviceId) { return this.listAlarms(deviceId, { activeOnly: true, limit: 1000 }); }
  async clearAlarm(id, { clearedAt, clearedBy }) {
    const a = this.alarms.find((x) => x.id === id);
    if (a) Object.assign(a, { cleared_at: clearedAt, cleared_by: clearedBy, processing_status: 'cleared' });
    return clone(a ?? null);
  }

  // ---- commands ----
  async insertCommand(c) {
    const row = { id: randomUUID(), requested_at: now(), updated_at: now(), ...strip(c), params: c.params ? toJsonSafe(c.params) : null };
    this.commands.push(row);
    return clone(row);
  }
  async updateCommand(id, patch) {
    const c = this.commands.find((x) => x.id === id);
    if (!c) return null;
    const p = strip(patch);
    if (p.reply_parsed) p.reply_parsed = toJsonSafe(p.reply_parsed);
    Object.assign(c, p, { updated_at: now() });
    return clone(c);
  }
  async getCommand(id) { return clone(this.commands.find((c) => c.id === id) ?? null); }
  async listCommands(deviceId, { limit = 100 } = {}) {
    return clone(this.commands.filter((c) => c.device_id === deviceId).reverse().slice(0, limit));
  }
  async findCommandByBusinessSerial(deviceId, serial, { statuses }) {
    const found = this.commands.filter((c) => c.device_id === deviceId && c.business_serial === serial && statuses.includes(c.status));
    return clone(found[found.length - 1] ?? null);
  }
  async failOpenCommands(reason) {
    const open = this.commands.filter((c) => ['pending', 'sent', 'acknowledged'].includes(c.status));
    for (const c of open) Object.assign(c, { status: 'timeout', outcome: c.outcome ?? 'timeout', error: reason });
    return open.map((c) => ({ id: c.id }));
  }
}

function strip(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v instanceof Date ? v.toISOString() : v;
  return out;
}
