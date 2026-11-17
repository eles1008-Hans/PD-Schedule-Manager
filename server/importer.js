'use strict';
const crypto = require('node:crypto');

// 탭마다 달라지는 위치(연도 행, 헤더 줄 수, 본문 시작 행)는 시트 내용을 보고 자동으로 찾는다.
// 열 위치(A열 그룹 / B열 담당자 / D열부터 월)는 모든 로드맵 탭이 같다. (0부터 시작하는 행/열 번호)
const DEFAULT_LAYOUT = Object.freeze({
  groupCol: 0, // A열: 팀/그룹 이름
  labelCol: 1, // B열: 담당자(행) 이름
  firstMonthCol: 3, // D열부터 월 열
});

const text = (v) => (v == null ? '' : String(v).trim());
const norm = (s) => text(s).replace(/\s+/g, ' ');
const laneKey = (group, label) => `${norm(group)}|${norm(label)}`;

function parseTimeline(grid, layout) {
  const yearRow = grid[layout.yearRow] || [];
  const monthRow = grid[layout.monthRow] || [];
  const width = Math.max(yearRow.length, monthRow.length);
  const months = [];
  let year = null;
  for (let c = layout.firstMonthCol; c < width; c++) {
    const y = text(yearRow[c]);
    if (/^\d{4}$/.test(y)) year = Number(y);
    const m = text(monthRow[c]);
    if (year != null && /^\d{1,2}$/.test(m) && Number(m) >= 1 && Number(m) <= 12) {
      months.push({
        key: `${year}-${String(Number(m)).padStart(2, '0')}`,
        col: c,
        year,
        month: Number(m),
      });
    }
  }
  return months;
}

// 한 담당자(행) 블록의 변경 여부를 판단하기 위한 해시
function hashLane(features) {
  const items = features
    .map((f) => [f.month, f.slot, text(f.text)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
  return crypto.createHash('sha1').update(JSON.stringify(items)).digest('hex');
}

const isYear = (v) => /^20\d{2}$/.test(text(v));
const isMonth = (v) => /^\d{1,2}$/.test(text(v)) && Number(text(v)) >= 1 && Number(text(v)) <= 12;

// 연도/월 행, 월 시작 열, 본문 시작 행을 찾는다. override 로 일부를 직접 지정할 수도 있다.
function detectLayout(grid, override = {}) {
  const layout = { ...DEFAULT_LAYOUT, ...override };
  if (layout.yearRow == null) {
    for (let r = 0; r < Math.min(grid.length - 1, 12); r++) {
      const years = (grid[r] || []).filter(isYear).length;
      const months = (grid[r + 1] || []).filter(isMonth).length;
      if (years >= 1 && months >= 2) {
        layout.yearRow = r;
        break;
      }
    }
  }
  if (layout.yearRow == null) {
    throw new Error('연도/월 헤더를 찾지 못했습니다. 시트 위쪽의 연도(2026 등)와 그 아래 월(1~12) 줄을 확인해 주세요.');
  }
  if (layout.monthRow == null) layout.monthRow = layout.yearRow + 1;
  if (override.firstMonthCol == null) {
    const first = (grid[layout.monthRow] || []).findIndex((v, c) => c > layout.labelCol && isMonth(v));
    if (first >= 0) layout.firstMonthCol = first;
  }
  if (layout.bodyStartRow == null) {
    let r = layout.monthRow + 1;
    while (r < grid.length && !text((grid[r] || [])[layout.labelCol])) r++;
    layout.bodyStartRow = r;
  }
  return layout;
}

// 시트 격자(2차원 배열)를 { 타임라인, 헤더, 담당자별 피쳐 } 구조로 변환한다.
function parseGrid(grid, layoutOverride = {}) {
  const layout = detectLayout(grid, layoutOverride);
  const warnings = [];
  const months = parseTimeline(grid, layout);
  if (!months.length) {
    throw new Error('연도/월 헤더를 찾지 못했습니다. 시트의 연도/월 줄 구성을 확인해 주세요.');
  }
  const colToMonth = new Map(months.map((m) => [m.col, m.key]));

  // 헤더 줄: 연도 위의 구간 표시(band), 월 아래 본문 전까지의 안내 줄(마일 스톤, 이슈 정리, 피쳐 마감 …)
  const header = [];
  const infoRows = [];
  const bandRows = [];
  for (let r = 0; r < layout.yearRow; r++) bandRows.push(r);
  for (let r = layout.monthRow + 1; r < layout.bodyStartRow; r++) {
    const row = grid[r] || [];
    const hasCells = row.some((v, c) => c >= layout.firstMonthCol && text(v));
    if (text(row[layout.groupCol]) || hasCells) infoRows.push(r);
  }
  const scanHeader = (kind, rowIdx) => {
    const r = grid[rowIdx] || [];
    for (let c = layout.firstMonthCol; c < r.length; c++) {
      const t = text(r[c]);
      if (!t) continue;
      const month = colToMonth.get(c);
      if (month) header.push({ kind, month, text: t });
      else warnings.push(`헤더(${kind}) ${c + 1}열의 내용이 월 열이 아니라 무시했습니다: ${t.slice(0, 30)}`);
    }
  };
  for (const r of bandRows) scanHeader('band', r);
  infoRows.forEach((r, i) => scanHeader(`info${i}`, r));

  const titles = {
    note: text(grid[0] && grid[0][layout.groupCol]),
    rows: infoRows.map((r, i) => ({ kind: `info${i}`, label: text((grid[r] || [])[layout.groupCol]) })),
  };

  const lanes = [];
  let group = '';
  let cur = null;
  let ignoredCells = 0;
  for (let r = layout.bodyStartRow; r < grid.length; r++) {
    const row = grid[r] || [];
    const g = text(row[layout.groupCol]);
    const label = text(row[layout.labelCol]);
    if (g) group = g;
    if (label) {
      cur = { group, label, rowStart: r, features: [] };
      lanes.push(cur);
    }
    for (let c = layout.firstMonthCol; c < row.length; c++) {
      const t = text(row[c]);
      if (!t) continue;
      const month = colToMonth.get(c);
      if (!month) {
        ignoredCells++;
        continue;
      }
      if (!cur) {
        cur = { group, label: '(미분류)', rowStart: r, features: [] };
        lanes.push(cur);
        warnings.push(`${r + 1}행: 담당자 이름 없이 시작하는 피쳐가 있어 '(미분류)' 행으로 묶었습니다.`);
      }
      cur.features.push({ month, slot: r - cur.rowStart, text: t });
    }
  }
  if (ignoredCells) warnings.push(`월 열이 아닌 위치(빈 구분 열 등)의 셀 ${ignoredCells}개를 가져오지 않았습니다.`);

  const used = new Map();
  for (const lane of lanes) {
    const base = laneKey(lane.group, lane.label);
    const n = (used.get(base) || 0) + 1;
    used.set(base, n);
    lane.key = n > 1 ? `${base}#${n}` : base;
  }

  return { layout, months, header, titles, lanes, warnings, rowCount: grid.length };
}

module.exports = { DEFAULT_LAYOUT, detectLayout, parseGrid, hashLane, laneKey, norm };
