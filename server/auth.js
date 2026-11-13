'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const COOKIE = 'pdsm';
const SESSION_SECONDS = 12 * 60 * 60;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltB64, hashB64] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// 세션 서명용 비밀키: 환경 변수 → 데이터 폴더에 저장된 키 → 새로 생성
function loadSecret(dataDir, env = process.env) {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  const file = path.join(dataDir, 'session.secret');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    const secret = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, secret, { mode: 0o600 });
    return secret;
  }
}

const sign = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('base64url');

function createSession(secret, user) {
  const payload = Buffer.from(
    JSON.stringify({ u: user.username, r: user.role, exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS }),
  ).toString('base64url');
  return `${payload}.${sign(secret, payload)}`;
}

function readSession(secret, token) {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = sign(secret, payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.exp || data.exp < Date.now() / 1000) return null;
    return { username: data.u, role: data.r };
  } catch {
    return null;
  }
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionCookie(token, { secure }) {
  return `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_SECONDS}${secure ? '; Secure' : ''}`;
}

function clearCookie({ secure }) {
  return `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;
}

module.exports = {
  COOKIE,
  hashPassword,
  verifyPassword,
  loadSecret,
  createSession,
  readSession,
  parseCookies,
  sessionCookie,
  clearCookie,
};
