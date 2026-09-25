// §10 TT electronic lock business protocol, carried in 0x8900 / 0x0900 with passthrough type 0x81.
//
//   Uplink:   LEN | 0x2A | business data | 0x23 | [28B GPS + 7B/10B LBS] | serial(2) | CRC(1)
//   Downlink: LEN | 0x2A | business data | 0x23 | serial(2) | CRC(1)
//
// Field encodings: Appendix 0. Result codes: Appendix 1. Lock status: Appendix 3.
// LEN semantics and the CRC algorithm are not fully specified (DOC-06, DOC-07) - see `DEFAULT_FRAME_OPTIONS`.
import { ProtocolError } from './errors.js';
import { toHex, hex8, decodeBcdTime, encodeBcdTime, isPrintableAscii, fromHex } from './bytes.js';
import { computeCrc, CRC_ALGORITHMS } from './crc.js';
import { decodeLocationBasic } from './location.js';

// location.js imports from this module; a local constant avoids a TDZ error in the import cycle.
const LOCATION_BASIC_LENGTH = 28;

export const PASSTHROUGH_ELOCK = 0x81;
export const BIZ_HEAD = 0x2a; // '*'
export const BIZ_TAIL = 0x23; // '#'

export const OP = {
  LOCK_OPERATION: 0x15, // downlink seal/unseal/clear alarm/passwords
  OPERATION_REPLY: 0x55, // uplink reply to 0x15
  LOCK_UPLOAD: 0x01, // uplink active upload (§10.3)
  LOCK_UPLOAD_REPLY: 0x61, // downlink "normal reply" to 0x01
  BINDING: 0x12, // downlink binding-type commands (7B lock only)
  BINDING_REPLY: 0x52,
};

export const LOCK_CMD = {
  SEAL: 0x32,
  UNSEAL: 0x38,
  CLEAR_ALARM: 0x42,
  SET_DYNAMIC_PASSWORD: 0xa0,
  MODIFY_LOCAL_PASSWORD: 0xa2,
};

export const COMMAND_TYPES = {
  seal: LOCK_CMD.SEAL,
  unseal: LOCK_CMD.UNSEAL,
  clear_alarm: LOCK_CMD.CLEAR_ALARM,
  set_dynamic_password: LOCK_CMD.SET_DYNAMIC_PASSWORD,
  modify_local_password: LOCK_CMD.MODIFY_LOCAL_PASSWORD,
};

export const COMMAND_TYPE_BY_CODE = Object.fromEntries(Object.entries(COMMAND_TYPES).map(([k, v]) => [v, k]));

