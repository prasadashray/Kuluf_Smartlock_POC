// Location, lock status, battery and alarm processing. Locations and alarms are append-only history; an alarm row is
// raised when a condition appears and marked cleared (never deleted) when it disappears or is cleared by command.
import { describeVoltage } from '../protocol/index.js';

const LOCK_ALARM_STATES = new Set(['alarm', 'alarm_local']);

export class TelemetryService {
  constructor({ store, logger, events }) {
    this.store = store;
    this.log = logger.child({ scope: 'telemetry' });
    this.events = events;
  }

  /** 0x0200 / 0x0201 body, or the 28-byte GPS block appended to a 0x0900 business frame. */
  async onLocation(device, loc, { messageLogId = null, source }) {
    if (!loc?.ok) return null;
    const extras = loc.extras ? { ...loc.extras } : {};
    if (loc.additional?.length) extras.items = loc.additional.map((i) => ({ id: i.idHex, len: i.length, hex: i.hex, decoded: i.decoded }));
    if (loc.additionalErrors?.length) extras.errors = loc.additionalErrors;
    const row = await this.store.insertLocation({
      device_id: device.id,
      message_log_id: messageLogId,
      source,
      positioned: Boolean(loc.positioned),
      latitude: loc.latitude,
      longitude: loc.longitude,
      altitude_m: loc.altitudeM,
      speed_kmh: loc.speedKmh,
      direction_deg: loc.directionDeg,
      alarm_flags: loc.alarmFlags,
      alarm_flags_hex: loc.alarmFlagsHex,
      status_flags: loc.statusFlags,
      status_flags_hex: loc.statusFlagsHex,
      lock_status_code: loc.status?.lockStatus?.code ?? null,
      device_time: loc.time?.iso ?? null,
      device_time_raw: loc.time?.raw ?? null,
      extras,
    });

    const patch = { last_location_at: new Date() };
    const ex = loc.extras ?? {};
    if (ex.batteryPercent !== undefined) Object.assign(patch, { battery_percent: ex.batteryPercent, battery_at: new Date() });
    if (ex.batteryMv !== undefined) patch.battery_mv = ex.batteryMv;
    if (ex.imei) patch.imei = ex.imei;
    if (ex.iccid) patch.iccid = ex.iccid;
    if (ex.firmwareVersion) patch.firmware_version = ex.firmwareVersion;
    let updated = await this.store.updateDevice(device.id, patch);

    const deviceTime = loc.time?.iso ?? null;
    // Table 24 alarm flags
    await this.reconcile(updated, 'location_alarm_flags',
      loc.alarms.map((a) => ({ type: a.key, label: a.label, raw: `bit${a.bit}`, rawFlagsHex: loc.alarmFlagsHex })), { messageLogId, deviceTime });
    // 0xE7 24-way alarm status (only when the item is present in this report)
    if (ex.e7Alarms) {
      await this.reconcile(updated, 'e7_alarm_status',
        ex.e7Alarms.map((a) => ({ type: a.key, label: a.label, raw: `bit${a.bit}`, rawFlagsHex: `0x${ex.e7Raw.toString(16).toUpperCase().padStart(6, '0')}` })), { messageLogId, deviceTime });
    }
    if (loc.status?.lockStatus) {
      updated = await this.onLockStatus(updated, { lockStatus: loc.status.lockStatus, messageLogId, deviceTime });
    }
    this.events.emit('location', { deviceId: device.id, location: row });
    return row;
  }

