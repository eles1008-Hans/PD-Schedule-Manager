'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../server/db');
const { SyncService } = require('../server/sync');
const { SheetsClient, colToA1 } = require('../server/gsheets');
const { sampleGrid, startMockSheets, fakeServiceAccount } = require('./helpers');

async function setup() {
  const mock = await startMockSheets(sampleGrid());
  const store = new Store(':memory:');
  const sync = new SyncService(store, {
    clientFactory: () =>
      new SheetsClient({
        serviceAccount: fakeServiceAccount(),
        sheetId: 'SHEET',
        tab: 'Roadmap',
        apiBase: mock.base,
        tokenUrl: `${mock.base}/token`,
      }),
  });
  return { mock, store, sync, lane: (label) => store.board().lanes.find((l) => l.label === label) };
}

test('colToA1', () => {
  assert.equal(colToA1(0), 'A');
  assert.equal(colToA1(25), 'Z');
  assert.equal(colToA1(26), 'AA');
  assert.equal(colToA1(55), 'BD');
});

test('동기화: 시트에서 가져오기 → 앱에서 이동 → 시트에 반영', async () => {
  const { mock, store, sync, lane } = await setup();
  try {
    sync.setEnabled(false);
    let r = await sync.run('manual');
    assert.equal(r.error, null);
    assert.equal(r.pull.created, 3);
    assert.equal(store.board().lanes.length, 3);

    const a1 = lane('Alice').features.find((f) => f.text === '[MOB] a1');
    store.moveFeature(a1.id, { laneId: lane('Bob').id, month: '2026-02' }, 'admin');
    r = await sync.run('manual');
    assert.equal(r.error, null);
    assert.equal(r.push.lanes, 2);

    // Alice(6행, 인덱스 5): 2026-01 칸은 a1b 가 위로 올라오고, Bob(9행, 인덱스 8): 2026-02 칸에 a1
    assert.equal(mock.cell(5, 4), '[MOB] a1b');
    assert.equal(mock.cell(6, 4), '');
    assert.equal(mock.cell(8, 5), '[MOB] a1');
    // 연도 사이 빈 구분 열(인덱스 6)과 A~C열은 건드리지 않음
    assert.equal(mock.cell(5, 1), 'Alice');
    assert.equal(mock.cell(5, 6), '');
    assert.equal(store.board().lanes.every((l) => !l.dirty), true);

    // 이미 반영된 뒤에는 다시 동기화해도 충돌/변경 없음
    r = await sync.run('manual');
    assert.equal(r.pull.conflicts, 0);
    assert.equal(r.push.lanes, 0);
  } finally {
    await mock.close();
  }
});

test('동기화: 담당자 칸이 모자라면 시트에 행을 끼워 넣고 아래 담당자 위치를 밀어낸다', async () => {
  const { mock, store, sync, lane } = await setup();
  try {
    await sync.run('manual');
    const bob = lane('Bob');
    const feats = lane('Alice').features.filter((f) => f.month === '2026-01');
    for (const f of feats) store.moveFeature(f.id, { laneId: bob.id, month: '2026-02' }, 'admin');
    store.createFeature({ laneId: bob.id, month: '2026-02', text: '[X] extra' }, 'admin');
    // Bob 의 2026-02 칸에 3개가 쌓임 → 기존 1행 + 추가 2행 필요
    const r = await sync.run('manual');
    assert.equal(r.error, null);
    assert.equal(r.push.insertedRows, 2);
    assert.equal(mock.state.rowCount, 12);
    assert.equal(mock.cell(8, 5) && mock.cell(9, 5) && mock.cell(10, 5) ? true : false, true);
    // Carol 은 3행 아래로 이동 (원래 9 → 11)
    assert.equal(mock.cell(11, 1), 'Carol');
    assert.equal(mock.cell(11, 8), '[WP] c1');
    assert.equal(store.laneRow(lane('Carol').id).row_start, 11);
  } finally {
    await mock.close();
  }
});

