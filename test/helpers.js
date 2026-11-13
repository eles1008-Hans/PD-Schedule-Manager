'use strict';
const http = require('node:http');
const crypto = require('node:crypto');

// 시트와 같은 구조의 작은 격자: 2025-12, 2026-01, 2026-02, (빈 열), 2027-01, 2027-02
function sampleGrid() {
  return [
    ['note', '', '', '', 'VS 스펙'],
    ['', '', '', '2025', '2026', '', '', '2027', ''],
    ['', '', '', '12', '1', '2', '', '1', '2'],
    ['마일 스톤', '', '', '', '프로토 빌드'],
    ['컨셉 피쳐 마감'],
    ['팀A', 'Alice', '', '', '[MOB] a1', '[MOB] a2', '', '[PC] a3'],
    ['', '', '', '', '[MOB] a1b'],
    [],
    ['', 'Bob', '', '[BOSS] b1'],
    ['팀B', 'Carol', '', '', '', '', '', '', '[WP] c1'],
  ];
}

// 구글 시트 API를 흉내 내는 로컬 서버 (인증, 메타, 읽기, 값 쓰기, 행 삽입/추가)
async function startMockSheets(grid, { title = 'Roadmap', gid = 42, colCount = 12 } = {}) {
  const state = { grid: grid.map((r) => [...r]), rowCount: grid.length, calls: [], gid, title };
  const letters = (s) => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const cell = (r, c) => (state.grid[r] && state.grid[r][c]) || '';

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const raw = Buffer.concat(chunks).toString('utf8');
      const reply = (obj, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      state.calls.push(`${req.method} ${url.pathname}`);
      if (url.pathname === '/token') return reply({ access_token: 'tkn', expires_in: 3600 });
      if (req.headers.authorization !== 'Bearer tkn') return reply({ error: { message: 'unauthorized' } }, 401);

      if (req.method === 'GET' && /^\/v4\/spreadsheets\/[^/]+$/.test(url.pathname)) {
        return reply({
          sheets: [{ properties: { sheetId: state.gid, title: state.title, gridProperties: { rowCount: state.rowCount, columnCount: colCount } } }],
        });
      }
      if (req.method === 'GET' && url.pathname.includes('/values/')) {
        const values = [];
        for (let r = 0; r < state.rowCount; r++) {
          const row = state.grid[r] ? [...state.grid[r]] : [];
          while (row.length && !row[row.length - 1]) row.pop();
          values.push(row);
        }
        return reply({ values });
      }
      if (req.method === 'POST' && url.pathname.endsWith('/values:batchUpdate')) {
        for (const d of JSON.parse(raw).data) {
          const m = decodeURIComponent(d.range).match(/^'.+'!([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
          const c0 = letters(m[1]);
          const r0 = Number(m[2]) - 1;
          d.values.forEach((row, i) => {
            state.grid[r0 + i] = state.grid[r0 + i] || [];
            row.forEach((v, j) => {
              state.grid[r0 + i][c0 + j] = v;
            });
          });
        }
        return reply({});
      }
      if (req.method === 'POST' && url.pathname.endsWith(':batchUpdate')) {
        for (const rq of JSON.parse(raw).requests) {
          if (rq.insertDimension) {
            const { startIndex, endIndex } = rq.insertDimension.range;
            state.grid.splice(startIndex, 0, ...Array.from({ length: endIndex - startIndex }, () => []));
            state.rowCount += endIndex - startIndex;
          } else if (rq.appendDimension) {
            state.rowCount += rq.appendDimension.length;
          }
        }
        return reply({});
      }
      reply({ error: { message: 'not found' } }, 404);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { state, base, cell, close: () => new Promise((r) => server.close(r)) };
}

function fakeServiceAccount() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return { client_email: 'bot@example.iam.gserviceaccount.com', private_key: privateKey };
}

module.exports = { sampleGrid, startMockSheets, fakeServiceAccount };
