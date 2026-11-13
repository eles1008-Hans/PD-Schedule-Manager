'use strict';
// 구글 시트를 CSV로 내보낸 파일에서 로드맵을 가져와 DB를 새로 채웁니다.
//   npm run import -- <CSV 파일> [탭 이름]
// 전체 시트 내보내기 파일("## Sheet name: ..." 구분)이면 탭 이름(기본: 캐릭터 컨셉 로드맵)으로 해당 구간만 읽습니다.
const fs = require('node:fs');
const path = require('node:path');
const { parseCSV, extractSection } = require('../server/csv');
const { parseGrid } = require('../server/importer');
const { Store } = require('../server/db');

const [file, tab = '캐릭터 컨셉 로드맵'] = process.argv.slice(2);
if (!file) {
  console.error('사용법: npm run import -- <CSV 파일> [탭 이름]');
  process.exit(1);
}
let text = fs.readFileSync(file, 'utf8');
if (text.includes('## Sheet name: ')) {
  const section = extractSection(text, tab);
  if (section == null) {
    console.error(`'${tab}' 탭을 파일에서 찾지 못했습니다.`);
    process.exit(1);
  }
  text = section;
}

const parsed = parseGrid(parseCSV(text));
const dataDir = path.resolve(process.env.DATA_DIR || './data');
const store = new Store(path.join(dataDir, 'roadmap.db'));
const stats = store.importParsed(parsed, { replace: true });
const features = parsed.lanes.reduce((n, l) => n + l.features.length, 0);
console.log(`가져오기 완료: 담당자(행) ${parsed.lanes.length}개, 피쳐 ${features}개, 월 ${parsed.months.length}개`);
console.log(`기간: ${parsed.months[0].key} ~ ${parsed.months[parsed.months.length - 1].key}`);
for (const w of parsed.warnings) console.warn(`주의: ${w}`);
store.close();
void stats;
