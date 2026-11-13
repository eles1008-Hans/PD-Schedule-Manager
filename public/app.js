(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const state = { me: null, board: null, sync: null, rev: 0, dragging: null, query: '', colW: 176, editing: null };

  try {
    const saved = Number(localStorage.getItem('pdsm.colW'));
    if (saved >= 120 && saved <= 320) state.colW = saved;
  } catch {
    /* 저장소를 쓸 수 없는 환경이면 기본값 사용 */
  }

  // ---------- 작은 도우미 ----------
  function h(tag, props = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
    return el;
  }

  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 4500);
  }

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && url !== '/api/login') {
      showLogin();
      throw new Error('로그인이 필요합니다.');
    }
    if (!res.ok) throw new Error(data.error || `요청 실패 (${res.status})`);
    return data;
  }

  const isAdmin = () => !!state.me && state.me.role === 'admin';
  const dialogOpen = () => !!document.querySelector('dialog[open]');
  const monthLabel = (m) => `${m.year}년 ${m.month}월`;
  const nowKey = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  };

  // 담당자 이름: 줄바꿈으로 이어진 이름에서 "Schedule Sheet" 링크 줄은 뺀다
  function laneName(label) {
    const lines = label.split('\n').map((s) => s.trim()).filter(Boolean);
    const name = lines.filter((l) => !/Schedule Sheet\]?$/i.test(l));
    return (name.length ? name : lines).join(' ');
  }
  const groupName = (g) => g.replace(/\s+/g, ' ').trim();

  // "[MOB][CH05_일반] 이름" → 태그와 제목 분리
  const KNOWN_HUE = { MOB: 22, BOSS: 355, NPC: 150, PC: 215, WP: 270, COMP: 188, FX: 45, RIDE: 95 };
  function parseCard(text) {
    const m = text.match(/^((?:\[[^\]]*\]\s*)+)([\s\S]*)$/);
    const tags = m ? [...m[1].matchAll(/\[([^\]]*)\]/g)].map((x) => x[1].trim()) : [];
    const title = m && m[2].trim() ? m[2].trim() : text;
    const first = tags.find((t) => KNOWN_HUE[t] != null) || tags[0] || '';
    let hue = KNOWN_HUE[first];
    if (hue == null) {
      let n = 0;
      for (const ch of first) n = (n * 31 + ch.charCodeAt(0)) % 360;
      hue = first ? n : 215;
    }
    return { tags, title: m && m[2].trim() ? title : text, hue, tagsOnly: !(m && m[2].trim()) };
  }

  // ---------- 화면 그리기 ----------
  function render() {
    const b = state.board;
    const admin = isAdmin();
    const wrap = $('#boardWrap');
    const keepX = wrap.scrollLeft;
    const keepY = wrap.scrollTop;
    const board = $('#board');
    board.replaceChildren();
    board.style.setProperty('--n', b.months.length);
    board.style.setProperty('--col-w', `${state.colW}px`);
    const cur = nowKey();
    const q = state.query.trim().toLowerCase();

    const yearStart = new Set();
    let prevYear = null;
    b.months.forEach((m) => {
      if (m.year !== prevYear) yearStart.add(m.key);
      prevYear = m.year;
    });

    // 머리글: 연도 / 월
    const note = (b.titles.note || '').split('\n')[0];
    const corner = h('div', { class: 'corner', text: note, title: b.titles.note || '' });
    corner.style.gridRow = '1 / span 2';
    corner.style.gridColumn = '1';
    board.append(corner);
    let i = 0;
    while (i < b.months.length) {
      let j = i;
      while (j + 1 < b.months.length && b.months[j + 1].year === b.months[i].year) j++;
      const y = h('div', { class: 'year yr-start', text: String(b.months[i].year) });
      y.style.gridRow = '1';
      y.style.gridColumn = `${i + 2} / span ${j - i + 1}`;
      board.append(y);
      i = j + 1;
    }
    b.months.forEach((m, idx) => {
      const el = h('div', {
        class: `month${yearStart.has(m.key) ? ' yr-start' : ''}${m.key === cur ? ' now' : ''}`,
        text: `${m.month}월`,
        'data-key': m.key,
      });
      el.style.gridRow = '2';
      el.style.gridColumn = String(idx + 2);
      board.append(el);
    });

    // 구간 / 마일스톤 / 마감
    const infoRow = (kind, title, cls) => {
      const map = b.header[kind] || {};
      if (!Object.keys(map).length) return;
      board.append(h('div', { class: 'row-title', text: title }));
      b.months.forEach((m) => {
        const t = map[m.key] || '';
        const extra = kind === 'band' ? `band-cell${/DEAD/i.test(t) ? ' dead' : ''}` : `note-cell ${cls}`;
        board.append(h('div', { class: `${extra}${yearStart.has(m.key) ? ' yr-start' : ''}`, text: t }));
      });
    };
    infoRow('band', '구간', '');
    infoRow('milestone', (b.titles.milestone || '마일스톤').split('\n')[0], 'milestone');
    infoRow('deadline', (b.titles.deadline || '마감').split('\n')[0], 'deadline');

    // 담당자(행)
    let prevGroup = null;
    for (const lane of b.lanes) {
      if (lane.group !== prevGroup) {
        board.append(h('div', { class: 'group' }, h('span', { text: groupName(lane.group) || '(그룹 없음)' })));
        prevGroup = lane.group;
      }
      const label = h(
        'div',
        { class: 'label' },
        h('div', { class: 'name', text: laneName(lane.label) }),
        h('div', { class: 'sub', text: `${lane.features.length}개` }),
        lane.conflict ? h('span', { class: 'tag bad', text: '충돌' }) : null,
        lane.dirty && !lane.conflict ? h('span', { class: 'tag', text: '시트 반영 대기' }) : null,
        lane.missing ? h('span', { class: 'tag bad', text: '시트에 없음' }) : null,
      );
      board.append(label);

      const byMonth = new Map();
      for (const f of lane.features) {
        if (!byMonth.has(f.month)) byMonth.set(f.month, []);
        byMonth.get(f.month).push(f);
      }
      for (const m of b.months) {
        const cell = h('div', {
          class: `cell${yearStart.has(m.key) ? ' yr-start' : ''}${m.key === cur ? ' now' : ''}`,
          'data-lane': String(lane.id),
          'data-month': m.key,
        });
        for (const f of byMonth.get(m.key) || []) cell.append(cardEl(f, lane, q));
        if (admin) {
          cell.append(
            h('button', {
              class: 'add',
              type: 'button',
              title: `${laneName(lane.label)} · ${monthLabel(m)}에 피쳐 추가`,
              'aria-label': '피쳐 추가',
              text: '+',
              onclick: () => openEdit({ lane, month: m.key }),
            }),
          );
          cell.addEventListener('dragover', onDragOver);
          cell.addEventListener('dragleave', onDragLeave);
          cell.addEventListener('drop', onDrop);
        }
        board.append(cell);
      }
    }

    wrap.scrollLeft = keepX;
    wrap.scrollTop = keepY;
    renderSync();
  }

  function cardEl(f, lane, q) {
    const p = parseCard(f.text);
    const admin = isAdmin();
    const card = h(
      'div',
      {
        class: `card${admin ? ' can-drag' : ''}${q && !f.text.toLowerCase().includes(q) ? ' dim' : ''}`,
        'data-id': String(f.id),
        title: f.text,
        tabindex: admin ? '0' : null,
        draggable: admin ? 'true' : null,
      },
      p.tags.length && !p.tagsOnly ? h('span', { class: 'tags', text: p.tags.join(' · ') }) : null,
      h('span', { text: p.tagsOnly ? f.text : p.title }),
    );
    card.style.setProperty('--h', String(p.hue));
    if (admin) {
      card.addEventListener('dragstart', (e) => {
        state.dragging = f.id;
        e.dataTransfer.setData('text/plain', String(f.id));
        e.dataTransfer.effectAllowed = 'move';
        requestAnimationFrame(() => card.classList.add('dragging'));
        document.body.classList.add('is-dragging');
      });
      card.addEventListener('dragend', () => {
        state.dragging = null;
        card.classList.remove('dragging');
        document.body.classList.remove('is-dragging');
        clearDrop();
      });
      card.addEventListener('dblclick', () => openEdit({ feature: f, lane, month: f.month }));
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') openEdit({ feature: f, lane, month: f.month });
      });
    }
    return card;
  }

  // ---------- 드래그 앤 드롭 ----------
  function insertIndex(cell, clientY) {
    const cards = [...cell.querySelectorAll('.card:not(.dragging)')];
    let idx = 0;
    for (const c of cards) {
      const r = c.getBoundingClientRect();
      if (r.top + r.height / 2 < clientY) idx++;
    }
    return idx;
  }

  function clearDrop() {
    document.querySelectorAll('.cell.drop').forEach((c) => c.classList.remove('drop'));
    document.querySelectorAll('.drop-line').forEach((l) => l.remove());
  }

  function onDragOver(e) {
    if (state.dragging == null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const cell = e.currentTarget;
    const idx = insertIndex(cell, e.clientY);
    document.querySelectorAll('.cell.drop').forEach((c) => c !== cell && c.classList.remove('drop'));
    cell.classList.add('drop');
    let line = cell.querySelector('.drop-line');
    if (!line) line = h('div', { class: 'drop-line' });
    const cards = [...cell.querySelectorAll('.card:not(.dragging)')];
    if (idx < cards.length) cards[idx].before(line);
    else cell.querySelector('.add') ? cell.querySelector('.add').before(line) : cell.append(line);
  }

  function onDragLeave(e) {
    if (!e.currentTarget.contains(e.relatedTarget)) {
      e.currentTarget.classList.remove('drop');
      e.currentTarget.querySelectorAll('.drop-line').forEach((l) => l.remove());
    }
  }

  async function onDrop(e) {
    e.preventDefault();
    const cell = e.currentTarget;
    const id = state.dragging;
    const index = insertIndex(cell, e.clientY);
    clearDrop();
    if (id == null) return;
    try {
      await api('POST', `/api/features/${id}/move`, { laneId: Number(cell.dataset.lane), month: cell.dataset.month, index });
    } catch (err) {
      toast(err.message);
    }
    state.dragging = null;
    await load();
  }

  // 드래그 중 가장자리에 닿으면 자동 스크롤 (월 열이 많아 필요)
  $('#boardWrap').addEventListener('dragover', (e) => {
    if (state.dragging == null) return;
    const wrap = e.currentTarget;
    const r = wrap.getBoundingClientRect();
    const edge = 70;
    const speed = 26;
    if (e.clientX > r.right - edge) wrap.scrollLeft += speed;
    else if (e.clientX < r.left + edge + 188) wrap.scrollLeft -= speed;
    if (e.clientY > r.bottom - edge) wrap.scrollTop += speed;
    else if (e.clientY < r.top + edge + 56) wrap.scrollTop -= speed;
  });

  // ---------- 피쳐 추가 / 수정 / 삭제 ----------
  function openEdit({ feature, lane, month }) {
    const b = state.board;
    state.editing = feature ? feature.id : null;
    $('#editTitle').textContent = feature ? '피쳐 수정 · 이동' : '피쳐 추가';
    $('#editText').value = feature ? feature.text : '';
    $('#editErr').textContent = '';
    $('#editDelete').hidden = !feature;
    const laneSel = $('#editLane');
    laneSel.replaceChildren(
      ...b.lanes.map((l) => h('option', { value: String(l.id), text: `${groupName(l.group)} · ${laneName(l.label)}` })),
    );
    laneSel.value = String(lane.id);
    const monthSel = $('#editMonth');
    monthSel.replaceChildren(...b.months.map((m) => h('option', { value: m.key, text: monthLabel(m) })));
    monthSel.value = month;
    $('#editDlg').showModal();
    $('#editText').focus();
  }

  $('#editCancel').addEventListener('click', () => $('#editDlg').close());
  $('#editForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $('#editText').value.trim();
    const laneId = Number($('#editLane').value);
    const month = $('#editMonth').value;
    try {
      if (state.editing == null) {
        await api('POST', '/api/features', { laneId, month, text });
      } else {
        const f = findFeature(state.editing);
        if (f && f.text !== text) await api('PATCH', `/api/features/${state.editing}`, { text });
        if (f && (f.laneId !== laneId || f.month !== month)) {
          await api('POST', `/api/features/${state.editing}/move`, { laneId, month });
        }
      }
      $('#editDlg').close();
      await load();
    } catch (err) {
      $('#editErr').textContent = err.message;
    }
  });
  $('#editDelete').addEventListener('click', async () => {
    if (state.editing == null || !confirm('이 피쳐를 삭제할까요?')) return;
    try {
      await api('DELETE', `/api/features/${state.editing}`);
      $('#editDlg').close();
      await load();
    } catch (err) {
      $('#editErr').textContent = err.message;
    }
  });

  function findFeature(id) {
    for (const l of state.board.lanes) {
      const f = l.features.find((x) => x.id === id);
      if (f) return { ...f, laneId: l.id };
    }
    return null;
  }

  // ---------- 시트 동기화 ----------
  function renderSync() {
    const s = state.sync;
    if (!s) return;
    const sw = $('#syncSwitch');
    const text = $('#syncText');
    sw.setAttribute('aria-checked', String(s.enabled));
    sw.disabled = !isAdmin() || (!s.configured && !s.enabled);
    sw.title = !s.configured
      ? '서버에 구글 시트 연동 설정이 없습니다.'
      : isAdmin()
        ? s.enabled
          ? '클릭하면 동기화를 끕니다.'
          : '클릭하면 구글 시트와 동기화를 켭니다.'
        : '관리자만 바꿀 수 있습니다.';
    $('#syncNow').hidden = !(isAdmin() && s.enabled);
    $('#syncNow').disabled = !!s.running;

    const parts = [];
    let bad = false;
    if (!s.configured) parts.push('연동 설정 필요');
    else if (s.running) parts.push('동기화 중…');
    else if (s.last && s.last.error) {
      parts.push(`오류: ${s.last.error}`);
      bad = true;
    } else if (s.enabled && s.last) {
      parts.push(`마지막 동기화 ${new Date(s.last.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}`);
    } else if (s.enabled) parts.push('대기 중');
    else parts.push('OFF · 앱에서의 변경은 시트에 쓰지 않습니다');
    if (s.pendingLanes) parts.push(`반영 대기 ${s.pendingLanes}행`);
    text.textContent = parts.join(' · ');
    text.title = text.textContent;
    text.classList.toggle('bad', bad);

    const cb = $('#conflictBtn');
    cb.hidden = !s.conflicts.length;
    cb.textContent = `충돌 ${s.conflicts.length}건`;
  }

  $('#syncSwitch').addEventListener('click', async () => {
    try {
      state.sync = await api('PUT', '/api/sync', { enabled: !state.sync.enabled });
      renderSync();
      await load();
    } catch (err) {
      toast(err.message);
    }
  });
  $('#syncNow').addEventListener('click', async () => {
    try {
      const { result, status } = await api('POST', '/api/sync/run', {});
      state.sync = status;
      if (result.error) toast(`동기화 오류: ${result.error}`);
      await load();
    } catch (err) {
      toast(err.message);
    }
  });
  $('#conflictBtn').addEventListener('click', () => {
    const list = $('#conflictList');
    list.replaceChildren(
      ...state.sync.conflicts.map((c) =>
        h(
          'li',
          {},
          h('span', { class: 'who-lane', text: `${groupName(c.group)} · ${laneName(c.label)}` }),
          h('button', { type: 'button', text: '앱 내용 유지', onclick: () => resolve(c.id, 'app') }),
          h('button', { type: 'button', text: '시트 내용 사용', onclick: () => resolve(c.id, 'sheet') }),
        ),
      ),
    );
    $('#conflictDlg').showModal();
  });
  $('#conflictClose').addEventListener('click', () => $('#conflictDlg').close());
  async function resolve(laneId, use) {
    if (use === 'sheet' && !confirm('앱에서 바꾼 이 담당자의 미반영 변경이 사라집니다. 시트 내용을 사용할까요?')) return;
    try {
      state.sync = await api('POST', '/api/sync/resolve', { laneId, use });
      await load();
      if (!state.sync.conflicts.length) $('#conflictDlg').close();
      else $('#conflictBtn').click();
    } catch (err) {
      toast(err.message);
    }
  }

  // ---------- 불러오기 / 로그인 ----------
  async function load() {
    const data = await api('GET', '/api/board');
    state.board = data;
    state.sync = data.sync;
    state.rev = data.rev;
    render();
  }

  function scrollToNow() {
    const wrap = $('#boardWrap');
    const months = state.board.months;
    if (!months.length) return;
    const cur = nowKey();
    const key = months.find((m) => m.key >= cur)?.key || months[months.length - 1].key;
    const el = document.querySelector(`.month[data-key="${key}"]`);
    if (el) wrap.scrollLeft = Math.max(0, el.offsetLeft - 188 - 8);
  }

  function showLogin() {
    state.me = null;
    $('#app').hidden = true;
    $('#login').hidden = false;
    $('#loginPass').value = '';
    $('#loginUser').focus();
  }

  async function showApp() {
    $('#login').hidden = true;
    $('#app').hidden = false;
    $('#who').textContent = `${state.me.username} (${isAdmin() ? '관리자' : '조회'})`;
    await load();
    scrollToNow();
  }

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#loginErr').textContent = '';
    try {
      const r = await api('POST', '/api/login', { username: $('#loginUser').value, password: $('#loginPass').value });
      state.me = r.user;
      await showApp();
    } catch (err) {
      $('#loginErr').textContent = err.message;
    }
  });
  $('#logout').addEventListener('click', async () => {
    try {
      await api('POST', '/api/logout', {});
    } catch {
      /* 이미 로그아웃된 경우 */
    }
    showLogin();
  });

  $('#search').addEventListener('input', (e) => {
    state.query = e.target.value;
    if (state.board) render();
  });
  const zoom = (delta) => {
    state.colW = Math.max(120, Math.min(320, state.colW + delta));
    $('#board').style.setProperty('--col-w', `${state.colW}px`);
    try {
      localStorage.setItem('pdsm.colW', String(state.colW));
    } catch {
      /* 무시 */
    }
  };
  $('#zoomIn').addEventListener('click', () => zoom(24));
  $('#zoomOut').addEventListener('click', () => zoom(-24));
  $('#goNow').addEventListener('click', scrollToNow);

  // 다른 관리자가 바꾼 내용을 5초마다 확인
  setInterval(async () => {
    if (!state.me || document.hidden || state.dragging != null || dialogOpen()) return;
    try {
      const r = await api('GET', '/api/rev');
      state.sync = r.sync;
      if (r.rev !== state.rev) await load();
      else renderSync();
    } catch {
      /* 일시적인 네트워크 오류는 다음 주기에 재시도 */
    }
  }, 5000);

  (async () => {
    try {
      state.me = (await api('GET', '/api/me')).user;
      await showApp();
    } catch {
      /* api() 가 로그인 화면을 띄움 */
    }
  })();
})();
