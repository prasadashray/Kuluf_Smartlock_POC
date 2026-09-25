// JT/T808 message bodies used by the POC (§8). Every decoder returns a plain object and never throws.
import { hex16, toHex, decodeString, encodeString, isPrintableAscii, bcdEncode, decodeBcdTime, encodeBcdTime } from './bytes.js';
import { decodeLocationReport } from './location.js';
import { decodeBusinessFrame, PASSTHROUGH_ELOCK } from './tt-elock.js';

export const MSG = {
  TERMINAL_GENERAL_RESPONSE: 0x0001,
  HEARTBEAT: 0x0002,
  REGISTER: 0x0100,
  AUTHENTICATE: 0x0102,
  QUERY_PARAMS_RESPONSE: 0x0104,
  UPGRADE_RESULT: 0x0108,
  LOCATION_REPORT: 0x0200,
  LOCATION_QUERY_RESPONSE: 0x0201,
  TEXT_UPLOAD: 0x0300,
  UPLINK_PASSTHROUGH: 0x0900,
  PLATFORM_GENERAL_RESPONSE: 0x8001,
  REGISTER_RESPONSE: 0x8100,
  SET_PARAMS: 0x8103,
  QUERY_PARAMS: 0x8104,
  TERMINAL_CONTROL: 0x8105,
  QUERY_ATTRIBUTES: 0x8107,
  LOCATION_QUERY: 0x8201,
  TEXT_DOWNLINK: 0x8300,
  DOWNLINK_PASSTHROUGH: 0x8900,
};

export const MSG_NAMES = {
  0x0001: 'Terminal general response',
  0x0002: 'Heartbeat',
  0x0100: 'Terminal registration',
  0x0102: 'Terminal authentication',
  0x0104: 'Query parameters response',
  0x0108: 'Upgrade result notification',
  0x0200: 'Location report',
  0x0201: 'Location query response',
  0x0300: 'Text upload',
  0x0900: 'Uplink passthrough',
  0x8001: 'Platform general response',
  0x8100: 'Registration response',
  0x8103: 'Set terminal parameters',
  0x8104: 'Query terminal parameters',
  0x8105: 'Terminal control',
  0x8107: 'Query terminal attributes',
  0x8201: 'Location query',
  0x8300: 'Text downlink',
  0x8900: 'Downlink passthrough',
};

export function messageName(id) {
  return MSG_NAMES[id] ?? `Unknown message ${hex16(id)}`;
}

export const GENERAL_RESULT = { SUCCESS: 0, FAILURE: 1, MESSAGE_ERROR: 2, NOT_SUPPORTED: 3, ALARM_CONFIRMED: 4 };
const GENERAL_RESULT_LABELS = ['success', 'failure', 'message_error', 'not_supported', 'alarm_processing_confirmed'];

// ---------- 0x0001 / 0x8001 general responses ----------

export function encodeGeneralResponse({ replySerial, replyId, result }) {
  const b = Buffer.alloc(5);
  b.writeUInt16BE(replySerial & 0xffff, 0);
  b.writeUInt16BE(replyId, 2);
  b[4] = result;
  return b;
}

export function decodeGeneralResponse(body) {
  if (body.length < 5) return { ok: false, error: `General response needs 5 bytes, got ${body.length}` };
  const result = body[4];
  return {
    ok: true,
    replySerial: body.readUInt16BE(0),
    replyId: body.readUInt16BE(2),
    replyIdHex: hex16(body.readUInt16BE(2)),
    result,
    resultLabel: GENERAL_RESULT_LABELS[result] ?? `unknown_${result}`,
  };
}

// ---------- 0x0100 registration (TT variant: 20-byte ICCID) ----------

export function decodeRegistration(body) {
  const iccidBytes = body.subarray(0, 20);
  return {
    ok: body.length >= 20,
    error: body.length < 20 ? `TT registration body should hold a 20-byte ICCID, got ${body.length} bytes` : undefined,
    iccid: decodeString(iccidBytes).replace(/\0+$/, ''),
    iccidHex: toHex(iccidBytes),
    extraHex: body.length > 20 ? toHex(body.subarray(20)) : null,
  };
}

