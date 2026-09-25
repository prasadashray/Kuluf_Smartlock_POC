// All runtime configuration comes from environment variables (optionally loaded from a .env file).
// Nothing device-specific (IDs, keys, auth codes, credentials) is hard-coded.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEN_MODES, CRC_RANGES, CRC_ALGORITHMS, KEY_FORMATS } from '../protocol/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..', '..', '..');

let envLoaded = false;
export function loadEnvFile() {
  if (envLoaded) return;
  envLoaded = true;
  const candidates = [process.env.ENV_FILE, path.join(process.cwd(), '.env'), path.join(REPO_ROOT, '.env')].filter(Boolean);
  for (const f of candidates) {
    if (fs.existsSync(f)) {
      process.loadEnvFile(f);
      return;
    }
  }
}

function str(name, def) {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}

function int(name, def, { min = -Infinity, max = Infinity } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Config ${name} must be an integer in [${min}, ${max}], got "${raw}"`);
  return n;
}

function bool(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  throw new Error(`Config ${name} must be a boolean, got "${raw}"`);
}

function oneOf(name, def, allowed) {
  const v = str(name, def);
  if (!allowed.includes(v)) throw new Error(`Config ${name} must be one of ${allowed.join(', ')}, got "${v}"`);
  return v;
}

export function loadConfig(overrides = {}) {
  loadEnvFile();
  const cfg = {
    tcp: {
      host: str('TCP_HOST', '0.0.0.0'),
      port: int('TCP_PORT', 6808, { min: 0, max: 65535 }),
      maxFrameLength: int('MAX_FRAME_LENGTH', 4096, { min: 64 }),
    },
    api: {
      host: str('API_HOST', '127.0.0.1'),
      port: int('API_PORT', 3000, { min: 0, max: 65535 }),
      token: str('API_TOKEN', ''),
      corsOrigin: str('API_CORS_ORIGIN', 'http://localhost:5173'),
    },
    db: {
      url: str('DATABASE_URL', ''),
      enabled: bool('DB_ENABLED', true),
    },
    device: {
      // Protocol says GMT+8 (§8.18); BLE evidence H-07 agrees. Offset used for all BCD times to/from the device.
      tzOffsetMinutes: int('DEVICE_TZ_OFFSET_MINUTES', 480, { min: -720, max: 840 }),
      offlineTimeoutS: int('DEVICE_OFFLINE_TIMEOUT_S', 300, { min: 5 }),
    },
    auth: {
      // accept_all: accept any 0x0102 and record the code (POC default, needed for the factory ICCID+version code).
      // known_devices: accept only codes stored for the device (devices.auth_code) or configured in ALLOWED_AUTH_CODES.
      mode: oneOf('AUTH_MODE', 'accept_all', ['accept_all', 'known_devices']),
      allowedCodes: str('ALLOWED_AUTH_CODES', '').split(',').map((s) => s.trim()).filter(Boolean),
      // Response to 0x0100 registration: issue a generated code, or refuse (result 4 "no such terminal").
      registration: oneOf('REGISTRATION_MODE', 'issue_code', ['issue_code', 'reject']),
      requireAuthForCommands: bool('REQUIRE_AUTH_FOR_COMMANDS', true),
    },
    timeSync: {
      // Protocol §8.9 note: send 0x8103 param 0x002A ~500 ms after successful authentication.
      enabled: bool('TIME_SYNC_ON_AUTH', true),
      delayMs: int('TIME_SYNC_DELAY_MS', 500, { min: 0 }),
    },
    business: {
      lenMode: oneOf('BIZ_LEN_MODE', 'after_len', LEN_MODES),
      crcAlgo: oneOf('BIZ_CRC_ALGO', 'crc8_maxim', [...Object.keys(CRC_ALGORITHMS), 'none']),
      crcRange: oneOf('BIZ_CRC_RANGE', 'from_len', CRC_RANGES),
      // While the CRC algorithm is unconfirmed (DOC-07) mismatches are logged loudly but frames are still processed.
      crcEnforce: bool('BIZ_CRC_ENFORCE', false),
      replyToLockUpload: bool('BIZ_REPLY_TO_LOCK_UPLOAD', false),
    },
    commands: {
      timeoutS: int('COMMAND_TIMEOUT_S', 60, { min: 1 }),
      defaultKeyFormat: oneOf('DEFAULT_KEY_FORMAT', 'rf10', KEY_FORMATS),
      defaultGate: int('DEFAULT_GATE', 0, { min: 0, max: 255 }),
      defaultBill: str('DEFAULT_BILL', '0'),
      defaultLineCode: int('DEFAULT_LINE_CODE', 0, { min: 0, max: 65535 }),
    },
    protocol: {
      ackUnknownMessages: bool('ACK_UNKNOWN_MESSAGES', true),
    },
    logging: {
      level: oneOf('LOG_LEVEL', 'info', ['debug', 'info', 'warn', 'error']),
      protocolVerbose: bool('PROTOCOL_VERBOSE', true),
      messageLogDb: bool('MESSAGE_LOG_DB', true),
      logRawChunks: bool('LOG_RAW_TCP_CHUNKS', true),
      captureFile: resolveCapture(str('CAPTURE_FILE', 'captures/traffic.jsonl')),
    },
  };
  return deepMerge(cfg, overrides);
}

function resolveCapture(p) {
  if (!p || p === 'none') return null;
  return path.isAbsolute(p) ? p : path.join(REPO_ROOT, p);
}

function deepMerge(base, over) {
  for (const [k, v] of Object.entries(over || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') deepMerge(base[k], v);
    else base[k] = v;
  }
  return base;
}

export function businessFrameOptions(cfg) {
  return { lenMode: cfg.business.lenMode, crcAlgo: cfg.business.crcAlgo, crcRange: cfg.business.crcRange };
}
