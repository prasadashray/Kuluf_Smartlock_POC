// Tracks live sessions, one per device. §5.3: "a terminal with the same identity establishes a new connection,
// indicating that the original connection is disconnected" -> the older session is closed.
export class SessionManager {
  constructor({ logger }) {
    this.all = new Set();
    this.byDevice = new Map();
    this.log = logger.child({ scope: 'sessions' });
  }

  add(session) {
    this.all.add(session);
  }

  remove(session) {
    this.all.delete(session);
    if (session.device && this.byDevice.get(session.device.id) === session) this.byDevice.delete(session.device.id);
  }

  bind(session, device) {
    const existing = this.byDevice.get(device.id);
    if (existing && existing !== session) {
      this.log.warn(`device ${device.terminal_id} opened a new connection ${session.remoteLabel}; closing previous ${existing.remoteLabel}`);
      existing.close('replaced_by_new_connection');
    }
    this.byDevice.set(device.id, session);
  }

  getByDeviceId(deviceId) {
    const s = this.byDevice.get(deviceId);
    return s && !s.closed ? s : null;
  }

  list() {
    return [...this.all].map((s) => ({
      id: s.id,
      dbId: s.dbId,
      remote: s.remoteLabel,
      terminalId: s.terminalId,
      deviceId: s.device?.id ?? null,
      authenticated: s.authenticated,
      connectedAt: s.connectedAt.toISOString(),
      lastRxAt: new Date(s.lastRxAt).toISOString(),
      counters: s.counters,
    }));
  }
}
