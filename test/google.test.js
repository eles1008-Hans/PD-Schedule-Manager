'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Store } = require('../server/db');
const { SyncService } = require('../server/sync');
const { createApp } = require('../server/index');
const { GoogleLink, parseSheetId, seal, unseal } = require('../server/googlelink');
const auth = require('../server/auth');
const { sampleGrid, startMockSheets } = require('./helpers');

const SHEET_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abc';
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit?gid=323340929#gid=323340929`;

async function start({ oauth = true } = {}) {
  const mock = await startMockSheets(sampleGrid(), { title: 'Roadmap' });
  const store = new Store(':memory:');
  store.createUser('boss', auth.hashPassword('password-admin'), 'admin');
  store.createUser('guest', auth.hashPassword('password-view'), 'viewer');
  let sync;
  const env = oauth
    ? {
        GOOGLE_OAUTH_CLIENT_ID: 'cid',
        GOOGLE_OAUTH_CLIENT_SECRET: 'csec',
        PUBLIC_URL: 'http://localhost:3000',
        GOOGLE_OAUTH_AUTH_URL: `${mock.base}/auth`,
        GOOGLE_OAUTH_TOKEN_URL: `${mock.base}/token`,
        GOOGLE_OAUTH_REVOKE_URL: `${mock.base}/revoke`,
        GOOGLE_SHEETS_API_BASE: mock.base,
      }
    : {};
  const google = new GoogleLink({ store, secret: 'test-secret', env, onChange: () => sync && sync.resetClient() });
  sync = new SyncService(store, { clientFactory: () => google.client() });
  const server = createApp({ store, sync, google, secret: 'test-secret', publicDir: path.resolve(__dirname, '..', 'public') });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, { body, cookie } = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    return {
      status: res.status,
      location: res.headers.get('location'),
      json: await res.json().catch(() => null),
      setCookie: res.headers.get('set-cookie'),
    };
  };
  const login = async (u, p) => (await call('POST', '/api/login', { body: { username: u, password: p } })).setCookie.split(';')[0];
  const cookie = await login('boss', 'password-admin');
  // 연동 신청 → 구글 동의 화면 주소에서 state 를 꺼낸다
  const apply = async () => {
    const r = await call('POST', '/api/google/link', { cookie, body: {} });
    return { r, state: r.json && r.json.url ? new URL(r.json.url).searchParams.get('state') : null };
  };
  const callback = (query) => call('GET', `/api/google/callback?${query}`, { cookie });
  return {
    mock, store, sync, google, call, cookie, apply, callback, login,
    close: async () => {
      await new Promise((r) => server.close(r));
      await mock.close();
    },
  };
}

test('시트 주소/ID에서 스프레드시트 ID를 꺼냄', () => {
  assert.equal(parseSheetId(SHEET_URL), SHEET_ID);
  assert.equal(parseSheetId(SHEET_ID), SHEET_ID);
  assert.equal(parseSheetId('  ' + SHEET_ID + ' '), SHEET_ID);
  assert.equal(parseSheetId('https://example.com/abc'), null);
  assert.equal(parseSheetId('짧음'), null);
  assert.equal(parseSheetId(''), null);
});

test('갱신 토큰은 암호화해서 저장하고, 다른 키로는 풀 수 없음', () => {
  const sealed = seal('secret-a', 'refresh-token-value');
  assert.ok(!sealed.includes('refresh-token-value'));
  assert.equal(unseal('secret-a', sealed), 'refresh-token-value');
  assert.throws(() => unseal('secret-b', sealed));
});

test('OAuth 클라이언트가 설정되지 않으면 연동 신청이 안내와 함께 거부됨', async () => {
  const t = await start({ oauth: false });
  try {
    const st = await t.call('GET', '/api/google', { cookie: t.cookie });
    assert.equal(st.json.oauthConfigured, false);
    assert.equal(st.json.redirectUri, 'http://localhost:3000/api/google/callback');
    assert.equal(st.json.linked, false);
    const { r } = await t.apply();
    assert.equal(r.status, 400);
    assert.match(r.json.error, /OAuth/);
  } finally {
    await t.close();
  }
});

