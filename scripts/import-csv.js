'use strict';
// 구글 시트를 CSV로 내보낸 파일에서 로드맵을 가져와 각 보드(탭)를 새로 채웁니다.
//   npm run import -- <CSV 파일>              로드맵 탭 7개를 모두 가져옴
//   npm run import -- <CSV 파일> <탭 이름>    한 탭만 (탭 이름, 보드 이름, 보드 id 중 하나)
// 전체 시트 내보내기 파일("## Sheet name: ..." 구분)에서 탭별 구간을 읽습니다.
const fs = require('node:fs');
const path = require('node:path');
const { parseCSV, extractSection } = require('../server/csv');
const { parseGrid } = require('../server/importer');
const { Store } = require('../server/db');
const { BOARD_DEFS } = require('../server/boards');

const [file, which = 'all'] = process.argv.slice(2);
if (!file) {
  console.error('사용법: npm run import -- <CSV 파일> [탭 이름|all]');
  process.exit(1);
}
const defs = which === 'all' ? BOARD_DEFS : BOARD_DEFS.filter((d) => [d.tab, d.title, d.id].includes(which));
if (!defs.length) {
  console.error(`'${which}' 에 해당하는 로드맵 탭이 없습니다. (${BOARD_DEFS.map((d) => d.tab).join(', ')})`);
  process.exit(1);
}

const text = fs.readFileSync(file, 'utf8');
const hasSections = text.includes('## Sheet name: ');
const boardsDir = path.join(path.resolve(process.env.DATA_DIR || './data'), 'boards');
let failed = 0;

for (const def of defs) {
  let body = text;
  if (hasSections) {
    body = extractSection(text, def.tab);
    if (body == null) {
      console.error(`✗ '${def.tab}' 탭을 파일에서 찾지 못했습니다.`);
      failed++;
      continue;
    }
  } else if (defs.length > 1) {
    console.error('탭 구분이 없는 CSV 입니다. 탭 이름을 지정해 주세요: npm run import -- <CSV 파일> <탭 이름>');
    process.exit(1);
  }
  try {
    const parsed = parseGrid(parseCSV(body));
    const store = new Store(path.join(boardsDir, `${def.id}.db`));
    store.importParsed(parsed, { replace: true });
    store.close();
    const features = parsed.lanes.reduce((n, l) => n + l.features.length, 0);
    console.log(
      `✓ ${def.tab}: 담당자(행) ${parsed.lanes.length}개, 피쳐 ${features}개, ` +
        `${parsed.months[0].key} ~ ${parsed.months[parsed.months.length - 1].key}`,
    );
    for (const w of parsed.warnings) console.warn(`  주의: ${w}`);
  } catch (err) {
    console.error(`✗ ${def.tab}: ${err.message}`);
    failed++;
  }
}
process.exit(failed ? 1 : 0);
