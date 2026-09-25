// §8.18 Location information report (0x0200): 28-byte basic info (Table 23) + additional items (Tables 26/27).
import { decodeBcdTime, encodeBcdTime, toHex, hex32, decodeString, isPrintableAscii } from './bytes.js';
import { describeLockStatus } from './tt-elock.js';

export const LOCATION_BASIC_LENGTH = 28;

// Table 24 - alarm flag bits. `clearOnAck` = "cleared after receiving response".
export const ALARM_FLAG_BITS = {
  0: { key: 'emergency', label: 'Emergency alarm (alarm switch touched)', clearOnAck: true },
  1: { key: 'overspeed', label: 'Overspeed alarm' },
  2: { key: 'fatigue_driving', label: 'Fatigue driving' },
  3: { key: 'danger_warning', label: 'Danger warning', clearOnAck: true },
  4: { key: 'gnss_module_failure', label: 'GNSS module failure' },
  5: { key: 'gnss_antenna_disconnected', label: 'GNSS antenna not connected or cut' },
  6: { key: 'gnss_antenna_short', label: 'GNSS antenna short circuit' },
  7: { key: 'main_power_undervoltage', label: 'Terminal main power undervoltage' },
  8: { key: 'main_power_off', label: 'Terminal main power off' },
  9: { key: 'display_failure', label: 'Terminal LCD/display failure' },
  10: { key: 'tts_failure', label: 'TTS module failure' },
  11: { key: 'camera_failure', label: 'Camera failure' },
  12: { key: 'ic_card_module_failure', label: 'Road transport certificate IC card module failure' },
  13: { key: 'overspeed_warning', label: 'Overspeed warning' },
  14: { key: 'fatigue_warning', label: 'Fatigue driving warning' },
  18: { key: 'daily_driving_overtime', label: 'Cumulative driving overtime of the day' },
  19: { key: 'overtime_parking', label: 'Overtime parking' },
  20: { key: 'area_in_out', label: 'Enter/exit area', clearOnAck: true },
  21: { key: 'route_in_out', label: 'Enter/exit route', clearOnAck: true },
  22: { key: 'road_segment_time', label: 'Road segment driving time insufficient/too long', clearOnAck: true },
  23: { key: 'route_deviation', label: 'Route deviation alarm' },
  24: { key: 'vss_failure', label: 'Vehicle VSS failure' },
  25: { key: 'fuel_abnormal', label: 'Vehicle fuel level abnormal' },
  26: { key: 'vehicle_stolen', label: 'Vehicle stolen' },
  27: { key: 'illegal_ignition', label: 'Vehicle illegal ignition', clearOnAck: true },
  28: { key: 'illegal_displacement', label: 'Vehicle illegal displacement', clearOnAck: true },
  29: { key: 'collision_warning', label: 'Collision warning' },
  30: { key: 'rollover_warning', label: 'Roll-over warning' },
  31: { key: 'illegal_door_open', label: 'Illegal door opening alarm', clearOnAck: true },
};

// 0xE7 - 24-way alarm status (TT extension). Bits 9-23 reserved ("parsed as alarm 9-24").
export const E7_ALARM_BITS = {
  0: { key: 'cable_cut', label: 'Cable cut alarm' },
  1: { key: 'emergency_unlock', label: 'Emergency unlock alarm' },
  2: { key: 'removal', label: 'Removal alarm' },
  3: { key: 'cover_open', label: 'Cover opening alarm' },
  4: { key: 'vibration', label: 'Vibration alarm' },
  5: { key: 'tilt', label: 'Tilt alarm' },
  6: { key: 'rollover', label: 'Roll-over alarm' },
  7: { key: 'high_temperature', label: 'High temperature alarm' },
  8: { key: 'low_temperature', label: 'Low temperature alarm' },
};

// 0xE8 - 24-way switch status (TT extension). Bits 20-23 = network type.
export const E8_SWITCH_BITS = {
  0: 'knob_opened',
  1: 'motor_released',
  2: 'lock_rod_opened',
  3: 'lock_rod_cut',
  4: 'cable_disconnected',
  5: 'cover_opened',
  6: 'shell_opened',
  7: 'removed',
  8: 'vibration',
  9: 'sleep_mode',
  10: 'deep_sleep_mode',
  11: 'satellite_positioning_off',
  12: 'device_power_off',
  13: 'firmware_upgrading',
};

