import { useState } from 'react';
import { get } from './api.js';
import { usePoll } from './usePoll.js';
import DeviceDetail from './components/DeviceDetail.jsx';
import { LockBadge, OnlineDot } from './components/Badges.jsx';

export default function App() {
  const [selected, setSelected] = useState(null);
  const { data: devices, error } = usePoll(() => get('/devices'), 3000);
  const { data: health } = usePoll(() => get('/health'), 5000);
  const current = selected ?? devices?.[0]?.id ?? null;

  return (
    <div className="app">
      <header>
        <h1>IndiaLock Connect POC</h1>
        <span className="muted">
          TCP :{health?.tcpPort ?? '?'} · live sessions {health?.liveSessions ?? '?'} · DB {health?.db ?? '?'}
        </span>
      </header>
      <div className="layout">
        <aside>
          <h2>Devices</h2>
          {error && <div className="error">API: {error.message}</div>}
          {!devices?.length && <p className="muted">No device has connected yet.</p>}
          <ul className="device-list">
            {devices?.map((d) => (
              <li key={d.id} className={d.id === current ? 'active' : ''} onClick={() => setSelected(d.id)}>
                <div>
                  <OnlineDot online={d.online} /> <strong>{d.display_name || d.lock_id || d.terminal_id}</strong>
                </div>
                <div className="muted small">terminal {d.terminal_id} · lock {d.lock_id ?? '—'}</div>
                <LockBadge state={d.lock_state} label={d.lock_status_label} />
              </li>
            ))}
          </ul>
        </aside>
        <main>{current ? <DeviceDetail key={current} id={current} /> : <p className="muted">Select a device.</p>}</main>
      </div>
    </div>
  );
}
