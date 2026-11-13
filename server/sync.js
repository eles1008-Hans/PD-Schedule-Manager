'use strict';
const { parseGrid, hashLane } = require('./importer');
const { httpError } = require('./db');

// 월 열 중 연속된 열끼리 묶는다. (연도 사이 빈 구분 열은 건드리지 않기 위해)
function contiguousRuns(months) {
  const sorted = [...months].sort((a, b) => a.col - b.col);
  const runs = [];
  for (const m of sorted) {
    const last = runs[runs.length - 1];
    if (last && m.col === last.lastCol + 1) {
      last.lastCol = m.col;
      last.keys.push(m.key);
    } else {
      runs.push({ firstCol: m.col, lastCol: m.col, keys: [m.key] });
    }
  }
  return runs;
}

class SyncService {
  constructor(store, { clientFactory, intervalMs = 30000, debounceMs = 3000 } = {}) {
    this.store = store;
    this.clientFactory = clientFactory || (() => null);
    this.intervalMs = intervalMs;
    this.debounceMs = debounceMs;
    this.running = false;
    this._client = undefined;
    this._timer = null;
    this._debounce = null;
  }

  client() {
    if (this._client === undefined) this._client = this.clientFactory() || null;
    return this._client;
  }

  configured() {
    try {
      return !!this.client();
    } catch {
      return false;
    }
  }

  enabled() {
    return this.store.getMeta('sync_enabled', '0') === '1';
  }

  status() {
    return {
      configured: this.configured(),
      enabled: this.enabled(),
      running: this.running,
      pendingLanes: this.store.dirtyCount(),
      conflicts: this.store.conflictLanes(),
      last: this.store.getJson('sync_last', null),
    };
  }

  setEnabled(on, user) {
    if (on && !this.configured()) {
      throw httpError(
        400,
        '구글 시트 연동이 설정되지 않았습니다. 서버의 GOOGLE_SHEET_ID / GOOGLE_SERVICE_ACCOUNT_FILE 설정을 확인해 주세요.',
      );
    }
    this.store.setMeta('sync_enabled', on ? '1' : '0');
    this.store.log(user, on ? 'sync_on' : 'sync_off', null);
    this.store.bump();
    if (on) this.schedule(0);
  }

  // 변경이 생긴 뒤 잠시 모았다가 한 번에 반영
  schedule(delay = this.debounceMs) {
    if (!this.enabled()) return;
    clearTimeout(this._debounce);
    this._debounce = setTimeout(() => {
      this.run('change').catch(() => {});
    }, delay);
    this._debounce.unref();
  }

  start() {
    this._timer = setInterval(() => {
      if (this.enabled() && !this.running) this.run('interval').catch(() => {});
    }, this.intervalMs);
    this._timer.unref();
  }

  stop() {
    clearInterval(this._timer);
    clearTimeout(this._debounce);
  }

  async run(reason = 'manual') {
    const client = this.client();
    if (!client) throw httpError(400, '구글 시트 연동이 설정되지 않았습니다.');
    if (this.running) return { skipped: true };
    this.running = true;
    const result = { at: new Date().toISOString(), reason, pull: null, push: null, error: null };
    try {
      result.pull = await this.pull(client);
      result.push = await this.push(client);
    } catch (err) {
      result.error = err.message;
    } finally {
      this.running = false;
      const prev = this.store.getJson('sync_last', null);
      this.store.setJson('sync_last', result);
      const changed =
        (result.pull && (result.pull.created || result.pull.updated || result.pull.missing || result.pull.conflicts)) ||
        (result.push && result.push.lanes) ||
        (prev && prev.error) !== result.error;
      if (changed) this.store.bump();
    }
    return result;
  }

  async pull(client) {
    const meta = await client.getMeta();
    const grid = await client.readGrid(meta);
    const parsed = parseGrid(grid, this.store.getJson('layout', {}));
    parsed.rowCount = Math.max(parsed.rowCount, 0);
    return this.store.applySheet(parsed);
  }

  async push(client) {
    const lanes = this.store.pushableLanes();
    if (!lanes.length) return { lanes: 0, insertedRows: 0 };
    const meta = await client.getMeta();
    let rowCount = meta.rowCount;
    const runs = contiguousRuns(this.store.timelineMonths());
    let pushed = 0;
    let insertedRows = 0;

    for (const { id } of lanes) {
      const lane = this.store.laneRow(id); // 앞선 행 삽입으로 위치가 바뀌었을 수 있어 다시 읽음
      const feats = this.store.laneFeatures(id);
      const needed = Math.max(1, ...feats.map((f) => f.slot + 1));
      let cap = this.store.laneCapacity(lane, rowCount);

      if (needed > cap) {
        const at = lane.row_start + cap;
        const delta = needed - cap;
        if (at >= rowCount) await client.appendRows(meta.gid, delta);
        else await client.insertRows(meta.gid, at, delta);
        this.store.shiftRows(at, delta);
        rowCount += delta;
        insertedRows += delta;
        cap = needed;
      }

      const cells = new Map(feats.map((f) => [`${f.month}|${f.slot}`, f.text]));
      const data = runs.map((run) => ({
        range: client.a1(run.firstCol, lane.row_start, run.lastCol, lane.row_start + cap - 1),
        values: Array.from({ length: cap }, (_, r) => run.keys.map((k) => cells.get(`${k}|${r}`) || '')),
      }));
      await client.writeValues(data);
      this.store.markPushed(id, hashLane(feats));
      pushed++;
    }
    return { lanes: pushed, insertedRows };
  }
}

module.exports = { SyncService, contiguousRuns };