const NETWORK_TYPES = {
  0: 'GSM (2G)', 2: 'UTRAN (2G)', 3: 'GSM W/EGPRS (2G)', 4: 'UTRAN W/HSDPA (3G)', 5: 'UTRAN W/HSUPA (3G)',
  6: 'UTRAN W/HSDPA+HSUPA (3G)', 7: 'E-UTRAN (4G)', 8: 'UTRAN HSPA+ (4G)', 9: '5G',
};

export function decodeAlarmFlags(flags) {
  const active = [];
  for (let bit = 0; bit < 32; bit++) {
    if ((flags >>> bit) & 1) {
      const def = ALARM_FLAG_BITS[bit];
      active.push({ bit, key: def ? def.key : `reserved_bit_${bit}`, label: def ? def.label : `Reserved alarm bit ${bit}`, clearOnAck: Boolean(def?.clearOnAck) });
    }
  }
  return active;
}

// Table 25 - status bits.
export function decodeStatusFlags(status) {
  const bit = (n) => Boolean((status >>> n) & 1);
  const lockStatusByte = (status >>> 24) & 0xff;
  return {
    accOn: bit(0),
    positioned: bit(1),
    southLatitude: bit(2),
    westLongitude: bit(3),
    outOfService: bit(4),
    coordinatesEncrypted: bit(5),
    loadStatus: (status >>> 8) & 0x03,
    fuelCircuitDisconnected: bit(10),
    circuitDisconnected: bit(11),
    doorLocked: bit(12),
    doors: { door1Open: bit(13), door2Open: bit(14), door3Open: bit(15), door4Open: bit(16), door5Open: bit(17) },
    gnss: { gps: bit(18), beidou: bit(19), glonass: bit(20), galileo: bit(21) },
    // Bits 24-31: 0x00 = invalid/not parsed; 0x10-0xFF = LockStatus (Appendix 3).
    lockStatus: lockStatusByte >= 0x10 ? describeLockStatus(lockStatusByte) : null,
    lockStatusRaw: lockStatusByte,
  };
}

export function decodeLocationBasic(buf, { tzOffsetMinutes = 480 } = {}) {
  if (buf.length < LOCATION_BASIC_LENGTH) {
    return { ok: false, error: `Location basic info needs ${LOCATION_BASIC_LENGTH} bytes, got ${buf.length}` };
  }
  const alarmFlags = buf.readUInt32BE(0);
  const statusFlags = buf.readUInt32BE(4);
  const latRaw = buf.readUInt32BE(8);
  const lonRaw = buf.readUInt32BE(12);
  const altitude = buf.readUInt16BE(16);
  const speedRaw = buf.readUInt16BE(18);
  const direction = buf.readUInt16BE(20);
  // Table 23 lists Time at offset 21, which contradicts Direction being a WORD at 20; Time is at 22 (DOC-08).
  const time = decodeBcdTime(buf.subarray(22, 28), tzOffsetMinutes);
  const status = decodeStatusFlags(statusFlags);
  return {
    ok: true,
    alarmFlags,
    alarmFlagsHex: hex32(alarmFlags),
    alarms: decodeAlarmFlags(alarmFlags),
    statusFlags,
    statusFlagsHex: hex32(statusFlags),
    status,
    positioned: status.positioned,
    latitudeRaw: latRaw,
    longitudeRaw: lonRaw,
    latitude: (status.southLatitude ? -1 : 1) * (latRaw / 1e6),
    longitude: (status.westLongitude ? -1 : 1) * (lonRaw / 1e6),
    altitudeM: altitude,
    speedRaw,
    speedKmh: speedRaw / 10,
    directionDeg: direction,
    time,
  };
}

function bits24(buf) {
  return (buf[0] << 16) | (buf[1] << 8) | buf[2];
}

function decodeLbs7(b) {
  return { mcc: b.readUInt16BE(0), mnc: b[2], lac: b.readUInt16BE(3), cellId: b.readUInt16BE(5) };
}

function decodeLbs10(b) {
  return { mcc: b.readUInt16BE(0), mnc: b[2], lac: b.readUInt16BE(3), cellId: b.readUInt32BE(5), signal: b[9] };
}