// Appendix 1. In the 0x55 operation reply the `Cmd` byte carries the result code.
// outcome: success | no_change | failure | timeout
export const RESULT_CODES = {
  0x80: { command: 'seal', outcome: 'success', label: 'Sealed', meaning: 'Seal success' },
  0x81: { command: 'seal', outcome: 'no_change', label: 'Already sealed', meaning: 'Repeat seal' },
  0x82: { command: 'seal', outcome: 'failure', label: 'Seal failed: lock not closed', meaning: 'Lock not locked properly, seal failed' },
  0x83: { command: 'seal', outcome: 'failure', label: 'Seal failed: low battery', meaning: 'Voltage too low, cannot seal' },
  0x84: { command: 'seal', outcome: 'failure', label: 'Seal refused: housing opened', meaning: 'Lock abnormal: housing illegally disassembled, not sealed' },
  0x85: { command: 'seal', outcome: 'failure', label: 'Seal refused: emergency unlock', meaning: 'Lock abnormal: emergency unlock, not sealed' },
  0x86: { command: 'seal', outcome: 'failure', label: 'Seal refused: lock rod cut', meaning: 'Lock rod cut alarm, not sealed' },
  0x87: { command: 'seal', outcome: 'failure', label: 'Seal refused: lock rod open', meaning: 'Lock open alarm, not sealed' },
  0x89: { command: 'seal', outcome: 'timeout', label: 'Seal failed: timeout', meaning: 'Seal timeout' },
  0x90: { command: 'unseal', outcome: 'success', label: 'Unsealed', meaning: 'Unseal success' },
  0x91: { command: 'unseal', outcome: 'no_change', label: 'Already unsealed', meaning: 'Repeat unseal' },
  0x92: { command: 'unseal', outcome: 'failure', label: 'Unseal failed: lock is open', meaning: 'Lock in open state when unsealing' },
  0x93: { command: 'unseal', outcome: 'failure', label: 'Unseal failed: wrong key', meaning: 'Key mismatch, unseal failed' },
  0x94: { command: 'unseal', outcome: 'failure', label: 'Unseal refused: housing opened', meaning: 'Lock abnormal: housing illegally disassembled, not unsealed' },
  0x95: { command: 'unseal', outcome: 'failure', label: 'Unseal refused: emergency unlock', meaning: 'Lock abnormal: emergency unlock, not unsealed' },
  0x96: { command: 'unseal', outcome: 'failure', label: 'Unseal refused: open alarm', meaning: 'Open alarm, not unsealed' },
  0x97: { command: 'unseal', outcome: 'no_change', label: 'Not sealed yet', meaning: 'Unseal without sealing' },
  0x98: { command: 'unseal', outcome: 'failure', label: 'Unseal refused: cut alarm', meaning: 'Cut alarm, not unsealed' },
  0x99: { command: 'unseal', outcome: 'timeout', label: 'Unseal failed: timeout', meaning: 'Unseal timeout' },
  0x70: { command: 'clear_alarm', outcome: 'success', label: 'Alarm cleared', meaning: 'Alarm release success' },
  0x71: { command: 'clear_alarm', outcome: 'timeout', label: 'Clear alarm failed: timeout', meaning: 'Alarm release timeout' },
  0x72: { command: 'clear_alarm', outcome: 'no_change', label: 'Lock not in alarm state', meaning: 'Lock not in alarm state' },
  0x73: { command: 'clear_alarm', outcome: 'failure', label: 'Clear alarm failed: wrong key', meaning: 'Key mismatch, not released' },
  0x74: { command: 'clear_alarm', outcome: 'failure', label: 'Clear alarm refused: housing opened', meaning: 'Lock abnormal: housing illegally opened, not released' },
  0x75: { command: 'clear_alarm', outcome: 'failure', label: 'Clear alarm refused: emergency unlock', meaning: 'Lock abnormal: emergency unlock, not released' },
  0xa1: { command: 'set_dynamic_password', outcome: 'success', label: 'Dynamic password set', meaning: 'Set dynamic password success' },
  0xa3: { command: 'modify_local_password', outcome: 'success', label: 'Local password changed', meaning: 'Modify local password success' },
};

export function describeResultCode(code) {
  const def = RESULT_CODES[code];
  return {
    code,
    hex: hex8(code),
    known: Boolean(def),
    command: def?.command ?? null,
    outcome: def?.outcome ?? 'unknown',
    label: def?.label ?? `Unknown result code ${hex8(code)}`,
    meaning: def?.meaning ?? null,
  };
}

// Appendix 3 - LockStatus high nibble.
const LOCK_STATES = {
  0x1: { state: 'open', label: 'Open' },
  0x2: { state: 'standby', label: 'Standby' },
  0x3: { state: 'not_closed', label: 'Not closed properly' },
  0x4: { state: 'sealed', label: 'Sealed' },
  0x5: { state: 'sealed_local', label: 'Sealed (local)' },
  0x6: { state: 'unsealed', label: 'Unsealed' },
  0xb: { state: 'unsealed_local', label: 'Unsealed (local)' },
  0x7: { state: 'alarm', label: 'Alarm' },
  0x8: { state: 'alarm_local', label: 'Alarm (local)' },
  0x9: { state: 'alarm_released', label: 'Alarm released' },
  0xa: { state: 'abnormal', label: 'Abnormal' },
};

const LOCK_STATUS_ALARM_BITS = { 0: 'lock_rod_cut', 1: 'opened', 2: 'shell_removed', 3: 'knob_damaged' };