export function encodeRegistration({ iccid }) {
  return encodeString(String(iccid).padEnd(20, '\0').slice(0, 20));
}

// ---------- 0x8100 registration response ----------

export const REGISTER_RESULT = { SUCCESS: 0, VEHICLE_REGISTERED: 1, NO_VEHICLE: 2, TERMINAL_REGISTERED: 3, NO_TERMINAL: 4 };

export function encodeRegistrationResponse({ replySerial, result, authCode }) {
  const head = Buffer.alloc(3);
  head.writeUInt16BE(replySerial & 0xffff, 0);
  head[2] = result;
  return result === REGISTER_RESULT.SUCCESS && authCode ? Buffer.concat([head, encodeString(authCode)]) : head;
}

export function decodeRegistrationResponse(body) {
  if (body.length < 3) return { ok: false, error: 'Registration response too short' };
  return { ok: true, replySerial: body.readUInt16BE(0), result: body[2], authCode: body.length > 3 ? decodeString(body.subarray(3)) : null };
}

// ---------- 0x0102 authentication ----------

/**
 * Body = authentication code STRING. For TT terminals without an issued code: SIM ICCID (20 bytes) + device version.
 * The split into ICCID/version is a heuristic for display only; the full string is the authentication code.
 */
export function decodeAuthentication(body) {
  const authCode = decodeString(body).replace(/\0+$/, '');
  const m = /^(\d{19}[\dA-F])(.*)$/i.exec(authCode);
  return {
    ok: body.length > 0,
    error: body.length ? undefined : 'Empty authentication code',
    authCode,
    authCodeHex: toHex(body),
    printable: isPrintableAscii(body),
    looksLikeFactoryDefault: Boolean(m && /^89/.test(m[1])),
    iccidGuess: m ? m[1] : null,
    versionGuess: m ? m[2] : null,
  };
}

export function encodeAuthentication({ authCode }) {
  return encodeString(authCode);
}

// ---------- 0x8103 set parameters / 0x0104 query response ----------

// Table 12 subset: parameters relevant to TT devices (types needed for decoding 0x0104).
export const PARAMS = {
  0x0001: { name: 'heartbeat_interval_s', type: 'DWORD' },
  0x0002: { name: 'tcp_response_timeout_s', type: 'DWORD' },
  0x0003: { name: 'tcp_retransmissions', type: 'DWORD' },
  0x0010: { name: 'apn', type: 'STRING' },
  0x0011: { name: 'apn_username', type: 'STRING' },
  0x0012: { name: 'apn_password', type: 'STRING' },
  0x0013: { name: 'main_server_address', type: 'STRING' },
  0x0014: { name: 'backup_apn', type: 'STRING' },
  0x0015: { name: 'backup_apn_username', type: 'STRING' },
  0x0016: { name: 'backup_apn_password', type: 'STRING' },
  0x0017: { name: 'backup_server_address', type: 'STRING' },
  0x0018: { name: 'server_tcp_port', type: 'DWORD' },
  0x0019: { name: 'server_udp_port', type: 'DWORD' },
  0x0020: { name: 'location_report_strategy', type: 'DWORD' },
  0x0021: { name: 'location_report_scheme', type: 'DWORD' },
  0x0022: { name: 'report_interval_not_logged_in_s', type: 'DWORD' },
  0x0027: { name: 'sleep_report_interval_s', type: 'DWORD' },
  0x0028: { name: 'emergency_report_interval_s', type: 'DWORD' },
  0x0029: { name: 'default_report_interval_s', type: 'DWORD' },
  0x002a: { name: 'device_time', type: 'BCD6' },
  0x002c: { name: 'default_report_distance_m', type: 'DWORD' },
  0x0030: { name: 'turn_angle', type: 'DWORD' },
  0x0031: { name: 'geofence_radius_m', type: 'WORD' },
  0x0050: { name: 'alarm_mask', type: 'DWORD' },
  0x0055: { name: 'max_speed_kmh', type: 'DWORD' },
  0x0080: { name: 'odometer_0_1km', type: 'DWORD' },
  0x0090: { name: 'gnss_mode', type: 'BYTE' },
};

