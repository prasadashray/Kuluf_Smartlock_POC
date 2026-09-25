// Drives the running platform through its REST API and prints a compact report.
// Usage: node tools/e2e-api-check.mjs [apiBase] [terminalId]
const API = process.argv[2] ?? 'http://127.0.0.1:3000/api';
const TERMINAL = process.argv[3] ?? '000082637294';

async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const cmdLine = (c) => `${c.command_type}: status=${c.status} code=${c.result_code_hex ?? '-'} "${c.result_label ?? ''}" outcome=${c.outcome ?? '-'} succeeded=${c.succeeded} ack=${c.ack_result_label ?? '-'} correlation=${c.correlation_method ?? '-'} 808serial=${c.jt808_serial} bizSerial=${c.business_serial}`;

const health = await call('GET', '/health');
console.log('health', JSON.stringify(health.body));
const dev = (await call('GET', `/devices/${TERMINAL}`)).body;
console.log('device', JSON.stringify({ online: dev.online, auth: dev.session_authenticated, terminal: dev.terminal_id, lock: dev.lock_id, state: dev.lock_state, voltage: dev.battery_voltage_code, pct: dev.battery_percent, loc: dev.latest_location && [dev.latest_location.latitude, dev.latest_location.longitude] }));

for (const [path, body] of [['seal', { key: '1234567890' }], ['unseal', { key: '0000000001' }], ['unseal', null], ['clear-alarm', null]]) {
  const r = await call('POST', `/devices/${dev.id}/${path}?wait=true`, body);
  console.log(r.status, r.body.command_type ? cmdLine(r.body) : JSON.stringify(r.body));
}
const seal = (await call('GET', `/devices/${dev.id}/commands?limit=10`)).body.find((c) => c.command_type === 'seal');
console.log('seal TX  ', seal.raw_tx_hex);
console.log('seal RX  ', seal.reply_raw_hex);
console.log('seal evidence', JSON.stringify({ crcMatches: seal.reply_parsed.crcMatches, crcValid: seal.reply_parsed.crcValid, len: seal.reply_parsed.lenInterpretations }));

const qp = await call('POST', `/devices/${dev.id}/diagnostics/query-params`);
console.log('0x0104 params', JSON.stringify(qp.body.body.params.map((p) => [p.idHex, p.name, p.value])));

for (const p of ['locations', 'alarms', 'commands', 'messages', 'events']) {
  console.log(`${p}: ${(await call('GET', `/devices/${dev.id}/${p}?limit=1000`)).body.length}`);
}
const msgs = (await call('GET', `/devices/${dev.id}/messages?limit=1000`)).body;
const counts = {};
for (const m of msgs) counts[`${m.direction} ${m.msg_id_hex}`] = (counts[`${m.direction} ${m.msg_id_hex}`] ?? 0) + 1;
console.log('message log by type', JSON.stringify(counts));
console.log('checksum failures', msgs.filter((m) => m.checksum_ok === false).length);
