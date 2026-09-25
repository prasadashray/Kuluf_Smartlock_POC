import { Fragment, useState } from 'react';
import { get } from '../api.js';
import { usePoll } from '../usePoll.js';

export default function MessageLog({ deviceId }) {
  const { data } = usePoll(() => get(`/devices/${deviceId}/messages?limit=150`), 3000, [deviceId]);
  const [open, setOpen] = useState(null);
  return (
    <table className="compact messages">
      <thead><tr><th>Time</th><th>Dir</th><th>Message</th><th>Serial</th><th>Result</th><th>Raw (wire)</th></tr></thead>
      <tbody>
        {data?.map((m) => (
          <Fragment key={m.id}>
            <tr className={`${m.direction} ${m.error ? 'err' : ''}`} onClick={() => setOpen(open === m.id ? null : m.id)}>
              <td>{new Date(m.created_at).toLocaleTimeString()}</td>
              <td>{m.direction.toUpperCase()}</td>
              <td>{m.msg_id_hex ?? '—'} {m.msg_name}</td>
              <td>{m.serial ?? '—'}</td>
              <td>{m.processing_result}{m.checksum_ok === false ? ' (bad checksum)' : ''}</td>
              <td className="hex">{m.raw_hex}</td>
            </tr>
            {open === m.id && (
              <tr><td colSpan={6}>
                {m.error && <div className="error">{m.error}</div>}
                <pre className="json">{JSON.stringify(m.parsed, null, 2)}</pre>
              </td></tr>
            )}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}
