'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Store, httpError } = require('./db');
const { SyncService } = require('./sync');
const { clientFromEnv } = require('./gsheets');
const auth = require('./auth');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function createApp({ store, sync, secret, publicDir, cookieSecure = false }) {
  const attempts = new Map(); // 로그인 시도 제한 (IP별 5분에 10회)

  const send = (res, status, body, headers = {}) => {
    const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
    res.writeHead(status, {
      'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    });
    res.end(isJson ? JSON.stringify(body) : body);
  };

  const readJson = (req) =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > 100 * 1024) {
          reject(httpError(413, '요청이 너무 큽니다.'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(httpError(400, '잘못된 JSON 형식입니다.'));
        }
      });
      req.on('error', reject);
    });

  const routes = [];
  const route = (method, pattern, opts, handler) => routes.push({ method, pattern, opts, handler });

  // ---- 인증 ----
  route('POST', /^\/api\/login$/, { public: true }, async (ctx) => {
    const ip = ctx.req.socket.remoteAddress || '?';
    const now = Date.now();
    const a = attempts.get(ip) || { n: 0, reset: now + 5 * 60 * 1000 };
    if (now > a.reset) {
      a.n = 0;
      a.reset = now + 5 * 60 * 1000;
    }
    if (a.n >= 10) throw httpError(429, '로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.');
    const { username, password } = ctx.body;
    const user = typeof username === 'string' ? store.getUser(username.trim()) : null;
    const ok = user && typeof password === 'string' && auth.verifyPassword(password, user.pass_hash);
    if (!ok) {
      a.n++;
      attempts.set(ip, a);
      throw httpError(401, '아이디 또는 비밀번호가 올바르지 않습니다.');
    }
    attempts.delete(ip);
    const token = auth.createSession(secret, user);
    return {
      headers: { 'Set-Cookie': auth.sessionCookie(token, { secure: cookieSecure }) },
      body: { user: { username: user.username, role: user.role } },
    };
  });
  route('POST', /^\/api\/logout$/, { public: true }, async () => ({
    headers: { 'Set-Cookie': auth.clearCookie({ secure: cookieSecure }) },
    body: { ok: true },
  }));
  route('GET', /^\/api\/me$/, {}, async (ctx) => ({ body: { user: ctx.user } }));

  // ---- 화면 데이터 ----
  route('GET', /^\/api\/board$/, {}, async () => ({ body: { ...store.board(), sync: sync.status() } }));
  route('GET', /^\/api\/rev$/, {}, async () => ({ body: { rev: store.rev(), sync: sync.status() } }));

  // ---- 피쳐 편집 (관리자 전용) ----
  const afterChange = () => sync.schedule();
  route('POST', /^\/api\/features$/, { admin: true }, async (ctx) => {
    const { laneId, month, index, text } = ctx.body;
    const r = store.createFeature({ laneId, month, index, text }, ctx.user.username);
    afterChange();
    return { status: 201, body: r };
  });
  route('PATCH', /^\/api\/features\/(\d+)$/, { admin: true }, async (ctx) => {
    const r = store.updateFeatureText(Number(ctx.params[0]), ctx.body.text, ctx.user.username);
    afterChange();
    return { body: r };
  });
  route('POST', /^\/api\/features\/(\d+)\/move$/, { admin: true }, async (ctx) => {
    const { laneId, month, index } = ctx.body;
    const r = store.moveFeature(Number(ctx.params[0]), { laneId, month, index }, ctx.user.username);
    afterChange();
    return { body: r };
  });
  route('DELETE', /^\/api\/features\/(\d+)$/, { admin: true }, async (ctx) => {
    store.deleteFeature(Number(ctx.params[0]), ctx.user.username);
    afterChange();
    return { body: { ok: true } };
  });

  // ---- 시트 동기화 ----
  route('GET', /^\/api\/sync$/, {}, async () => ({ body: sync.status() }));
  route('PUT', /^\/api\/sync$/, { admin: true }, async (ctx) => {
    sync.setEnabled(ctx.body.enabled === true, ctx.user.username);
    return { body: sync.status() };
  });
  route('POST', /^\/api\/sync\/run$/, { admin: true }, async () => {
    if (!sync.enabled()) throw httpError(400, '동기화가 꺼져 있습니다. 먼저 동기화를 켜 주세요.');
    const result = await sync.run('manual');
    return { body: { result, status: sync.status() } };
  });
  route('POST', /^\/api\/sync\/resolve$/, { admin: true }, async (ctx) => {
    store.resolveConflict(ctx.body.laneId, ctx.body.use);
    store.log(ctx.user.username, 'resolve_conflict', { laneId: ctx.body.laneId, use: ctx.body.use });
    if (sync.enabled()) await sync.run('resolve');
    return { body: sync.status() };
  });
  route('GET', /^\/api\/log$/, { admin: true }, async () => ({ body: { log: store.recentLog(100) } }));

  // ---- 정적 파일 ----
  const serveStatic = (req, res) => {
    let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (rel === '/') rel = '/index.html';
    const file = path.join(publicDir, path.normalize(rel));
    if (!file.startsWith(publicDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return send(res, 404, 'Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
    });
    fs.createReadStream(file).pipe(res);
  };

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (!url.pathname.startsWith('/api/')) return serveStatic(req, res);

      const r = routes.find((x) => x.method === req.method && x.pattern.test(url.pathname));
      if (!r) throw httpError(404, '존재하지 않는 API입니다.');

      const mutating = req.method !== 'GET';
      if (mutating) {
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) throw httpError(403, '허용되지 않은 요청 출처입니다.');
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
          throw httpError(415, 'Content-Type 은 application/json 이어야 합니다.');
        }
      }

      const cookies = auth.parseCookies(req.headers.cookie);
      const session = auth.readSession(secret, cookies[auth.COOKIE]);
      // 세션 이후 계정이 삭제/강등되었을 수 있으므로 DB 기준으로 역할을 다시 확인
      const dbUser = session ? store.getUser(session.username) : null;
      const user = dbUser ? { username: dbUser.username, role: dbUser.role } : null;

      if (!r.opts.public && !user) throw httpError(401, '로그인이 필요합니다.');
      if (r.opts.admin && user.role !== 'admin') throw httpError(403, '관리자만 변경할 수 있습니다.');

      const body = mutating ? await readJson(req) : {};
      const out = await r.handler({ req, res, user, body, params: url.pathname.match(r.pattern).slice(1) });
      send(res, out.status || 200, out.body, out.headers);
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error(err);
      send(res, status, { error: status === 500 ? '서버 오류가 발생했습니다.' : err.message });
    }
  });
}

