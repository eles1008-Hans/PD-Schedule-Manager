'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseGrid, detectLayout } = require('../server/importer');

// 실제 시트의 탭들처럼 헤더 위치가 다른 격자를 만든다.
//  - 연도 행 위치(0 또는 1), 연도 사이 빈 구분 열 유무, 본문 앞 안내 줄 개수가 탭마다 다르다.
function grid({ bandRow = false, separators = true, infoRows = ['마일 스톤', '이슈 정리'] } = {}) {
  const rows = [];
  const years = [2026, 2027];
  const yearRow = ['', '', ''];
  const monthRow = ['', '', ''];
  years.forEach((y, yi) => {
    for (let m = 1; m <= 12; m++) {
      yearRow.push(m === 1 ? String(y) : '');
      monthRow.push(String(m));
    }
    if (separators && yi === 0) {
      yearRow.push('');
      monthRow.push('');
    }
  });
  const colOf = (y, m) => 3 + (y - 2026) * (12 + (separators ? 1 : 0)) + (m - 1);
  const put = (row, y, m, v) => {
    row[colOf(y, m)] = v;
    return row;
  };
  if (bandRow) rows.push(put(['메모'], 2026, 2, 'VS 스펙'));
  rows.push(yearRow, monthRow);
  infoRows.forEach((label, i) => rows.push(put([label], 2026, 3 + i, `안내${i}`)));
  rows.push([]); // 빈 줄은 건너뜀
  rows.push(put(['팀A', 'Alice'], 2026, 1, '[PC] a1'));
  rows.push(put(['', ''], 2027, 12, '[MOB] a2'));
  rows.push(put(['', 'Bob'], 2026, 12, '[NPC] b1'));
  return rows;
}

test('연도 행이 맨 위(0행)이고 연도 사이 빈 열이 없는 탭', () => {
  const p = parseGrid(grid({ separators: false }));
  assert.equal(p.layout.yearRow, 0);
  assert.equal(p.layout.monthRow, 1);
  assert.equal(p.layout.firstMonthCol, 3);
  assert.equal(p.months.length, 24);
  assert.equal(p.months[12].key, '2027-01');
  assert.equal(p.months[12].col, 15, '구분 열이 없으니 2027-01 은 바로 다음 열');
  assert.deepEqual(p.lanes.map((l) => l.label), ['Alice', 'Bob']);
  assert.equal(p.lanes[0].features.length, 2);
  assert.deepEqual(p.lanes[0].features.map((f) => f.month), ['2026-01', '2027-12']);
});

test('연도 사이 빈 구분 열이 있는 탭도 같은 방식으로 읽힘', () => {
  const p = parseGrid(grid({ separators: true }));
  assert.equal(p.months.length, 24);
  assert.equal(p.months[12].col, 16, '구분 열 1칸을 건너뜀');
  assert.equal(p.lanes[0].features[1].month, '2027-12');
});

test('본문 앞 안내 줄은 개수·이름이 달라도 순서대로 인식', () => {
  const two = parseGrid(grid({ infoRows: ['마일 스톤', '3D 피쳐 마감'] }));
  assert.deepEqual(two.titles.rows.map((r) => r.label), ['마일 스톤', '3D 피쳐 마감']);
  const three = parseGrid(grid({ infoRows: ['마일 스톤', '이슈 정리', '추가 줄'] }));
  assert.deepEqual(three.titles.rows.map((r) => r.kind), ['info0', 'info1', 'info2']);
  assert.equal(three.layout.bodyStartRow, three.layout.monthRow + 1 + 3 + 1, '안내 3줄 + 빈 줄 다음이 본문');
  assert.deepEqual(three.header.filter((h) => h.kind === 'info2').map((h) => h.text), ['안내2']);
  const none = parseGrid(grid({ infoRows: [] }));
  assert.deepEqual(none.titles.rows, []);
  assert.deepEqual(none.lanes.map((l) => l.label), ['Alice', 'Bob']);
});

test('연도 위의 구간 표시 줄(band)', () => {
  const p = parseGrid(grid({ bandRow: true }));
  assert.equal(p.layout.yearRow, 1);
  assert.deepEqual(p.header.filter((h) => h.kind === 'band'), [{ kind: 'band', month: '2026-02', text: 'VS 스펙' }]);
  assert.equal(p.titles.note, '메모');
  const noBand = parseGrid(grid({ bandRow: false }));
  assert.equal(noBand.header.filter((h) => h.kind === 'band').length, 0);
});

test('안내 줄과 본문을 혼동하지 않음: 담당자 이름(B열)이 나오는 첫 줄부터 본문', () => {
  const g = grid();
  const layout = detectLayout(g);
  assert.equal(g[layout.bodyStartRow][1], 'Alice');
  // 안내 줄의 카드는 담당자 피쳐로 세지 않는다
  const p = parseGrid(g);
  assert.equal(p.lanes.reduce((n, l) => n + l.features.length, 0), 3);
});

test('직접 지정한 위치(override)는 자동 인식보다 우선', () => {
  const g = grid();
  const bobRow = g.findIndex((r) => r[1] === 'Bob');
  assert.ok(bobRow > detectLayout(g).bodyStartRow);
  const p = parseGrid(g, { bodyStartRow: bobRow }); // Alice 줄을 통째로 건너뛰게 함
  assert.deepEqual(p.lanes.map((l) => l.label), ['Bob']);
});

test('연도/월 줄을 못 찾으면 알기 쉬운 오류', () => {
  assert.throws(() => parseGrid([['a', 'b'], ['c']]), /연도\/월 헤더를 찾지 못했습니다/);
  assert.throws(() => parseGrid([['', '', '', '2026'], ['', '', '', 'x']]), /헤더/);
});
