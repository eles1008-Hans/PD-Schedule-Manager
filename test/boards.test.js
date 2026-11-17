'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../server/db');
const { SyncService } = require('../server/sync');
const { SheetsClient } = require('../server/gsheets');
const { createApp } = require('../server/index');
const { Boards, BOARD_DEFS, openBoards, migrateLegacy } = require('../server/boards');
const auth = require('../server/auth');
const { parseGrid } = require('../server/importer');
const { sampleGrid, startMockSheets, fakeServiceAccount } = require('./helpers');

function gridWithOwner(owner) {
  const g = sampleGrid();
  g[5][1] = owner; // 첫 담당자 이름을 바꿔 보드를 구분한다
  return g;
}

async function start({ configured = false } = {}) {
  const mock = await startMockSheets(sampleGrid(), { title: 'Roadmap' });
  const appStore = new Store(':memory:');
  appStore.createUser('boss', auth.hashPassword('password-admin'), 'admin');
  appStore.createUser('guest', auth.hashPassword('password-view'), 'viewer');
  const mk = (id, title, owner) => {
    const store = new Store(':memory:');
    store.importParsed(parseGrid(gridWithOwner(owner)), { replace: true });
    const sync = new SyncService(store, {
      clientFactory: () =>
        configured
          ? new SheetsClient({ serviceAccount: fakeServiceAccount(), sheetId: 'S', tab: 'Roadmap', apiBase: mock.base, tokenUrl: `${mock.base}/token` })
          : null,
    });
    return { id, title, tab: `${title} 탭`, store, sync };
  };
  const boards = new Boards([mk('a', '보드A', 'AliceA'), mk('b', '보드B', 'AliceB')]);
  const server = createApp({ store: appStore, boards, secret: 'test-secret', publicDir: path.resolve(__dirname, '..', 'public') });
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
  const login = async (u, p) => (await call('POST', '/api/login', { body: { username: u, password: p } })).setCookie.split(';')[0];
  const cookie = await login('boss', 'password-admin');
  return {
    boards, call, cookie, login,
    close: async () => {
      await new Promise((r) => server.close(r));
      await mock.close();
    },
  };
}

const laneLabels = (board) => board.json.lanes.map((l) => l.label);

test('보드 목록: 탭 이름과 동기화 요약', async () => {
  const t = await start();
  try {
    const r = await t.call('GET', '/api/boards', { cookie: t.cookie });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.boards.map((b) => [b.id, b.title, b.tab]), [['a', '보드A', '보드A 탭'], ['b', '보드B', '보드B 탭']]);
    assert.equal(r.json.boards[0].sync.configured, false);
    assert.equal(r.json.boards[0].sync.conflicts, 0);
    assert.equal((await t.call('GET', '/api/boards')).status, 401);
  } finally {
    await t.close();
  }
});

test('보드마다 내용이 따로이고, 접두가 없으면 첫 보드', async () => {
  const t = await start();
  try {
    const a = await t.call('GET', '/api/boards/a/board', { cookie: t.cookie });
    const b = await t.call('GET', '/api/boards/b/board', { cookie: t.cookie });
    assert.ok(laneLabels(a).includes('AliceA') && !laneLabels(a).includes('AliceB'));
    assert.ok(laneLabels(b).includes('AliceB') && !laneLabels(b).includes('AliceA'));
    assert.ok(laneLabels(await t.call('GET', '/api/board', { cookie: t.cookie })).includes('AliceA'), '접두 없는 예전 주소는 첫 보드');
    assert.equal((await t.call('GET', '/api/boards/zzz/board', { cookie: t.cookie })).status, 404);
  } finally {
    await t.close();
  }
});

test('한 보드에서 카드를 옮겨도 다른 보드는 그대로', async () => {
  const t = await start();
  try {
    const before = (await t.call('GET', '/api/boards/b/board', { cookie: t.cookie })).json;
    const boardA = (await t.call('GET', '/api/boards/a/board', { cookie: t.cookie })).json;
    const alice = boardA.lanes.find((l) => l.label === 'AliceA');
    const bob = boardA.lanes.find((l) => l.label === 'Bob');
    const feat = alice.features[0];
    const mv = await t.call('POST', `/api/boards/a/features/${feat.id}/move`, { cookie: t.cookie, body: { laneId: bob.id, month: '2026-02' } });
    assert.equal(mv.status, 200);
    const afterA = (await t.call('GET', '/api/boards/a/board', { cookie: t.cookie })).json;
    assert.ok(afterA.lanes.find((l) => l.label === 'Bob').features.some((f) => f.id === feat.id));
    const afterB = (await t.call('GET', '/api/boards/b/board', { cookie: t.cookie })).json;
    assert.deepEqual(afterB.lanes, before.lanes, '다른 보드는 변하지 않아야 함');
    assert.equal(afterB.rev, before.rev);
    // 변경 표시도 해당 보드만
    const sum = (await t.call('GET', '/api/boards', { cookie: t.cookie })).json.boards;
    assert.ok(sum.find((b) => b.id === 'a').sync.pendingLanes > 0);
    assert.equal(sum.find((b) => b.id === 'b').sync.pendingLanes, 0);
  } finally {
    await t.close();
  }
});

