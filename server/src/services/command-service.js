// Lock commands (Seal / Unseal / Clear alarm) over 0x8900 + TT business frame, with full correlation:
//   1. 0x8900 JT/T808 serial  <-> 0x0001 terminal general response (delivery acknowledgement only)
//   2. business serial        <-> 0x0900 / 0x55 operation reply (the actual result)
// A command is successful only when the device returns the success result code for it. Writing bytes to the socket,
// or a 0x0001 acknowledgement, is never reported as success.
import {
  MSG, COMMAND_TYPES, PASSTHROUGH_ELOCK, encodeLockOperation, encodeBusinessFrame, encodePassthrough,
  encodeKey, toHex, hex8, GENERAL_RESULT,
} from '../protocol/index.js';
import { businessFrameOptions } from '../config/index.js';
import { ServiceError } from './errors.js';

const OPEN = ['pending', 'sent', 'acknowledged'];
const GENERAL_LABELS = ['success', 'failure', 'message_error', 'not_supported'];

export class CommandService {
  constructor({ cfg, store, sessions, telemetry, send, logger, events }) {
    this.cfg = cfg;
    this.store = store;
    this.sessions = sessions;
    this.telemetry = telemetry;
    this.send = send; // (session, msgId, body, parsed) => { serial, logRow }
    this.log = logger.child({ scope: 'commands' });
    this.events = events;
    this.pending = new Map(); // `${deviceId}:${businessSerial}` -> entry
    this.waiters = new Map(); // commandId -> [resolve]
    this.bizSerials = new Map(); // deviceId -> last business serial
  }

  async recoverAfterRestart() {
    const failed = await this.store.failOpenCommands('Server restarted before the device replied');
    if (failed.length) this.log.warn(`marked ${failed.length} open command(s) from a previous run as timed out`);
  }

  nextBusinessSerial(deviceId) {
    // Downlink serial range 0x0001-0xFFFF (§10.1); 0x0000 is reserved for spontaneous uplinks. A random start per
    // process makes it unlikely that a late reply to a previous run's command matches a new command.
    let s = this.bizSerials.get(deviceId);
    if (s === undefined) s = Math.floor(Math.random() * 0x7fff);
    s = (s % 0xffff) + 1;
    this.bizSerials.set(deviceId, s);
    return s;
  }

  async resolveDevice(ref) {
    const device = await this.store.findDevice(ref);
    if (!device) throw new ServiceError(404, 'DEVICE_NOT_FOUND', `No device ${ref}`);
    return device;
  }

