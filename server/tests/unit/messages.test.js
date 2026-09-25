import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MSG, encodeGeneralResponse, decodeGeneralResponse, encodeRegistrationResponse, decodeRegistrationResponse,
  decodeRegistration, encodeRegistration, decodeAuthentication, encodeAuthentication, encodeSetParams, decodeSetParams,
  decodeQueryParamsResponse, encodePassthrough, decodeBody, encodeBusinessFrame, encodeLockUpload, PASSTHROUGH_ELOCK,
  fromHex, toHex, encodeText, decodeText,
} from '../../src/protocol/index.js';

test('0x8001 platform general response body', () => {
  const b = encodeGeneralResponse({ replySerial: 0x0102, replyId: MSG.HEARTBEAT, result: 0 });
  assert.equal(toHex(b), '0102000200');
  const d = decodeGeneralResponse(b);
  assert.equal(d.replyIdHex, '0x0002');
  assert.equal(d.resultLabel, 'success');
});

test('0x0001 terminal general response result labels', () => {
  assert.equal(decodeGeneralResponse(fromHex('0005890002')).resultLabel, 'message_error');
  assert.equal(decodeGeneralResponse(fromHex('0005890003')).resultLabel, 'not_supported');
  assert.equal(decodeGeneralResponse(fromHex('00')).ok, false);
});

test('0x0100 TT registration carries a 20-byte ICCID', () => {
  const body = encodeRegistration({ iccid: '89914509001234567890' });
  assert.equal(body.length, 20);
  const d = decodeRegistration(body);
  assert.equal(d.ok, true);
  assert.equal(d.iccid, '89914509001234567890');
  assert.equal(decodeRegistration(fromHex('3839')).ok, false);
});

test('0x8100 registration response: auth code only on success', () => {
  assert.equal(toHex(encodeRegistrationResponse({ replySerial: 3, result: 0, authCode: 'AB12' })), '0003004142' + '3132');
  assert.equal(toHex(encodeRegistrationResponse({ replySerial: 3, result: 4, authCode: 'AB12' })), '000304');
  assert.equal(decodeRegistrationResponse(fromHex('00030041423132')).authCode, 'AB12');
});

test('0x0102 authentication: factory default ICCID + version is recognised, full string kept as the code', () => {
  const d = decodeAuthentication(encodeAuthentication({ authCode: '89914509001234567890V2.1.3' }));
  assert.equal(d.authCode, '89914509001234567890V2.1.3');
  assert.equal(d.looksLikeFactoryDefault, true);
  assert.equal(d.iccidGuess, '89914509001234567890');
  assert.equal(d.versionGuess, 'V2.1.3');
  const issued = decodeAuthentication(encodeAuthentication({ authCode: 'IL-3F9A2C' }));
  assert.equal(issued.looksLikeFactoryDefault, false);
});

test('0x8103 set parameters: time calibration param 0x002A (BCD[6]) and heartbeat 0x0001', () => {
  const body = encodeSetParams([
    { id: 0x002a, value: new Date('2026-09-25T19:15:40Z') },
    { id: 0x0001, value: 60 },
  ]);
  assert.equal(toHex(body), '02' + '0000002A06260926031540' + '000000010400000' + '03C');
  const d = decodeSetParams(body);
  assert.equal(d.params[0].value.iso, '2026-09-25T19:15:40.000Z');
  assert.equal(d.params[1].value, 60);
});

test('0x0104 query parameters response decodes server address/port/APN', () => {
  const params = encodeSetParams([
    { id: 0x0013, value: '203.0.113.10' },
    { id: 0x0018, value: 7018 },
    { id: 0x0010, value: 'airteliot.com' },
  ]);
  const body = Buffer.concat([fromHex('0009'), params]);
  const d = decodeQueryParamsResponse(body);
  assert.equal(d.replySerial, 9);
  const byName = Object.fromEntries(d.params.map((p) => [p.name, p.value]));
  assert.deepEqual(byName, { main_server_address: '203.0.113.10', server_tcp_port: 7018, apn: 'airteliot.com' });
});

test('0x0900 passthrough with type 0x81 decodes the e-lock business frame', () => {
  const frame = encodeBusinessFrame(encodeLockUpload({ lockId: '82637294', lockStatus: 0x50, time: fromHex('260926031540') }), 0);
  const d = decodeBody(MSG.UPLINK_PASSTHROUGH, encodePassthrough(PASSTHROUGH_ELOCK, frame));
  assert.equal(d.ok, true);
  assert.equal(d.elock.payload.type, 'lock_upload');
  assert.equal(d.elock.payload.lock.lockId, '82637294');
  assert.equal(d.elock.payload.lockStatus.state, 'sealed_local');
});

test('passthrough with a non-0x81 type is kept as raw content', () => {
  const d = decodeBody(MSG.UPLINK_PASSTHROUGH, fromHex('41AABB'));
  assert.equal(d.elock, null);
  assert.equal(d.contentHex, 'AABB');
});

test('text upload / downlink (0x0300 / 0x8300)', () => {
  const b = encodeText({ flag: 4, text: 'TT%REST=?' });
  assert.equal(decodeText(b).text, 'TT%REST=?');
});

test('unknown message IDs are preserved as hex', () => {
  const d = decodeBody(0x0f01, fromHex('0102'));
  assert.equal(d.unsupported, true);
  assert.equal(d.hex, '0102');
});