test('조회 계정은 보드를 볼 수만 있고 바꿀 수 없음', async () => {
  const t = await start();
  try {
    const guest = await t.login('guest', 'password-view');
    assert.equal((await t.call('GET', '/api/boards/b/board', { cookie: guest })).status, 200);
    const feat = (await t.call('GET', '/api/boards/b/board', { cookie: guest })).json.lanes[0].features[0];
    assert.equal((await t.call('DELETE', `/api/boards/b/features/${feat.id}`, { cookie: guest, body: {} })).status, 403);
    assert.equal((await t.call('PUT', '/api/sync/all', { cookie: guest, body: { enabled: true } })).status, 403);
  } finally {
    await t.close();
  }
});

test('전체 동기화 스위치: 연동이 안 되어 있으면 어느 보드도 켜지지 않음', async () => {
  const t = await start({ configured: false });
  try {
    const on = await t.call('PUT', '/api/sync/all', { cookie: t.cookie, body: { enabled: true } });
    assert.equal(on.status, 400);
    const sum = (await t.call('GET', '/api/boards', { cookie: t.cookie })).json.boards;
    assert.ok(sum.every((b) => !b.sync.enabled));
  } finally {
    await t.close();
  }
});

test('전체 동기화 스위치: 모든 보드를 한꺼번에 켜고 끔, 보드별로 따로 동기화 실행', async () => {
  const t = await start({ configured: true });
  try {
    const on = await t.call('PUT', '/api/sync/all', { cookie: t.cookie, body: { enabled: true } });
    assert.equal(on.status, 200);
    assert.ok(on.json.boards.every((b) => b.sync.enabled && b.sync.configured));

    // 켜면 첫 동기화가 자동으로 시작되므로, 끝날 때까지 기다린 뒤 직접 실행한다
    const settled = () => t.boards.list.every((b) => !b.sync.running && b.sync.status().last);
    for (let i = 0; i < 200 && !settled(); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(settled(), '모든 보드의 첫 동기화가 끝나야 함');
    const run = await t.call('POST', '/api/boards/b/sync/run', { cookie: t.cookie, body: {} });
    assert.equal(run.status, 200);
    assert.equal(run.json.result.error, null);
    // 보드 b 만 시트 내용을 가져옴 (sync 상태에 마지막 실행 기록)
    const sum = (await t.call('GET', '/api/boards', { cookie: t.cookie })).json.boards;
    assert.ok(sum.find((b) => b.id === 'b').sync.lastAt);

    const off = await t.call('PUT', '/api/sync/all', { cookie: t.cookie, body: { enabled: false } });
    assert.ok(off.json.boards.every((b) => !b.sync.enabled));
  } finally {
    await t.close();
  }
});

test('실제 보드 정의: 로드맵 탭 7개, 현황판은 아직 포함하지 않음', () => {
  assert.equal(BOARD_DEFS.length, 7);
  assert.deepEqual(BOARD_DEFS.map((d) => d.tab), [
    '캐릭터 컨셉 로드맵', '캐릭터 3D 로드맵', '배경 컨셉 로드맵', '배경 3D 로드맵', '리깅 로드맵', '월드애니 로드맵', 'FX 로드맵',
  ]);
  assert.equal(new Set(BOARD_DEFS.map((d) => d.id)).size, 7, 'id 는 서로 달라야 함');
});

test('openBoards: 보드마다 별도 DB 파일, 보드별 시트 탭을 요청', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdsm-boards-'));
  const requested = [];
  const google = { client: ({ tab }) => (requested.push(tab), null) };
  const boards = openBoards({ dataDir: dir, appStore: null, google, env: {} });
  try {
    assert.equal(boards.list.length, 7);
    for (const d of BOARD_DEFS) assert.ok(fs.existsSync(path.join(dir, 'boards', `${d.id}.db`)), `${d.id}.db`);
    boards.list.forEach((b) => b.sync.configured());
    assert.deepEqual(requested, BOARD_DEFS.map((d) => d.tab), '각 보드가 자기 탭 이름으로 클라이언트를 요청');
    boards.resetClients();
    boards.list[3].sync.configured();
    assert.equal(requested.at(-1), '배경 3D 로드맵');
  } finally {
    boards.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('예전(탭 하나) DB 의 로드맵은 첫 보드로 옮겨 오고, 두 번 옮기지 않음', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdsm-legacy-'));
  const legacy = new Store(path.join(dir, 'roadmap.db'));
  const boardsDir = path.join(dir, 'boards');
  try {
    // 내용이 없으면 옮길 것이 없음
    assert.equal(migrateLegacy(legacy, BOARD_DEFS[0], boardsDir), false);
    legacy.importParsed(parseGrid(sampleGrid()), { replace: true });
    assert.equal(migrateLegacy(legacy, BOARD_DEFS[0], boardsDir), true);
    const moved = new Store(path.join(boardsDir, `${BOARD_DEFS[0].id}.db`));
    assert.deepEqual(moved.board().lanes.map((l) => l.label), ['Alice', 'Bob', 'Carol']);
    moved.close();
    assert.equal(migrateLegacy(legacy, BOARD_DEFS[0], boardsDir), false, '이미 있으면 덮어쓰지 않음');
  } finally {
    legacy.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
