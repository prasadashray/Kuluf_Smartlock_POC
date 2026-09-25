import { useState } from 'react';
import { get, post, patch } from '../api.js';
import { usePoll } from '../usePoll.js';
import { LockBadge, OnlineDot, CommandBadge, fmt } from './Badges.jsx';
import MapView from './MapView.jsx';
import MessageLog from './MessageLog.jsx';

export default function DeviceDetail({ id }) {
  const { data: d, refresh } = usePoll(() => get(`/devices/${id}`), 2500, [id]);
  const { data: commands, refresh: refreshCmds } = usePoll(() => get(`/devices/${id}/commands?limit=20`), 2000, [id]);
  const { data: locations } = usePoll(() => get(`/devices/${id}/locations?limit=200`), 5000, [id]);
  const { data: events } = usePoll(() => get(`/devices/${id}/events?limit=60`), 3000, [id]);
  const [tab, setTab] = useState('events');
  if (!d) return <p className="muted">Loading…</p>;

  return (
    <div className="detail">
      <section className="card status">
        <h2>
          <OnlineDot online={d.online} /> {d.display_name || `Lock ${d.lock_id ?? '—'}`} <LockBadge state={d.lock_state} label={d.lock_status_label} />
        </h2>
        <div className="grid">
          <Field k="Connection" v={d.online ? `online (${d.session_remote})` : `offline${d.last_disconnect_reason ? ` — ${d.last_disconnect_reason}` : ''}`} />
          <Field k="Authenticated" v={d.session_authenticated ? 'yes' : 'no'} />
          <Field k="Terminal ID" v={d.terminal_id} />
          <Field k="LockID" v={d.lock_id ?? 'unknown'} />
          <Field k="Lock status" v={d.lock_status_code != null ? `${d.lock_status_label} (0x${d.lock_status_code.toString(16).toUpperCase()})` : '—'} />
          <Field k="Battery" v={[d.battery_voltage_v != null && `${d.battery_voltage_v} V (${d.battery_voltage_code})`, d.battery_percent != null && `${d.battery_percent}%`, d.battery_mv != null && `${d.battery_mv} mV`].filter(Boolean).join(' · ') || '—'} />
          <Field k="Last seen" v={fmt(d.last_seen_at)} />
          <Field k="Last heartbeat" v={fmt(d.last_heartbeat_at)} />
          <Field k="Auth code" v={d.auth_code ? `${d.auth_code} (${d.auth_code_source})` : '—'} />
          <Field k="ICCID / IMEI" v={`${d.iccid ?? '—'} / ${d.imei ?? '—'}`} />
          <Field k="Firmware" v={d.firmware_version ?? '—'} />
          <Field k="Seal key" v={d.has_key ? `${d.current_key_masked} (${d.key_format})` : `not set (${d.key_format})`} />
        </div>
      </section>

      <section className="card">
        <h3>Commands</h3>
        <CommandPanel device={d} onDone={() => { refresh(); refreshCmds(); }} />
        <table className="compact">
          <thead><tr><th>Requested</th><th>Command</th><th>Status / result</th><th>Code</th><th>Serials (808 / biz)</th><th>Correlation</th></tr></thead>
          <tbody>
            {commands?.map((c) => (
              <tr key={c.id} title={c.error ?? ''}>
                <td>{fmt(c.requested_at)}</td>
                <td>{c.command_type}</td>
                <td><CommandBadge c={c} />{c.error && <div className="error small">{c.error}</div>}</td>
                <td>{c.result_code_hex ?? (c.ack_result_label ? `ack: ${c.ack_result_label}` : '—')}</td>
                <td>{c.jt808_serial ?? '—'} / {c.business_serial ?? '—'}</td>
                <td>{c.correlation_method ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h3>Active alarms</h3>
        {!d.active_alarms?.length && <p className="muted">None</p>}
        <ul className="alarms">
          {d.active_alarms?.map((a) => (
            <li key={a.id}><span className="badge red">{a.alarm_type}</span> {a.label} <span className="muted small">({a.source} {a.raw_value}) since {fmt(a.raised_at)}</span></li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h3>Location</h3>
        {d.latest_location
          ? <p className="small">{d.latest_location.latitude}, {d.latest_location.longitude} · {d.latest_location.speed_kmh} km/h · {d.latest_location.direction_deg}° · device time {fmt(d.latest_location.device_time)} · received {fmt(d.latest_location.received_at)}</p>
          : <p className="muted">No GPS fix received yet{d.latest_report ? ` (last report ${fmt(d.latest_report.received_at)} had no fix)` : ''}.</p>}
        <MapView locations={locations ?? []} />
      </section>

      <section className="card">
        <div className="tabs">
          <button className={tab === 'events' ? 'on' : ''} onClick={() => setTab('events')}>Event feed</button>
          <button className={tab === 'messages' ? 'on' : ''} onClick={() => setTab('messages')}>Raw protocol log</button>
        </div>
        {tab === 'events' && (
          <ul className="events">
            {events?.map((e, i) => (
              <li key={i} className={e.kind}><span className="muted small">{fmt(e.time)}</span> <b>{e.kind}</b> {e.summary}</li>
            ))}
          </ul>
        )}
        {tab === 'messages' && <MessageLog deviceId={id} />}
      </section>

      <DeviceConfig device={d} onSaved={refresh} />
    </div>
  );
}

function Field({ k, v }) {
  return <div className="field"><span className="k">{k}</span><span className="v">{v}</span></div>;
}

function CommandPanel({ device, onDone }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);
  const run = async (path, label) => {
    setBusy(label);
    setMsg(null);
    try {
      const body = key ? { key } : {};
      const c = await post(`/devices/${device.id}/${path}?wait=true`, body);
      setMsg({ ok: c.succeeded, text: `${label}: ${c.status}${c.result_label ? ` — ${c.result_label} (${c.result_code_hex})` : ''}${c.error ? ` — ${c.error}` : ''}` });
    } catch (e) {
      setMsg({ ok: false, text: `${label}: ${e.data?.error ?? ''} ${e.message}` });
    } finally {
      setBusy(null);
      onDone();
    }
  };
  const disabled = Boolean(busy) || !device.online;
  return (
    <div className="command-panel">
      <input placeholder={device.has_key ? `key (blank = stored ${device.current_key_masked})` : `key (${device.key_format})`} value={key} onChange={(e) => setKey(e.target.value)} />
      <button disabled={disabled} onClick={() => run('seal', 'Seal')}>{busy === 'Seal' ? 'Sealing…' : 'Seal'}</button>
      <button disabled={disabled} onClick={() => run('unseal', 'Unseal')}>{busy === 'Unseal' ? 'Unsealing…' : 'Unseal'}</button>
      <button disabled={disabled} onClick={() => run('clear-alarm', 'Clear alarm')}>{busy === 'Clear alarm' ? 'Clearing…' : 'Clear alarm'}</button>
      {!device.online && <span className="muted small">device offline</span>}
      {msg && <div className={msg.ok ? 'ok' : 'error'}>{msg.text}</div>}
      <p className="muted small">A command is only shown as successful after the lock's operation reply arrives. Waiting up to the command timeout.</p>
    </div>
  );
}

function DeviceConfig({ device, onSaved }) {
  const [form, setForm] = useState({ lock_id: device.lock_id ?? '', key_format: device.key_format ?? 'rf10', current_key: '', display_name: device.display_name ?? '' });
  const [msg, setMsg] = useState(null);
  const save = async () => {
    try {
      const body = { lock_id: form.lock_id || undefined, key_format: form.key_format, display_name: form.display_name };
      if (form.current_key) body.current_key = form.current_key;
      await patch(`/devices/${device.id}`, body);
      setMsg('saved');
      onSaved();
    } catch (e) {
      setMsg(e.message);
    }
  };
  return (
    <section className="card">
      <h3>Device configuration (platform side)</h3>
      <div className="form">
        <label>LockID <input value={form.lock_id} onChange={(e) => setForm({ ...form, lock_id: e.target.value })} placeholder="8 digits" /></label>
        <label>Key format
          <select value={form.key_format} onChange={(e) => setForm({ ...form, key_format: e.target.value })}>
            <option value="rf10">rf10 (10 digits)</option><option value="ascii6">ascii6 (6 digits)</option><option value="hex">hex (12 hex)</option>
          </select>
        </label>
        <label>Stored key <input value={form.current_key} onChange={(e) => setForm({ ...form, current_key: e.target.value })} placeholder="leave blank to keep" /></label>
        <label>Name <input value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} /></label>
        <button onClick={save}>Save</button> {msg && <span className="muted">{msg}</span>}
      </div>
      <Diagnostics device={device} />
    </section>
  );
}

function Diagnostics({ device }) {
  const [out, setOut] = useState(null);
  const run = async (path) => {
    setOut('…');
    try {
      setOut(JSON.stringify(await post(`/devices/${device.id}/diagnostics/${path}`), null, 2));
    } catch (e) {
      setOut(`${e.data?.error ?? ''} ${e.message}`);
    }
  };
  return (
    <div className="diag">
      <span className="muted small">Read-only diagnostics:</span>
      <button disabled={!device.online} onClick={() => run('query-params')}>Query parameters (0x8104)</button>
      <button disabled={!device.online} onClick={() => run('query-location')}>Query location (0x8201)</button>
      {out && <pre className="json">{out}</pre>}
    </div>
  );
}