/** Decode one additional-information item value. Unknown IDs are preserved as hex only. */
export function decodeAdditionalItem(id, value) {
  const len = value.length;
  switch (id) {
    case 0x01: return len === 4 ? { name: 'mileage', mileageKm: value.readUInt32BE(0) / 10 } : null;
    case 0x02: return len === 2 ? { name: 'fuel', fuelL: value.readUInt16BE(0) / 10 } : null;
    case 0x03: return len === 2 ? { name: 'recorder_speed', speedKmh: value.readUInt16BE(0) / 10 } : null;
    case 0x04: return len === 2 ? { name: 'alarm_event_id', eventId: value.readUInt16BE(0) } : null;
    case 0x11: return { name: 'overspeed_alarm_info', locationType: value[0], areaId: len >= 5 ? value.readUInt32BE(1) : null };
    case 0x12: return len === 6 ? { name: 'area_route_alarm_info', locationType: value[0], areaId: value.readUInt32BE(1), direction: value[5] === 0 ? 'enter' : 'exit' } : null;
    case 0x13: return len === 7 ? { name: 'road_segment_time_info', segmentId: value.readUInt32BE(0), seconds: value.readUInt16BE(4), result: value[6] === 0 ? 'insufficient' : 'too_long' } : null;
    case 0x25: return len === 4 ? { name: 'extended_vehicle_signal', raw: value.readUInt32BE(0) } : null;
    case 0x2a: return len === 2 ? { name: 'io_status', deepSleep: Boolean(value[1] & 1), sleep: Boolean(value[1] & 2), raw: value.readUInt16BE(0) } : null;
    case 0x2b: return len === 4 ? { name: 'analog', ad0: value.readUInt16BE(2), ad1: value.readUInt16BE(0) } : null;
    case 0x30: return len === 1 ? { name: 'signal_strength', value: value[0] } : null;
    case 0x31: return len === 1 ? { name: 'satellites', value: value[0] } : null;
    case 0xe1: return len === 7 ? { name: 'lbs_7b', ...decodeLbs7(value) } : null;
    case 0xe2: return { name: 'imei', value: decodeString(value).replace(/\0+$/, '') };
    case 0xe3: return { name: 'version', value: decodeString(value).replace(/\0+$/, '') };
    case 0xe6: return { name: 'iccid', value: decodeString(value).replace(/\0+$/, '') };
    case 0x5d: {
      if (len < 1) return null;
      const n = value[0];
      if (len !== 1 + n * 10) return { name: 'lbs_10b', count: n, error: `expected ${1 + n * 10} bytes, got ${len}` };
      const stations = [];
      for (let i = 0; i < n; i++) stations.push(decodeLbs10(value.subarray(1 + i * 10, 11 + i * 10)));
      return { name: 'lbs_10b', count: n, stations };
    }
    case 0xe7: {
      if (len !== 3) return null;
      const raw = bits24(value);
      const active = [];
      for (let bit = 0; bit < 24; bit++) {
        if ((raw >> bit) & 1) {
          const def = E7_ALARM_BITS[bit];
          active.push({ bit, key: def ? def.key : `alarm_${bit}`, label: def ? def.label : `Alarm ${bit}` });
        }
      }
      return { name: 'alarm_status_24', raw, active };
    }
    case 0xe8: {
      if (len !== 3) return null;
      const raw = bits24(value);
      const switches = {};
      for (const [bit, key] of Object.entries(E8_SWITCH_BITS)) switches[key] = Boolean((raw >> Number(bit)) & 1);
      const reservedOn = [];
      for (let bit = 14; bit <= 19; bit++) if ((raw >> bit) & 1) reservedOn.push(bit);
      const networkType = (raw >> 20) & 0x0f;
      return { name: 'switch_status_24', raw, switches, reservedOn, networkType, networkTypeLabel: NETWORK_TYPES[networkType] || 'unknown' };
    }
    case 0xe9: return len === 1 ? { name: 'battery_percent', value: value[0] } : null;
    case 0x56: return len === 2 ? { name: 'battery', percent: value[0] * 10, levelRaw: value[0], voltageMv: value[1] * 50 } : null;
    case 0x51: {
      if (len % 2) return null;
      const t = [];
      for (let i = 0; i < len; i += 2) { const v = value.readUInt16BE(i); t.push(v === 0xffff ? null : value.readInt16BE(i) / 10); }
      return { name: 'temperatures_c', values: t };
    }
    case 0x58: {
      if (len % 2) return null;
      const h = [];
      for (let i = 0; i < len; i += 2) { const v = value.readUInt16BE(i); h.push(v === 0xffff || v === 0x0fff ? null : v / 10); }
      return { name: 'humidity_pct', values: h };
    }
    case 0xea: return len === 6 ? { name: 'gsensor', x: value.readInt16BE(0) / 256, y: value.readInt16BE(2) / 256, z: value.readInt16BE(4) / 256, unit: 'g' } : null;
    default: return null;
  }
}

