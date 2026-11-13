'use strict';
const crypto = require('node:crypto');

// 구글 시트 "캐릭터 컨셉 로드맵" 탭의 기본 배치 (0부터 시작하는 행/열 번호)
const DEFAULT_LAYOUT = Object.freeze({
  bandRow: 0, // "VS 스펙", "DEAD ZONE" 같은 구간 표시
  yearRow: 1, // 2025, 2026 ...
  monthRow: 2, // 1, 2, 3 ...
  milestoneRow: 3, // 마일 스톤
  deadlineRow: 4, // 컨셉 피쳐 마감
  bodyStartRow: 5, // 이 행부터 담당자별 피쳐
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

// 시트 격자(2차원 배열)를 { 타임라인, 헤더, 담당자별 피쳐 } 구조로 변환한다.
function parseGrid(grid, layoutOverride = {}) {
  const layout = { ...DEFAULT_LAYOUT, ...layoutOverride };
  const warnings = [];
  const months = parseTimeline(grid, layout);
  if (!months.length) {
    throw new Error('연도/월 헤더를 찾지 못했습니다. 시트의 2~3행(연도/월) 구성을 확인해 주세요.');
  }
  const colToMonth = new Map(months.map((m) => [m.col, m.key]));

  const header = [];
  for (const [kind, rowIdx] of [
    ['band', layout.bandRow],
    ['milestone', layout.milestoneRow],
    ['deadline', layout.deadlineRow],
  ]) {
    const r = grid[rowIdx] || [];
    for (let c = layout.firstMonthCol; c < r.length; c++) {
      const t = text(r[c]);
      if (!t) continue;
      const month = colToMonth.get(c);
      if (month) header.push({ kind, month, text: t });
      else warnings.push(`헤더(${kind}) ${c + 1}열의 내용이 월 열이 아니라 무시했습니다: ${t.slice(0, 30)}`);
    }
  }

  const titles = {
    note: text(grid[0] && grid[0][0]),
    milestone: text(grid[layout.milestoneRow] && grid[layout.milestoneRow][0]),
    deadline: text(grid[layout.deadlineRow] && grid[layout.deadlineRow][0]),
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

module.exports = { DEFAULT_LAYOUT, parseGrid, hashLane, laneKey, norm };
