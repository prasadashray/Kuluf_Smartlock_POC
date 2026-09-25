// Simulated TT ELOCK terminal. Uses the server's protocol library for every byte it sends or parses, so the simulator
// cannot drift from the real implementation. Behaviour that the documents do not define is kept minimal and flagged.
import net from 'node:net';
import { EventEmitter } from 'node:events';
import {
  FrameDecoder, encodePacket, decodePacket, decodeBody, MSG, GENERAL_RESULT,
  encodeGeneralResponse, encodeAuthentication, encodeRegistration, encodeLocationReport, encodeLocationBasic,
  encodePassthrough, encodeBusinessFrame, encodeOperationReply, encodeLockUpload,
  encodeSetParams, encodeText, encodeKey, PASSTHROUGH_ELOCK, LOCK_CMD, toHex, hex16, messageName,
} from '../server/src/protocol/index.js';

const LOCK_STATUS = { sealed: 0x40, unsealed: 0x60, standby: 0x20, alarm_released: 0x90 };

export class SimulatedDevice extends EventEmitter {
  constructor(opts) {
    super();
    this.o = {
      host: '127.0.0.1',
      port: 6808,
      terminalId: '000082637294',
      lockId: '82637294',
      iccid: '89910000000000000001',
      version: 'SIM-1.0',
      authCode: null,
      forceRegister: false,
      heartbeatS: 30,
      locationS: 60,
      lockUploadS: 0,
      lat: 28.613939,
      lon: 77.209021,
      moving: false,
      replyDelayMs: 1000,
      noReply: false,
      replyWithGps: true,
      keyFormat: 'rf10',
      initialState: 'unsealed',
      initialKey: null,
      lowBattery: false,
      tamper: false,
      business: {},
      tzOffsetMinutes: 480,
      verbose: false,
      ...opts,
    };
    this.serial = 0;
    this.authCode = this.o.authCode;
    this.authenticated = false;
    this.timers = [];
    this.pending = new Map(); // our serial -> resolver for 0x8001
    this.lock = {
      state: this.o.initialState, // sealed | unsealed | alarm
      stateBeforeAlarm: null,
      key: this.o.initialKey ? encodeKey(this.o.initialKey, this.o.keyFormat) : null,
      voltage: this.o.lowBattery ? 0x30 : 0x36,
      alarmBits: 0, // LockStatus low nibble when in alarm
    };
    this.position = { lat: this.o.lat, lon: this.o.lon, speed: 0, dir: 0 };
    if (this.o.tamper) this.raiseTamper(false);
    this.received = [];
  }

  log(...a) {
    if (this.o.verbose) console.log(`[sim ${this.o.terminalId}]`, ...a);
  }

  nextSerial() {
    const s = this.serial;
    this.serial = (this.serial + 1) & 0xffff;
    return s;
  }

