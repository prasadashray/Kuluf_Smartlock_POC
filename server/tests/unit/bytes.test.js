import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bcdEncode, bcdDecode, decodeBcdTime, encodeBcdTime, word, dword, byte, fromHex, toHex, decodeString, encodeString } from '../../src/protocol/index.js';

test('WORD / DWORD / BYTE are big-endian and range-checked', () => {
  assert.equal(toHex(word(0x1234)), '1234');
  assert.equal(toHex(dword(0x12345678)), '12345678');
  assert.equal(toHex(byte(0xab)), 'AB');
  assert.throws(() => word(0x10000));
  assert.throws(() => dword(-1));
  assert.throws(() => byte(256));
});

test('BCD encode/decode', () => {
  assert.equal(toHex(bcdEncode('123', 3)), '000123');
  assert.equal(bcdDecode(fromHex('080402152050')), '080402152050');
  assert.throws(() => bcdEncode('12a', 2));
  assert.throws(() => bcdEncode('1234567', 3));
});

test('BCD time 0x080402152050 = 2008-04-02 15:20:50 GMT+8 = 07:20:50Z (param 0x002A example)', () => {
  const t = decodeBcdTime(fromHex('080402152050'), 480);
  assert.equal(t.valid, true);
  assert.equal(t.iso, '2008-04-02T07:20:50.000Z');
});

test('BCD time with a configurable offset (IST +330) and round-trip', () => {
  const d = new Date('2026-09-25T19:16:33Z');
  assert.equal(toHex(encodeBcdTime(d, 480)), '260926031633');
  assert.equal(toHex(encodeBcdTime(d, 330)), '260926004633');
  assert.equal(decodeBcdTime(encodeBcdTime(d, 330), 330).iso, d.toISOString());
});

test('hardware BLE timestamp 26 09 26 03 15 40 (GMT+8) = 2026-09-25T19:15:40Z', () => {
  assert.equal(decodeBcdTime(fromHex('260926031540'), 480).iso, '2026-09-25T19:15:40.000Z');
});

test('invalid / zero BCD times are flagged not converted', () => {
  assert.equal(decodeBcdTime(fromHex('000000000000')).valid, false);
  assert.equal(decodeBcdTime(fromHex('261399000000')).reason, 'out_of_range');
  assert.equal(decodeBcdTime(fromHex('2609260315AA')).reason, 'not_bcd');
});

test('STRING: ASCII round-trip, GBK decode, non-ASCII encode rejected', () => {
  assert.equal(decodeString(encodeString('89860012345678901234V1.0')), '89860012345678901234V1.0');
  assert.equal(decodeString(fromHex('D6D0CEC4')), '中文');
  assert.throws(() => encodeString('中文'));
});
