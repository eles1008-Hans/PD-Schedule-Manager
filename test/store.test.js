'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseGrid } = require('../server/importer');
const { parseCSV } = require('../server/csv');
const { Store } = require('../server/db');
const { sampleGrid } = require('./helpers');

const laneByLabel = (board, label) => board.lanes.find((l) => l.label === label);
const texts = (lane, month) => lane.features.filter((f) => f.month === month).map((f) => f.text);

test('CSV: 따옴표 안의 줄바꿈과 "" 이스케이프를 처리한다', () => {
  const rows = parseCSV('a,"b\nc","d ""q"""\n,,\n');
  assert.deepEqual(rows[0], ['a', 'b\nc', 'd "q"']);
  assert.deepEqual(rows[1], ['', '', '']);
});

test('파서: 연도/월 헤더에서 타임라인을 만들고 빈 구분 열은 건너뛴다', () => {
  const p = parseGrid(sampleGrid());
  assert.deepEqual(
    p.months.map((m) => [m.key, m.col]),
    [['2025-12', 3], ['2026-01', 4], ['2026-02', 5], ['2027-01', 7], ['2027-02', 8]],
  );
});

test('파서: 담당자 블록, 그룹 승계, 같은 월 칸의 쌓인 피쳐', () => {
  const p = parseGrid(sampleGrid());
  assert.deepEqual(p.lanes.map((l) => [l.group, l.label]), [['팀A', 'Alice'], ['팀A', 'Bob'], ['팀B', 'Carol']]);
  const alice = p.lanes[0];
  assert.deepEqual(
    alice.features.map((f) => [f.month, f.slot, f.text]),
    [['2026-01', 0, '[MOB] a1'], ['2026-02', 0, '[MOB] a2'], ['2027-01', 0, '[PC] a3'], ['2026-01', 1, '[MOB] a1b']],
  );
  assert.deepEqual(p.header.find((h) => h.kind === 'milestone'), { kind: 'milestone', month: '2026-01', text: '프로토 빌드' });
});

test('파서: 월 헤더가 없으면 오류', () => {
  assert.throws(() => parseGrid([['a'], ['b'], ['c']]), /헤더/);
});

test('이동: 다른 담당자·월로 옮기면 양쪽 칸이 정리되고 두 담당자 모두 변경됨 표시', () => {
  const store = new Store(':memory:');
  store.importParsed(parseGrid(sampleGrid()), { replace: true });
  let b = store.board();
  const alice = laneByLabel(b, 'Alice');
  const bob = laneByLabel(b, 'Bob');
  assert.equal(b.lanes.every((l) => !l.dirty), true);

  const moving = alice.features.find((f) => f.text === '[MOB] a1');
  store.moveFeature(moving.id, { laneId: bob.id, month: '2026-02', index: 0 }, 'tester');

  b = store.board();
  assert.deepEqual(texts(laneByLabel(b, 'Alice'), '2026-01'), ['[MOB] a1b']);
  assert.equal(laneByLabel(b, 'Alice').features.find((f) => f.text === '[MOB] a1b').slot, 0);
  assert.deepEqual(texts(laneByLabel(b, 'Bob'), '2026-02'), ['[MOB] a1']);
  assert.equal(laneByLabel(b, 'Alice').dirty, true);
  assert.equal(laneByLabel(b, 'Bob').dirty, true);
  assert.equal(laneByLabel(b, 'Carol').dirty, false);
});

test('이동: 같은 칸 안에서 순서만 바꾸고, 제자리 이동은 변경 없음', () => {
  const store = new Store(':memory:');
  store.importParsed(parseGrid(sampleGrid()), { replace: true });
  const alice = laneByLabel(store.board(), 'Alice');
  const [first, second] = alice.features.filter((f) => f.month === '2026-01');
  assert.equal(store.moveFeature(first.id, { laneId: alice.id, month: '2026-01', index: 0 }, 't').changed, false);
  assert.equal(store.moveFeature(second.id, { laneId: alice.id, month: '2026-01', index: 0 }, 't').changed, true);
  assert.deepEqual(texts(laneByLabel(store.board(), 'Alice'), '2026-01'), ['[MOB] a1b', '[MOB] a1']);
});

test('이동: 없는 월/담당자는 거부', () => {
  const store = new Store(':memory:');
  store.importParsed(parseGrid(sampleGrid()), { replace: true });
  const alice = laneByLabel(store.board(), 'Alice');
  const f = alice.features[0];
  assert.throws(() => store.moveFeature(f.id, { laneId: alice.id, month: '2099-01' }, 't'), /월/);
  assert.throws(() => store.moveFeature(f.id, { laneId: 9999, month: '2026-01' }, 't'), /담당자/);
});

test('추가 · 이름 변경 · 삭제', () => {
  const store = new Store(':memory:');
  store.importParsed(parseGrid(sampleGrid()), { replace: true });
  const bob = laneByLabel(store.board(), 'Bob');
  const { id } = store.createFeature({ laneId: bob.id, month: '2026-02', text: ' 새 피쳐 ' }, 't');
  assert.equal(store.getFeature(id).text, '새 피쳐');
  store.updateFeatureText(id, '이름 변경', 't');
  assert.equal(store.getFeature(id).text, '이름 변경');
  assert.throws(() => store.createFeature({ laneId: bob.id, month: '2026-02', text: '   ' }, 't'), /입력/);
  store.deleteFeature(id, 't');
  assert.equal(store.getFeature(id), undefined);
});
