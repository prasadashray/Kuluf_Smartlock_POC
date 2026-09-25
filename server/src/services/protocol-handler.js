// Dispatches decoded frames. Every received frame is logged before anything else is done with it.
import { randomBytes } from 'node:crypto';
import {
  decodePacket, decodeBody, MSG, GENERAL_RESULT, REGISTER_RESULT, encodeGeneralResponse, encodeRegistrationResponse,
  encodeSetParams, encodeText, encodePassthrough, encodeBusinessFrame, encodeLockUploadReply, PASSTHROUGH_ELOCK,
  toHex, hex16, messageName,
} from '../protocol/index.js';
import { businessFrameOptions } from '../config/index.js';
import { ServiceError } from './errors.js';

export class ProtocolHandler {
  constructor({ cfg, store, sessions, messageLog, telemetry, logger, events }) {
    this.cfg = cfg;
    this.store = store;
    this.sessions = sessions;
    this.messageLog = messageLog;
    this.telemetry = telemetry;
    this.log = logger.child({ scope: 'handler' });
    this.events = events;
    this.commands = null; // set after construction (circular dependency)
    this.waiters = new Map(); // `${sessionId}:${responseMsgId}:${serial}` -> resolve
  }

  decodeOptions() {
    return { tzOffsetMinutes: this.cfg.device.tzOffsetMinutes, ...businessFrameOptions(this.cfg) };
  }

  /** Encode + write + log one platform message. `onWritten(serial)` runs synchronously right after the socket write. */
  async send(session, msgId, body, parsed = null, onWritten = null) {
    const { serial, frame, unescaped } = session.write(msgId, body);
    onWritten?.(serial);
    const logRow = await this.messageLog.tx(session, { msgId, serial, frame, unescaped, parsed });
    return { serial, frame, logRow };
  }

  async reply(session, header, result = GENERAL_RESULT.SUCCESS) {
    return this.send(session, MSG.PLATFORM_GENERAL_RESPONSE, encodeGeneralResponse({ replySerial: header.serial, replyId: header.msgId, result }), {
      replySerial: header.serial, replyId: hex16(header.msgId), result,
    });
  }

  // ---------- frame entry point ----------

  async handleItem(session, item) {
    const rawHex = `7E${toHex(item.data)}7E`;
    if (item.type === 'garbage') {
      session.counters.rxErrors++;
      await this.messageLog.rx(session, { rawHex: toHex(item.data), processingResult: 'garbage', error: `Bytes outside a frame (${item.reason})` });
      return;
    }
    const packet = decodePacket(item.data);
    if (!packet.ok) {
      session.counters.rxErrors++;
      await this.messageLog.rx(session, { rawHex, packet, processingResult: 'invalid_frame', error: `${packet.errorCode}: ${packet.error}` });
      return; // no acknowledgement for frames that fail validation; the terminal retransmits per its own policy
    }
    session.counters.rxFrames++;
    session.lastRxAt = Date.now();
    const { header } = packet;

    await this.identify(session, packet);
    const parsed = decodeBody(header.msgId, packet.body, { direction: 'uplink', ...this.decodeOptions() });
    const known = Boolean(Object.values(MSG).includes(header.msgId));
    const logRow = await this.messageLog.rx(session, {
      rawHex, packet, parsed,
      processingResult: !known ? 'unsupported' : parsed.ok === false ? 'decode_error' : 'ok',
      error: parsed.ok === false ? parsed.error ?? 'decode error' : null,
    });
    session.device = await this.store.updateDevice(session.device.id, { last_seen_at: new Date(), connection_status: 'online' });

    try {
      await this.dispatch(session, header, parsed, logRow);
    } catch (e) {
      this.log.error(`processing ${hex16(header.msgId)} failed: ${e.stack || e.message}`);
    }
    this.resolveWaiter(session, header, parsed);
    this.events.emit('message', { deviceId: session.device.id, direction: 'rx', msgId: header.msgId });
  }

  async identify(session, packet) {
    const tid = packet.header.terminalId;
    if (session.terminalId === tid && session.device) return;
    if (session.terminalId && session.terminalId !== tid) {
      this.log.warn(`terminal ID changed within one connection: ${session.terminalId} -> ${tid} (${session.remoteLabel})`);
    }
    let device = await this.store.getDeviceByTerminalId(tid);
    if (!device) {
      device = await this.store.createDevice({ terminal_id: tid, key_format: this.cfg.commands.defaultKeyFormat });
      this.log.info(`new device record terminal_id=${tid} (raw ${packet.header.terminal.hex}) from ${session.remoteLabel}`);
    }
    session.terminalId = tid;
    session.terminalRaw = Buffer.from(packet.header.terminal.hex, 'hex');
    this.sessions.bind(session, device);
    session.device = await this.store.updateDevice(device.id, {
      connection_status: 'online', last_connected_at: session.connectedAt, last_remote_address: session.remoteLabel,
    });
    if (session.dbId) await this.store.updateSession(session.dbId, { device_id: device.id, terminal_id: tid });
    this.events.emit('deviceOnline', { deviceId: device.id });
  }

