import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startPlatform, startDevice, waitUntil, sleep, rawClient } from '../helpers.js';
import { MSG, fromHex, encodeAuthentication } from '../../src/protocol/index.js';

describe('simulator <-> TCP listener <-> protocol <-> services <-> store <-> API', () => {
  let ctx;
  let dev;
  let deviceId;

  before(async () => {
    ctx = await startPlatform();
    dev = await startDevice(ctx.platform, { terminalId: '000082637294', lockId: '82637294', iccid: '89914509001234567890', version: 'V1.2' });
    const d = await waitUntil(() => ctx.store.getDeviceByTerminalId('000082637294'), { message: 'device row' });
    deviceId = d.id;
  });

  after(async () => {
    dev?.close();
    await ctx.platform.stop();
  });

  test('connection + factory authentication (ICCID + version) is accepted and recorded', async () => {
    assert.equal(dev.authenticated, true);
    const d = await ctx.store.getDeviceById(deviceId);
    assert.equal(d.authenticated, true);
    assert.equal(d.auth_code, '89914509001234567890V1.2');
    assert.equal(d.iccid, '89914509001234567890');
    assert.equal(d.connection_status, 'online');
    const { body } = await ctx.api('GET', `/devices/${deviceId}/status`);
    assert.equal(body.online, true);
    assert.equal(body.authenticated, true);
  });

  test('time calibration 0x8103/0x002A is sent after authentication and acknowledged', async () => {
    await waitUntil(() => dev.received.some((m) => m.header.msgId === MSG.SET_PARAMS), { message: '0x8103' });
    const sp = dev.received.find((m) => m.header.msgId === MSG.SET_PARAMS);
    assert.equal(sp.body.params[0].idHex, '0x002A');
    const skew = Math.abs(new Date(sp.body.params[0].value.iso) - Date.now());
    assert.ok(skew < 5000, `time skew ${skew}`);
  });

  test('heartbeat is acknowledged with 0x8001 and recorded', async () => {
    const serial = dev.heartbeat();
    await waitUntil(() => dev.received.some((m) => m.header.msgId === MSG.PLATFORM_GENERAL_RESPONSE && m.body.replySerial === serial && m.body.replyId === MSG.HEARTBEAT));
    const d = await waitUntil(async () => (await ctx.store.getDeviceById(deviceId)).last_heartbeat_at && ctx.store.getDeviceById(deviceId));
    assert.ok(d.last_heartbeat_at);
  });

  test('location report is decoded, stored as history and acknowledged', async () => {
    dev.sendLocation();
    dev.sendLocation();
    const locs = await waitUntil(async () => {
      const l = await ctx.store.listLocations(deviceId);
      return l.length >= 2 ? l : null;
    }, { message: 'two locations' });
    assert.equal(locs[0].latitude, 28.613939);
    assert.equal(locs[0].longitude, 77.209021);
    assert.equal(locs[0].positioned, true);
    assert.equal(locs[0].source, '0x0200');
    const d = await ctx.store.getDeviceById(deviceId);
    assert.equal(d.battery_percent, 80);
    assert.equal(d.lock_state, 'unsealed');
    const { body } = await ctx.api('GET', `/devices/${deviceId}/locations`);
    assert.ok(body.length >= 2);
  });

  test('commands are refused while the LockID is unknown (it is never guessed)', async () => {
    const { status, body } = await ctx.api('POST', `/devices/${deviceId}/seal`, { key: '1234567890' });
    assert.equal(status, 409);
    assert.equal(body.error, 'LOCK_ID_UNKNOWN');
  });

  test('LockID is learned from a 0x0900 lock-info upload', async () => {
    dev.sendLockUpload(0x01);
    const d = await waitUntil(async () => {
      const x = await ctx.store.getDeviceById(deviceId);
      return x.lock_id ? x : null;
    }, { message: 'lock_id learned' });
    assert.equal(d.lock_id, '82637294');
    assert.equal(d.battery_voltage_code, '0x36');
  });

  test('seal: command -> 0x8900 -> 0x0001 ack -> 0x0900/0x55 reply 0x80 -> success; key stored', async () => {
    const { status, body } = await ctx.api('POST', `/devices/${deviceId}/seal?wait=true`, { key: '1234567890' });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.status, 'completed');
    assert.equal(body.result_code_hex, '0x80');
    assert.equal(body.result_label, 'Sealed');
    assert.equal(body.outcome, 'success');
    assert.equal(body.succeeded, true);
    assert.equal(body.correlation_method, 'business_serial');
    assert.equal(body.ack_result, 0);
    assert.ok(body.raw_tx_hex.startsWith('7E8900'));
    assert.ok(body.reply_raw_hex.startsWith('7E0900'));
    assert.equal(body.params.key, '12******90', 'key is masked in API output');
    const d = await ctx.store.getDeviceById(deviceId);
    assert.equal(d.lock_state, 'sealed');
    assert.equal(d.current_key, '1234567890');
    assert.equal(dev.lock.state, 'sealed');
  });

  test('repeat seal returns 0x81 "Already sealed" (no_change, not success)', async () => {
    const { body } = await ctx.api('POST', `/devices/${deviceId}/seal?wait=true`, {});
    assert.equal(body.result_code_hex, '0x81');
    assert.equal(body.outcome, 'no_change');
    assert.equal(body.succeeded, false);
  });

  test('unseal with the wrong key returns 0x93 and the lock stays sealed', async () => {
    const { body } = await ctx.api('POST', `/devices/${deviceId}/unseal?wait=true`, { key: '9999999999' });
    assert.equal(body.result_code_hex, '0x93');
    assert.equal(body.result_label, 'Unseal failed: wrong key');
    assert.equal(body.outcome, 'failure');
    assert.equal(dev.lock.state, 'sealed');
  });

  test('unseal with the stored key returns 0x90 success', async () => {
    const { body } = await ctx.api('POST', `/devices/${deviceId}/unseal?wait=true`, {});
    assert.equal(body.result_code_hex, '0x90');
    assert.equal(body.succeeded, true);
    assert.equal((await ctx.store.getDeviceById(deviceId)).lock_state, 'unsealed');
  });

  test('API returns 202 with status "sent" (not success) when not waiting', async () => {
    const { status, body } = await ctx.api('POST', `/devices/${deviceId}/unseal`, {});
    assert.equal(status, 202);
    assert.ok(['sent', 'acknowledged', 'pending'].includes(body.status));
    assert.equal(body.succeeded, false);
    const final = await waitUntil(async () => {
      const r = await ctx.api('GET', `/commands/${body.id}`);
      return r.body.final ? r.body : null;
    });
    assert.equal(final.result_code_hex, '0x97', 'unseal of an unsealed lock = "unseal without sealing"');
  });

  test('tamper: alarm upload + lock status alarm + E7 cable cut are raised; clear alarm 0x70 clears them', async () => {
    dev.raiseTamper();
    await waitUntil(async () => (await ctx.store.activeAlarms(deviceId)).length >= 3, { message: 'alarms' });
    const types = (await ctx.store.activeAlarms(deviceId)).map((a) => `${a.source}:${a.alarm_type}`).sort();
    assert.deepEqual(types, ['e7_alarm_status:cable_cut', 'lock_status:lock_rod_cut', 'lock_upload:lock_rod_cut']);
    assert.equal((await ctx.store.getDeviceById(deviceId)).lock_state, 'alarm');

    const seal = await ctx.api('POST', `/devices/${deviceId}/seal?wait=true`, {});
    assert.equal(seal.body.result_code_hex, '0x86', 'seal refused while rod-cut alarm is active');

    const { body } = await ctx.api('POST', `/devices/${deviceId}/clear-alarm?wait=true`, {});
    assert.equal(body.result_code_hex, '0x70');
    assert.equal(body.succeeded, true);
    dev.sendLocation();
    await waitUntil(async () => (await ctx.store.activeAlarms(deviceId)).length === 0, { message: 'alarms cleared' });
    const all = await ctx.store.listAlarms(deviceId);
    assert.ok(all.every((a) => a.cleared_at), 'alarm history kept, rows marked cleared');
    assert.ok(all.some((a) => a.cleared_by.startsWith('clear_alarm_command:')));
  });

  test('clear alarm when not in alarm returns 0x72', async () => {
    const { body } = await ctx.api('POST', `/devices/${deviceId}/clear-alarm?wait=true`, {});
    assert.equal(body.result_code_hex, '0x72');
    assert.equal(body.outcome, 'no_change');
  });

  test('low battery: seal returns 0x83 and a low_battery alarm is raised from the voltage code', async () => {
    dev.setLowBattery(true);
    const { body } = await ctx.api('POST', `/devices/${deviceId}/seal?wait=true`, {});
    assert.equal(body.result_code_hex, '0x83');
    assert.equal(body.result_label, 'Seal failed: low battery');
    const active = await ctx.store.activeAlarms(deviceId);
    assert.ok(active.some((a) => a.alarm_type === 'low_battery' && a.raw_value === '0x30'));
    dev.setLowBattery(false);
  });

  test('diagnostics: 0x8104 parameter query returns decoded 0x0104', async () => {
    const { status, body } = await ctx.api('POST', `/devices/${deviceId}/diagnostics/query-params`);
    assert.equal(status, 200);
    const names = body.body.params.map((p) => p.name);
    assert.ok(names.includes('main_server_address') && names.includes('server_tcp_port'));
  });

  test('diagnostics: 0x8201 location query returns 0x0201 and stores a location', async () => {
    const before = (await ctx.store.listLocations(deviceId)).length;
    const { status } = await ctx.api('POST', `/devices/${deviceId}/diagnostics/query-location`);
    assert.equal(status, 200);
    await waitUntil(async () => (await ctx.store.listLocations(deviceId)).length > before);
  });

  test('every RX/TX frame is in the message log with raw hex, serial and checksum result', async () => {
    const { body } = await ctx.api('GET', `/devices/${deviceId}/messages?limit=500`);
    assert.ok(body.some((m) => m.direction === 'rx' && m.msg_id_hex === '0x0102'));
    assert.ok(body.some((m) => m.direction === 'tx' && m.msg_id_hex === '0x8900'));
    assert.ok(body.some((m) => m.direction === 'rx' && m.msg_id_hex === '0x0900'));
    assert.ok(body.every((m) => m.raw_hex.startsWith('7E') && m.raw_hex.endsWith('7E')));
    assert.ok(body.filter((m) => m.direction === 'rx').every((m) => m.checksum_ok === true));
    const events = await ctx.api('GET', `/devices/${deviceId}/events`);
    assert.ok(events.body.some((e) => e.kind === 'command') && events.body.some((e) => e.kind === 'alarm'));
  });

  test('a second connection with the same terminal ID replaces the first (§5.3)', async () => {
    const dev2 = await startDevice(ctx.platform, { terminalId: '000082637294', lockId: '82637294', authCode: dev.authCode ?? undefined });
    await waitUntil(() => dev.socket.destroyed, { message: 'old socket closed' });
    const { body } = await ctx.api('POST', `/devices/${deviceId}/seal?wait=true`, { key: '1234567890' });
    assert.equal(body.result_code_hex, '0x80', 'command goes through the new session');
    dev2.close();
    await waitUntil(async () => (await ctx.store.getDeviceById(deviceId)).connection_status === 'offline', { message: 'offline' });
    const d = await ctx.store.getDeviceById(deviceId);
    assert.equal(d.authenticated, false);
    // reconnect
    dev = await startDevice(ctx.platform, { terminalId: '000082637294', lockId: '82637294', initialState: 'sealed', initialKey: '1234567890' });
    await waitUntil(async () => (await ctx.store.getDeviceById(deviceId)).connection_status === 'online', { message: 'online again' });
    const sessions = await ctx.store.listSessions(deviceId);
    assert.ok(sessions.some((s) => s.disconnect_reason === 'replaced_by_new_connection'));
  });

  test('command to an offline device is refused and recorded as send_failed', async () => {
    dev.close();
    await waitUntil(async () => (await ctx.store.getDeviceById(deviceId)).connection_status === 'offline');
    const { status, body } = await ctx.api('POST', `/devices/${deviceId}/unseal`, {});
    assert.equal(status, 409);
    assert.equal(body.error, 'DEVICE_OFFLINE');
    assert.equal(body.details.command.status, 'send_failed');
  });
});