export function describeLockStatus(code) {
  const hi = (code >> 4) & 0x0f;
  const lo = code & 0x0f;
  const def = LOCK_STATES[hi];
  const alarmBits = [];
  if (hi === 0x7 || hi === 0x8) {
    for (const [bit, key] of Object.entries(LOCK_STATUS_ALARM_BITS)) if ((lo >> Number(bit)) & 1) alarmBits.push(key);
  }
  return {
    code,
    hex: hex8(code),
    state: def?.state ?? 'unknown',
    label: def?.label ?? `Unknown lock status ${hex8(code)}`,
    lowNibble: lo,
    alarmBits,
  };
}

// Appendix 0 - Voltage (ordinary padlock).
const VOLTAGES = {
  0x30: { volts: 3.3, label: 'Critical - severe low battery', level: 'critical' },
  0x31: { volts: 3.6, label: 'Low battery', level: 'low' },
  0x32: { volts: 3.7, label: 'Normal', level: 'normal' },
  0x33: { volts: 3.8, label: 'Normal', level: 'normal' },
  0x34: { volts: 3.9, label: 'Normal', level: 'normal' },
  0x35: { volts: 4.0, label: 'Normal', level: 'normal' },
  0x36: { volts: 4.1, label: 'Normal', level: 'normal' },
  0x37: { volts: 4.2, label: 'Fully charged', level: 'full' },
};

export function describeVoltage(code) {
  const def = VOLTAGES[code];
  return { code, hex: hex8(code), volts: def?.volts ?? null, label: def?.label ?? `Unknown voltage code ${hex8(code)}`, level: def?.level ?? 'unknown' };
}

const CMD_SOURCES = { 0x00: 'sms', 0x01: 'automatic', 0x02: 'keypad', 0x03: 'handheld', 0x04: 'platform', 0x05: 'checkpoint', 0x06: 'ic_card' };

export function describeCommandSource(code) {
  return { code, hex: hex8(code), source: CMD_SOURCES[code] ?? (code >= 0x07 && code <= 0x0f ? 'other' : 'unknown') };
}

// ---------- Appendix 0 field encodings ----------

/** LockID: 8 decimal digits; first and last 4 digits each converted to a WORD. 83181001 -> 0x207E03E9. */
export function encodeLockId(lockId) {
  const s = String(lockId);
  if (!/^\d{8}$/.test(s)) throw new ProtocolError('BAD_LOCK_ID', `LockID must be exactly 8 digits, got "${s}"`);
  const b = Buffer.alloc(4);
  b.writeUInt16BE(Number(s.slice(0, 4)), 0);
  b.writeUInt16BE(Number(s.slice(4)), 2);
  return b;
}

export function decodeLockId(buf) {
  const hi = buf.readUInt16BE(0);
  const lo = buf.readUInt16BE(2);
  const valid = hi <= 9999 && lo <= 9999;
  return { lockId: valid ? `${String(hi).padStart(4, '0')}${String(lo).padStart(4, '0')}` : null, hex: toHex(buf), valid };
}

export const KEY_FORMATS = ['rf10', 'ascii6', 'hex'];

/**
 * Key (6 bytes). Appendix 0 (Chinese original; English translation is wrong - DOC-04):
 *  rf10   - RF lock: 10 digits; first 4 digits -> WORD, last 6 digits -> DWORD. "1234567890" -> 04D2 0008AA52
 *  ascii6 - password lock: 6 ASCII digits
 *  hex    - raw 12 hex characters (escape hatch for hardware validation)
 */
export function encodeKey(key, format = 'rf10') {
  const s = String(key);
  switch (format) {
    case 'rf10': {
      if (!/^\d{10}$/.test(s)) throw new ProtocolError('BAD_KEY', 'rf10 key must be exactly 10 digits');
      const b = Buffer.alloc(6);
      b.writeUInt16BE(Number(s.slice(0, 4)), 0);
      b.writeUInt32BE(Number(s.slice(4)), 2);
      return b;
    }
    case 'ascii6':
      if (!/^\d{6}$/.test(s)) throw new ProtocolError('BAD_KEY', 'ascii6 key must be exactly 6 digits');
      return Buffer.from(s, 'ascii');
    case 'hex': {
      const b = fromHex(s);
      if (b.length !== 6) throw new ProtocolError('BAD_KEY', 'hex key must be exactly 6 bytes (12 hex chars)');
      return b;
    }
    default:
      throw new ProtocolError('BAD_KEY_FORMAT', `Unknown key format ${format}`);
  }
}