  async dispatch(session, header, parsed, logRow) {
    const ctx = { messageLogId: logRow.id };
    switch (header.msgId) {
      case MSG.HEARTBEAT:
        session.device = await this.store.updateDevice(session.device.id, { last_heartbeat_at: new Date() });
        await this.reply(session, header);
        return;
      case MSG.AUTHENTICATE:
        return this.onAuthenticate(session, header, parsed);
      case MSG.REGISTER:
        return this.onRegister(session, header, parsed);
      case MSG.LOCATION_REPORT:
        await this.reply(session, header, parsed.ok ? GENERAL_RESULT.SUCCESS : GENERAL_RESULT.MESSAGE_ERROR);
        if (parsed.ok) await this.telemetry.onLocation(session.device, parsed, { ...ctx, source: '0x0200' });
        return;
      case MSG.LOCATION_QUERY_RESPONSE:
        if (parsed.ok) await this.telemetry.onLocation(session.device, parsed, { ...ctx, source: '0x0201' });
        return;
      case MSG.TERMINAL_GENERAL_RESPONSE:
        if (parsed.ok && this.commands) await this.commands.onTerminalAck(session, session.device, parsed);
        return;
      case MSG.UPLINK_PASSTHROUGH:
        return this.onUplinkPassthrough(session, header, parsed, logRow);
      case MSG.QUERY_PARAMS_RESPONSE:
        this.log.info(`parameters reported by ${session.terminalId}: ${JSON.stringify(parsed.params?.map((p) => [p.idHex, p.name, p.value]))}`);
        return;
      case MSG.TEXT_UPLOAD:
        this.log.info(`text from ${session.terminalId}: ${parsed.text}`);
        await this.reply(session, header);
        return;
      case MSG.UPGRADE_RESULT:
        await this.reply(session, header);
        return;
      default:
        this.log.warn(`unsupported message ${hex16(header.msgId)} from ${session.terminalId}; body=${toHex(parsed.hex ?? '')}`);
        if (this.cfg.protocol.ackUnknownMessages) await this.reply(session, header, GENERAL_RESULT.NOT_SUPPORTED);
    }
  }

  async onAuthenticate(session, header, auth) {
    const device = session.device;
    let accept = false;
    let reason;
    if (!auth.ok) {
      reason = auth.error;
    } else if (this.cfg.auth.mode === 'accept_all') {
      accept = true;
      reason = 'AUTH_MODE=accept_all';
    } else if ((device.auth_code && auth.authCode === device.auth_code) || this.cfg.auth.allowedCodes.includes(auth.authCode)) {
      accept = true;
      reason = 'code matches stored/allowed code';
    } else {
      reason = 'code not recognised';
    }
    const patch = { authenticated: accept, last_auth_at: new Date() };
    if (accept) {
      patch.auth_code = auth.authCode;
      patch.auth_code_source = device.auth_code === auth.authCode && device.auth_code_source ? device.auth_code_source : 'presented_by_device';
    }
    if (auth.looksLikeFactoryDefault && !device.iccid) patch.iccid = auth.iccidGuess;
    if (auth.looksLikeFactoryDefault && auth.versionGuess && !device.firmware_version) patch.firmware_version = auth.versionGuess;
    session.device = await this.store.updateDevice(device.id, patch);
    session.authenticated = accept;
    if (session.dbId && accept) await this.store.updateSession(session.dbId, { authenticated_at: new Date() });
    this.log.info(`authentication ${accept ? 'ACCEPTED' : 'REJECTED'} terminal=${session.terminalId} code="${auth.authCode}" (${reason})`);
    await this.reply(session, header, accept ? GENERAL_RESULT.SUCCESS : GENERAL_RESULT.FAILURE);
    if (accept && this.cfg.timeSync.enabled) {
      setTimeout(() => session.enqueue(() => this.sendTimeSync(session).catch((e) => this.log.warn(`time sync failed: ${e.message}`))), this.cfg.timeSync.delayMs);
    }
    this.events.emit('authenticated', { deviceId: device.id, accepted: accept });
  }