export function decodeAdditionalItems(buf) {
  const items = [];
  const errors = [];
  let i = 0;
  while (i < buf.length) {
    if (i + 2 > buf.length) {
      errors.push(`Truncated additional item header at offset ${i}: ${toHex(buf.subarray(i))}`);
      break;
    }
    const id = buf[i];
    const len = buf[i + 1];
    if (i + 2 + len > buf.length) {
      errors.push(`Additional item 0x${id.toString(16)} declares ${len} bytes but only ${buf.length - i - 2} remain`);
      items.push({ id, idHex: `0x${id.toString(16).toUpperCase().padStart(2, '0')}`, length: len, hex: toHex(buf.subarray(i + 2)), truncated: true });
      break;
    }
    const value = buf.subarray(i + 2, i + 2 + len);
    let decoded = null;
    try {
      decoded = decodeAdditionalItem(id, value);
    } catch (e) {
      errors.push(`Additional item 0x${id.toString(16)} decode error: ${e.message}`);
    }
    items.push({
      id,
      idHex: `0x${id.toString(16).toUpperCase().padStart(2, '0')}`,
      length: len,
      hex: toHex(value),
      ascii: isPrintableAscii(value) && len > 0 ? value.toString('ascii') : undefined,
      decoded,
    });
    i += 2 + len;
  }
  return { items, errors };
}

/** Summarise useful additional items into flat fields. */
export function summariseExtras(items) {
  const s = {};
  for (const it of items) {
    const d = it.decoded;
    if (!d) continue;
    switch (d.name) {
      case 'battery_percent': s.batteryPercent = d.value; break;
      case 'battery': s.batteryPercent ??= d.percent; s.batteryMv = d.voltageMv; break;
      case 'signal_strength': s.signalStrength = d.value; break;
      case 'satellites': s.satellites = d.value; break;
      case 'imei': s.imei = d.value; break;
      case 'iccid': s.iccid = d.value; break;
      case 'version': s.firmwareVersion = d.value; break;
      case 'mileage': s.mileageKm = d.mileageKm; break;
      case 'alarm_status_24': s.e7Alarms = d.active; s.e7Raw = d.raw; break;
      case 'switch_status_24': s.switches = d.switches; s.networkType = d.networkTypeLabel; s.e8Raw = d.raw; break;
      case 'lbs_7b': s.lbs = { variant: '7B', stations: [d] }; break;
      case 'lbs_10b': s.lbs = { variant: '10B', stations: d.stations || [] }; break;
      default: break;
    }
  }
  return s;
}

export function decodeLocationReport(body, opts = {}) {
  const basic = decodeLocationBasic(body, opts);
  if (!basic.ok) return basic;
  const { items, errors } = decodeAdditionalItems(body.subarray(LOCATION_BASIC_LENGTH));
  return { ...basic, additional: items, additionalErrors: errors, extras: summariseExtras(items) };
}

// ---------- encoders (used by the simulator and tests) ----------

export function encodeLocationBasic({
  alarmFlags = 0,
  statusFlags = null,
  latitude = 0,
  longitude = 0,
  altitudeM = 0,
  speedKmh = 0,
  directionDeg = 0,
  time = new Date(),
  positioned = true,
  lockStatus = 0,
  tzOffsetMinutes = 480,
} = {}) {
  let status = statusFlags;
  if (status === null) {
    status = 0;
    if (positioned) status |= 1 << 1;
    if (latitude < 0) status |= 1 << 2;
    if (longitude < 0) status |= 1 << 3;
    if (positioned) status |= 1 << 18; // GPS used
    status = (status | ((lockStatus & 0xff) << 24)) >>> 0;
  }
  const out = Buffer.alloc(LOCATION_BASIC_LENGTH);
  out.writeUInt32BE(alarmFlags >>> 0, 0);
  out.writeUInt32BE(status >>> 0, 4);
  out.writeUInt32BE(Math.round(Math.abs(latitude) * 1e6), 8);
  out.writeUInt32BE(Math.round(Math.abs(longitude) * 1e6), 12);
  out.writeUInt16BE(altitudeM, 16);
  out.writeUInt16BE(Math.round(speedKmh * 10), 18);
  out.writeUInt16BE(directionDeg, 20);
  encodeBcdTime(time, tzOffsetMinutes).copy(out, 22);
  return out;
}

export function encodeAdditionalItem(id, value) {
  const v = Buffer.from(value);
  return Buffer.concat([Buffer.from([id, v.length]), v]);
}

export function encodeLocationReport(fields = {}, additional = []) {
  return Buffer.concat([encodeLocationBasic(fields), ...additional.map(({ id, value }) => encodeAdditionalItem(id, value))]);
}
