// Packet encode/decode (§4.4). Transmit: build -> checksum -> escape -> frame. Receive: unescape -> checksum -> parse.
import { escape, unescape, FLAG } from './escape.js';
import { xorChecksum } from './checksum.js';
import { decodeHeader, encodeHeader, HEADER_LENGTH } from './header.js';
import { toHex, hex8 } from './bytes.js';

/**
 * Build a complete on-the-wire frame.
 * @returns {{ frame: Buffer, unescaped: Buffer, checksum: number }}
 */
export function encodePacket({ msgId, terminalId, serial, body = Buffer.alloc(0), encryption = 0, package: pkg = null }) {
  const header = encodeHeader({ msgId, bodyLength: body.length, terminalId, serial, encryption, package: pkg });
  const content = Buffer.concat([header, body]);
  const checksum = xorChecksum(content);
  const unescaped = Buffer.concat([content, Buffer.from([checksum])]);
  const frame = Buffer.concat([Buffer.from([FLAG]), escape(unescaped), Buffer.from([FLAG])]);
  return { frame, unescaped, checksum };
}

/**
 * Decode one frame. Accepts the bytes between the 0x7E delimiters (still escaped), or a full frame including them.
 * Never throws for malformed input: returns { ok:false, error } so the caller can log it against the session.
 */
export function decodePacket(input) {
  let inner = input;
  if (inner.length >= 2 && inner[0] === FLAG && inner[inner.length - 1] === FLAG) {
    inner = inner.subarray(1, inner.length - 1);
  }
  const result = {
    ok: false,
    error: null,
    errorCode: null,
    escapedHex: toHex(inner),
    unescapedHex: null,
    header: null,
    body: null,
    checksum: null,
    warnings: [],
  };

  const { data, errors: escErrors } = unescape(inner);
  result.unescapedHex = toHex(data);
  if (escErrors.length) {
    result.errorCode = 'BAD_ESCAPE';
    result.error = `Invalid escape sequence(s): ${escErrors.map((e) => `${e.reason}@${e.offset}`).join(', ')}`;
    return result;
  }
  if (data.length < HEADER_LENGTH + 1) {
    result.errorCode = 'TOO_SHORT';
    result.error = `Frame too short: ${data.length} bytes after unescape (minimum ${HEADER_LENGTH + 1})`;
    return result;
  }

  const received = data[data.length - 1];
  const calculated = xorChecksum(data, 0, data.length - 1);
  result.checksum = { received, calculated, valid: received === calculated, receivedHex: hex8(received), calculatedHex: hex8(calculated) };

  let header;
  try {
    header = decodeHeader(data.subarray(0, data.length - 1));
  } catch (e) {
    result.errorCode = e.code || 'BAD_HEADER';
    result.error = e.message;
    return result;
  }
  result.header = header;

  if (!result.checksum.valid) {
    result.errorCode = 'BAD_CHECKSUM';
    result.error = `Checksum mismatch: received ${result.checksum.receivedHex}, calculated ${result.checksum.calculatedHex}`;
    return result;
  }

  const body = data.subarray(header.length, data.length - 1);
  if (body.length !== header.properties.bodyLength) {
    // Keep the frame (checksum is valid) but record the inconsistency; body is taken from the actual bytes.
    result.warnings.push(`Body length mismatch: properties say ${header.properties.bodyLength}, actual ${body.length}`);
  }
  if (header.properties.encryption !== 0) {
    result.warnings.push(`Encrypted body flag set (encryption=${header.properties.encryption}); body not decrypted`);
  }
  result.body = Buffer.from(body);
  result.ok = true;
  return result;
}
