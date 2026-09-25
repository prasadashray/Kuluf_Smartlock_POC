#!/usr/bin/env node
// TT ELOCK device simulator CLI. Example:
//   node simulator/simulate-device.js --host 127.0.0.1 --port 6808 --device-id 000082637294 --lock-id 82637294 --verbose
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SimulatedDevice } from './device.js';
import { loadConfig, businessFrameOptions } from '../server/src/config/index.js';

const HELP = `TT ELOCK simulator

Connection:
  --host <ip>                 server host (default 127.0.0.1)
  --port <n>                  server TCP port (default TCP_PORT or 6808)
  --device-id <digits>        JT/T808 terminal ID, up to 12 digits (default 000082637294)
  --lock-id <8 digits>        e-lock LockID (default 82637294)
  --auth-code <str>           authentication code to present (default: ICCID + version, i.e. factory behaviour)
  --iccid <20 chars>          SIM ICCID used for registration / factory auth code
  --register                  skip the first 0x0102 and register (0x0100) straight away

Timing:
  --heartbeat <s>             heartbeat interval (default 30, 0 = off)
  --location-interval <s>     location report interval (default 60, 0 = off)
  --lock-upload-interval <s>  0x0900 lock-info upload interval (default 0 = off)
  --reply-delay-ms <ms>       delay before the 0x55 operation reply (default 1000)
  --exit-after <s>            disconnect and exit after N seconds

Lock state / scenarios:
  --simulate-sealed           start sealed (use --key for the stored seal key)
  --simulate-unsealed         start unsealed (default)
  --key <digits>              key currently stored in the lock
  --key-format <rf10|ascii6|hex>
  --simulate-low-battery      voltage code 0x30 -> seal returns 0x83
  --simulate-tamper           start in lock-rod-cut alarm (0x71), sends 0x04 alarm upload after connect
  --simulate-location         move along a path (otherwise stationary)
  --lat <deg> --lon <deg>     start position
  --no-reply                  acknowledge 0x8900 but never send the 0x55 reply (command-timeout testing)
  --scenario <file|name>      JSON scenario from simulator/scenarios
  --verbose                   print every frame
`;

const { values: a } = parseArgs({
  options: {
    host: { type: 'string', default: '127.0.0.1' },
    port: { type: 'string' },
    'device-id': { type: 'string', default: '000082637294' },
    'lock-id': { type: 'string', default: '82637294' },
    'auth-code': { type: 'string' },
    iccid: { type: 'string', default: '89910000000000000001' },
    register: { type: 'boolean', default: false },
    heartbeat: { type: 'string', default: '30' },
    'location-interval': { type: 'string', default: '60' },
    'lock-upload-interval': { type: 'string', default: '0' },
    'reply-delay-ms': { type: 'string', default: '1000' },
    'exit-after': { type: 'string' },
    'simulate-sealed': { type: 'boolean', default: false },
    'simulate-unsealed': { type: 'boolean', default: false },
    key: { type: 'string' },
    'key-format': { type: 'string', default: 'rf10' },
    'simulate-low-battery': { type: 'boolean', default: false },
    'simulate-tamper': { type: 'boolean', default: false },
    'simulate-location': { type: 'boolean', default: false },
    lat: { type: 'string', default: '28.613939' },
    lon: { type: 'string', default: '77.209021' },
    'no-reply': { type: 'boolean', default: false },
    scenario: { type: 'string' },
    verbose: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

if (a.help) {
  console.log(HELP);
  process.exit(0);
}

const cfg = loadConfig();
const here = path.dirname(fileURLToPath(import.meta.url));

function loadScenario(ref) {
  if (!ref) return null;
  const candidates = [ref, path.join(here, 'scenarios', ref), path.join(here, 'scenarios', `${ref}.json`)];
  const file = candidates.find((f) => fs.existsSync(f));
  if (!file) throw new Error(`Scenario not found: ${ref}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const scenario = loadScenario(a.scenario);

const device = new SimulatedDevice({
  host: a.host,
  port: Number(a.port ?? cfg.tcp.port),
  terminalId: a['device-id'],
  lockId: a['lock-id'],
  authCode: a['auth-code'] ?? null,
  iccid: a.iccid,
  forceRegister: a.register,
  heartbeatS: Number(a.heartbeat),
  locationS: Number(a['location-interval']),
  lockUploadS: Number(a['lock-upload-interval']),
  replyDelayMs: Number(a['reply-delay-ms']),
  noReply: a['no-reply'],
  initialState: a['simulate-sealed'] ? 'sealed' : 'unsealed',
  initialKey: a.key ?? null,
  keyFormat: a['key-format'],
  lowBattery: a['simulate-low-battery'],
  tamper: a['simulate-tamper'],
  moving: a['simulate-location'],
  lat: Number(a.lat),
  lon: Number(a.lon),
  business: businessFrameOptions(cfg),
  tzOffsetMinutes: cfg.device.tzOffsetMinutes,
  verbose: a.verbose,
});

device.on('authenticated', ({ authCode }) => console.log(`[sim] authenticated with code "${authCode}"`));
device.on('operation', (o) => console.log(`[sim] lock operation cmd=0x${o.cmd.toString(16)} -> result 0x${o.resultCode.toString(16)} state=${o.state}`));
device.on('setParams', (p) => console.log('[sim] 0x8103 set params:', JSON.stringify(p.params.map((x) => ({ id: x.idHex, name: x.name, value: x.value })))));
device.on('closed', () => {
  console.log('[sim] connection closed');
  process.exit(0);
});

function runScenario(sc) {
  for (const step of sc.steps ?? []) {
    setTimeout(() => {
      console.log(`[sim] scenario step @${step.at}s: ${step.action}`);
      switch (step.action) {
        case 'tamper': device.raiseTamper(); break;
        case 'low_battery': device.setLowBattery(true); device.sendLocation(); break;
        case 'battery_ok': device.setLowBattery(false); device.sendLocation(); break;
        case 'location': device.sendLocation(); break;
        case 'heartbeat': device.heartbeat(); break;
        case 'lock_upload': device.sendLockUpload(step.subCmd ?? 0x01); break;
        case 'emergency_alarm': device.sendLocation({ alarmFlags: 0x00000001 }); break;
        case 'disconnect': device.close(); break;
        default: console.log(`[sim] unknown scenario action ${step.action}`);
      }
    }, step.at * 1000);
  }
}

try {
  await device.connect();
  console.log(`[sim] connected to ${a.host}:${device.o.port} as terminal ${device.o.terminalId}, lock ${device.o.lockId}, state ${device.lock.state}`);
  if (a['simulate-tamper']) device.raiseTamper();
  if (scenario) runScenario(scenario);
  if (a['exit-after']) setTimeout(() => device.close(), Number(a['exit-after']) * 1000);
} catch (e) {
  console.error('[sim] failed:', e.message);
  process.exit(1);
}