function encodeParamValue(type, value, tzOffsetMinutes) {
  switch (type) {
    case 'DWORD': { const b = Buffer.alloc(4); b.writeUInt32BE(value >>> 0); return b; }
    case 'WORD': { const b = Buffer.alloc(2); b.writeUInt16BE(value); return b; }
    case 'BYTE': return Buffer.from([value]);
    case 'STRING': return encodeString(value);
    case 'BCD6': return value instanceof Date ? encodeBcdTime(value, tzOffsetMinutes) : bcdEncode(value, 6);
    case 'RAW': return Buffer.from(value);
    default: throw new Error(`Unknown parameter type ${type}`);
  }
}

/** items: [{ id, value, type? }] - type defaults to the Table 12 type. */
export function encodeSetParams(items, { tzOffsetMinutes = 480 } = {}) {
  const parts = [Buffer.from([items.length])];
  for (const { id, value, type } of items) {
    const t = type ?? PARAMS[id]?.type;
    if (!t) throw new Error(`Unknown parameter type for 0x${id.toString(16)}`);
    const v = encodeParamValue(t, value, tzOffsetMinutes);
    const head = Buffer.alloc(5);
    head.writeUInt32BE(id, 0);
    head[4] = v.length;
    parts.push(head, v);
  }
  return Buffer.concat(parts);
}

function decodeParamValue(id, v, tzOffsetMinutes) {
  const def = PARAMS[id];
  if (!def) return { raw: toHex(v) };
  try {
    switch (def.type) {
      case 'DWORD': return v.length === 4 ? v.readUInt32BE(0) : { raw: toHex(v) };
      case 'WORD': return v.length === 2 ? v.readUInt16BE(0) : { raw: toHex(v) };
      case 'BYTE': return v.length === 1 ? v[0] : { raw: toHex(v) };
      case 'STRING': return decodeString(v).replace(/\0+$/, '');
      case 'BCD6': return decodeBcdTime(v, tzOffsetMinutes);
      default: return { raw: toHex(v) };
    }
  } catch {
    return { raw: toHex(v) };
  }
}

function decodeParamList(buf, count, tzOffsetMinutes) {
  const params = [];
  const errors = [];
  let i = 0;
  while (i < buf.length) {
    if (i + 5 > buf.length) { errors.push(`Truncated parameter at offset ${i}`); break; }
    const id = buf.readUInt32BE(i);
    const len = buf[i + 4];
    if (i + 5 + len > buf.length) { errors.push(`Parameter 0x${id.toString(16)} truncated`); break; }
    const v = buf.subarray(i + 5, i + 5 + len);
    params.push({ id, idHex: `0x${id.toString(16).toUpperCase().padStart(4, '0')}`, name: PARAMS[id]?.name ?? 'unknown', length: len, hex: toHex(v), value: decodeParamValue(id, v, tzOffsetMinutes) });
    i += 5 + len;
  }
  if (count !== undefined && count !== params.length) errors.push(`Declared ${count} parameters, decoded ${params.length}`);
  return { params, errors };
}

export function decodeSetParams(body, { tzOffsetMinutes = 480 } = {}) {
  if (!body.length) return { ok: false, error: 'Empty set-parameters body' };
  const { params, errors } = decodeParamList(body.subarray(1), body[0], tzOffsetMinutes);
  return { ok: true, count: body[0], params, errors };
}

export function decodeQueryParamsResponse(body, { tzOffsetMinutes = 480 } = {}) {
  if (body.length < 3) return { ok: false, error: 'Query parameters response too short' };
  const { params, errors } = decodeParamList(body.subarray(3), body[2], tzOffsetMinutes);
  return { ok: true, replySerial: body.readUInt16BE(0), count: body[2], params, errors };
}