function main() {
  if (fs.existsSync('.env')) process.loadEnvFile('.env');
  const dataDir = path.resolve(process.env.DATA_DIR || './data');
  const store = new Store(path.join(dataDir, 'roadmap.db'));

  if (store.countUsers() === 0) {
    const { ADMIN_USERNAME: u, ADMIN_PASSWORD: p } = process.env;
    if (u && p) {
      store.createUser(u.trim(), auth.hashPassword(p), 'admin');
      console.log(`관리자 계정 '${u}' 을(를) 생성했습니다.`);
    } else {
      console.warn("등록된 사용자가 없습니다. 'npm run create-user -- <아이디> <비밀번호> admin' 으로 관리자를 만들어 주세요.");
    }
  }

  const sync = new SyncService(store, {
    clientFactory: () => clientFromEnv(),
    intervalMs: Number(process.env.SYNC_INTERVAL_SEC || 30) * 1000,
  });
  sync.start();

  const app = createApp({
    store,
    sync,
    secret: auth.loadSecret(dataDir),
    publicDir: path.resolve(__dirname, '..', 'public'),
    cookieSecure: process.env.COOKIE_SECURE === '1',
  });
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  app.listen(port, host, () => console.log(`PD Schedule Manager: http://${host}:${port}`));
}

if (require.main === module) main();

module.exports = { createApp };
