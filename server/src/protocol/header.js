// §4.4.3 message header (Table 2) and body properties (Figure 2).
import { bcdDecode, bcdEncode, isValidBcd, hex16, toHex } from './bytes.js';
import { ProtocolError } from './errors.js';

export const HEADER_LENGTH = 12;
export const PACKAGE_ITEM_LENGTH = 4;
export const MAX_BODY_LENGTH = 0x3ff;

export function decodeProperties(props) {
  return {
    raw: props,
    bodyLength: props & 0x03ff,
    encryption: (props >> 10) & 0x07, // bit10 = RSA, others reserved
    subpackage: Boolean((props >> 13) & 0x01),
    reserved: (props >> 14) & 0x03,
  };
}

export function encodeProperties({ bodyLength, encryption = 0, subpackage = false, reserved = 0 }) {
  if (bodyLength < 0 || bodyLength > MAX_BODY_LENGTH) {
    throw new ProtocolError('BODY_TOO_LONG', `Body length ${bodyLength} exceeds ${MAX_BODY_LENGTH}`);
  }
  return (bodyLength & 0x03ff) | ((encryption & 0x07) << 10) | ((subpackage ? 1 : 0) << 13) | ((reserved & 0x03) << 14);
}

/**
 * Terminal ID: BCD[6] parsed as 12 digits; leading zeros may be omitted (§4.4.3).
 * We keep both the full 12-digit form (lossless) and the stripped form.
 */
export function decodeTerminalId(buf) {
  const full = bcdDecode(buf);
  return {
    full,
    stripped: full.replace(/^0+(?=.)/, ''),
    validBcd: isValidBcd(buf),
    hex: toHex(buf),
  };
}

/** Accepts a digit string, or the raw 6 bytes as received (so replies echo non-BCD IDs exactly). */
export function encodeTerminalId(terminalId) {
  if (Buffer.isBuffer(terminalId)) {
    if (terminalId.length !== 6) throw new ProtocolError('BAD_TERMINAL_ID', 'Raw terminal ID must be 6 bytes');
    return terminalId;
  }
  return bcdEncode(String(terminalId), 6);
}

export function decodeHeader(buf) {
  if (buf.length < HEADER_LENGTH) {
    throw new ProtocolError('SHORT_HEADER', `Header needs ${HEADER_LENGTH} bytes, got ${buf.length}`);
  }
  const msgId = buf.readUInt16BE(0);
  const properties = decodeProperties(buf.readUInt16BE(2));
  const terminal = decodeTerminalId(buf.subarray(4, 10));
  const serial = buf.readUInt16BE(10);
  let pkg = null;
  let length = HEADER_LENGTH;
  if (properties.subpackage) {
    if (buf.length < HEADER_LENGTH + PACKAGE_ITEM_LENGTH) {
      throw new ProtocolError('SHORT_HEADER', 'Sub-packet flag set but package item missing');
    }
    pkg = { total: buf.readUInt16BE(12), index: buf.readUInt16BE(14) };
    length += PACKAGE_ITEM_LENGTH;
  }
  return {
    msgId,
    msgIdHex: hex16(msgId),
    properties,
    terminalId: terminal.full,
    terminal,
    serial,
    package: pkg,
    length,
  };
}

export function encodeHeader({ msgId, bodyLength, terminalId, serial, encryption = 0, package: pkg = null }) {
  const len = pkg ? HEADER_LENGTH + PACKAGE_ITEM_LENGTH : HEADER_LENGTH;
  const out = Buffer.alloc(len);
  out.writeUInt16BE(msgId, 0);
  out.writeUInt16BE(encodeProperties({ bodyLength, encryption, subpackage: Boolean(pkg) }), 2);
  encodeTerminalId(terminalId).copy(out, 4);
  out.writeUInt16BE(serial & 0xffff, 10);
  if (pkg) {
    out.writeUInt16BE(pkg.total, 12);
    out.writeUInt16BE(pkg.index, 14);
  }
  return out;
}