  async onRegister(session, header, reg) {
    const device = session.device;
    if (reg.iccid) session.device = await this.store.updateDevice(device.id, { iccid: reg.iccid });
    if (this.cfg.auth.registration === 'reject') {
      this.log.warn(`registration from ${session.terminalId} rejected (REGISTRATION_MODE=reject)`);
      await this.send(session, MSG.REGISTER_RESPONSE, encodeRegistrationResponse({ replySerial: header.serial, result: REGISTER_RESULT.NO_TERMINAL }), { result: REGISTER_RESULT.NO_TERMINAL });
      return;
    }
    const code = `IL${randomBytes(5).toString('hex').toUpperCase()}`;
    session.device = await this.store.updateDevice(device.id, { auth_code: code, auth_code_source: 'issued_by_platform' });
    this.log.info(`registration from ${session.terminalId} iccid=${reg.iccid}; issued authentication code ${code}`);
    await this.send(session, MSG.REGISTER_RESPONSE, encodeRegistrationResponse({ replySerial: header.serial, result: REGISTER_RESULT.SUCCESS, authCode: code }), {
      result: REGISTER_RESULT.SUCCESS, authCode: code,
    });
  }

  async onUplinkPassthrough(session, header, parsed, logRow) {
    const elock = parsed.elock;
    if (!parsed.ok || !elock) {
      await this.reply(session, header, parsed.ok ? GENERAL_RESULT.SUCCESS : GENERAL_RESULT.MESSAGE_ERROR);
      if (!elock) this.log.warn(`0x0900 passthrough type ${parsed.typeHex ?? '?'} is not e-lock data; kept raw only`);
      return;
    }
    this.logBusinessEvidence(session, elock);
    if (elock.crcValid === false && this.cfg.business.crcEnforce) {
      this.log.error(`business CRC mismatch and BIZ_CRC_ENFORCE=true: frame not processed`);
      await this.reply(session, header, GENERAL_RESULT.MESSAGE_ERROR);
      return;
    }
    await this.reply(session, header);
    const payload = elock.payload;
    const ctx = { messageLogId: logRow.id, rawHex: logRow.raw_hex };

    const lockId = payload?.lock?.lockId;
    if (lockId && session.device.lock_id !== lockId) {
      if (!session.device.lock_id) {
        try {
          session.device = await this.store.updateDevice(session.device.id, { lock_id: lockId });
          this.log.info(`LockID ${lockId} learned for terminal ${session.terminalId} from 0x0900`);
        } catch (e) {
          this.log.error(`cannot set LockID ${lockId} on terminal ${session.terminalId}: ${e.message}`);
        }
      } else {
        this.log.warn(`0x0900 LockID ${lockId} differs from stored LockID ${session.device.lock_id} for terminal ${session.terminalId}`);
      }
    }

    if (elock.gps?.ok) await this.telemetry.onLocation(session.device, elock.gps, { messageLogId: logRow.id, source: '0x0900_gps' });

    if (payload?.type === 'operation_reply') {
      await this.commands?.onOperationReply(session, session.device, elock, ctx);
    } else if (payload?.type === 'lock_upload') {
      session.device = await this.telemetry.onLockUpload(session.device, payload, ctx);
      if (this.cfg.business.replyToLockUpload && payload.lock?.valid) {
        const data = encodeLockUploadReply({ subCmd: payload.subCmd, lockId: payload.lock.lockId, time: new Date(), tzOffsetMinutes: this.cfg.device.tzOffsetMinutes });
        const frame = encodeBusinessFrame(data, elock.serial, businessFrameOptions(this.cfg));
        await this.send(session, MSG.DOWNLINK_PASSTHROUGH, encodePassthrough(PASSTHROUGH_ELOCK, frame), { businessReply: '0x61', subCmd: payload.subCmdHex });
      }
    } else {
      this.log.warn(`unhandled e-lock business data ${elock.dataHex}`);
    }
  }

  /** Hardware-validation evidence for DOC-06 / DOC-07: logged for every uplink business frame. */
  logBusinessEvidence(session, elock) {
    const msg = `business frame evidence terminal=${session.terminalId} len=0x${elock.lenByte.toString(16)} lenMatches=[${elock.lenInterpretations}] ` +
      `crc=0x${elock.crcReceived.toString(16)} crcMatches=[${elock.crcMatches}] configured=${elock.crcConfigured} valid=${elock.crcValid}`;
    if (elock.crcValid === false || !elock.lenMatchesConfigured) this.log.warn(msg);
    else this.log.info(msg);
    for (const w of elock.warnings) this.log.warn(`business frame: ${w}`);
  }

  // ---------- platform-initiated diagnostics ----------