describe('failure handling', () => {
  test('no operation reply -> command times out (never reported as success)', async () => {
    const ctx = await startPlatform({ commands: { timeoutS: 1 } });
    const dev = await startDevice(ctx.platform, { terminalId: '000000000777', lockId: '00000777', noReply: true });
    const d = await waitUntil(() => ctx.store.getDeviceByTerminalId('000000000777'));
    await ctx.api('PATCH', `/devices/${d.id}`, { lock_id: '00000777' });
    const { body } = await ctx.api('POST', `/devices/${d.id}/seal?wait=true`, { key: '1234567890' });
    assert.equal(body.status, 'timeout');
    assert.equal(body.outcome, 'timeout');
    assert.equal(body.ack_result, 0, 'the 0x0001 delivery ack alone does not make it a success');
    assert.equal(body.succeeded, false);
    dev.close();
    await ctx.platform.stop();
  });

  test('keypad operation (unsolicited 0x55, cmdSRC keypad) never completes a pending platform command', async () => {
    const ctx = await startPlatform({ commands: { timeoutS: 2 } });
    const dev = await startDevice(ctx.platform, { terminalId: '000000000321', lockId: '00000321', noReply: true, initialState: 'sealed' });
    const d = await waitUntil(() => ctx.store.getDeviceByTerminalId('000000000321'));
    await ctx.api('PATCH', `/devices/${d.id}`, { lock_id: '00000321', key_format: 'hex', current_key: '000000000000' });
    const sent = await ctx.api('POST', `/devices/${d.id}/unseal`, {});
    assert.equal(sent.status, 202);
    dev.keypadOperation(0x38, Buffer.from('000000', 'ascii'));
    await waitUntil(async () => (await ctx.store.getDeviceById(d.id)).lock_state === 'unsealed_local', { message: 'local unseal state' });
    const reply = ctx.store.messages.find((m) => m.msg_id === MSG.UPLINK_PASSTHROUGH && m.parsed?.body?.elock?.payload?.type === 'operation_reply');
    const oi = reply.parsed.body.elock.payload.operationIdentifier;
    assert.equal(oi.mode, 'keyboard');
    assert.equal(oi.password, '000000');
    assert.equal(reply.parsed.body.elock.payload.commandSource.source, 'keypad');
    const final = await waitUntil(async () => {
      const c = await ctx.store.getCommand(sent.body.id);
      return c.status === 'timeout' ? c : null;
    }, { timeout: 5000, message: 'platform command times out' });
    assert.equal(final.correlation_method ?? null, null, 'keypad reply was not attached to the platform command');
    dev.close();
    await ctx.platform.stop();
  });

  test('registration flow when authentication is rejected (AUTH_MODE=known_devices)', async () => {
    const ctx = await startPlatform({ auth: { mode: 'known_devices' } });
    const dev = await startDevice(ctx.platform, { terminalId: '000000000888', lockId: '00000888' });
    assert.equal(dev.authenticated, true);
    assert.match(dev.authCode, /^IL[0-9A-F]{10}$/);
    const d = await ctx.store.getDeviceByTerminalId('000000000888');
    assert.equal(d.auth_code, dev.authCode);
    assert.equal(d.auth_code_source, 'issued_by_platform');
    assert.equal(d.iccid, '89910000000000000001');
    const regs = ctx.store.messages.filter((m) => m.msg_id === MSG.REGISTER || m.msg_id === MSG.REGISTER_RESPONSE);
    assert.equal(regs.length, 2);
    dev.close();
    await ctx.platform.stop();
  });

  test('commands are refused for sessions that have not authenticated', async () => {
    const ctx = await startPlatform();
    const c = await rawClient(ctx.platform.tcpPort);
    c.send(MSG.HEARTBEAT, Buffer.alloc(0), '000000000999');
    const d = await waitUntil(() => ctx.store.getDeviceByTerminalId('000000000999'));
    await ctx.api('PATCH', `/devices/${d.id}`, { lock_id: '00000999', current_key: '1234567890' });
    const { status, body } = await ctx.api('POST', `/devices/${d.id}/seal`, {});
    assert.equal(status, 409);
    assert.equal(body.error, 'NOT_AUTHENTICATED');
    c.close();
    await ctx.platform.stop();
  });

  test('malformed input never crashes the listener; bad checksum / garbage logged; valid frames still processed', async () => {
    const ctx = await startPlatform();
    const c = await rawClient(ctx.platform.tcpPort);
    c.sendRaw(fromHex('DEADBEEF'));
    c.sendRaw(fromHex('7E 00 02 00 00 00 00 12 34 56 78 00 01 FF 7E')); // bad checksum
    c.sendRaw(fromHex('7E 00 02 00 7D 05 7E')); // bad escape
    c.sendRaw(fromHex('7E 01 7E')); // too short
    c.send(MSG.HEARTBEAT);
    await waitUntil(() => c.received.some((m) => m.header.msgId === MSG.PLATFORM_GENERAL_RESPONSE && m.body.replyId === MSG.HEARTBEAT), { message: 'heartbeat ack' });
    assert.equal(c.received.length, 1, 'only the valid heartbeat was acknowledged');
    const results = ctx.store.messages.filter((m) => m.direction === 'rx').map((m) => m.processing_result);
    assert.deepEqual(results.sort(), ['garbage', 'invalid_frame', 'invalid_frame', 'invalid_frame', 'ok'].sort());
    const bad = ctx.store.messages.find((m) => m.error?.startsWith('BAD_CHECKSUM'));
    assert.ok(bad, 'checksum failure recorded with its error');
    assert.equal(bad.checksum_ok, false);
    c.close();
    await ctx.platform.stop();
  });

  test('fragmented + coalesced frames over TCP are reassembled', async () => {
    const ctx = await startPlatform();
    const c = await rawClient(ctx.platform.tcpPort);
    const { encodePacket } = await import('../../src/protocol/index.js');
    const f1 = encodePacket({ msgId: MSG.AUTHENTICATE, terminalId: '000000004242', serial: 0, body: encodeAuthentication({ authCode: 'X' }) }).frame;
    const f2 = encodePacket({ msgId: MSG.HEARTBEAT, terminalId: '000000004242', serial: 1 }).frame;
    const f3 = encodePacket({ msgId: MSG.HEARTBEAT, terminalId: '000000004242', serial: 2 }).frame;
    const all = Buffer.concat([f1, f2, f3]);
    c.sendRaw(all.subarray(0, 5));
    await sleep(20);
    c.sendRaw(all.subarray(5, 30));
    await sleep(20);
    c.sendRaw(all.subarray(30));
    const acks = () => c.received.filter((m) => m.header.msgId === MSG.PLATFORM_GENERAL_RESPONSE);
    await waitUntil(() => acks().length === 3, { message: 'three acks' });
    assert.deepEqual(acks().map((m) => m.body.replySerial), [0, 1, 2]);
    c.close();
    await ctx.platform.stop();
  });

  test('unknown message IDs are acknowledged with result 3 (not supported) and logged', async () => {
    const ctx = await startPlatform();
    const c = await rawClient(ctx.platform.tcpPort);
    c.send(0x0f0f, fromHex('0102'));
    await waitUntil(() => c.received.length === 1);
    assert.equal(c.received[0].body.result, 3);
    assert.ok(ctx.store.messages.some((m) => m.processing_result === 'unsupported' && m.msg_id === 0x0f0f));
    c.close();
    await ctx.platform.stop();
  });

  test('heartbeat timeout marks the device offline and closes the socket', async () => {
    const ctx = await startPlatform({ device: { offlineTimeoutS: 1 } });
    const dev = await startDevice(ctx.platform, { terminalId: '000000005555', lockId: '00005555' });
    const d = await ctx.store.getDeviceByTerminalId('000000005555');
    await sleep(1200);
    ctx.platform.listener.sweep();
    await waitUntil(async () => (await ctx.store.getDeviceById(d.id)).connection_status === 'offline', { message: 'offline' });
    assert.equal((await ctx.store.getDeviceById(d.id)).last_disconnect_reason, 'heartbeat_timeout');
    dev.close();
    await ctx.platform.stop();
  });
});
