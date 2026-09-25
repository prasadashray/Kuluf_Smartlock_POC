import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeLockId, decodeLockId, encodeKey, decodeKey, encodeBill, encodeLineCode,
  encodeLockOperation, decodeLockOperation, encodeOperationReply, decodeOperationReply,
  encodeLockUpload, decodeLockUpload, encodeLockUploadReply, decodeLockUploadReply,
  encodeBusinessFrame, decodeBusinessFrame, describeResultCode, describeLockStatus, describeVoltage,
  encodeLocationBasic, computeCrc, LOCK_CMD, fromHex, toHex,
} from '../../src/protocol/index.js';

test('LockID conversion, Appendix 0 example: 83181001 -> 0x207E03E9', () => {
  assert.equal(toHex(encodeLockId('83181001')), '207E03E9');
  assert.equal(decodeLockId(fromHex('207E03E9')).lockId, '83181001');
});

test('LockID of the physical sample (hardware BLE evidence): 82637294 -> 20 47 1C 7E', () => {
  assert.equal(toHex(encodeLockId('82637294')), '20471C7E');
  assert.equal(decodeLockId(fromHex('20471C7E')).lockId, '82637294');
});

test('LockID validation', () => {
  assert.throws(() => encodeLockId('1234567'));
  assert.throws(() => encodeLockId('ABCDEFGH'));
  assert.equal(decodeLockId(fromHex('FFFF0000')).valid, false);
  assert.equal(toHex(encodeLockId('00010002')), '00010002');
});

test('Key rf10 (Chinese Appendix 0): first 4 digits -> WORD, last 6 digits -> DWORD; example 1234567890 -> 04D2 0008AA52', () => {
  assert.equal(toHex(encodeKey('1234567890', 'rf10')), '04D20008AA52');
  assert.equal(decodeKey(fromHex('04D20008AA52'), 'rf10').key, '1234567890');
});

test('Key ascii6 (password lock) and hex escape hatch', () => {
  assert.equal(toHex(encodeKey('123456', 'ascii6')), '313233343536');
  assert.equal(decodeKey(fromHex('313233343536'), 'ascii6').key, '123456');
  assert.equal(toHex(encodeKey('AABBCCDDEEFF', 'hex')), 'AABBCCDDEEFF');
  assert.throws(() => encodeKey('12345', 'ascii6'));
  assert.throws(() => encodeKey('123456789', 'rf10'));
});

test('Bill and LineCode', () => {
  assert.equal(toHex(encodeBill('1234567890ABCDEF')), '1234567890ABCDEF');
  assert.equal(toHex(encodeBill('0')), '0000000000000000');
  assert.equal(toHex(encodeLineCode(1234)), '04D2');
  assert.throws(() => encodeBill('XYZ'));
});

// Chinese A13 §10.2.1 example (the English translation drops one byte - DOC-05):
//   252A 1532 043B1F46 02 00003039040BEBCB 04D204D20008AA52 03 01108026081010164318 23 $$
const DOC_SEAL_DATA = ['1532', '043B1F46', '02', '00003039040BEBCB', '04D204D20008AA52', '03', '01108026081010164318'].join('');

test('Seal command reproduces the protocol document example byte-for-byte', () => {
  const data = encodeLockOperation({
    cmd: LOCK_CMD.SEAL,
    lockId: '10838006', // 0x043B = 1083, 0x1F46 = 8006
    gate: 0x02,
    bill: '00003039040BEBCB',
    lineCode: 1234,
    key: '1234567890',
    keyFormat: 'rf10',
    validTime: 3,
    spare: fromHex('01108026'),
    time: fromHex('081010164318'),
  });
  assert.equal(toHex(data), DOC_SEAL_DATA);
  assert.equal(data.length, 34);
});

test('document example LEN 0x25 equals the doc_example interpretation', () => {
  const data = fromHex(DOC_SEAL_DATA);
  const frame = encodeBusinessFrame(data, 1, { lenMode: 'doc_example' });
  assert.equal(frame[0], 0x25);
  assert.equal(toHex(frame.subarray(1, 1 + 36)), `2A${DOC_SEAL_DATA}23`);
});

test('decodeLockOperation reads the document example', () => {
  const d = decodeLockOperation(fromHex(DOC_SEAL_DATA));
  assert.equal(d.ok, true);
  assert.equal(d.commandType, 'seal');
  assert.equal(d.lock.lockId, '10838006');
  assert.equal(d.gate, 2);
  assert.equal(d.lineCode, 1234);
  assert.equal(d.key.key, '1234567890');
  assert.equal(d.validTime, 3);
  assert.equal(d.time.raw, '081010164318');
});