export function decodeKey(buf, format = 'rf10') {
  const hex = toHex(buf);
  if (format === 'ascii6') return { key: isPrintableAscii(buf) ? buf.toString('ascii') : null, hex };
  if (format === 'rf10') {
    const hi = buf.readUInt16BE(0);
    const lo = buf.readUInt32BE(2);
    const valid = hi <= 9999 && lo <= 999999;
    return { key: valid ? `${String(hi).padStart(4, '0')}${String(lo).padStart(6, '0')}` : null, hex };
  }
  return { key: hex, hex };
}

/** Bill: 8 bytes, "HEX explicit code, parsed as the hex literal" (0x1234567890ABCDEF = "1234567890ABCDEF"). */
export function encodeBill(bill = '0') {
  const s = String(bill);
  if (!/^[0-9a-fA-F]{1,16}$/.test(s)) throw new ProtocolError('BAD_BILL', 'Bill must be 1-16 hex digits');
  return Buffer.from(s.padStart(16, '0'), 'hex');
}

/** LineCode: decimal route number -> WORD. */
export function encodeLineCode(lineCode = 0) {
  const n = Number(lineCode);
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new ProtocolError('BAD_LINE_CODE', 'LineCode must be an integer 0-65535');
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
}

// ---------- business data (between 0x2A and 0x23) ----------

export const LOCK_OPERATION_LENGTH = 34;
export const OPERATION_REPLY_LENGTH = 35; // A10+ format (LineCode + operation identifier)
export const OPERATION_REPLY_LEGACY_LENGTH = 25; // pre-A10 format, matches the document's reply example
export const LOCK_UPLOAD_LENGTH = 21;
export const LOCK_UPLOAD_REPLY_LENGTH = 12;

/** §10.2.1 downlink: 0x15 + Cmd + LockID(4) + Gate + Bill(8) + LineCode(2) + Key(6) + ValidTime + Spare(4) + AbsTime(6) */
export function encodeLockOperation({
  cmd,
  lockId,
  gate = 0x00,
  bill = '0',
  lineCode = 0,
  key,
  keyFormat = 'rf10',
  validTime = 0,
  spare = Buffer.alloc(4),
  time = new Date(),
  tzOffsetMinutes = 480,
}) {
  const timeBytes = Buffer.isBuffer(time) ? time : encodeBcdTime(time, tzOffsetMinutes);
  const keyBytes = Buffer.isBuffer(key) ? key : encodeKey(key, keyFormat);
  const out = Buffer.concat([
    Buffer.from([OP.LOCK_OPERATION, cmd]),
    Buffer.isBuffer(lockId) ? lockId : encodeLockId(lockId),
    Buffer.from([gate]),
    Buffer.isBuffer(bill) ? bill : encodeBill(bill),
    Buffer.isBuffer(lineCode) ? lineCode : encodeLineCode(lineCode),
    keyBytes,
    Buffer.from([validTime]),
    spare,
    timeBytes,
  ]);
  if (out.length !== LOCK_OPERATION_LENGTH) throw new ProtocolError('BAD_LENGTH', `Lock operation must be ${LOCK_OPERATION_LENGTH} bytes, got ${out.length}`);
  return out;
}

export function decodeLockOperation(data, { tzOffsetMinutes = 480, keyFormat = 'rf10' } = {}) {
  if (data.length !== LOCK_OPERATION_LENGTH) return { ok: false, error: `Lock operation must be ${LOCK_OPERATION_LENGTH} bytes, got ${data.length}` };
  return {
    ok: true,
    type: 'lock_operation',
    cmd: data[1],
    cmdHex: hex8(data[1]),
    commandType: COMMAND_TYPE_BY_CODE[data[1]] ?? 'unknown',
    lock: decodeLockId(data.subarray(2, 6)),
    gate: data[6],
    bill: toHex(data.subarray(7, 15)),
    lineCode: data.readUInt16BE(15),
    key: decodeKey(data.subarray(17, 23), keyFormat),
    validTime: data[23],
    spare: toHex(data.subarray(24, 28)),
    time: decodeBcdTime(data.subarray(28, 34), tzOffsetMinutes),
  };
}

