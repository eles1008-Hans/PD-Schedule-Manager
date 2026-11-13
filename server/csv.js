'use strict';

// RFC 4180 방식 CSV 파서 (따옴표 안의 줄바꿈, "" 이스케이프 지원)
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// "## Sheet name: <이름>" 으로 구분된 전체 시트 내보내기 파일에서 한 탭의 CSV 본문을 꺼낸다.
function extractSection(text, sheetName) {
  const marker = `## Sheet name: ${sheetName}`;
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.replace(/\r$/, '') === marker);
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## Sheet name: ')) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join('\n');
}

module.exports = { parseCSV, extractSection };
