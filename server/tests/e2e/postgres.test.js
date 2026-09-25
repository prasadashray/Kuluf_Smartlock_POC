// End-to-end against a real PostgreSQL (docker compose service "db"). Runs in a throw-away schema and drops it
// afterwards. Skipped when DATABASE_URL is not set or the database is unreachable.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { loadEnvFile } from '../../src/config/index.js';
import { migrate } from '../../src/db/migrate.js';
import { PgStore } from '../../src/db/pg-store.js';
import { startPlatform, startDevice, waitUntil } from '../helpers.js';

loadEnvFile();
const baseUrl = process.env.DATABASE_URL;
const schema = `e2e_${Date.now()}`;

async function reachable() {
  if (!baseUrl) return 'DATABASE_URL not set';
  const c = new pg.Client({ connectionString: baseUrl, connectionTimeoutMillis: 3000 });
  try {
    await c.connect();
    await c.end();
    return null;
  } catch (e) {
    return `database unreachable: ${e.message}`;
  }
}

const skipReason = await reachable();

describe('PostgreSQL end-to-end', { skip: skipReason ?? false }, () => {
  let ctx;
  let dev;
  let admin;
  let deviceId;
  const url = baseUrl ? `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${schema}`)}` : null;

  before(async () => {
    admin = new pg.Client({ connectionString: baseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await migrate(url, { log: () => {} });
    ctx = await startPlatform({}, new PgStore(url));
    dev = await startDevice(ctx.platform, { terminalId: '000082637294', lockId: '82637294' });
    deviceId = (await waitUntil(() => ctx.store.getDeviceByTerminalId('000082637294'))).id;
  });

  after(async () => {
    dev?.close();
    await ctx?.platform.stop();
    await ctx?.store.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  test('migrations applied and device persisted', async () => {
    const d = await ctx.store.getDeviceById(deviceId);
    assert.equal(d.connection_status, 'online');
    assert.equal(d.authenticated, true);
    const r = await admin.query(`SELECT version FROM ${schema}.schema_migrations`);
    assert.equal(r.rows[0].version, '001_initial_schema.sql');
  });

  test('location + lock upload + seal/unseal round-trip persisted', async () => {
    dev.sendLocation();
    dev.sendLockUpload(0x01);
    await waitUntil(async () => (await ctx.store.getDeviceById(deviceId)).lock_id === '82637294', { message: 'lock id' });
    const seal = await ctx.api('POST', `/devices/${deviceId}/seal?wait=true`, { key: '1234567890' });
    assert.equal(seal.body.result_code_hex, '0x80');
    assert.equal(seal.body.succeeded, true);
    const unseal = await ctx.api('POST', `/devices/${deviceId}/unseal?wait=true`, {});
    assert.equal(unseal.body.result_code_hex, '0x90');
    const locs = await ctx.store.listLocations(deviceId);
    assert.ok(locs.length >= 1);
    assert.equal(typeof locs[0].latitude, 'number');
    const cmd = await ctx.store.getCommand(seal.body.id);
    assert.equal(cmd.reply_parsed.reply.result.hex, '0x80');
  });

  test('tamper alarms persisted and cleared by command', async () => {
    dev.raiseTamper();
    await waitUntil(async () => (await ctx.store.activeAlarms(deviceId)).length >= 2, { message: 'alarms' });
    const clr = await ctx.api('POST', `/devices/${deviceId}/clear-alarm?wait=true`, {});
    assert.equal(clr.body.result_code_hex, '0x70');
    dev.sendLocation();
    await waitUntil(async () => (await ctx.store.activeAlarms(deviceId)).length === 0, { message: 'alarms cleared' });
  });

  test('message_log and locations are append-only at the database level', async () => {
    await assert.rejects(admin.query(`UPDATE ${schema}.message_log SET raw_hex = 'X'`), /append-only/);
    await assert.rejects(admin.query(`DELETE FROM ${schema}.locations`), /append-only/);
    const n = await admin.query(`SELECT count(*)::int AS n FROM ${schema}.message_log WHERE device_id = $1`, [deviceId]);
    assert.ok(n.rows[0].n > 10);
  });
});
