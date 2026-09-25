import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FrameDecoder, encodePacket, decodePacket, MSG, fromHex } from '../../src/protocol/index.js';

const hb = (serial) => encodePacket({ msgId: MSG.HEARTBEAT, terminalId: '82637294', serial }).frame;

function frames(out) {
  return out.filter((o) => o.type === 'frame').map((o) => decodePacket(o.data));
}

test('single complete frame in one read', () => {
  const d = new FrameDecoder();
  const out = frames(d.push(hb(1)));
  assert.equal(out.length, 1);
  assert.equal(out[0].ok, true);
  assert.equal(d.pendingBytes, 0);
});

test('multiple frames in one TCP read', () => {
  const d = new FrameDecoder();
  const out = frames(d.push(Buffer.concat([hb(1), hb(2), hb(3)])));
  assert.deepEqual(out.map((p) => p.header.serial), [1, 2, 3]);
});

test('frame split across reads at every possible byte boundary', () => {
  const f = encodePacket({ msgId: 0x0900, terminalId: '82637294', serial: 0x7e7d, body: fromHex('7E7D') }).frame;
  for (let cut = 1; cut < f.length; cut++) {
    const d = new FrameDecoder();
    const out = [...frames(d.push(f.subarray(0, cut))), ...frames(d.push(f.subarray(cut)))];
    assert.equal(out.length, 1, `cut at ${cut}`);
    assert.equal(out[0].ok, true, `cut at ${cut}: ${out[0].error}`);
  }
});

test('byte-by-byte delivery', () => {
  const d = new FrameDecoder();
  const stream = Buffer.concat([hb(1), hb(2)]);
  const out = [];
  for (const b of stream) out.push(...frames(d.push(Buffer.from([b]))));
  assert.deepEqual(out.map((p) => p.header.serial), [1, 2]);
});

test('garbage before first delimiter is reported and skipped', () => {
  const d = new FrameDecoder();
  const out = d.push(Buffer.concat([fromHex('DEADBEEF'), hb(9)]));
  assert.equal(out[0].type, 'garbage');
  assert.equal(frames(out)[0].header.serial, 9);
});

test('garbage between frames surfaces as an invalid frame, next frame still decodes', () => {
  const d = new FrameDecoder();
  const out = frames(d.push(Buffer.concat([hb(1), fromHex('0102037E'), hb(2)])));
  assert.equal(out.length, 3);
  assert.equal(out[0].ok, true);
  assert.equal(out[1].ok, false);
  assert.equal(out[2].ok, true);
  assert.equal(out[2].header.serial, 2);
});

test('shared delimiter between frames (7E A 7E B 7E) is tolerated', () => {
  const a = hb(1);
  const b = hb(2);
  const d = new FrameDecoder();
  const out = frames(d.push(Buffer.concat([a, b.subarray(1)])));
  assert.deepEqual(out.map((p) => p.header.serial), [1, 2]);
});

test('oversize data without delimiter is discarded and decoder resynchronises', () => {
  const d = new FrameDecoder({ maxFrameLength: 64 });
  const junk = Buffer.concat([Buffer.from([0x7e]), Buffer.alloc(100, 0x11)]);
  const out1 = d.push(junk);
  assert.equal(out1.some((o) => o.type === 'garbage' && o.reason === 'oversize_without_delimiter'), true);
  const out2 = frames(d.push(Buffer.concat([hb(5)])));
  assert.equal(out2.length, 1);
  assert.equal(out2[0].header.serial, 5);
});
