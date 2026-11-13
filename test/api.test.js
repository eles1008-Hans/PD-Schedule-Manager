'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Store } = require('../server/db');
const { SyncService } = require('../server/sync');
const { createApp } = require('../server/index');
const auth = require('../server/auth');
const { parseGrid } = require('../server/importer');
const { sampleGrid } = require('./helpers');

async function start() {
  const store = new Store(':memory:');
  store.importParsed(parseGrid(sampleGrid()), { replace: true });
  store.createUser('boss', auth.hashPassword('password-admin'), 'admin');
  store.createUser('guest', auth.hashPassword('password-view'), 'viewer');
  const sync = new SyncService(store, { clientFactory: () => null });
  const server = createApp({ store, sync, secret: 'test-secret', publicDir: path.resolve(__dirname, '..', 'public') });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, { body, cookie, headers } = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => null), setCookie: res.headers.get('set-cookie') };
  };
  const login = async (username, password) => {
    const r = await call('POST', '/api/login', { body: { username, password } });
    return r.setCookie ? r.setCookie.split(';')[0] : null;
  };
  return { store, sync, base, call, login, close: () => new Promise((r) => server.close(r)) };
}

test('로그인 없이는 API 접근 불가', async () => {
  const t = await start();
  try {
    assert.equal((await t.call('GET', '/api/board')).status, 401);
    assert.equal((await t.call('POST', '/api/login', { body: { username: 'boss', password: 'x' } })).status, 401);
  } finally {
    await t.close();
  }
});

test('로그인 쿠키는 HttpOnly + SameSite 이고 세션이 위조되면 거부', async () => {
  const t = await start();
  try {
    const r = await t.call('POST', '/api/login', { body: { username: 'boss', password: 'password-admin' } });
    assert.equal(r.status, 200);
    assert.match(r.setCookie, /HttpOnly/);
    assert.match(r.setCookie, /SameSite=Lax/);
    assert.equal((await t.call('GET', '/api/me', { cookie: 'pdsm=forged.value' })).status, 401);
  } finally {
    await t.close();
  }
});

test('조회자는 볼 수만 있고 관리자만 변경 가능', async () => {
  const t = await start();
  try {
    const viewer = await t.login('guest', 'password-view');
    const admin = await t.login('boss', 'password-admin');

    const board = await t.call('GET', '/api/board', { cookie: viewer });
    assert.equal(board.status, 200);
    const bob = board.json.lanes.find((l) => l.label === 'Bob');
    const feature = board.json.lanes.find((l) => l.label === 'Alice').features[0];
    const move = { laneId: bob.id, month: '2026-02', index: 0 };

    assert.equal((await t.call('POST', `/api/features/${feature.id}/move`, { cookie: viewer, body: move })).status, 403);
    assert.equal((await t.call('PUT', '/api/sync', { cookie: viewer, body: { enabled: true } })).status, 403);

    assert.equal((await t.call('POST', `/api/features/${feature.id}/move`, { cookie: admin, body: move })).status, 200);
    const after = await t.call('GET', '/api/board', { cookie: viewer });
    assert.equal(after.json.lanes.find((l) => l.label === 'Bob').features.some((f) => f.id === feature.id), true);
    assert.ok(after.json.rev > board.json.rev);
  } finally {
    await t.close();
  }
});

test('연동 설정이 없으면 동기화를 켤 수 없음', async () => {
  const t = await start();
  try {
    const admin = await t.login('boss', 'password-admin');
    const r = await t.call('PUT', '/api/sync', { cookie: admin, body: { enabled: true } });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /설정/);
    const s = await t.call('GET', '/api/sync', { cookie: admin });
    assert.equal(s.json.enabled, false);
    assert.equal(s.json.configured, false);
  } finally {
    await t.close();
  }
});

test('다른 출처의 변경 요청과 JSON 이 아닌 요청은 거부', async () => {
  const t = await start();
  try {
    const admin = await t.login('boss', 'password-admin');
    const f = (await t.call('GET', '/api/board', { cookie: admin })).json.lanes[0].features[0];
    const foreign = await t.call('DELETE', `/api/features/${f.id}`, { cookie: admin, headers: { Origin: 'https://evil.example' } });
    assert.equal(foreign.status, 403);
    const plain = await fetch(`${t.base}/api/features/${f.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'text/plain', Cookie: admin },
      body: '{"text":"x"}',
    });
    assert.equal(plain.status, 415);
  } finally {
    await t.close();
  }
});

test('잘못된 입력은 400 으로 응답', async () => {
  const t = await start();
  try {
    const admin = await t.login('boss', 'password-admin');
    const board = (await t.call('GET', '/api/board', { cookie: admin })).json;
    const lane = board.lanes[0];
    const bad = await t.call('POST', '/api/features', { cookie: admin, body: { laneId: lane.id, month: '2026-01', text: '  ' } });
    assert.equal(bad.status, 400);
    const badMonth = await t.call('POST', '/api/features', { cookie: admin, body: { laneId: lane.id, month: 'nope', text: 'x' } });
    assert.equal(badMonth.status, 400);
  } finally {
    await t.close();
  }
});