test('Unseal and Clear alarm command bytes', () => {
  const common = { lockId: '82637294', key: '1234567890', time: fromHex('260926120000') };
  const unseal = encodeLockOperation({ ...common, cmd: LOCK_CMD.UNSEAL });
  const clear = encodeLockOperation({ ...common, cmd: LOCK_CMD.CLEAR_ALARM });
  assert.equal(toHex(unseal.subarray(0, 7)), '153820471C7E00');
  assert.equal(toHex(clear.subarray(0, 2)), '1542');
  assert.equal(unseal.length, 34);
});

test('Legacy (pre-A10) operation reply example from the Chinese document decodes', () => {
  // Eg: 1C 2A 5597 04 3B 1F 46 02 12 34 56 78 12 34 56 78 35 20 00 05 05 07 15 14 48 33 23 $$
  const data = fromHex('5597043B1F4602123456781234567835200005050715144833');
  const r = decodeOperationReply(data);
  assert.equal(r.ok, true);
  assert.equal(r.format, 'legacy_pre_A10');
  assert.equal(r.result.hex, '0x97');
  assert.equal(r.result.label, 'Not sealed yet');
  assert.equal(r.lock.lockId, '10838006');
  assert.equal(r.voltage.volts, 4.0);
  assert.equal(r.lockStatus.state, 'standby');
  assert.equal(r.commandSource.source, 'checkpoint');
  assert.equal(r.time.raw, '050715144833');
  // and the LEN 0x1C of that example also equals the doc_example interpretation
  const frame = encodeBusinessFrame(data, 0, { lenMode: 'doc_example' });
  assert.equal(frame[0], 0x1c);
});

test('A13 operation reply round-trip with operation identifier', () => {
  const opIdent = Buffer.concat([Buffer.from('C'), Buffer.from([0x38]), Buffer.from('123456')]);
  const data = encodeOperationReply({
    resultCode: 0x90, lockId: '82637294', bill: '1', voltage: 0x36, lockStatus: 0x60, motorStatus: 0x01,
    lineCode: 7, operationIdentifier: opIdent, commandSource: 0x04, time: fromHex('260926031540'),
  });
  assert.equal(data.length, 35);
  const r = decodeOperationReply(data);
  assert.equal(r.format, 'A13');
  assert.equal(r.result.outcome, 'success');
  assert.equal(r.result.command, 'unseal');
  assert.equal(r.lock.lockId, '82637294');
  assert.equal(r.lockStatus.state, 'unsealed');
  assert.equal(r.lineCode, 7);
  assert.equal(r.operationIdentifier.mode, 'remote');
  assert.equal(r.operationIdentifier.password, '123456');
  assert.equal(r.commandSource.source, 'platform');
  assert.equal(r.time.iso, '2026-09-25T19:15:40.000Z');
});

test('result codes keep raw code, protocol meaning and label', () => {
  const expectations = {
    0x80: ['seal', 'success'], 0x81: ['seal', 'no_change'], 0x82: ['seal', 'failure'], 0x83: ['seal', 'failure'],
    0x84: ['seal', 'failure'], 0x85: ['seal', 'failure'], 0x86: ['seal', 'failure'], 0x87: ['seal', 'failure'],
    0x89: ['seal', 'timeout'], 0x90: ['unseal', 'success'], 0x91: ['unseal', 'no_change'], 0x93: ['unseal', 'failure'],
    0x97: ['unseal', 'no_change'], 0x99: ['unseal', 'timeout'], 0x70: ['clear_alarm', 'success'], 0x72: ['clear_alarm', 'no_change'],
  };
  for (const [code, [command, outcome]] of Object.entries(expectations)) {
    const r = describeResultCode(Number(code));
    assert.equal(r.command, command, `code ${code}`);
    assert.equal(r.outcome, outcome, `code ${code}`);
    assert.ok(r.meaning && r.label);
  }
  assert.equal(describeResultCode(0x88).known, false);
});

test('lock status (Appendix 3) and voltage codes', () => {
  assert.equal(describeLockStatus(0x50).state, 'sealed_local');
  assert.equal(describeLockStatus(0xb0).state, 'unsealed_local');
  assert.deepEqual(describeLockStatus(0x73).alarmBits, ['lock_rod_cut', 'opened']);
  assert.deepEqual(describeLockStatus(0x43).alarmBits, []);
  assert.equal(describeVoltage(0x30).level, 'critical');
  assert.equal(describeVoltage(0x37).volts, 4.2);
});