/** Operation identifier (8B), §10.2.1 notes 1-3. */
export function decodeOperationIdentifier(b) {
  const hex = toHex(b);
  const tag = String.fromCharCode(b[0]);
  const pw = b.subarray(2, 8);
  if (tag === 'R' || tag === 'C' || tag === 'K') {
    const mode = { R: 'rf', C: 'remote', K: 'keyboard' }[tag];
    return { hex, mode, opCode: hex8(b[1]), password: isPrintableAscii(pw) ? pw.toString('ascii') : null, passwordHex: toHex(pw) };
  }
  if (tag === 'I') {
    const opCodes = { 0x60: 'seal_card', 0x61: 'unseal_card', 0x62: 'temporary_unseal_card' };
    return { hex, mode: 'ic_card', opCode: hex8(b[1]), cardOperation: opCodes[b[1]] ?? 'unknown', cardNumber: toHex(b.subarray(2, 6)), remainingUses: b[6] };
  }
  if (tag === '1' || tag === '0' || b[0] === 0x00 || b[0] === 0x01) {
    const valid = tag === '1' || b[0] === 0x01;
    return { hex, mode: 'dynamic_password', dynamicPasswordValid: valid, passwordHex: toHex(b.subarray(1, 7)), validTime: b[7] };
  }
  return { hex, mode: 'unknown' };
}

export function decodeOperationReply(data, { tzOffsetMinutes = 480 } = {}) {
  const legacy = data.length === OPERATION_REPLY_LEGACY_LENGTH;
  if (data.length !== OPERATION_REPLY_LENGTH && !legacy) {
    return { ok: false, error: `Operation reply must be ${OPERATION_REPLY_LENGTH} (or legacy ${OPERATION_REPLY_LEGACY_LENGTH}) bytes, got ${data.length}` };
  }
  const base = {
    ok: true,
    type: 'operation_reply',
    format: legacy ? 'legacy_pre_A10' : 'A13',
    result: describeResultCode(data[1]),
    lock: decodeLockId(data.subarray(2, 6)),
    gate: data[6],
    bill: toHex(data.subarray(7, 15)),
    voltage: describeVoltage(data[15]),
    lockStatus: describeLockStatus(data[16]),
    motorStatus: { code: data[17], hex: hex8(data[17]) },
  };
  if (legacy) {
    return { ...base, lineCode: null, operationIdentifier: null, commandSource: describeCommandSource(data[18]), time: decodeBcdTime(data.subarray(19, 25), tzOffsetMinutes) };
  }
  return {
    ...base,
    lineCode: data.readUInt16BE(18),
    operationIdentifier: decodeOperationIdentifier(data.subarray(20, 28)),
    commandSource: describeCommandSource(data[28]),
    time: decodeBcdTime(data.subarray(29, 35), tzOffsetMinutes),
  };
}

export function encodeOperationReply({
  resultCode,
  lockId,
  gate = 0,
  bill = Buffer.alloc(8),
  voltage = 0x35,
  lockStatus = 0x20,
  motorStatus = 0x00,
  lineCode = 0,
  operationIdentifier = Buffer.alloc(8),
  commandSource = 0x04,
  time = new Date(),
  tzOffsetMinutes = 480,
}) {
  return Buffer.concat([
    Buffer.from([OP.OPERATION_REPLY, resultCode]),
    Buffer.isBuffer(lockId) ? lockId : encodeLockId(lockId),
    Buffer.from([gate]),
    Buffer.isBuffer(bill) ? bill : encodeBill(bill),
    Buffer.from([voltage, lockStatus, motorStatus]),
    Buffer.isBuffer(lineCode) ? lineCode : encodeLineCode(lineCode),
    operationIdentifier,
    Buffer.from([commandSource]),
    Buffer.isBuffer(time) ? time : encodeBcdTime(time, tzOffsetMinutes),
  ]);
}

export const LOCK_UPLOAD_SUBCMDS = {
  0x01: { key: 'lock_info', label: 'Lock information upload', alarm: false },
  0x02: { key: 'knob_damage', label: 'Knob damage alarm', alarm: true },
  0x03: { key: 'lock_body_damage', label: 'Lock body damage alarm', alarm: true },
  0x04: { key: 'lock_rod_cut', label: 'Lock rod cut alarm', alarm: true },
  0x05: { key: 'lock_rod_open', label: 'Lock rod open alarm', alarm: true },
  0xf2: { key: 'request_dynamic_password', label: 'Apply dynamic password / apply unlock', alarm: false },
};