  /**
   * @param {object} req { deviceRef, type: 'seal'|'unseal'|'clear_alarm', key?, keyFormat?, lockId?, gate?, bill?, lineCode?, requestedBy? }
   * @returns the command row (status 'sent' on success of transmission)
   */
  async execute(req) {
    const cmdCode = COMMAND_TYPES[req.type];
    if (cmdCode === undefined || !['seal', 'unseal', 'clear_alarm'].includes(req.type)) {
      throw new ServiceError(400, 'BAD_COMMAND', `Unsupported command type ${req.type}`);
    }
    const device = await this.resolveDevice(req.deviceRef);
    const lockId = req.lockId ?? device.lock_id;
    if (!lockId) throw new ServiceError(409, 'LOCK_ID_UNKNOWN', 'LockID is not known for this device yet; set it with PATCH /api/devices/:id {"lock_id": "..."} or wait for a 0x0900 message');
    const keyFormat = req.keyFormat ?? device.key_format ?? this.cfg.commands.defaultKeyFormat;
    const key = req.key ?? device.current_key;
    if (!key) throw new ServiceError(409, 'KEY_UNKNOWN', 'No key given and no current key stored for this device (the key is a hardware configuration dependency - see docs/PROTOCOL_NOTES.md)');
    try {
      encodeKey(key, keyFormat);
    } catch (e) {
      throw new ServiceError(400, 'BAD_KEY', e.message);
    }
    const params = {
      lockId,
      gate: req.gate ?? this.cfg.commands.defaultGate,
      bill: req.bill ?? this.cfg.commands.defaultBill,
      lineCode: req.lineCode ?? this.cfg.commands.defaultLineCode,
      key,
      keyFormat,
      validTime: 0,
    };

    const base = { device_id: device.id, command_type: req.type, cmd_code: cmdCode, lock_id: lockId, params, requested_by: req.requestedBy ?? 'api' };
    const session = this.sessions.getByDeviceId(device.id);
    if (!session) {
      const c = await this.store.insertCommand({ ...base, status: 'send_failed', outcome: 'failure', error: 'Device is not connected' });
      throw new ServiceError(409, 'DEVICE_OFFLINE', 'Device is not connected; command recorded as send_failed', { command: c });
    }
    if (this.cfg.auth.requireAuthForCommands && !session.authenticated) {
      const c = await this.store.insertCommand({ ...base, session_id: session.dbId, status: 'send_failed', outcome: 'failure', error: 'Session not authenticated' });
      throw new ServiceError(409, 'NOT_AUTHENTICATED', 'Device session has not authenticated (0x0102); command recorded as send_failed', { command: c });
    }

    let data;
    try {
      data = encodeLockOperation({ cmd: cmdCode, ...params, time: new Date(), tzOffsetMinutes: this.cfg.device.tzOffsetMinutes });
    } catch (e) {
      throw new ServiceError(400, 'BAD_PARAMS', e.message);
    }
    const businessSerial = this.nextBusinessSerial(device.id);
    const bizFrame = encodeBusinessFrame(data, businessSerial, businessFrameOptions(this.cfg));
    const body = encodePassthrough(PASSTHROUGH_ELOCK, bizFrame);

    let cmd = await this.store.insertCommand({ ...base, session_id: session.dbId, status: 'pending', business_serial: businessSerial, business_tx_hex: toHex(bizFrame) });
    // Register before writing: the device's 0x0001 / 0x0900 may be processed while the TX log insert is still running.
    const pendingKey = `${device.id}:${businessSerial}`;
    const entry = { commandId: cmd.id, deviceId: device.id, sessionId: session.id, type: req.type, cmdCode, jt808Serial: null, businessSerial, key, lockId, acked: false, timer: null };
    this.pending.set(pendingKey, entry);
    const timeoutMs = this.cfg.commands.timeoutS * 1000;
    let sent;
    try {
      sent = await this.send(session, MSG.DOWNLINK_PASSTHROUGH, body, { command: req.type, commandId: cmd.id, businessSerial, cmd: hex8(cmdCode) }, (serial) => {
        entry.jt808Serial = serial;
        entry.timer = setTimeout(() => this.onTimeout(entry), timeoutMs);
      });
    } catch (e) {
      clearTimeout(entry.timer);
      this.pending.delete(pendingKey);
      cmd = await this.store.updateCommand(cmd.id, { status: 'send_failed', outcome: 'failure', error: `Socket write failed: ${e.message}` });
      throw new ServiceError(502, 'SEND_FAILED', e.message, { command: cmd });
    }
    const tx = { sent_at: new Date(), jt808_serial: sent.serial, raw_tx_hex: sent.logRow.raw_hex, tx_message_log_id: sent.logRow.id, timeout_at: new Date(Date.now() + timeoutMs) };
    const stillOpen = this.pending.get(pendingKey) === entry && !entry.acked;
    cmd = await this.store.updateCommand(cmd.id, stillOpen ? { status: 'sent', ...tx } : tx);
    this.log.info(`${req.type} sent device=${device.terminal_id} lock=${lockId} jt808Serial=${sent.serial} businessSerial=${businessSerial} command=${cmd.id}`);
    this.events.emit('command', { deviceId: device.id, command: cmd });
    return cmd;
  }

  /** Resolves with the final command row once it leaves the open states (or after maxMs). */
  waitFor(commandId, maxMs) {
    return new Promise((resolve) => {
      const list = this.waiters.get(commandId) ?? [];
      const timer = setTimeout(async () => resolve(await this.store.getCommand(commandId)), maxMs);
      list.push(async (row) => {
        clearTimeout(timer);
        resolve(row);
      });
      this.waiters.set(commandId, list);
    });
  }

  finish(entry, row) {
    if (entry) {
      clearTimeout(entry.timer);
      this.pending.delete(`${entry.deviceId}:${entry.businessSerial}`);
    }
    const list = this.waiters.get(row.id) ?? [];
    this.waiters.delete(row.id);
    for (const fn of list) fn(row);
    this.events.emit('command', { deviceId: row.device_id, command: row });
  }

  async onTimeout(entry) {
    if (!this.pending.has(`${entry.deviceId}:${entry.businessSerial}`)) return;
    const row = await this.store.updateCommand(entry.commandId, {
      status: 'timeout', outcome: 'timeout', error: `No operation reply (0x0900/0x55) within ${this.cfg.commands.timeoutS}s`,
    });
    this.log.warn(`${entry.type} TIMEOUT command=${entry.commandId} businessSerial=${entry.businessSerial}`);
    this.finish(entry, row);
  }

