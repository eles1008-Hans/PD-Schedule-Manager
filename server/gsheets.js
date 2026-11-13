'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

// 0 -> A, 25 -> Z, 26 -> AA
function colToA1(index) {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

class SheetsClient {
  constructor({ serviceAccount, sheetId, tab, apiBase, tokenUrl }) {
    this.sa = serviceAccount;
    this.sheetId = sheetId;
    this.tab = tab;
    this.apiBase = (apiBase || 'https://sheets.googleapis.com').replace(/\/$/, '');
    this.tokenUrl = tokenUrl || this.sa.token_uri || 'https://oauth2.googleapis.com/token';
    this._token = null;
  }

  async accessToken() {
    const now = Math.floor(Date.now() / 1000);
    if (this._token && this._token.exp - 60 > now) return this._token.value;
    const claims = { iss: this.sa.client_email, scope: SCOPE, aud: this.tokenUrl, iat: now, exp: now + 3600 };
    const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}`;
    const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(this.sa.private_key);
    const res = await fetch(this.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${unsigned}.${b64url(signature)}`,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      throw new Error(`구글 인증 실패 (${res.status}): ${data.error_description || data.error || '알 수 없는 오류'}`);
    }
    this._token = { value: data.access_token, exp: now + (data.expires_in || 3600) };
    return this._token.value;
  }

  async request(method, pathAndQuery, body) {
    const token = await this.accessToken();
    const res = await fetch(`${this.apiBase}${pathAndQuery}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (data.error && data.error.message) || res.statusText;
      throw new Error(`구글 시트 API 오류 (${res.status}): ${msg}`);
    }
    return data;
  }

  quotedTab() {
    return `'${this.tab.replace(/'/g, "''")}'`;
  }

  a1(c0, r0, c1, r1) {
    return `${this.quotedTab()}!${colToA1(c0)}${r0 + 1}:${colToA1(c1)}${r1 + 1}`;
  }

  // 대상 탭의 gid, 행/열 개수
  async getMeta() {
    const data = await this.request(
      'GET',
      `/v4/spreadsheets/${encodeURIComponent(this.sheetId)}?fields=${encodeURIComponent('sheets.properties')}`,
    );
    const sheet = (data.sheets || []).find((s) => s.properties && s.properties.title === this.tab);
    if (!sheet) throw new Error(`시트에서 '${this.tab}' 탭을 찾을 수 없습니다. GOOGLE_SHEET_TAB 값을 확인해 주세요.`);
    const p = sheet.properties;
    return { gid: p.sheetId, rowCount: p.gridProperties.rowCount, colCount: p.gridProperties.columnCount };
  }

  async readGrid(meta) {
    const range = this.a1(0, 0, meta.colCount - 1, meta.rowCount - 1);
    const data = await this.request(
      'GET',
      `/v4/spreadsheets/${encodeURIComponent(this.sheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`,
    );
    return data.values || [];
  }

  async writeValues(data) {
    if (!data.length) return;
    await this.request('POST', `/v4/spreadsheets/${encodeURIComponent(this.sheetId)}/values:batchUpdate`, {
      valueInputOption: 'RAW',
      data: data.map((d) => ({ range: d.range, majorDimension: 'ROWS', values: d.values })),
    });
  }

  async insertRows(gid, startIndex, length) {
    await this.request('POST', `/v4/spreadsheets/${encodeURIComponent(this.sheetId)}:batchUpdate`, {
      requests: [
        {
          insertDimension: {
            range: { sheetId: gid, dimension: 'ROWS', startIndex, endIndex: startIndex + length },
            inheritFromBefore: true,
          },
        },
      ],
    });
  }

  async appendRows(gid, length) {
    await this.request('POST', `/v4/spreadsheets/${encodeURIComponent(this.sheetId)}:batchUpdate`, {
      requests: [{ appendDimension: { sheetId: gid, dimension: 'ROWS', length } }],
    });
  }
}

// 환경 변수에서 시트 연동 설정을 읽는다. 하나라도 빠지면 null (연동 미설정).
function clientFromEnv(env = process.env) {
  const sheetId = (env.GOOGLE_SHEET_ID || '').trim();
  if (!sheetId) return null;
  let raw = env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw && env.GOOGLE_SERVICE_ACCOUNT_FILE) raw = fs.readFileSync(env.GOOGLE_SERVICE_ACCOUNT_FILE, 'utf8');
  if (!raw) return null;
  const serviceAccount = JSON.parse(raw);
  if (!serviceAccount.client_email || !serviceAccount.private_key) {
    throw new Error('서비스 계정 키에 client_email / private_key 가 없습니다.');
  }
  return new SheetsClient({
    serviceAccount,
    sheetId,
    tab: (env.GOOGLE_SHEET_TAB || '캐릭터 컨셉 로드맵').trim(),
    apiBase: env.GOOGLE_SHEETS_API_BASE,
    tokenUrl: env.GOOGLE_OAUTH_TOKEN_URL,
  });
}

module.exports = { SheetsClient, clientFromEnv, colToA1 };