/** §10.3 uplink: 0x01 + SubCmd + LockID(4) + Gate + Voltage + LockStatus + MotoStatus + Spare(4) + Ver + AbsTime(6) */
export function decodeLockUpload(data, { tzOffsetMinutes = 480 } = {}) {
  if (data.length !== LOCK_UPLOAD_LENGTH) return { ok: false, error: `Lock upload must be ${LOCK_UPLOAD_LENGTH} bytes, got ${data.length}` };
  const sub = LOCK_UPLOAD_SUBCMDS[data[1]];
  return {
    ok: true,
    type: 'lock_upload',
    subCmd: data[1],
    subCmdHex: hex8(data[1]),
    subCmdKey: sub?.key ?? 'unknown',
    subCmdLabel: sub?.label ?? `Unknown SubCmd ${hex8(data[1])}`,
    isAlarm: Boolean(sub?.alarm),
    lock: decodeLockId(data.subarray(2, 6)),
    gate: data[6],
    voltage: describeVoltage(data[7]),
    lockStatus: describeLockStatus(data[8]),
    motorStatus: { code: data[9], hex: hex8(data[9]) },
    spare: toHex(data.subarray(10, 14)),
    version: data[14],
    time: decodeBcdTime(data.subarray(15, 21), tzOffsetMinutes),
  };
}

export function encodeLockUpload({ subCmd = 0x01, lockId, gate = 0, voltage = 0x35, lockStatus = 0x20, motorStatus = 0, spare = Buffer.alloc(4), version = 1, time = new Date(), tzOffsetMinutes = 480 }) {
  return Buffer.concat([
    Buffer.from([OP.LOCK_UPLOAD, subCmd]),
    Buffer.isBuffer(lockId) ? lockId : encodeLockId(lockId),
    Buffer.from([gate, voltage, lockStatus, motorStatus]),
    spare,
    Buffer.from([version]),
    Buffer.isBuffer(time) ? time : encodeBcdTime(time, tzOffsetMinutes),
  ]);
}

/** §10.3 "normal reply": 0x61 + SubCmd + LockID(4) + AbsTime(6) */
export function encodeLockUploadReply({ subCmd, lockId, time = new Date(), tzOffsetMinutes = 480 }) {
  return Buffer.concat([
    Buffer.from([OP.LOCK_UPLOAD_REPLY, subCmd]),
    Buffer.isBuffer(lockId) ? lockId : encodeLockId(lockId),
    Buffer.isBuffer(time) ? time : encodeBcdTime(time, tzOffsetMinutes),
  ]);
}

export function decodeLockUploadReply(data, { tzOffsetMinutes = 480 } = {}) {
  if (data.length !== LOCK_UPLOAD_REPLY_LENGTH) return { ok: false, error: `Lock upload reply must be ${LOCK_UPLOAD_REPLY_LENGTH} bytes, got ${data.length}` };
  return { ok: true, type: 'lock_upload_reply', subCmd: data[1], lock: decodeLockId(data.subarray(2, 6)), time: decodeBcdTime(data.subarray(6, 12), tzOffsetMinutes) };
}

export function decodeBusinessData(data, opts = {}) {
  if (!data.length) return { ok: false, error: 'Empty business data' };
  switch (data[0]) {
    case OP.OPERATION_REPLY: return decodeOperationReply(data, opts);
    case OP.LOCK_UPLOAD: return decodeLockUpload(data, opts);
    case OP.LOCK_OPERATION: return decodeLockOperation(data, opts);
    case OP.LOCK_UPLOAD_REPLY: return decodeLockUploadReply(data, opts);
    default: return { ok: false, type: 'unsupported', error: `Unsupported business operation ${hex8(data[0])}`, hex: toHex(data) };
  }
}

// ---------- business frame envelope (§10.1) ----------