  /** Lock status / voltage / motor status from 0x0200 bits 24-31, 0x0900 uploads or 0x55 replies. */
  async onLockStatus(device, { lockStatus = null, voltage = null, motorStatus = null, messageLogId = null, deviceTime = null }) {
    const patch = {};
    if (lockStatus) {
      Object.assign(patch, { lock_status_code: lockStatus.code, lock_state: lockStatus.state, lock_status_label: lockStatus.label, lock_status_at: new Date() });
    }
    if (voltage) {
      Object.assign(patch, { battery_voltage_code: voltage.hex, battery_voltage_v: voltage.volts, battery_at: new Date() });
    }
    if (motorStatus) patch.motor_status_code = motorStatus.code;
    const updated = Object.keys(patch).length ? await this.store.updateDevice(device.id, patch) : device;

    if (lockStatus) {
      const current = [];
      if (LOCK_ALARM_STATES.has(lockStatus.state)) {
        const bits = lockStatus.alarmBits.length ? lockStatus.alarmBits : ['lock_alarm_state'];
        for (const b of bits) current.push({ type: b, label: `Lock status ${lockStatus.label}: ${b.replace(/_/g, ' ')}`, raw: lockStatus.hex });
      }
      if (lockStatus.state === 'abnormal') current.push({ type: 'lock_abnormal', label: 'Lock abnormal state', raw: lockStatus.hex });
      await this.reconcile(updated, 'lock_status', current, { messageLogId, deviceTime });
    }
    if (voltage) {
      const v = describeVoltage(voltage.code);
      const current = v.level === 'critical' || v.level === 'low'
        ? [{ type: 'low_battery', label: `Battery ${v.label} (${v.volts} V)`, raw: v.hex }] : [];
      await this.reconcile(updated, 'voltage', current, { messageLogId, deviceTime });
    }
    this.events.emit('deviceUpdated', { deviceId: device.id });
    return updated;
  }

  /** §10.3 lock active upload: status fields plus, for SubCmd 0x02-0x05, an alarm event. */
  async onLockUpload(device, payload, { messageLogId = null }) {
    const deviceTime = payload.time?.iso ?? null;
    const updated = await this.onLockStatus(device, { lockStatus: payload.lockStatus, voltage: payload.voltage, motorStatus: payload.motorStatus, messageLogId, deviceTime });
    if (payload.isAlarm) {
      const active = (await this.store.activeAlarms(device.id)).some((a) => a.source === 'lock_upload' && a.alarm_type === payload.subCmdKey);
      if (!active) {
        await this.raise(updated, { source: 'lock_upload', type: payload.subCmdKey, label: payload.subCmdLabel, raw: payload.subCmdHex }, { messageLogId, deviceTime });
      }
    }
    return updated;
  }

  /** After a successful Clear Alarm command, event-type alarms have no natural "cleared" report - clear them here. */
  async clearByCommand(device, commandId) {
    for (const a of await this.store.activeAlarms(device.id)) {
      if (a.source === 'lock_upload' || a.source === 'lock_status') {
        await this.store.clearAlarm(a.id, { clearedAt: new Date(), clearedBy: `clear_alarm_command:${commandId}` });
      }
    }
    this.events.emit('alarm', { deviceId: device.id, cleared: true });
  }

  async raise(device, a, { messageLogId, deviceTime }) {
    const row = await this.store.insertAlarm({
      device_id: device.id,
      message_log_id: messageLogId,
      source: a.source,
      alarm_type: a.type,
      label: a.label,
      raw_value: a.raw,
      raw_flags_hex: a.rawFlagsHex ?? null,
      raised_at: new Date(),
      device_time: deviceTime,
      processing_status: 'active',
    });
    this.log.warn(`ALARM raised device=${device.terminal_id} source=${a.source} type=${a.type} raw=${a.raw}`);
    this.events.emit('alarm', { deviceId: device.id, alarm: row });
    return row;
  }

  async reconcile(device, source, current, ctx) {
    const active = (await this.store.activeAlarms(device.id)).filter((a) => a.source === source);
    const activeTypes = new Set(active.map((a) => a.alarm_type));
    const currentTypes = new Set(current.map((c) => c.type));
    for (const c of current) if (!activeTypes.has(c.type)) await this.raise(device, { source, ...c }, ctx);
    for (const a of active) {
      if (!currentTypes.has(a.alarm_type)) {
        await this.store.clearAlarm(a.id, { clearedAt: new Date(), clearedBy: 'device_report' });
        this.log.info(`alarm cleared by device report device=${device.terminal_id} source=${source} type=${a.alarm_type}`);
      }
    }
  }
}
