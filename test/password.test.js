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

const ID = 'me@example.com';

async function start() {
  const store = new Store(':memory:');
  store.importParsed(parseGrid(sampleGrid()), { replace: true });
  // 첫 비밀번호 = 아이디, 변경 필요 상태
  store.createUser(ID, auth.hashPassword(ID), 'admin', true);
  const sync = new SyncService(store, { clientFactory: () => null });
  const server = createApp({ store, sync, secret: 'test-secret', publicDir: path.resolve(__dirname, '..', 'public') });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, { body, cookie } = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => null), setCookie: res.headers.get('set-cookie') };
  };
  const login = async (password) => {
    const r = await call('POST', '/api/login', { body: { username: ID, password } });
    return { r, cookie: r.setCookie ? r.setCookie.split(';')[0] : null };
  };
  return { store, call, login, close: () => new Promise((r) => server.close(r)) };
}

test('첫 비밀번호는 아이디이고, 로그인 응답이 변경 필요를 알려 줌', async () => {
  const t = await start();
  try {
    const { r, cookie } = await t.login(ID);
    assert.equal(r.status, 200);
    assert.equal(r.json.user.mustChange, true);
    assert.ok(cookie);
    assert.equal((await t.login('wrong-password')).r.status, 401);
  } finally {
    await t.close();
  }
});

test('비밀번호를 바꾸기 전에는 서버가 다른 API를 막음', async () => {
  const t = await start();
  try {
    const { cookie } = await t.login(ID);
    const board = await t.call('GET', '/api/board', { cookie });
    assert.equal(board.status, 403);
    assert.equal(board.json.code, 'password_change_required');
    assert.equal((await t.call('GET', '/api/sync', { cookie })).status, 403);
    assert.equal((await t.call('POST', '/api/features', { cookie, body: { laneId: 1, month: '2026-01', text: 'x' } })).status, 403);
    // 상태 확인은 가능
    const me = await t.call('GET', '/api/me', { cookie });
    assert.equal(me.status, 200);
    assert.equal(me.json.user.mustChange, true);
  } finally {
    await t.close();
  }
});

test('새 비밀번호 규칙: 현재 비밀번호 확인, 8자 이상, 아이디/현재와 달라야 함', async () => {
  const t = await start();
  try {
    const { cookie } = await t.login(ID);
    const change = (current, next) => t.call('POST', '/api/password', { cookie, body: { current, next } });
    assert.equal((await change('틀린-현재', 'new-password-1')).status, 400);
    assert.equal((await change(ID, 'short')).status, 400);
    assert.equal((await change(ID, ID)).status, 400); // 아이디와 같음
    assert.equal((await t.call('GET', '/api/board', { cookie })).status, 403); // 실패 후에도 여전히 막힘
  } finally {
    await t.close();
  }
});

test('비밀번호를 바꾸면 기능이 열리고, 이전 비밀번호는 쓸 수 없음', async () => {
  const t = await start();
  try {
    const { cookie } = await t.login(ID);
    const ok = await t.call('POST', '/api/password', { cookie, body: { current: ID, next: 'new-password-1' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.user.mustChange, false);

    assert.equal((await t.call('GET', '/api/board', { cookie })).status, 200);
    assert.equal((await t.login(ID)).r.status, 401); // 예전(아이디) 비밀번호는 더 이상 안 됨
    const again = await t.login('new-password-1');
    assert.equal(again.r.status, 200);
    assert.equal(again.r.json.user.mustChange, false);

    // 이후 자발적 변경: 현재 비밀번호와 같으면 거부
    const same = await t.call('POST', '/api/password', { cookie: again.cookie, body: { current: 'new-password-1', next: 'new-password-1' } });
    assert.equal(same.status, 400);
    const later = await t.call('POST', '/api/password', { cookie: again.cookie, body: { current: 'new-password-1', next: 'another-pass-2' } });
    assert.equal(later.status, 200);
    assert.ok(t.store.recentLog(10).some((l) => l.action === 'password_change'));
  } finally {
    await t.close();
  }
});

test('현재 비밀번호를 계속 틀리면 변경 시도가 제한됨', async () => {
  const t = await start();
  try {
    const { cookie } = await t.login(ID);
    let last;
    for (let i = 0; i < 11; i++) {
      last = await t.call('POST', '/api/password', { cookie, body: { current: `bad-${i}`, next: 'new-password-1' } });
    }
    assert.equal(last.status, 429);
  } finally {
    await t.close();
  }
});

test('기존 DB(must_change 컬럼 없음)도 열려서 이어서 쓸 수 있음', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const { DatabaseSync } = require('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdsm-mig-'));
  const file = path.join(dir, 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, pass_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','viewer')), created_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO users(username, pass_hash, role) VALUES('legacy', 'x', 'admin');`);
  old.close();
  const store = new Store(file);
  try {
    assert.equal(store.getUser('legacy').must_change, 0);
    store.setPassword('legacy', auth.hashPassword('abcdefgh'));
    assert.equal(store.getUser('legacy').must_change, 0);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