test('lock info upload (§10.3) and 0x61 reply round-trip', () => {
  const up = encodeLockUpload({ subCmd: 0x04, lockId: '82637294', voltage: 0x31, lockStatus: 0x71, time: fromHex('260926031540') });
  assert.equal(up.length, 21);
  const d = decodeLockUpload(up);
  assert.equal(d.subCmdKey, 'lock_rod_cut');
  assert.equal(d.isAlarm, true);
  assert.equal(d.lockStatus.state, 'alarm');
  const reply = encodeLockUploadReply({ subCmd: 0x04, lockId: '82637294', time: fromHex('260926031540') });
  assert.equal(toHex(reply), '610420471C7E260926031540');
  assert.equal(decodeLockUploadReply(reply).lock.lockId, '82637294');
});

test('business frame downlink round-trip with default options', () => {
  const data = encodeLockOperation({ cmd: LOCK_CMD.SEAL, lockId: '82637294', key: '1234567890', time: fromHex('260926120000') });
  const frame = encodeBusinessFrame(data, 0x0102);
  assert.equal(frame[0], frame.length - 1, 'after_len: LEN counts every byte after it');
  assert.equal(frame[1], 0x2a);
  assert.equal(frame[frame.length - 4], 0x23);
  const d = decodeBusinessFrame(frame, { direction: 'downlink' });
  assert.equal(d.ok, true, d.errors.join());
  assert.equal(d.serial, 0x0102);
  assert.equal(d.crcValid, true);
  assert.ok(d.crcMatches.includes('crc8_maxim/from_len'));
  assert.ok(d.lenInterpretations.includes('after_len'));
  assert.equal(d.payload.commandType, 'seal');
});

test('business frame uplink with 28B GPS + 10B LBS additional information', () => {
  const reply = encodeOperationReply({ resultCode: 0x80, lockId: '82637294', lockStatus: 0x40, time: fromHex('260926031540') });
  const gps = encodeLocationBasic({ latitude: 28.6139, longitude: 77.209, speedKmh: 12.5, directionDeg: 90, time: new Date('2026-09-25T19:15:40Z') });
  const lbs = fromHex('0194 5A 1234 01501234 1F'); // MCC 404, MNC 90
  const frame = encodeBusinessFrame(reply, 0x0007, { additional: Buffer.concat([gps, lbs]) });
  const d = decodeBusinessFrame(frame, { direction: 'uplink' });
  assert.equal(d.ok, true, d.errors.join());
  assert.equal(d.serial, 7);
  assert.equal(d.payload.result.label, 'Sealed');
  assert.equal(d.gps.latitude, 28.6139);
  assert.equal(d.lbs.variant, '10B');
  assert.equal(d.lbs.mcc, 404);
  assert.equal(d.crcValid, true);
});

test('LockID containing 0x23 does not confuse tail detection', () => {
  // 0035 -> 0x0023, so LockID "00350035" encodes as 00 23 00 23
  const reply = encodeOperationReply({ resultCode: 0x80, lockId: '00350035', time: fromHex('260926232323') });
  const frame = encodeBusinessFrame(reply, 0x2323);
  const d = decodeBusinessFrame(frame, { direction: 'uplink' });
  assert.equal(d.ok, true, d.errors.join());
  assert.equal(d.payload.lock.lockId, '00350035');
  assert.equal(d.serial, 0x2323);
});

test('decoder records which LEN / CRC interpretation a frame matches (evidence for DOC-06/07)', () => {
  const data = encodeLockUpload({ lockId: '82637294', time: fromHex('260926031540') });
  const frame = encodeBusinessFrame(data, 0, { lenMode: 'doc_example', crcAlgo: 'xor', crcRange: 'from_head' });
  const d = decodeBusinessFrame(frame, { direction: 'uplink' });
  assert.equal(d.ok, true);
  assert.ok(d.lenInterpretations.includes('doc_example'));
  assert.equal(d.lenMatchesConfigured, false);
  assert.ok(d.crcMatches.includes('xor/from_head'));
  assert.equal(d.crcValid, false, 'default config is crc8_maxim/from_len so this must be flagged');
  assert.ok(d.warnings.some((w) => w.includes('does not match configured')));
});

test('CRC-8/MAXIM reproduces the checksums of the frames captured from the device over BLE (H-06)', () => {
  for (const hex of ['010e0120471c7e3750fd26092603154067', '010e0120471c7e3750fd26092603154385', '010e0120471c7e3750fd260926031741a8',
    '010e0120471c7e3750fd26092603174497', '010e0120471c7e3750fd26092603174775']) {
    const f = fromHex(hex);
    assert.equal(computeCrc('crc8_maxim', f.subarray(0, -1)), f[f.length - 1], hex);
  }
});

test('malformed business frames produce errors, not exceptions', () => {
  assert.equal(decodeBusinessFrame(fromHex('0102')).ok, false);
  assert.equal(decodeBusinessFrame(fromHex('10FF5580000000000000')).ok, false);
  const noTail = decodeBusinessFrame(fromHex('0A2A55800000000000AABBCC'));
  assert.equal(noTail.ok, false);
});
