import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  xorChecksum, encodePacket, decodePacket, decodeHeader, encodeHeader, decodeProperties, encodeProperties,
  decodeTerminalId, encodeTerminalId, fromHex, toHex, MSG,
} from '../../src/protocol/index.js';

test('checksum known value: heartbeat header for terminal 000082637294 serial 1 = 0x04 (hand-calculated)', () => {
  // 00^02^00^00 ^ 00^00^82^63^72^94 ^ 00^01 = 0x04
  const header = fromHex('0002 0000 000082637294 0001');
  assert.equal(xorChecksum(header), 0x04);
});

test('encodePacket builds the exact heartbeat frame', () => {
  const { frame, checksum } = encodePacket({ msgId: MSG.HEARTBEAT, terminalId: '82637294', serial: 1 });
  assert.equal(checksum, 0x04);
  assert.equal(toHex(frame, ' '), '7E 00 02 00 00 00 00 82 63 72 94 00 01 04 7E');
});

test('decodePacket round-trips header, body and checksum', () => {
  const body = fromHex('0102030405');
  const { frame } = encodePacket({ msgId: 0x0200, terminalId: '013912345678', serial: 0x1234, body });
  const p = decodePacket(frame);
  assert.equal(p.ok, true, p.error);
  assert.equal(p.header.msgId, 0x0200);
  assert.equal(p.header.terminalId, '013912345678');
  assert.equal(p.header.terminal.stripped, '13912345678');
  assert.equal(p.header.serial, 0x1234);
  assert.equal(p.header.properties.bodyLength, 5);
  assert.deepEqual(p.body, body);
  assert.equal(p.checksum.valid, true);
});

test('packets whose header/body/checksum contain 0x7E/0x7D are escaped and restored', () => {
  // serial 0x7E7D and body bytes force escaping in header and body
  const body = fromHex('7E7D7E00');
  const { frame, unescaped } = encodePacket({ msgId: 0x0900, terminalId: '82637294', serial: 0x7e7d, body });
  assert.equal(frame.subarray(1, -1).includes(0x7e), false);
  const p = decodePacket(frame);
  assert.equal(p.ok, true, p.error);
  assert.equal(p.header.serial, 0x7e7d);
  assert.deepEqual(p.body, body);
  assert.equal(p.unescapedHex, toHex(unescaped));
});

test('checksum that itself needs escaping is escaped', () => {
  // find a serial that yields checksum 0x7E
  for (let s = 0; s < 0x10000; s++) {
    const { frame, checksum } = encodePacket({ msgId: 0x0002, terminalId: '1', serial: s });
    if (checksum === 0x7e) {
      assert.equal(toHex(frame.subarray(-3), ' '), '7D 02 7E');
      assert.equal(decodePacket(frame).ok, true);
      return;
    }
  }
  assert.fail('no serial produced checksum 0x7E');
});

test('invalid checksum is rejected (not silently accepted) but header is still reported for logging', () => {
  const { frame } = encodePacket({ msgId: MSG.HEARTBEAT, terminalId: '82637294', serial: 1 });
  const bad = Buffer.from(frame);
  bad[bad.length - 2] ^= 0xff;
  const p = decodePacket(bad);
  assert.equal(p.ok, false);
  assert.equal(p.errorCode, 'BAD_CHECKSUM');
  assert.equal(p.header.msgId, MSG.HEARTBEAT);
  assert.equal(p.checksum.valid, false);
  assert.equal(p.checksum.calculated, 0x04);
});

test('truncated and badly escaped frames are rejected', () => {
  assert.equal(decodePacket(fromHex('7E 00 02 00 7E')).errorCode, 'TOO_SHORT');
  assert.equal(decodePacket(fromHex('7E 00 02 00 00 00 00 82 63 72 94 00 7D 05 04 7E')).errorCode, 'BAD_ESCAPE');
});

test('body length mismatch and encryption flag are reported as warnings', () => {
  const header = encodeHeader({ msgId: 0x0200, bodyLength: 10, terminalId: '1', serial: 0, encryption: 1 });
  const content = Buffer.concat([header, fromHex('AABB')]);
  const frame = Buffer.concat([content, Buffer.from([xorChecksum(content)])]);
  const p = decodePacket(frame);
  assert.equal(p.ok, true);
  assert.equal(p.warnings.length, 2);
});

test('body properties bit layout (Figure 2)', () => {
  const p = decodeProperties(0b0010_0100_0000_0101);
  assert.deepEqual({ len: p.bodyLength, enc: p.encryption, sub: p.subpackage }, { len: 5, enc: 1, sub: true });
  assert.equal(encodeProperties({ bodyLength: 1023, encryption: 0, subpackage: false }), 0x03ff);
  assert.throws(() => encodeProperties({ bodyLength: 1024 }));
});

test('sub-packet header includes the package item', () => {
  const h = encodeHeader({ msgId: 0x0200, bodyLength: 0, terminalId: '1', serial: 7, package: { total: 3, index: 2 } });
  assert.equal(h.length, 16);
  const d = decodeHeader(h);
  assert.deepEqual(d.package, { total: 3, index: 2 });
  assert.equal(d.length, 16);
});

test('terminal ID: BCD[6] parsed as 12 digits, leading zeros optional (§4.4.3 example)', () => {
  const t = decodeTerminalId(fromHex('023456789012'));
  assert.equal(t.full, '023456789012');
  assert.equal(t.stripped, '23456789012');
  assert.equal(toHex(encodeTerminalId('23456789012')), '023456789012');
  assert.equal(toHex(encodeTerminalId('82637294')), '000082637294');
});

test('non-BCD terminal ID nibbles are preserved, not dropped', () => {
  const t = decodeTerminalId(fromHex('0000ABCD1234'));
  assert.equal(t.validBcd, false);
  assert.equal(t.full, '0000ABCD1234');
});