/**
 * LEN interpretations (DOC-06):
 *  after_len          - all bytes after LEN up to and including CRC  (INFERRED default: "business data to CRC")
 *  after_len_excl_crc - all bytes after LEN, excluding CRC
 *  doc_example        - (bytes 0x2A..0x23 inclusive) + 1; what both document examples show (they omit the serial)
 * CRC (DOC-07): algorithm crc8_maxim | xor | sum ; range from_len (LEN..serial) | from_head (0x2A..serial).
 */
export const LEN_MODES = ['after_len', 'after_len_excl_crc', 'doc_example'];
export const CRC_RANGES = ['from_len', 'from_head'];

export const DEFAULT_FRAME_OPTIONS = Object.freeze({ lenMode: 'after_len', crcAlgo: 'crc8_maxim', crcRange: 'from_len' });

function lenValue(mode, { dataLength, coreLength }) {
  switch (mode) {
    case 'after_len': return coreLength + 1;
    case 'after_len_excl_crc': return coreLength;
    case 'doc_example': return dataLength + 2 + 1;
    default: throw new ProtocolError('BAD_LEN_MODE', `Unknown LEN mode ${mode}`);
  }
}

function crcInput(range, frameNoCrc) {
  if (range === 'from_len') return frameNoCrc;
  if (range === 'from_head') return frameNoCrc.subarray(1);
  throw new ProtocolError('BAD_CRC_RANGE', `Unknown CRC range ${range}`);
}

/** Build LEN | 0x2A | data | 0x23 | [additional] | serial | CRC. */
export function encodeBusinessFrame(data, serial, { additional = null, ...options } = {}) {
  const opt = { ...DEFAULT_FRAME_OPTIONS, ...options };
  const serialBuf = Buffer.alloc(2);
  serialBuf.writeUInt16BE(serial & 0xffff);
  const core = Buffer.concat([Buffer.from([BIZ_HEAD]), data, Buffer.from([BIZ_TAIL]), additional ?? Buffer.alloc(0), serialBuf]);
  const len = lenValue(opt.lenMode, { dataLength: data.length, coreLength: core.length });
  if (len > 0xff) throw new ProtocolError('BIZ_TOO_LONG', `Business frame LEN ${len} exceeds one byte`);
  const noCrc = Buffer.concat([Buffer.from([len]), core]);
  const crc = opt.crcAlgo === 'none' ? 0 : computeCrc(opt.crcAlgo, crcInput(opt.crcRange, noCrc));
  return Buffer.concat([noCrc, Buffer.from([crc])]);
}

const KNOWN_DATA_LENGTHS = {
  uplink: { [OP.OPERATION_REPLY]: [OPERATION_REPLY_LENGTH, OPERATION_REPLY_LEGACY_LENGTH], [OP.LOCK_UPLOAD]: [LOCK_UPLOAD_LENGTH] },
  downlink: { [OP.LOCK_OPERATION]: [LOCK_OPERATION_LENGTH], [OP.LOCK_UPLOAD_REPLY]: [LOCK_UPLOAD_REPLY_LENGTH] },
};

const ADDITIONAL_SIZES = [0, LOCATION_BASIC_LENGTH + 7, LOCATION_BASIC_LENGTH + 10, LOCATION_BASIC_LENGTH];

/**
 * Decode a business frame without trusting unverified assumptions: locates the 0x23 tail using known data lengths
 * and the documented optional-additional sizes, then records which LEN interpretations and CRC candidates match.
 */
