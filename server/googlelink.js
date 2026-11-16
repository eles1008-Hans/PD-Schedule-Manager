'use strict';
// 구글 계정 연동(OAuth 2.0 승인 코드 방식).
// 사용자가 "연동 신청"을 누르면 구글 동의 화면으로 이동하고, 승인하면 이 앱이 그 계정의 권한으로 지정한 시트를 읽고 쓴다.
// 갱신 토큰은 서버 DB에 암호화해서 저장한다.
const crypto = require('node:crypto');
const { httpError } = require('./db');
const { SheetsClient } = require('./gsheets');

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets', 'openid', 'email'];
const SHEETS_SCOPE = SCOPES[0];
const DEFAULT_TAB = '캐릭터 컨셉 로드맵';
const STATE_TTL_MS = 10 * 60 * 1000;

// 시트 주소(또는 ID)에서 스프레드시트 ID만 꺼낸다.
function parseSheetId(input) {
  const s = String(input || '').trim();
  const m = s.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{20,}$/.test(s) ? s : null;
}

const sealKey = (secret) => crypto.createHash('sha256').update(`pdsm-google|${secret}`).digest();

function seal(secret, text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', sealKey(secret), iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}

function unseal(secret, sealed) {
  const [iv, tag, enc] = String(sealed).split('.').map((s) => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', sealKey(secret), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

function emailFromIdToken(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.email === 'string' ? payload.email : null;
  } catch {
    return null;
  }
}

class GoogleLink {
  constructor({ store, secret, env = process.env, onChange = () => {} }) {
    this.store = store;
    this.secret = secret;
    this.onChange = onChange;
    this.clientId = (env.GOOGLE_OAUTH_CLIENT_ID || '').trim();
    this.clientSecret = (env.GOOGLE_OAUTH_CLIENT_SECRET || '').trim();
    // 브라우저로 이 앱에 접속하는 주소와 같아야 한다 (구글에 등록하는 리디렉션 주소의 기준)
    this.publicUrl = (env.PUBLIC_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, '');
    this.authUrl = env.GOOGLE_OAUTH_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';
    this.tokenUrl = env.GOOGLE_OAUTH_TOKEN_URL || 'https://oauth2.googleapis.com/token';
    this.revokeUrl = env.GOOGLE_OAUTH_REVOKE_URL || 'https://oauth2.googleapis.com/revoke';
    this.apiBase = env.GOOGLE_SHEETS_API_BASE;
    this.envSheetId = (env.GOOGLE_SHEET_ID || '').trim();
    this.envTab = (env.GOOGLE_SHEET_TAB || '').trim();
    this.states = new Map(); // 진행 중인 연동 요청 (state → { user, exp })
    this._token = null;
  }

  oauthConfigured() {
    return !!(this.clientId && this.clientSecret);
  }

  redirectUri() {
    return `${this.publicUrl}/api/google/callback`;
  }

  sheet() {
    return {
      id: this.store.getMeta('google_sheet_id') || this.envSheetId || '',
      tab: this.store.getMeta('google_sheet_tab') || this.envTab || DEFAULT_TAB,
    };
  }

  link() {
    return this.store.getJson('google_link', null);
  }

  status() {
    const link = this.link();
    return {
      oauthConfigured: this.oauthConfigured(),
      redirectUri: this.redirectUri(),
      linked: !!link,
      email: link ? link.email : null,
      linkedAt: link ? link.linkedAt : null,
      needsRelink: !!link && this.store.getMeta('google_needs_relink', '0') === '1',
      sheet: this.sheet(),
      scopes: { sheets: SHEETS_SCOPE },
    };
  }

  setSheet({ sheet, tab }, user) {
    const id = parseSheetId(sheet);
    if (!id) throw httpError(400, '시트 주소(또는 시트 ID)를 확인해 주세요. 예: https://docs.google.com/spreadsheets/d/…');
    const t = String(tab == null || tab === '' ? DEFAULT_TAB : tab).trim();
    if (!t || t.length > 100) throw httpError(400, '탭 이름은 1~100자로 입력해 주세요.');
    this.store.setMeta('google_sheet_id', id);
    this.store.setMeta('google_sheet_tab', t);
    this.store.log(user, 'google_sheet_set', { tab: t });
    this.store.bump();
    this.onChange();
  }

  // "연동 신청": 구글 동의 화면 주소를 만든다.
  beginLink(user) {
    if (!this.oauthConfigured()) {
      throw httpError(400, '서버에 구글 OAuth 클라이언트가 설정되지 않았습니다. 연동 창의 설정 안내를 먼저 진행해 주세요.');
    }
    const now = Date.now();
    for (const [k, v] of this.states) if (v.exp < now) this.states.delete(k);
    const state = crypto.randomBytes(24).toString('hex');
    this.states.set(state, { user, exp: now + STATE_TTL_MS });
    const url = new URL(this.authUrl);
    url.search = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri(),
      response_type: 'code',
      scope: SCOPES.join(' '),
      access_type: 'offline', // 갱신 토큰을 받기 위해
      prompt: 'consent',
      state,
    }).toString();
    return url.toString();
  }

  // 구글이 되돌려 보낸 승인 코드를 토큰으로 바꿔 저장한다.
  async finishLink({ code, state, user }) {
    const entry = this.states.get(state);
    this.states.delete(state); // 한 번만 사용
    if (!entry || entry.exp < Date.now() || entry.user !== user) {
      throw httpError(400, '연동 요청이 만료되었거나 올바르지 않습니다. 다시 연동 신청을 해 주세요.');
    }
    if (!code) throw httpError(400, '구글에서 승인 코드를 받지 못했습니다.');
    let tokens;
    try {
      tokens = await this.tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: this.redirectUri() });
    } catch (err) {
      throw httpError(400, `구글 연동에 실패했습니다: ${err.message}`);
    }
    if (tokens.scope && !String(tokens.scope).split(' ').includes(SHEETS_SCOPE)) {
      throw httpError(400, '구글 스프레드시트 접근 권한을 허용해야 연동할 수 있습니다. 다시 신청해 주세요.');
    }
    if (!tokens.refresh_token) {
      throw httpError(
        400,
        '구글이 갱신 토큰을 주지 않았습니다. 구글 계정의 "서드 파티 앱 및 서비스" 권한에서 이 앱을 제거한 뒤 다시 연동해 주세요.',
      );
    }
    const email = emailFromIdToken(tokens.id_token);
    this.store.setJson('google_link', {
      email,
      refresh: seal(this.secret, tokens.refresh_token),
      linkedAt: new Date().toISOString(),
      linkedBy: user,
    });
    this.store.setMeta('google_needs_relink', '0');
    this._token = { value: tokens.access_token, exp: Math.floor(Date.now() / 1000) + (tokens.expires_in || 3600) };
    this.store.log(user, 'google_link', { email });
    this.store.bump();
    this.onChange();
    return { email };
  }

  async unlink(user) {
    const link = this.link();
    if (link) {
      try {
        await fetch(this.revokeUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: unseal(this.secret, link.refresh) }),
        });
      } catch {
        /* 구글 쪽 취소는 최선만 시도. 이 앱에서는 어쨌든 지운다 */
      }
    }
    this.store.setMeta('google_link', 'null');
    this.store.setMeta('google_needs_relink', '0');
    this._token = null;
    this.store.log(user, 'google_unlink', null);
    this.store.bump();
    this.onChange();
  }

  async tokenRequest(params) {
    const res = await fetch(this.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, ...params }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      const err = new Error(data.error_description || data.error || `HTTP ${res.status}`);
      err.google = data.error;
      throw err;
    }
    return data;
  }

  // 시트 API 호출에 쓸 접근 토큰 (만료되면 갱신 토큰으로 새로 받음)
  async accessToken() {
    const now = Math.floor(Date.now() / 1000);
    if (this._token && this._token.exp - 60 > now) return this._token.value;
    const link = this.link();
    if (!link) throw new Error('구글 계정이 연동되어 있지 않습니다.');
    try {
      const t = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: unseal(this.secret, link.refresh) });
      this._token = { value: t.access_token, exp: now + (t.expires_in || 3600) };
      return this._token.value;
    } catch (err) {
      if (err.google === 'invalid_grant') {
        // 비밀번호 변경·앱 권한 제거 등으로 연동이 끊김 → 다시 연동 필요
        this._token = null;
        if (this.store.getMeta('google_needs_relink', '0') !== '1') {
          this.store.setMeta('google_needs_relink', '1');
          this.store.bump();
        }
        throw new Error('구글 연동이 만료되었거나 해제되었습니다. "구글 시트 연동"에서 다시 연동 신청을 해 주세요.');
      }
      throw new Error(`구글 인증 실패: ${err.message}`);
    }
  }

  // 연동되어 있고 시트가 지정되어 있으면 시트 클라이언트를, 아니면 null
  client() {
    if (!this.oauthConfigured() || !this.link()) return null;
    const { id, tab } = this.sheet();
    if (!id) return null;
    return new SheetsClient({ tokenProvider: () => this.accessToken(), sheetId: id, tab, apiBase: this.apiBase });
  }
}

module.exports = { GoogleLink, parseSheetId, seal, unseal, emailFromIdToken, DEFAULT_TAB };