  lockStatusByte() {
    if (this.lock.state === 'alarm') return 0x70 | (this.lock.alarmBits & 0x0f);
    return LOCK_STATUS[this.lock.state] ?? 0x20;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.decoder = new FrameDecoder();
      this.socket = net.createConnection({ host: this.o.host, port: this.o.port }, async () => {
        this.log('connected');
        this.emit('connected');
        try {
          await this.handshake();
          this.startTimers();
          resolve(this);
        } catch (e) {
          reject(e);
        }
      });
      this.socket.on('data', (chunk) => this.onData(chunk));
      this.socket.on('error', (e) => {
        this.log('socket error', e.message);
        this.emit('socketError', e);
        reject(e);
      });
      this.socket.on('close', () => {
        this.stopTimers();
        this.authenticated = false;
        this.emit('closed');
      });
    });
  }

  close() {
    this.stopTimers();
    if (this.socket) this.socket.destroy();
  }

  send(msgId, body = Buffer.alloc(0)) {
    const serial = this.nextSerial();
    const { frame } = encodePacket({ msgId, terminalId: this.o.terminalId, serial, body });
    this.log('TX', hex16(msgId), messageName(msgId), toHex(frame));
    this.socket.write(frame);
    return serial;
  }

  /** Send and wait for the platform general response (0x8001) to that serial. */
  sendAwait(msgId, body, timeoutMs = 5000) {
    const serial = this.send(msgId, body);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(serial);
        reject(new Error(`No 0x8001 for ${hex16(msgId)} serial ${serial}`));
      }, timeoutMs);
      this.pending.set(serial, (r) => {
        clearTimeout(t);
        resolve(r);
      });
    });
  }

  async handshake() {
    // §8.8 note 1: a terminal without an issued code authenticates with ICCID + version.
    const initial = this.authCode ?? `${this.o.iccid}${this.o.version}`;
    if (!this.o.forceRegister) {
      const r = await this.sendAwait(MSG.AUTHENTICATE, encodeAuthentication({ authCode: initial }));
      if (r.result === GENERAL_RESULT.SUCCESS) {
        this.authenticated = true;
        this.emit('authenticated', { authCode: initial });
        return;
      }
    }
    // §8.5 note: registration is sent only when authentication fails.
    this.authCode = await this.register();
    const r = await this.sendAwait(MSG.AUTHENTICATE, encodeAuthentication({ authCode: this.authCode }));
    if (r.result !== GENERAL_RESULT.SUCCESS) throw new Error(`Authentication rejected (result ${r.result})`);
    this.authenticated = true;
    this.emit('authenticated', { authCode: this.authCode });
  }

  register() {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('No 0x8100 registration response')), 5000);
      this.once('registrationResponse', (r) => {
        clearTimeout(t);
        if (r.result !== 0 || !r.authCode) reject(new Error(`Registration refused (result ${r.result})`));
        else resolve(r.authCode);
      });
      this.send(MSG.REGISTER, encodeRegistration({ iccid: this.o.iccid }));
    });
  }

  startTimers() {
    if (this.o.heartbeatS > 0) this.timers.push(setInterval(() => this.heartbeat(), this.o.heartbeatS * 1000));
    if (this.o.locationS > 0) {
      this.timers.push(setInterval(() => this.sendLocation(), this.o.locationS * 1000));
      setImmediate(() => this.sendLocation());
    }
    if (this.o.lockUploadS > 0) this.timers.push(setInterval(() => this.sendLockUpload(0x01), this.o.lockUploadS * 1000));
  }

  stopTimers() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  heartbeat() {
    return this.send(MSG.HEARTBEAT);
  }

  locationFields(extra = {}) {
    if (this.o.moving) {
      this.position.lat += 0.0005;
      this.position.lon += 0.0003;
      this.position.speed = 32.4;
      this.position.dir = 31;
    }
    return {
      latitude: this.position.lat,
      longitude: this.position.lon,
      altitudeM: 216,
      speedKmh: this.position.speed,
      directionDeg: this.position.dir,
      time: new Date(),
      positioned: true,
      lockStatus: this.lockStatusByte(),
      alarmFlags: 0,
      tzOffsetMinutes: this.o.tzOffsetMinutes,
      ...extra,
    };
  }

  additionalItems() {
    const batteryPct = this.lock.voltage <= 0x30 ? 5 : 80;
    const e7 = this.lock.state === 'alarm' && this.lock.alarmBits & 0x01 ? 0x000001 : 0;
    return [
      { id: 0x30, value: Buffer.from([24]) },
      { id: 0x31, value: Buffer.from([9]) },
      { id: 0xe9, value: Buffer.from([batteryPct]) },
      { id: 0xe7, value: Buffer.from([(e7 >> 16) & 0xff, (e7 >> 8) & 0xff, e7 & 0xff]) },
      { id: 0x5d, value: Buffer.from('0101945A123401501234' + '1F', 'hex') },
    ];
  }

  sendLocation(extra = {}) {
    return this.send(MSG.LOCATION_REPORT, encodeLocationReport(this.locationFields(extra), this.additionalItems()));
  }

  gpsAdditional() {
    if (!this.o.replyWithGps) return null;
    return Buffer.concat([encodeLocationBasic(this.locationFields()), Buffer.from('01945A1234015012341F', 'hex')]);
  }

  sendBusiness(data, businessSerial) {
    const frame = encodeBusinessFrame(data, businessSerial, { ...this.o.business, additional: this.gpsAdditional() });
    return this.send(MSG.UPLINK_PASSTHROUGH, encodePassthrough(PASSTHROUGH_ELOCK, frame));
  }

  sendLockUpload(subCmd = 0x01) {
    const data = encodeLockUpload({
      subCmd, lockId: this.o.lockId, voltage: this.lock.voltage, lockStatus: this.lockStatusByte(), time: new Date(), tzOffsetMinutes: this.o.tzOffsetMinutes,
    });
    return this.sendBusiness(data, 0x0000);
  }

  /** Simulate a lock rod cut: lock goes into alarm state, active upload + location report with E7 cable-cut bit. */
  raiseTamper(report = true) {
    if (this.lock.state !== 'alarm') this.lock.stateBeforeAlarm = this.lock.state;
    this.lock.state = 'alarm';
    this.lock.alarmBits |= 0x01; // Appendix 3 bit0: lock rod cut
    if (report && this.socket) {
      this.sendLockUpload(0x04);
      this.sendLocation();
    }
  }

  /**
   * Simulate someone operating the lock on its keypad. The lock reports an unsolicited 0x55 with cmdSRC 0x02 (keypad),
   * operation identifier 'K' + opcode + entered password (§10.2.1 note 1) and business serial 0x0000.
   */
  keypadOperation(cmd = LOCK_CMD.UNSEAL, password = Buffer.from('000000', 'ascii')) {
    let resultCode;
    let lockStatus;
    if (cmd === LOCK_CMD.UNSEAL) {
      resultCode = this.lock.state === 'sealed' ? 0x90 : 0x97;
      if (resultCode === 0x90) this.lock.state = 'unsealed';
      lockStatus = 0xb0; // Appendix 3: locally unsealed
    } else {
      resultCode = this.lock.state === 'sealed' ? 0x81 : 0x80;
      this.lock.state = 'sealed';
      lockStatus = 0x50; // Appendix 3: locally sealed
    }
    const pw = Buffer.alloc(6);
    Buffer.from(password).copy(pw, 0, 0, 6);
    const reply = encodeOperationReply({
      resultCode, lockId: this.o.lockId, voltage: this.lock.voltage, lockStatus, motorStatus: 0,
      operationIdentifier: Buffer.concat([Buffer.from('K'), Buffer.from([cmd]), pw]),
      commandSource: 0x02, time: new Date(), tzOffsetMinutes: this.o.tzOffsetMinutes,
    });
    return this.sendBusiness(reply, 0x0000);
  }

  setLowBattery(on = true) {
    this.lock.voltage = on ? 0x30 : 0x36;
  }

  onData(chunk) {
    for (const item of this.decoder.push(chunk)) {
      if (item.type !== 'frame') continue;
      const p = decodePacket(item.data);
      if (!p.ok) {
        this.log('RX invalid', p.error);
        continue;
      }
      const body = decodeBody(p.header.msgId, p.body, { direction: 'downlink', ...this.o.business, tzOffsetMinutes: this.o.tzOffsetMinutes });
      this.log('RX', p.header.msgIdHex, messageName(p.header.msgId), toHex(p.body));
      this.received.push({ header: p.header, body });
      this.emit('message', { header: p.header, body });
      this.handle(p.header, body, p.body);
    }
  }

  ack(header, result = GENERAL_RESULT.SUCCESS) {
    this.send(MSG.TERMINAL_GENERAL_RESPONSE, encodeGeneralResponse({ replySerial: header.serial, replyId: header.msgId, result }));
  }

  handle(header, body) {
    switch (header.msgId) {
      case MSG.PLATFORM_GENERAL_RESPONSE: {
        const fn = this.pending.get(body.replySerial);
        if (fn) {
          this.pending.delete(body.replySerial);
          fn(body);
        }
        break;
      }
      case MSG.REGISTER_RESPONSE:
        this.emit('registrationResponse', body);
        break;
      case MSG.SET_PARAMS:
        this.ack(header);
        this.emit('setParams', body);
        break;
      case MSG.QUERY_PARAMS: {
        // 0x0104 body = reply serial + (count + parameter list), the same list format as 0x8103.
        const params = encodeSetParams([
          { id: 0x0001, value: this.o.heartbeatS },
          { id: 0x0013, value: this.o.host },
          { id: 0x0018, value: this.o.port },
          { id: 0x0010, value: 'simulated.apn' },
        ]);
        const head = Buffer.alloc(2);
        head.writeUInt16BE(header.serial);
        this.send(MSG.QUERY_PARAMS_RESPONSE, Buffer.concat([head, params]));
        break;
      }
      case MSG.LOCATION_QUERY: {
        const head = Buffer.alloc(2);
        head.writeUInt16BE(header.serial);
        this.send(MSG.LOCATION_QUERY_RESPONSE, Buffer.concat([head, encodeLocationReport(this.locationFields(), this.additionalItems())]));
        break;
      }
      case MSG.TEXT_DOWNLINK:
        this.ack(header);
        this.send(MSG.TEXT_UPLOAD, encodeText({ flag: 4, text: `SIM:${body.text}=OK` }));
        break;
      case MSG.DOWNLINK_PASSTHROUGH:
        this.handlePassthrough(header, body);
        break;
      default:
        this.ack(header, GENERAL_RESULT.NOT_SUPPORTED);
    }
  }

  handlePassthrough(header, body) {
    if (!body.ok || !body.elock?.ok || body.elock.payload?.type !== 'lock_operation') {
      this.ack(header, GENERAL_RESULT.MESSAGE_ERROR);
      return;
    }
    this.ack(header);
    if (this.o.noReply) return;
    const op = body.elock.payload;
    const bizSerial = body.elock.serial;
    const rawData = body.elock.data;
    setTimeout(() => {
      const resultCode = this.applyLockOperation(op, rawData);
      if (resultCode === null) return;
      const opIdent = Buffer.concat([Buffer.from('C'), Buffer.from([op.cmd]), rawData.subarray(17, 23)]);
      const reply = encodeOperationReply({
        resultCode,
        lockId: rawData.subarray(2, 6),
        gate: op.gate,
        bill: rawData.subarray(7, 15),
        voltage: this.lock.voltage,
        lockStatus: this.lockStatusByte(),
        motorStatus: 0x00,
        lineCode: rawData.subarray(15, 17),
        operationIdentifier: opIdent,
        commandSource: 0x04,
        time: new Date(),
        tzOffsetMinutes: this.o.tzOffsetMinutes,
      });
      this.sendBusiness(reply, bizSerial);
      this.emit('operation', { cmd: op.cmd, resultCode, state: this.lock.state });
    }, this.o.replyDelayMs);
  }

  /**
   * Lock state machine following Appendix 1 result codes. Returns the result code, or null for no business reply.
   * The documents do not say how a lock treats a command for another LockID; the simulator stays silent (assumption).
   */
  applyLockOperation(op, rawData) {
    const key = rawData.subarray(17, 23);
    const L = this.lock;
    if (op.lock.lockId !== this.o.lockId) return null;
    switch (op.cmd) {
      case LOCK_CMD.SEAL:
        if (L.state === 'alarm') return 0x86; // lock rod cut alarm, not sealed
        if (L.voltage <= 0x30) return 0x83; // voltage too low
        if (L.state === 'sealed') return 0x81; // repeat seal
        L.state = 'sealed';
        L.key = Buffer.from(key);
        return 0x80;
      case LOCK_CMD.UNSEAL:
        if (L.state === 'alarm') return 0x98; // cut alarm, not unsealed
        if (L.state !== 'sealed') return 0x97; // unseal without sealing
        if (L.key && !L.key.equals(key)) return 0x93; // key mismatch
        L.state = 'unsealed';
        return 0x90;
      case LOCK_CMD.CLEAR_ALARM:
        if (L.state !== 'alarm') return 0x72; // lock not in alarm state
        if (L.stateBeforeAlarm === 'sealed' && L.key && !L.key.equals(key)) return 0x73;
        L.state = L.stateBeforeAlarm === 'sealed' ? 'sealed' : 'unsealed';
        L.alarmBits = 0;
        return 0x70;
      default:
        return 0x00;
    }
  }
}
