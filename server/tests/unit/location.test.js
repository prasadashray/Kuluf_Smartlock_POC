import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeLocationReport, decodeLocationReport, encodeLocationBasic, decodeLocationBasic, fromHex, toHex } from '../../src/protocol/index.js';

test('basic location info is 28 bytes with time at offset 22 (DOC-08)', () => {
  const b = encodeLocationBasic({ time: new Date('2026-09-25T19:15:40Z') });
  assert.equal(b.length, 28);
  assert.equal(toHex(b.subarray(22)), '260926031540');
});

test('known-value decode: lat/lon x1e6, speed 1/10 km/h, direction, GMT+8 time', () => {
  // alarm=0x80000001 (bit31 illegal door open + bit0 emergency), status: positioned + GPS + LockStatus 0x40
  const hex = '80000001' + '40040002' + '01B49D2C' + '0499F2A8' + '00D7' + '007D' + '005A' + '260926031540';
  const r = decodeLocationBasic(fromHex(hex));
  assert.equal(r.ok, true);
  assert.equal(r.latitude, 28.613932);
  assert.equal(r.longitude, 77.197992); // 0x0499F2A8 = 77197992
  assert.equal(r.altitudeM, 215);
  assert.equal(r.speedKmh, 12.5);
  assert.equal(r.directionDeg, 90);
  assert.equal(r.time.iso, '2026-09-25T19:15:40.000Z');
  assert.equal(r.positioned, true);
  assert.deepEqual(r.alarms.map((a) => a.key), ['emergency', 'illegal_door_open']);
  assert.equal(r.status.lockStatus.state, 'sealed');
  assert.equal(r.status.gnss.gps, true);
});

test('southern / western hemisphere sign comes from status bits 2 and 3', () => {
  const r = decodeLocationBasic(encodeLocationBasic({ latitude: -33.8688, longitude: -151.2093 }));
  assert.equal(r.status.southLatitude, true);
  assert.equal(r.status.westLongitude, true);
  assert.equal(r.latitude, -33.8688);
  assert.equal(r.longitude, -151.2093);
});

test('status bits 24-31 = 0x00 means no lock status', () => {
  const r = decodeLocationBasic(encodeLocationBasic({ lockStatus: 0 }));
  assert.equal(r.status.lockStatus, null);
});

test('TT additional items: E7 alarms, E8 switches, E9 battery, 56 voltage, 5D LBS, E6 ICCID, 30/31', () => {
  const body = encodeLocationReport({ latitude: 28.6, longitude: 77.2 }, [
    { id: 0xe7, value: fromHex('000003') }, // cable cut + emergency unlock
    { id: 0xe8, value: fromHex('700005') }, // knob opened + lock rod opened, network type 7 (4G)
    { id: 0xe9, value: fromHex('55') },
    { id: 0x56, value: fromHex('0850') },
    { id: 0x5d, value: fromHex('01 0194 5A 1234 01501234 1F') },
    { id: 0xe6, value: Buffer.from('89914000000000000001') },
    { id: 0x30, value: fromHex('17') },
    { id: 0x31, value: fromHex('09') },
    { id: 0xfe, value: fromHex('DEAD') },
  ]);
  const r = decodeLocationReport(body);
  assert.equal(r.ok, true);
  assert.deepEqual(r.additionalErrors, []);
  assert.deepEqual(r.extras.e7Alarms.map((a) => a.key), ['cable_cut', 'emergency_unlock']);
  assert.equal(r.extras.switches.knob_opened, true);
  assert.equal(r.extras.switches.lock_rod_opened, true);
  assert.equal(r.extras.switches.motor_released, false);
  assert.equal(r.extras.networkType, 'E-UTRAN (4G)');
  assert.equal(r.extras.batteryPercent, 85);
  assert.equal(r.extras.batteryMv, 4000);
  assert.equal(r.extras.lbs.variant, '10B');
  assert.equal(r.extras.lbs.stations[0].mcc, 404);
  assert.equal(r.extras.lbs.stations[0].cellId, 0x01501234);
  assert.equal(r.extras.iccid, '89914000000000000001');
  assert.equal(r.extras.signalStrength, 23);
  assert.equal(r.extras.satellites, 9);
  const unknown = r.additional.find((i) => i.id === 0xfe);
  assert.equal(unknown.hex, 'DEAD');
  assert.equal(unknown.decoded, null);
});

test('truncated additional item is reported, earlier items kept', () => {
  const body = Buffer.concat([encodeLocationBasic({}), fromHex('3001 17 E905')]);
  const r = decodeLocationReport(body);
  assert.equal(r.ok, true);
  assert.equal(r.extras.signalStrength, 23);
  assert.equal(r.additionalErrors.length, 1);
});

test('short body is an error, not an exception', () => {
  assert.equal(decodeLocationReport(fromHex('0000')).ok, false);
});
