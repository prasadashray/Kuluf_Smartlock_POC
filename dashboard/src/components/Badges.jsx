const LOCK_COLORS = {
  sealed: 'green', sealed_local: 'green', unsealed: 'blue', unsealed_local: 'blue', open: 'blue', standby: 'grey',
  not_closed: 'amber', alarm: 'red', alarm_local: 'red', alarm_released: 'amber', abnormal: 'red',
};

export function LockBadge({ state, label }) {
  return <span className={`badge ${LOCK_COLORS[state] ?? 'grey'}`}>{label ?? 'Unknown'}</span>;
}

export function OnlineDot({ online }) {
  return <span className={`dot ${online ? 'on' : 'off'}`} title={online ? 'online' : 'offline'} />;
}

const OUTCOME_COLORS = { success: 'green', no_change: 'amber', failure: 'red', timeout: 'red', unknown: 'amber' };

export function CommandBadge({ c }) {
  if (!c.final) return <span className="badge grey">{c.status}…</span>;
  const color = c.status === 'completed' ? OUTCOME_COLORS[c.outcome] ?? 'grey' : 'red';
  return <span className={`badge ${color}`}>{c.status === 'completed' ? c.result_label : c.status}</span>;
}

export function fmt(t) {
  return t ? new Date(t).toLocaleString() : '—';
}