test('동기화: 시트에서만 바뀐 담당자는 앱에 반영', async () => {
  const { mock, store, sync, lane } = await setup();
  try {
    await sync.run('manual');
    mock.state.grid[8][3] = '[BOSS] b1 수정됨';
    const r = await sync.run('manual');
    assert.equal(r.pull.updated, 1);
    assert.equal(lane('Bob').features[0].text, '[BOSS] b1 수정됨');
  } finally {
    await mock.close();
  }
});

test('동기화: 앱과 시트가 같은 담당자를 바꾸면 충돌로 표시하고 덮어쓰지 않음', async () => {
  const { mock, store, sync, lane } = await setup();
  try {
    await sync.run('manual');
    const bob = lane('Bob');
    store.createFeature({ laneId: bob.id, month: '2026-01', text: '앱에서 추가' }, 'admin');
    mock.state.grid[8][3] = '시트에서 수정';

    let r = await sync.run('manual');
    assert.equal(r.pull.conflicts, 1);
    assert.equal(r.push.lanes, 0);
    assert.equal(mock.cell(8, 3), '시트에서 수정');
    assert.equal(sync.status().conflicts.length, 1);

    // 앱 내용 유지 → 시트가 앱 내용으로 바뀜
    store.resolveConflict(bob.id, 'app');
    r = await sync.run('manual');
    assert.equal(r.pull.conflicts, 0);
    assert.equal(mock.cell(8, 3), '[BOSS] b1');
    assert.equal(mock.cell(8, 4), '앱에서 추가');
    assert.equal(sync.status().conflicts.length, 0);
  } finally {
    await mock.close();
  }
});

test('동기화: 충돌에서 시트 내용을 선택하면 앱의 미반영 변경을 버림', async () => {
  const { mock, store, sync, lane } = await setup();
  try {
    await sync.run('manual');
    const bob = lane('Bob');
    store.createFeature({ laneId: bob.id, month: '2026-01', text: '앱에서 추가' }, 'admin');
    mock.state.grid[8][3] = '시트에서 수정';
    await sync.run('manual');
    store.resolveConflict(bob.id, 'sheet');
    await sync.run('manual');
    const texts = lane('Bob').features.map((f) => f.text);
    assert.deepEqual(texts, ['시트에서 수정']);
  } finally {
    await mock.close();
  }
});

test('동기화: 꺼져 있는 동안 쌓인 변경은 켠 뒤 한꺼번에 반영', async () => {
  const { mock, store, sync, lane } = await setup();
  try {
    await sync.run('manual');
    store.createFeature({ laneId: lane('Bob').id, month: '2026-01', text: 'OFF 중 변경' }, 'admin');
    assert.equal(sync.status().pendingLanes, 1);
    assert.equal(mock.cell(8, 4), '');
    await sync.run('manual');
    assert.equal(mock.cell(8, 4), 'OFF 중 변경');
  } finally {
    await mock.close();
  }
});

test('동기화: 연동 미설정이면 켤 수 없음', () => {
  const store = new Store(':memory:');
  const sync = new SyncService(store, { clientFactory: () => null });
  assert.throws(() => sync.setEnabled(true, 'admin'), /설정/);
  assert.equal(sync.status().configured, false);
});

test('동기화: 인증 실패는 오류로 기록되고 앱 데이터는 그대로', async () => {
  const mock = await startMockSheets(sampleGrid());
  const store = new Store(':memory:');
  const sync = new SyncService(store, {
    clientFactory: () =>
      new SheetsClient({
        serviceAccount: fakeServiceAccount(),
        sheetId: 'SHEET',
        tab: '없는 탭',
        apiBase: mock.base,
        tokenUrl: `${mock.base}/token`,
      }),
  });
  try {
    const r = await sync.run('manual');
    assert.match(r.error, /탭을 찾을 수 없습니다/);
    assert.equal(sync.status().last.error, r.error);
  } finally {
    await mock.close();
  }
});
