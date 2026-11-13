'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { hashLane } = require('./importer');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'viewer')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS lanes (
  id INTEGER PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  group_name TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL,
  position INTEGER NOT NULL,
  row_start INTEGER NOT NULL,
  dirty INTEGER NOT NULL DEFAULT 0,
  sheet_hash TEXT,
  missing INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS features (
  id INTEGER PRIMARY KEY,
  lane_id INTEGER NOT NULL REFERENCES lanes(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  slot INTEGER NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_features_cell ON features(lane_id, month, slot);
CREATE TABLE IF NOT EXISTS header_cells (
  kind TEXT NOT NULL,
  month TEXT NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (kind, month)
);
CREATE TABLE IF NOT EXISTS conflicts (
  lane_id INTEGER PRIMARY KEY REFERENCES lanes(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  sheet_hash TEXT
);
CREATE TABLE IF NOT EXISTS change_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  username TEXT,
  action TEXT NOT NULL,
  detail TEXT
);
`;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

class Store {
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  tx(fn) {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ---- 설정값 ----
  getMeta(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? row.value : fallback;
  }
  setMeta(key, value) {
    this.db
      .prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, String(value));
  }
  getJson(key, fallback) {
    const v = this.getMeta(key);
    return v == null ? fallback : JSON.parse(v);
  }
  setJson(key, value) {
    this.setMeta(key, JSON.stringify(value));
  }
  rev() {
    return Number(this.getMeta('rev', '0'));
  }
  bump() {
    this.setMeta('rev', this.rev() + 1);
  }
  log(username, action, detail) {
    this.db
      .prepare('INSERT INTO change_log(username, action, detail) VALUES(?, ?, ?)')
      .run(username || null, action, detail == null ? null : JSON.stringify(detail));
  }
  recentLog(limit = 50) {
    return this.db.prepare('SELECT * FROM change_log ORDER BY id DESC LIMIT ?').all(limit);
  }

  // ---- 사용자 ----
  countUsers() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  }
  getUser(username) {
    return this.db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  }
  createUser(username, passHash, role) {
    this.db.prepare('INSERT INTO users(username, pass_hash, role) VALUES(?, ?, ?)').run(username, passHash, role);
  }
  updateUser(username, passHash, role) {
    this.db.prepare('UPDATE users SET pass_hash = ?, role = ? WHERE username = ?').run(passHash, role, username);
  }

  // ---- 가져오기 / 시트 반영 ----
  importParsed(parsed, { replace = false } = {}) {
    return this.tx(() => {
      if (replace) {
        this.db.exec('DELETE FROM conflicts; DELETE FROM features; DELETE FROM lanes; DELETE FROM header_cells;');
      }
      const stats = this._applyParsed(parsed);
      this.bump();
      return stats;
    });
  }

  applySheet(parsed) {
    return this.tx(() => {
      const stats = this._applyParsed(parsed);
      if (stats.created || stats.updated || stats.missing || stats.conflicts) this.bump();
      return stats;
    });
  }

  _applyParsed(parsed) {
    const stats = { created: 0, updated: 0, unchanged: 0, conflicts: 0, missing: 0 };
    const db = this.db;
    this.setJson('timeline', parsed.months);
    this.setJson('layout', parsed.layout);
    this.setJson('titles', parsed.titles);

    db.exec('DELETE FROM header_cells');
    const insHeader = db.prepare('INSERT OR REPLACE INTO header_cells(kind, month, text) VALUES(?, ?, ?)');
    for (const h of parsed.header) insHeader.run(h.kind, h.month, h.text);

    const insLane = db.prepare(
      'INSERT INTO lanes(key, group_name, label, position, row_start, dirty, sheet_hash) VALUES(?, ?, ?, ?, ?, 0, ?)',
    );
    const insFeature = db.prepare('INSERT INTO features(lane_id, month, slot, text) VALUES(?, ?, ?, ?)');
    const existing = new Map(db.prepare('SELECT * FROM lanes').all().map((l) => [l.key, l]));
    const seen = new Set();

    parsed.lanes.forEach((pl, i) => {
      const hash = hashLane(pl.features);
      const lane = existing.get(pl.key);
      if (!lane) {
        const { lastInsertRowid } = insLane.run(pl.key, pl.group, pl.label, i, pl.rowStart, hash);
        for (const f of pl.features) insFeature.run(lastInsertRowid, f.month, f.slot, f.text);
        stats.created++;
        return;
      }
      seen.add(lane.id);
      db.prepare('UPDATE lanes SET group_name = ?, label = ?, position = ?, row_start = ?, missing = 0 WHERE id = ?').run(
        pl.group,
        pl.label,
        i,
        pl.rowStart,
        lane.id,
      );
      if (lane.sheet_hash === hash) {
        db.prepare('DELETE FROM conflicts WHERE lane_id = ?').run(lane.id);
        stats.unchanged++;
        return;
      }
      if (lane.dirty) {
        db.prepare('INSERT OR REPLACE INTO conflicts(lane_id, at, sheet_hash) VALUES(?, ?, ?)').run(
          lane.id,
          new Date().toISOString(),
          hash,
        );
        stats.conflicts++;
        return;
      }
      db.prepare('DELETE FROM features WHERE lane_id = ?').run(lane.id);
      for (const f of pl.features) insFeature.run(lane.id, f.month, f.slot, f.text);
      db.prepare('UPDATE lanes SET sheet_hash = ? WHERE id = ?').run(hash, lane.id);
      stats.updated++;
    });

    for (const lane of existing.values()) {
      if (!seen.has(lane.id)) {
        db.prepare('UPDATE lanes SET missing = 1 WHERE id = ?').run(lane.id);
        stats.missing++;
      }
    }
    return stats;
  }

  // ---- 화면용 데이터 ----
  board() {
    const lanes = this.db
      .prepare(
        'SELECT l.*, EXISTS(SELECT 1 FROM conflicts c WHERE c.lane_id = l.id) AS conflict FROM lanes l ORDER BY position, id',
      )
      .all();
    const feats = this.db
      .prepare('SELECT id, lane_id, month, slot, text FROM features ORDER BY lane_id, month, slot, id')
      .all();
    const byLane = new Map();
    for (const f of feats) {
      if (!byLane.has(f.lane_id)) byLane.set(f.lane_id, []);
      byLane.get(f.lane_id).push({ id: f.id, month: f.month, slot: f.slot, text: f.text });
    }
    const header = { band: {}, milestone: {}, deadline: {} };
    for (const h of this.db.prepare('SELECT kind, month, text FROM header_cells').all()) {
      if (header[h.kind]) header[h.kind][h.month] = h.text;
    }
    return {
      rev: this.rev(),
      titles: this.getJson('titles', {}),
      months: this.timelineMonths().map(({ key, year, month }) => ({ key, year, month })),
      header,
      lanes: lanes.map((l) => ({
        id: l.id,
        group: l.group_name,
        label: l.label,
        dirty: !!l.dirty,
        missing: !!l.missing,
        conflict: !!l.conflict,
        features: byLane.get(l.id) || [],
      })),
    };
  }

  timelineMonths() {
    return this.getJson('timeline', []);
  }

  getFeature(id) {
    return this.db.prepare('SELECT * FROM features WHERE id = ?').get(id);
  }

  // ---- 피쳐 편집 (같은 담당자·월 칸 안에서는 slot 순서가 위에서 아래 순서) ----
  _column(laneId, month) {
    return this.db
      .prepare('SELECT id FROM features WHERE lane_id = ? AND month = ? ORDER BY slot, id')
      .all(laneId, month)
      .map((r) => r.id);
  }
  _place(ids, laneId, month) {
    const st = this.db.prepare('UPDATE features SET lane_id = ?, month = ?, slot = ? WHERE id = ?');
    ids.forEach((id, i) => st.run(laneId, month, i, id));
  }
  _markDirty(...laneIds) {
    const st = this.db.prepare('UPDATE lanes SET dirty = 1 WHERE id = ?');
    for (const id of new Set(laneIds)) st.run(id);
  }
  _assertTarget(laneId, month) {
    const lane = this.db.prepare('SELECT id FROM lanes WHERE id = ?').get(laneId);
    if (!lane) throw httpError(400, '존재하지 않는 담당자(행)입니다.');
    if (!this.timelineMonths().some((m) => m.key === month)) throw httpError(400, '존재하지 않는 월입니다.');
  }
  _cleanText(value) {
    const t = typeof value === 'string' ? value.trim() : '';
    if (!t) throw httpError(400, '피쳐 이름을 입력해 주세요.');
    if (t.length > 500) throw httpError(400, '피쳐 이름은 500자 이하로 입력해 주세요.');
    return t;
  }

  moveFeature(id, { laneId, month, index }, user) {
    return this.tx(() => {
      const f = this.getFeature(id);
      if (!f) throw httpError(404, '피쳐를 찾을 수 없습니다.');
      this._assertTarget(laneId, month);
      const same = f.lane_id === laneId && f.month === month;
      const original = same ? this._column(laneId, month) : null;
      const dst = this._column(laneId, month).filter((x) => x !== id);
      const at = Number.isInteger(index) ? Math.max(0, Math.min(index, dst.length)) : dst.length;
      dst.splice(at, 0, id);
      if (same && original.join() === dst.join()) return { changed: false };
      const from = { laneId: f.lane_id, month: f.month };
      this._place(dst, laneId, month);
      if (!same) this._place(this._column(from.laneId, from.month), from.laneId, from.month);
      this._markDirty(from.laneId, laneId);
      this.log(user, 'move', { id, text: f.text, from, to: { laneId, month } });
      this.bump();
      return { changed: true };
    });
  }

  createFeature({ laneId, month, index, text }, user) {
    return this.tx(() => {
      const t = this._cleanText(text);
      this._assertTarget(laneId, month);
      const ids = this._column(laneId, month);
      const { lastInsertRowid } = this.db
        .prepare('INSERT INTO features(lane_id, month, slot, text) VALUES(?, ?, ?, ?)')
        .run(laneId, month, ids.length, t);
      const id = Number(lastInsertRowid);
      const at = Number.isInteger(index) ? Math.max(0, Math.min(index, ids.length)) : ids.length;
      ids.splice(at, 0, id);
      this._place(ids, laneId, month);
      this._markDirty(laneId);
      this.log(user, 'create', { id, text: t, laneId, month });
      this.bump();
      return { id };
    });
  }

  updateFeatureText(id, value, user) {
    return this.tx(() => {
      const f = this.getFeature(id);
      if (!f) throw httpError(404, '피쳐를 찾을 수 없습니다.');
      const t = this._cleanText(value);
      if (t === f.text) return { changed: false };
      this.db.prepare('UPDATE features SET text = ? WHERE id = ?').run(t, id);
      this._markDirty(f.lane_id);
      this.log(user, 'rename', { id, from: f.text, to: t });
      this.bump();
      return { changed: true };
    });
  }

  deleteFeature(id, user) {
    return this.tx(() => {
      const f = this.getFeature(id);
      if (!f) throw httpError(404, '피쳐를 찾을 수 없습니다.');
      this.db.prepare('DELETE FROM features WHERE id = ?').run(id);
      this._place(this._column(f.lane_id, f.month), f.lane_id, f.month);
      this._markDirty(f.lane_id);
      this.log(user, 'delete', { id, text: f.text, laneId: f.lane_id, month: f.month });
      this.bump();
    });
  }

  // ---- 시트 동기화 보조 ----
  dirtyCount() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM lanes WHERE dirty = 1').get().n;
  }
  conflictCount() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM conflicts').get().n;
  }
  pushableLanes() {
    return this.db
      .prepare(
        'SELECT * FROM lanes WHERE dirty = 1 AND missing = 0 AND id NOT IN (SELECT lane_id FROM conflicts) ORDER BY row_start',
      )
      .all();
  }
  laneRow(id) {
    return this.db.prepare('SELECT * FROM lanes WHERE id = ?').get(id);
  }
  laneFeatures(id) {
    return this.db.prepare('SELECT month, slot, text FROM features WHERE lane_id = ?').all(id);
  }
  // 이 담당자 블록이 시트에서 차지하는 행 수 (다음 담당자 시작 행 전까지, 마지막이면 시트 끝까지)
  laneCapacity(lane, sheetRowCount) {
    const next = this.db
      .prepare('SELECT MIN(row_start) AS r FROM lanes WHERE row_start > ? AND missing = 0')
      .get(lane.row_start).r;
    return (next == null ? sheetRowCount : next) - lane.row_start;
  }
  shiftRows(fromRow, delta) {
    this.db.prepare('UPDATE lanes SET row_start = row_start + ? WHERE row_start >= ? AND missing = 0').run(delta, fromRow);
  }
  markPushed(id, hash) {
    this.db.prepare('UPDATE lanes SET dirty = 0, sheet_hash = ? WHERE id = ?').run(hash, id);
  }

  resolveConflict(laneId, use) {
    return this.tx(() => {
      const c = this.db.prepare('SELECT * FROM conflicts WHERE lane_id = ?').get(laneId);
      if (!c) throw httpError(404, '해결할 충돌이 없습니다.');
      if (use === 'app') {
        // 시트에서 바뀐 내용을 확인한 것으로 기록 → 다음 동기화에서 앱 내용이 시트를 덮어씀
        this.db.prepare('UPDATE lanes SET sheet_hash = ? WHERE id = ?').run(c.sheet_hash, laneId);
      } else if (use === 'sheet') {
        // 앱의 미반영 변경을 버림 → 다음 동기화에서 시트 내용으로 교체됨
        this.db.prepare('UPDATE lanes SET dirty = 0, sheet_hash = NULL WHERE id = ?').run(laneId);
      } else {
        throw httpError(400, "use 값은 'app' 또는 'sheet' 여야 합니다.");
      }
      this.db.prepare('DELETE FROM conflicts WHERE lane_id = ?').run(laneId);
      this.bump();
    });
  }

  conflictLanes() {
    return this.db
      .prepare('SELECT l.id, l.group_name AS "group", l.label FROM conflicts c JOIN lanes l ON l.id = c.lane_id ORDER BY l.position')
      .all();
  }
}

module.exports = { Store, httpError };
