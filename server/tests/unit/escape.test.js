import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escape, unescape, fromHex, toHex } from '../../src/protocol/index.js';

test('§4.4.2 worked example: 30 7E 08 7D 55 -> 7E 30 7D 02 08 7D 01 55 7E', () => {
  const raw = fromHex('30 7E 08 7D 55');
  const framed = Buffer.concat([Buffer.from([0x7e]), escape(raw), Buffer.from([0x7e])]);
  assert.equal(toHex(framed, ' '), '7E 30 7D 02 08 7D 01 55 7E');
});

test('§4.4.2 worked example reverses exactly', () => {
  const { data, errors } = unescape(fromHex('30 7D 02 08 7D 01 55'));
  assert.deepEqual(errors, []);
  assert.equal(toHex(data, ' '), '30 7E 08 7D 55');
});

test('escape leaves ordinary bytes untouched', () => {
  const raw = fromHex('00 01 7C 7F 80 FF');
  assert.equal(toHex(escape(raw)), toHex(raw));
});

test('escape/unescape round-trip over every byte value', () => {
  const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const esc = escape(all);
  assert.equal(esc.includes(0x7e), false, 'escaped data must not contain a raw 0x7E');
  const { data, errors } = unescape(esc);
  assert.deepEqual(errors, []);
  assert.deepEqual(data, all);
});

test('consecutive special bytes', () => {
  const raw = fromHex('7E 7E 7D 7D');
  assert.equal(toHex(escape(raw), ' '), '7D 02 7D 02 7D 01 7D 01');
});

test('unescape reports invalid escape sequences instead of guessing', () => {
  assert.equal(unescape(fromHex('30 7D 03 55')).errors[0].reason, 'invalid_escape_0x7D_0x03');
  assert.equal(unescape(fromHex('30 7D')).errors[0].reason, 'trailing_escape');
  assert.equal(unescape(fromHex('30 7E 55')).errors[0].reason, 'unescaped_0x7E_inside_frame');
});