  /** 0x0001 terminal general response. Only records delivery; result != 0 means the device refused the message. */
  async onTerminalAck(session, device, ack) {
    if (ack.replyId !== MSG.DOWNLINK_PASSTHROUGH) return false;
    const entry = [...this.pending.values()].find((e) => e.sessionId === session.id && e.jt808Serial === ack.replySerial);
    if (!entry) {
      this.log.warn(`0x0001 for 0x8900 serial ${ack.replySerial} matches no open command`);
      return false;
    }
    const label = GENERAL_LABELS[ack.result] ?? `unknown_${ack.result}`;
    entry.acked = true;
    if (ack.result === GENERAL_RESULT.SUCCESS) {
      const row = await this.store.updateCommand(entry.commandId, { status: 'acknowledged', ack_at: new Date(), ack_result: ack.result, ack_result_label: label });
      this.events.emit('command', { deviceId: device.id, command: row });
    } else {
      const row = await this.store.updateCommand(entry.commandId, {
        status: 'rejected', outcome: 'failure', ack_at: new Date(), ack_result: ack.result, ack_result_label: label,
        error: `Device answered 0x8900 with general response result ${ack.result} (${label})`,
      });
      this.log.warn(`${entry.type} REJECTED by device (0x0001 result ${ack.result} ${label}) command=${entry.commandId}`);
      this.finish(entry, row);
    }
    return true;
  }

  /** 0x0900 business frame carrying a 0x55 operation reply. */
  async onOperationReply(session, device, elock, { messageLogId, rawHex }) {
    const reply = elock.payload;
    const result = reply.result;
    const key = `${device.id}:${elock.serial}`;
    let entry = this.pending.get(key);
    let method = entry ? 'business_serial' : null;
    let commandId = entry?.commandId ?? null;

    if (!entry) {
      const late = await this.store.findCommandByBusinessSerial(device.id, elock.serial, { statuses: ['timeout', ...OPEN] });
      if (late && elock.serial !== 0) {
        commandId = late.id;
        method = 'late_business_serial';
      }
    }
    const fromPlatform = reply.commandSource?.source === 'platform';
    if (!commandId && result.command && fromPlatform) {
      // Fallback when the device does not echo the business serial: oldest open command of the matching type.
      // Only for replies whose cmdSRC says "platform" - a keypad/RF/IC-card operation must never complete our command.
      entry = [...this.pending.values()].filter((e) => e.deviceId === device.id && e.type === result.command).sort((a, b) => a.jt808Serial - b.jt808Serial)[0];
      if (entry) {
        commandId = entry.commandId;
        method = 'heuristic_oldest_pending';
        this.log.warn(`operation reply serial ${elock.serial} did not match; correlated by command type to ${commandId} (heuristic)`);
      }
    }

    // Device state is updated from every reply, correlated or not.
    const updatedDevice = await this.telemetry.onLockStatus(device, {
      lockStatus: reply.lockStatus, voltage: reply.voltage, motorStatus: reply.motorStatus, messageLogId, deviceTime: reply.time?.iso ?? null,
    });

    if (!commandId) {
      const oi = reply.operationIdentifier;
      this.log.info(`unsolicited operation reply ${result.hex} (${result.label}) source=${reply.commandSource?.source} ` +
        `opIdent=${oi ? `${oi.mode} hex=${oi.hex}` : 'n/a'} businessSerial=${elock.serial} - not initiated by this platform`);
      this.events.emit('operationReply', { deviceId: device.id, reply });
      return null;
    }

    const cmd = await this.store.getCommand(commandId);
    const errors = [];
    if (reply.lock?.lockId && cmd.lock_id && reply.lock.lockId !== cmd.lock_id) errors.push(`Reply LockID ${reply.lock.lockId} != command LockID ${cmd.lock_id}`);
    if (result.command && result.command !== cmd.command_type) errors.push(`Result code ${result.hex} belongs to ${result.command}, command was ${cmd.command_type}`);

    const row = await this.store.updateCommand(commandId, {
      status: 'completed',
      replied_at: new Date(),
      result_code: result.code,
      result_code_hex: result.hex,
      result_label: result.label,
      result_meaning: result.meaning,
      outcome: errors.length ? 'unknown' : result.outcome,
      reply_message_log_id: messageLogId,
      reply_raw_hex: rawHex,
      reply_parsed: { reply, businessSerial: elock.serial, crcMatches: elock.crcMatches, crcValid: elock.crcValid, lenInterpretations: elock.lenInterpretations, gps: elock.gps ?? null },
      correlation_method: method,
      error: errors.length ? errors.join('; ') : null,
    });
    this.log.info(`${cmd.command_type} REPLY ${result.hex} "${result.label}" outcome=${row.outcome} command=${commandId} (${method})`);

    if (row.outcome === 'success') {
      if (cmd.command_type === 'seal') {
        const params = cmd.params ?? {};
        await this.store.updateDevice(device.id, { current_key: entry?.key ?? params.key ?? updatedDevice.current_key, key_format: params.keyFormat ?? updatedDevice.key_format });
      }
      if (cmd.command_type === 'clear_alarm') await this.telemetry.clearByCommand(device, commandId);
    }
    this.finish(entry?.commandId === commandId ? entry : null, row);
    return row;
  }
}