test('연동 신청: 동의 화면 주소 생성 → 승인 후 계정 연동, 토큰은 암호화 저장', async () => {
  const t = await start();
  try {
    const { r, state } = await t.apply();
    assert.equal(r.status, 200);
    const u = new URL(r.json.url);
    assert.equal(u.origin + u.pathname, `${t.mock.base}/auth`);
    assert.equal(u.searchParams.get('client_id'), 'cid');
    assert.equal(u.searchParams.get('redirect_uri'), 'http://localhost:3000/api/google/callback');
    assert.equal(u.searchParams.get('access_type'), 'offline');
    assert.ok(u.searchParams.get('scope').includes('https://www.googleapis.com/auth/spreadsheets'));
    assert.ok(state && state.length >= 32);

    const cb = await t.callback(`code=good-code&state=${state}`);
    assert.equal(cb.status, 302);
    assert.equal(cb.location, '/?google=linked');

    const st = (await t.call('GET', '/api/google', { cookie: t.cookie })).json;
    assert.equal(st.linked, true);
    assert.equal(st.email, 'me@gmail.com');
    assert.equal(st.needsRelink, false);
    assert.ok(!t.store.getMeta('google_link').includes('rtok'), '갱신 토큰이 평문으로 저장되면 안 됨');
    assert.ok(t.store.recentLog(5).some((l) => l.action === 'google_link'));
  } finally {
    await t.close();
  }
});

test('연동 요청 검증: 틀린 state, 재사용, 로그인 없는 요청, 동의 거부, 권한 누락', async () => {
  const t = await start();
  try {
    // 모르는 state
    let cb = await t.callback('code=good-code&state=forged');
    assert.match(cb.location, /^\/\?google=error&msg=/);
    assert.equal((await t.call('GET', '/api/google', { cookie: t.cookie })).json.linked, false);

    // 한 번 쓴 state 는 재사용 불가
    let { state } = await t.apply();
    assert.equal((await t.callback(`code=good-code&state=${state}`)).location, '/?google=linked');
    assert.match((await t.callback(`code=good-code&state=${state}`)).location, /google=error/);

    // 로그인 없이 콜백
    ({ state } = await t.apply());
    const anon = await t.call('GET', `/api/google/callback?code=good-code&state=${state}`);
    assert.match(anon.location, /google=error/);

    // 구글에서 동의 거부
    assert.equal((await t.callback('error=access_denied')).location, '/?google=denied');

    // 시트 권한을 빼고 승인한 경우
    await t.call('POST', '/api/google/unlink', { cookie: t.cookie, body: {} });
    t.mock.state.scope = 'openid email';
    ({ state } = await t.apply());
    cb = await t.callback(`code=good-code&state=${state}`);
    assert.match(decodeURIComponent(cb.location), /스프레드시트 접근 권한/);
    assert.equal((await t.call('GET', '/api/google', { cookie: t.cookie })).json.linked, false);

    // 갱신 토큰을 못 받은 경우
    t.mock.state.scope = null;
    t.mock.state.noRefresh = true;
    ({ state } = await t.apply());
    cb = await t.callback(`code=good-code&state=${state}`);
    assert.match(decodeURIComponent(cb.location), /갱신 토큰/);
  } finally {
    await t.close();
  }
});

test('관리자만 연동할 수 있음 (조회 계정 거부)', async () => {
  const t = await start();
  try {
    const guest = await t.login('guest', 'password-view');
    assert.equal((await t.call('GET', '/api/google', { cookie: guest })).status, 403);
    assert.equal((await t.call('POST', '/api/google/link', { cookie: guest, body: {} })).status, 403);
    assert.equal((await t.call('PUT', '/api/google/sheet', { cookie: guest, body: { sheet: SHEET_URL } })).status, 403);
    assert.equal((await t.call('GET', '/api/google')).status, 401);
  } finally {
    await t.close();
  }
});

