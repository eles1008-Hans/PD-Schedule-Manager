'use strict';
// 보드 = 로드맵 탭 하나. 탭마다 독립된 DB 파일(data/boards/<id>.db)과 동기화 서비스를 가진다.
// 사용자 계정과 구글 연동 정보는 앱 DB(data/roadmap.db)에 따로 둔다.
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('./db');
const { SyncService } = require('./sync');
const { clientFromEnv } = require('./gsheets');

// 부서별 스케줄 로드맵 탭 7개 (현황판 [PC] [NPC] 등은 나중에 별도 기능으로 추가)
const BOARD_DEFS = Object.freeze([
  { id: 'char-concept', tab: '캐릭터 컨셉 로드맵', title: '캐릭터 컨셉' },
  { id: 'char-3d', tab: '캐릭터 3D 로드맵', title: '캐릭터 3D' },
  { id: 'bg-concept', tab: '배경 컨셉 로드맵', title: '배경 컨셉' },
  { id: 'bg-3d', tab: '배경 3D 로드맵', title: '배경 3D' },
  { id: 'rigging', tab: '리깅 로드맵', title: '리깅' },
  { id: 'world-anim', tab: '월드애니 로드맵', title: '월드애니' },
  { id: 'fx', tab: 'FX 로드맵', title: 'FX' },
]);

class Boards {
  constructor(list) {
    this.list = list;
    this.byId = new Map(list.map((b) => [b.id, b]));
  }

  get(id) {
    return this.byId.get(id) || null;
  }

  get default() {
    return this.list[0];
  }

  // 구글 연동/시트 설정이 바뀌면 모든 보드가 새 설정으로 클라이언트를 다시 만든다.
  resetClients() {
    for (const b of this.list) b.sync.resetClient();
  }

  // 탭 목록 화면용 요약 (가볍게: 담당자 줄/카드 본문은 포함하지 않음)
  summary() {
    return this.list.map((b) => {
      const s = b.sync.status();
      return {
        id: b.id,
        title: b.title,
        tab: b.tab,
        rev: b.store.rev(),
        sync: {
          configured: s.configured,
          enabled: s.enabled,
          running: s.running,
          pendingLanes: s.pendingLanes,
          conflicts: s.conflicts.length,
          error: s.last && s.last.error ? s.last.error : null,
          lastAt: s.last ? s.last.at : null,
        },
      };
    });
  }

  // 구글 호출이 한꺼번에 몰리지 않도록 보드마다 시작 시점을 어긋나게 한다.
  start(intervalMs = 30000) {
    this.list.forEach((b, i) => b.sync.start(Math.round((i * intervalMs) / this.list.length)));
  }

  close() {
    for (const b of this.list) {
      b.sync.stop();
      b.store.close();
    }
  }
}

// 테스트/단일 보드용: 이미 만든 store + sync 를 보드 하나로 감싼다.
function singleBoard(store, sync) {
  return new Boards([{ id: 'default', title: '로드맵', tab: '', store, sync }]);
}

// 예전(탭 하나) 버전의 data/roadmap.db 에 로드맵 내용이 있으면 첫 번째 보드로 옮겨 온다.
function migrateLegacy(appStore, firstBoard, boardsDir) {
  const target = path.join(boardsDir, `${firstBoard.id}.db`);
  if (fs.existsSync(target)) return false;
  const n = appStore.db.prepare('SELECT COUNT(*) AS n FROM lanes').get().n;
  if (!n) return false;
  fs.mkdirSync(boardsDir, { recursive: true });
  appStore.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  fs.copyFileSync(appStore.file, target);
  return true;
}

function openBoards({ dataDir, appStore, google, defs = BOARD_DEFS, env = process.env }) {
  const boardsDir = path.join(dataDir, 'boards');
  if (appStore && appStore.file) migrateLegacy(appStore, defs[0], boardsDir);
  const list = defs.map((def) => {
    const store = new Store(path.join(boardsDir, `${def.id}.db`));
    const sync = new SyncService(store, {
      clientFactory: () => (google && google.client({ tab: def.tab })) || clientFromEnv(env, def.tab),
      intervalMs: Number(env.SYNC_INTERVAL_SEC || 30) * 1000,
    });
    return { ...def, store, sync };
  });
  return new Boards(list);
}

module.exports = { BOARD_DEFS, Boards, singleBoard, openBoards, migrateLegacy };
