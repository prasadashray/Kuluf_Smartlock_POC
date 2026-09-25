// Primitive encodings from protocol §4.2/§4.3: big-endian WORD/DWORD, BCD[n] (8421), STRING (GBK).
import { ProtocolError } from './errors.js';

export function toHex(buf, sep = '') {
  if (!buf) return '';
  return Buffer.from(buf).toString('hex').toUpperCase().replace(/(..)(?!$)/g, sep ? `$1${sep}` : '$1');
}

export function fromHex(hex) {
  const clean = String(hex).replace(/[\s:_-]/g, '');
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) {
    throw new ProtocolError('BAD_HEX', `Invalid hex string: ${hex}`);
  }
  return Buffer.from(clean, 'hex');
}

export function hex8(n) {
  return `0x${(n & 0xff).toString(16).toUpperCase().padStart(2, '0')}`;
}

export function hex16(n) {
  return `0x${(n & 0xffff).toString(16).toUpperCase().padStart(4, '0')}`;
}

export function hex32(n) {
  return `0x${(n >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
}

export function word(n) {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new ProtocolError('RANGE', `WORD out of range: ${n}`);
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
}

export function dword(n) {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new ProtocolError('RANGE', `DWORD out of range: ${n}`);
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

export function byte(n) {
  if (!Number.isInteger(n) || n < 0 || n > 0xff) throw new ProtocolError('RANGE', `BYTE out of range: ${n}`);
  return Buffer.from([n]);
}

export function isValidBcd(buf) {
  for (const b of buf) {
    if ((b >> 4) > 9 || (b & 0x0f) > 9) return false;
  }
  return true;
}

/** Encode a decimal digit string into BCD[length], left-padded with zeros. */
export function bcdEncode(digits, length) {
  const s = String(digits);
  if (!/^\d*$/.test(s)) throw new ProtocolError('BAD_BCD', `BCD value must be digits only: ${s}`);
  if (s.length > length * 2) throw new ProtocolError('BAD_BCD', `BCD value ${s} does not fit in ${length} bytes`);
  const padded = s.padStart(length * 2, '0');
  const out = Buffer.alloc(length);
  for (let i = 0; i < length; i++) {
    out[i] = (Number(padded[2 * i]) << 4) | Number(padded[2 * i + 1]);
  }
  return out;
}

/** Decode BCD to the full digit string (no stripping). Non-BCD nibbles are rendered as hex so nothing is lost. */
export function bcdDecode(buf) {
  let s = '';
  for (const b of buf) s += (b >> 4).toString(16) + (b & 0x0f).toString(16);
  return s.toUpperCase();
}

/**
 * Protocol time: BCD[6] YYMMDDhhmmss. The protocol states GMT+8 (§8.18 Table 23); the offset is a parameter
 * because the real device clock must be validated (see docs/PROTOCOL_NOTES.md).
 * Returns { raw, iso, valid } where iso is the UTC instant, or null when the value is all zeros / invalid.
 */
export function decodeBcdTime(buf, tzOffsetMinutes = 480) {
  const raw = bcdDecode(buf);
  if (buf.length !== 6 || !isValidBcd(buf)) return { raw, iso: null, valid: false, reason: 'not_bcd' };
  if (/^0+$/.test(raw)) return { raw, iso: null, valid: false, reason: 'zero' };
  const [yy, mo, dd, hh, mi, ss] = raw.match(/../g).map(Number);
  if (mo < 1 || mo > 12 || dd < 1 || dd > 31 || hh > 23 || mi > 59 || ss > 59) {
    return { raw, iso: null, valid: false, reason: 'out_of_range' };
  }
  const ms = Date.UTC(2000 + yy, mo - 1, dd, hh, mi, ss) - tzOffsetMinutes * 60000;
  return { raw, iso: new Date(ms).toISOString(), valid: true };
}

export function encodeBcdTime(date = new Date(), tzOffsetMinutes = 480) {
  const d = new Date(date.getTime() + tzOffsetMinutes * 60000);
  const parts = [
    d.getUTCFullYear() % 100,
    d.getUTCMonth() + 1,
    d.getUTCDate(),
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds(),
  ];
  return bcdEncode(parts.map((p) => String(p).padStart(2, '0')).join(''), 6);
}

let gbkDecoder = null;
function getGbkDecoder() {
  if (gbkDecoder === null) {
    try {
      gbkDecoder = new TextDecoder('gbk');
    } catch {
      gbkDecoder = false;
    }
  }
  return gbkDecoder;
}

/** STRING fields are GBK (§4.2). ASCII is a subset of GBK, so ASCII text decodes identically. */
export function decodeString(buf) {
  const dec = getGbkDecoder();
  if (dec) return dec.decode(buf);
  return Buffer.from(buf).toString('latin1');
}

/**
 * Encode a STRING field. Only ASCII is supported for encoding (GBK encoding of non-ASCII text needs a codec
 * table; not needed for the POC - see TDD gap #2). Non-ASCII input is rejected rather than silently mangled.
 */
export function encodeString(str) {
  const s = String(str);
  if (/[^\x00-\x7f]/.test(s)) {
    throw new ProtocolError('NON_ASCII_STRING', 'Only ASCII STRING values can be encoded (GBK encoder not implemented)');
  }
  return Buffer.from(s, 'ascii');
}

export function isPrintableAscii(buf) {
  for (const b of buf) if (b < 0x20 || b > 0x7e) return false;
  return true;
}