// ---------- 0x0201 location query response ----------

export function decodeLocationQueryResponse(body, opts) {
  if (body.length < 2) return { ok: false, error: 'Location query response too short' };
  return { replySerial: body.readUInt16BE(0), ...decodeLocationReport(body.subarray(2), opts) };
}

// ---------- 0x8900 / 0x0900 passthrough ----------

export function encodePassthrough(type, content) {
  return Buffer.concat([Buffer.from([type]), content]);
}

export function decodePassthrough(body, { direction = 'uplink', ...opts } = {}) {
  if (!body.length) return { ok: false, error: 'Empty passthrough body' };
  const type = body[0];
  const content = body.subarray(1);
  if (type !== PASSTHROUGH_ELOCK) {
    return { ok: true, type, typeHex: `0x${type.toString(16).toUpperCase().padStart(2, '0')}`, elock: null, contentHex: toHex(content), warning: 'Passthrough type is not 0x81 (e-lock business data)' };
  }
  const elock = decodeBusinessFrame(content, { direction, ...opts });
  return { ok: elock.ok, type, typeHex: '0x81', elock, error: elock.ok ? undefined : elock.errors.join('; ') };
}

// ---------- 0x0300 text upload / 0x8300 text downlink ----------

export function decodeText(body) {
  if (!body.length) return { ok: false, error: 'Empty text message' };
  return { ok: true, flag: body[0], text: decodeString(body.subarray(1)) };
}

export function encodeText({ flag = 0x04, text }) {
  return Buffer.concat([Buffer.from([flag]), encodeString(text)]);
}

// ---------- 0x0108 upgrade result ----------

export function decodeUpgradeResult(body) {
  if (body.length < 2) return { ok: false, error: 'Upgrade result too short' };
  return { ok: true, upgradeType: body[0], result: body[1] };
}

/** Decode a message body by ID. `direction` is only relevant for passthrough decoding. */
export function decodeBody(msgId, body, opts = {}) {
  try {
    switch (msgId) {
      case MSG.TERMINAL_GENERAL_RESPONSE:
      case MSG.PLATFORM_GENERAL_RESPONSE:
        return decodeGeneralResponse(body);
      case MSG.HEARTBEAT:
        return { ok: true, empty: body.length === 0, extraHex: body.length ? toHex(body) : null };
      case MSG.REGISTER:
        return decodeRegistration(body);
      case MSG.REGISTER_RESPONSE:
        return decodeRegistrationResponse(body);
      case MSG.AUTHENTICATE:
        return decodeAuthentication(body);
      case MSG.LOCATION_REPORT:
        return decodeLocationReport(body, opts);
      case MSG.LOCATION_QUERY_RESPONSE:
        return decodeLocationQueryResponse(body, opts);
      case MSG.QUERY_PARAMS_RESPONSE:
        return decodeQueryParamsResponse(body, opts);
      case MSG.SET_PARAMS:
        return decodeSetParams(body, opts);
      case MSG.UPLINK_PASSTHROUGH:
        return decodePassthrough(body, { ...opts, direction: 'uplink' });
      case MSG.DOWNLINK_PASSTHROUGH:
        return decodePassthrough(body, { ...opts, direction: 'downlink' });
      case MSG.TEXT_UPLOAD:
      case MSG.TEXT_DOWNLINK:
        return decodeText(body);
      case MSG.UPGRADE_RESULT:
        return decodeUpgradeResult(body);
      case MSG.QUERY_PARAMS:
      case MSG.LOCATION_QUERY:
      case MSG.QUERY_ATTRIBUTES:
        return { ok: true, empty: body.length === 0 };
      default:
        return { ok: true, unsupported: true, hex: toHex(body) };
    }
  } catch (e) {
    return { ok: false, error: `Body decode exception: ${e.message}`, hex: toHex(body) };
  }
}