  async sendTimeSync(session) {
    if (session.closed) return null;
    const body = encodeSetParams([{ id: 0x002a, value: new Date() }], { tzOffsetMinutes: this.cfg.device.tzOffsetMinutes });
    this.log.info(`time sync (0x8103 param 0x002A) -> ${session.terminalId}`);
    return this.send(session, MSG.SET_PARAMS, body, { params: ['0x002A device_time'], tzOffsetMinutes: this.cfg.device.tzOffsetMinutes });
  }

  waitForResponse(session, responseMsgId, serial, timeoutMs) {
    return new Promise((resolve, reject) => {
      const key = `${session.id}:${responseMsgId}:${serial}`;
      const t = setTimeout(() => {
        this.waiters.delete(key);
        reject(new ServiceError(504, 'NO_RESPONSE', `No ${hex16(responseMsgId)} (${messageName(responseMsgId)}) within ${timeoutMs} ms`));
      }, timeoutMs);
      this.waiters.set(key, (r) => {
        clearTimeout(t);
        resolve(r);
      });
    });
  }

  resolveWaiter(session, header, parsed) {
    let serial = null;
    if (header.msgId === MSG.TERMINAL_GENERAL_RESPONSE) serial = parsed.replySerial;
    else if (header.msgId === MSG.QUERY_PARAMS_RESPONSE || header.msgId === MSG.LOCATION_QUERY_RESPONSE) serial = parsed.replySerial;
    if (serial === null || serial === undefined) return;
    const key = `${session.id}:${header.msgId}:${serial}`;
    const fn = this.waiters.get(key);
    if (fn) {
      this.waiters.delete(key);
      fn({ header, body: parsed });
    }
  }

  /** Send a diagnostic request and wait for its response message. */
  async request(deviceId, kind, args = {}, timeoutMs = 15000) {
    const session = this.sessions.getByDeviceId(deviceId);
    if (!session) throw new ServiceError(409, 'DEVICE_OFFLINE', 'Device is not connected');
    const enqueueSend = (msgId, body, meta) => new Promise((resolve, reject) => {
      session.enqueue(() => this.send(session, msgId, body, meta).then(resolve, reject));
    });
    switch (kind) {
      case 'query_params': {
        const { serial } = await enqueueSend(MSG.QUERY_PARAMS, Buffer.alloc(0), { request: 'query all parameters' });
        return this.waitForResponse(session, MSG.QUERY_PARAMS_RESPONSE, serial, timeoutMs);
      }
      case 'query_location': {
        const { serial } = await enqueueSend(MSG.LOCATION_QUERY, Buffer.alloc(0), { request: 'location query' });
        return this.waitForResponse(session, MSG.LOCATION_QUERY_RESPONSE, serial, timeoutMs);
      }
      case 'time_sync': {
        const { serial } = await new Promise((resolve, reject) => session.enqueue(() => this.sendTimeSync(session).then(resolve, reject)));
        return this.waitForResponse(session, MSG.TERMINAL_GENERAL_RESPONSE, serial, timeoutMs);
      }
      case 'text': {
        if (!args.text) throw new ServiceError(400, 'BAD_PARAMS', 'text is required');
        let body;
        try {
          body = encodeText({ flag: args.flag ?? 0x01, text: args.text });
        } catch (e) {
          throw new ServiceError(400, 'BAD_PARAMS', e.message);
        }
        const { serial } = await enqueueSend(MSG.TEXT_DOWNLINK, body, { text: args.text });
        return this.waitForResponse(session, MSG.TERMINAL_GENERAL_RESPONSE, serial, timeoutMs);
      }
      default:
        throw new ServiceError(400, 'BAD_REQUEST', `Unknown diagnostic ${kind}`);
    }
  }

  // ---------- disconnect / offline ----------

  async onDisconnect(session) {
    this.sessions.remove(session);
    const reason = session.closeReason ?? 'closed_by_peer';
    if (session.dbId) {
      await this.store.updateSession(session.dbId, {
        disconnected_at: new Date(), disconnect_reason: reason,
        rx_frames: session.counters.rxFrames, tx_frames: session.counters.txFrames, rx_errors: session.counters.rxErrors,
      });
    }
    if (session.device && !this.sessions.getByDeviceId(session.device.id)) {
      await this.store.updateDevice(session.device.id, {
        connection_status: 'offline', authenticated: false, last_disconnected_at: new Date(), last_disconnect_reason: reason,
      });
      this.events.emit('deviceOffline', { deviceId: session.device.id, reason });
    }
    this.log.info(`session closed ${session.remoteLabel} terminal=${session.terminalId ?? '?'} reason=${reason} rx=${session.counters.rxFrames} tx=${session.counters.txFrames} errors=${session.counters.rxErrors}`);
  }
}