export function decodeBusinessFrame(buf, { direction = 'uplink', tzOffsetMinutes = 480, ...options } = {}) {
  const opt = { ...DEFAULT_FRAME_OPTIONS, ...options };
  const res = { ok: false, direction, hex: toHex(buf), errors: [], warnings: [] };
  const n = buf.length;
  if (n < 7) {
    res.errors.push(`Business frame too short (${n} bytes)`);
    return res;
  }
  res.lenByte = buf[0];
  if (buf[1] !== BIZ_HEAD) {
    res.errors.push(`Expected business head 0x2A at offset 1, found ${hex8(buf[1])}`);
    return res;
  }
  const bodyEnd = n - 3; // exclusive end of [head .. additional]
  res.serial = buf.readUInt16BE(n - 3);
  res.crcReceived = buf[n - 1];
  const op = buf[2];

  const candidates = [];
  for (const L of KNOWN_DATA_LENGTHS[direction]?.[op] ?? []) {
    const idx = 2 + L;
    if (idx < bodyEnd && buf[idx] === BIZ_TAIL) candidates.push({ idx, knownLength: true, extra: bodyEnd - idx - 1 });
  }
  const extras = direction === 'uplink' ? ADDITIONAL_SIZES : [0];
  for (const E of extras) {
    const idx = bodyEnd - E - 1;
    if (idx >= 3 && buf[idx] === BIZ_TAIL && !candidates.some((c) => c.idx === idx)) candidates.push({ idx, knownLength: false, extra: E });
  }
  const score = (c) => (c.knownLength ? 2 : 0) + (extras.includes(c.extra) ? 1 : 0);
  candidates.sort((a, b) => score(b) - score(a));
  const chosen = candidates[0];
  if (!chosen) {
    res.errors.push('Could not locate business tail 0x23 at any expected position');
    return res;
  }
  if (!chosen.knownLength && KNOWN_DATA_LENGTHS[direction]?.[op]) {
    res.warnings.push(`Business data length ${chosen.idx - 2} differs from documented length(s) ${KNOWN_DATA_LENGTHS[direction][op].join('/')} for ${hex8(op)}`);
  }
  if (!extras.includes(chosen.extra)) {
    res.warnings.push(`Unexpected additional-information size ${chosen.extra} bytes`);
  }
  const tailIdx = chosen.idx;
  const data = buf.subarray(2, tailIdx);
  const additional = buf.subarray(tailIdx + 1, bodyEnd);
  res.data = Buffer.from(data);
  res.dataHex = toHex(data);
  res.additionalHex = toHex(additional);

  if (additional.length >= LOCATION_BASIC_LENGTH) {
    res.gps = decodeLocationBasic(additional.subarray(0, LOCATION_BASIC_LENGTH), { tzOffsetMinutes });
    const lbs = additional.subarray(LOCATION_BASIC_LENGTH);
    if (lbs.length === 7) res.lbs = { variant: '7B', mcc: lbs.readUInt16BE(0), mnc: lbs[2], lac: lbs.readUInt16BE(3), cellId: lbs.readUInt16BE(5) };
    else if (lbs.length === 10) res.lbs = { variant: '10B', mcc: lbs.readUInt16BE(0), mnc: lbs[2], lac: lbs.readUInt16BE(3), cellId: lbs.readUInt32BE(5), signal: lbs[9] };
    else if (lbs.length) res.lbs = { variant: 'unknown', hex: toHex(lbs) };
  }

  // LEN interpretations that match this frame (evidence for DOC-06).
  const coreLength = n - 2;
  res.lenInterpretations = LEN_MODES.filter((m) => lenValue(m, { dataLength: data.length, coreLength }) === res.lenByte);
  res.lenMatchesConfigured = res.lenInterpretations.includes(opt.lenMode);
  if (!res.lenInterpretations.length) res.warnings.push(`LEN byte ${res.lenByte} matches no known interpretation`);

  // CRC candidates that match (evidence for DOC-07).
  const noCrc = buf.subarray(0, n - 1);
  res.crcMatches = [];
  for (const algo of Object.keys(CRC_ALGORITHMS)) {
    for (const range of CRC_RANGES) {
      if (computeCrc(algo, crcInput(range, noCrc)) === res.crcReceived) res.crcMatches.push(`${algo}/${range}`);
    }
  }
  const configuredKey = `${opt.crcAlgo}/${opt.crcRange}`;
  res.crcConfigured = configuredKey;
  res.crcValid = opt.crcAlgo === 'none' ? null : res.crcMatches.includes(configuredKey);
  if (res.crcValid === false) {
    res.warnings.push(res.crcMatches.length
      ? `Business CRC does not match configured ${configuredKey}; matches ${res.crcMatches.join(', ')}`
      : `Business CRC ${hex8(res.crcReceived)} matches no candidate algorithm`);
  }

  res.payload = decodeBusinessData(data, { tzOffsetMinutes });
  if (!res.payload.ok) res.warnings.push(res.payload.error);
  res.ok = true;
  return res;
}