test('시트 주소 저장 검증', async () => {
  const t = await start();
  try {
    const bad = await t.call('PUT', '/api/google/sheet', { cookie: t.cookie, body: { sheet: 'https://example.com/nope' } });
    assert.equal(bad.status, 400);
    const ok = await t.call('PUT', '/api/google/sheet', { cookie: t.cookie, body: { sheet: SHEET_URL, tab: 'Roadmap' } });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json.sheet, { id: SHEET_ID, tab: 'Roadmap' });
    const dflt = await t.call('PUT', '/api/google/sheet', { cookie: t.cookie, body: { sheet: SHEET_ID } });
    assert.equal(dflt.json.sheet.tab, '캐릭터 컨셉 로드맵');
  } finally {
    await t.close();
  }
});

test('연동한 계정으로 시트를 읽어 와 동기화됨 (연동·시트 지정 전에는 켤 수 없음)', async () => {
  const t = await start();
  try {
    assert.equal((await t.call('PUT', '/api/sync', { cookie: t.cookie, body: { enabled: true } })).status, 400);

    const { state } = await t.apply();
    await t.callback(`code=good-code&state=${state}`);
    // 연동만 하고 시트를 안 정했으면 여전히 미설정
    assert.equal((await t.call('GET', '/api/sync', { cookie: t.cookie })).json.configured, false);

    await t.call('PUT', '/api/google/sheet', { cookie: t.cookie, body: { sheet: SHEET_URL, tab: 'Roadmap' } });
    assert.equal((await t.call('GET', '/api/sync', { cookie: t.cookie })).json.configured, true);

    t.store.setMeta('sync_enabled', '1');
    const run = await t.call('POST', '/api/sync/run', { cookie: t.cookie, body: {} });
    assert.equal(run.status, 200);
    assert.equal(run.json.result.error, null);
    assert.ok(run.json.result.pull.created > 0, '시트 내용을 가져와야 함');
    const board = await t.call('GET', '/api/board', { cookie: t.cookie });
    assert.ok(board.json.lanes.some((l) => l.label === 'Alice'));
  } finally {
    await t.close();
  }
});

test('구글에서 권한이 취소되면 오류와 함께 다시 연동 필요로 표시됨', async () => {
  const t = await start();
  try {
    const { state } = await t.apply();
    await t.callback(`code=good-code&state=${state}`);
    await t.call('PUT', '/api/google/sheet', { cookie: t.cookie, body: { sheet: SHEET_URL, tab: 'Roadmap' } });
    t.store.setMeta('sync_enabled', '1');

    t.mock.state.revoked = true;
    t.google._token = null; // 접근 토큰이 만료된 상황
    const run = await t.call('POST', '/api/sync/run', { cookie: t.cookie, body: {} });
    assert.match(run.json.result.error, /다시 연동/);
    assert.equal((await t.call('GET', '/api/google', { cookie: t.cookie })).json.needsRelink, true);

    // 다시 연동하면 정상으로 돌아옴
    t.mock.state.revoked = false;
    const again = await t.apply();
    await t.callback(`code=good-code&state=${again.state}`);
    const st = (await t.call('GET', '/api/google', { cookie: t.cookie })).json;
    assert.equal(st.needsRelink, false);
    const run2 = await t.call('POST', '/api/sync/run', { cookie: t.cookie, body: {} });
    assert.equal(run2.json.result.error, null);
  } finally {
    await t.close();
  }
});

test('연동 해제: 토큰 삭제, 동기화 꺼짐, 구글에 취소 요청', async () => {
  const t = await start();
  try {
    const { state } = await t.apply();
    await t.callback(`code=good-code&state=${state}`);
    await t.call('PUT', '/api/google/sheet', { cookie: t.cookie, body: { sheet: SHEET_URL, tab: 'Roadmap' } });
    t.store.setMeta('sync_enabled', '1');

    const r = await t.call('POST', '/api/google/unlink', { cookie: t.cookie, body: {} });
    assert.equal(r.status, 200);
    assert.equal(r.json.linked, false);
    assert.equal(r.json.email, null);
    assert.equal((await t.call('GET', '/api/sync', { cookie: t.cookie })).json.enabled, false);
    assert.equal((await t.call('GET', '/api/sync', { cookie: t.cookie })).json.configured, false);
    assert.ok(t.mock.state.calls.includes('POST /revoke'));
  } finally {
    await t.close();
  }
});
