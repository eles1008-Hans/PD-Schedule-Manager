(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const state = { me: null, boards: [], boardId: null, board: null, sync: null, rev: 0, dragging: null, query: '', colW: 176, editing: null };

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

  // 현재 보드(탭)의 API 주소: /api/boards/<id>/...
  const B = (path) => `/api/boards/${encodeURIComponent(state.boardId)}${path}`;
  const LAST_TAB_KEY = 'pdsm.board';

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
    if (res.status === 403 && data.code === 'password_change_required') {
      if (state.me) state.me.mustChange = true;
      openPw(true);
      throw new Error(data.error);
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
    // 본문 앞의 안내 줄(마일 스톤, 이슈 정리, 피쳐 마감 …)은 탭마다 이름과 개수가 다르다
    const infoRows = b.titles.rows || [
      { kind: 'milestone', label: b.titles.milestone || '마일스톤' },
      { kind: 'deadline', label: b.titles.deadline || '마감' },
    ];
    for (const r of infoRows) {
      const label = r.label || '';
      const cls = /마감/.test(label) ? 'deadline' : /마일/.test(label) ? 'milestone' : 'issue';
      infoRow(r.kind, label.split('\n')[0] || '안내', cls);
    }

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
      await api('POST', B(`/features/${id}/move`), { laneId: Number(cell.dataset.lane), month: cell.dataset.month, index });
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
        await api('POST', B('/features'), { laneId, month, text });
      } else {
        const f = findFeature(state.editing);
        if (f && f.text !== text) await api('PATCH', B(`/features/${state.editing}`), { text });
        if (f && (f.laneId !== laneId || f.month !== month)) {
          await api('POST', B(`/features/${state.editing}/move`), { laneId, month });
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
      await api('DELETE', B(`/features/${state.editing}`));
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
      // 스위치는 모든 탭의 동기화를 한꺼번에 켜고 끈다
      const r = await api('PUT', '/api/sync/all', { enabled: !state.sync.enabled });
      state.boards = r.boards;
      state.sync = await api('GET', B('/sync'));
      renderTabs();
      renderSync();
      await load();
    } catch (err) {
      toast(err.message);
    }
  });
  $('#syncNow').addEventListener('click', async () => {
    try {
      const { result, status } = await api('POST', B('/sync/run'), {});
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
      state.sync = await api('POST', B('/sync/resolve'), { laneId, use });
      await load();
      if (!state.sync.conflicts.length) $('#conflictDlg').close();
      else $('#conflictBtn').click();
    } catch (err) {
      toast(err.message);
    }
  }

  // ---------- 불러오기 / 로그인 ----------
  async function load() {
    const data = await api('GET', B('/board'));
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

  // ---------- 구글 계정 연동 ----------
  function renderGoogle() {
    const g = state.google;
    const st = $('#gStatus');
    st.classList.remove('bad', 'ok');
    if (!g.oauthConfigured) {
      st.textContent = '구글 OAuth 클라이언트가 아직 설정되지 않았어요. 아래 설정을 먼저 진행해 주세요.';
      st.classList.add('bad');
    } else if (!g.linked) {
      st.textContent = '아직 구글 계정이 연동되지 않았어요. "연동 신청"을 눌러 구글 계정으로 승인해 주세요.';
    } else if (g.needsRelink) {
      st.textContent = `연동이 끊겼어요 (${g.email || '구글 계정'}). 다시 연동 신청해 주세요.`;
      st.classList.add('bad');
    } else {
      st.textContent = `연동됨: ${g.email || '구글 계정'}`;
      st.classList.add('ok');
    }
    $('#gSetup').open = !g.oauthConfigured;
    $('#gRedirect').textContent = g.redirectUri;
    $('#gOrigin').textContent = new URL(g.redirectUri).origin;
    $('#gLink').textContent = g.linked ? '다시 연동 신청' : '구글 계정 연동 신청';
    $('#gLink').disabled = !g.oauthConfigured;
    $('#gUnlink').hidden = !g.linked;
  }
  async function openGoogle() {
    $('#gErr').textContent = '';
    try {
      state.google = await api('GET', '/api/google');
    } catch (err) {
      toast(err.message);
      return;
    }
    const s = state.google.sheet;
    $('#gSheetUrl').value = s.id ? `https://docs.google.com/spreadsheets/d/${s.id}` : '';
    renderGoogle();
    if (!$('#googleDlg').open) $('#googleDlg').showModal();
  }
  async function saveSheet() {
    const url = $('#gSheetUrl').value.trim();
    if (!url) return; // 주소를 비워 두면 저장하지 않음
    state.google = await api('PUT', '/api/google/sheet', { sheet: url });
    state.sync = await api('GET', B('/sync'));
    renderSync();
    renderGoogle();
  }
  $('#googleBtn').addEventListener('click', openGoogle);
  $('#gClose').addEventListener('click', () => $('#googleDlg').close());
  $('#gSheetForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#gErr').textContent = '';
    try {
      await saveSheet();
      toast('시트 설정을 저장했어요.');
    } catch (err) {
      $('#gErr').textContent = err.message;
    }
  });
  // "연동 신청": 시트 주소를 저장한 뒤 구글 동의 화면으로 이동한다.
  $('#gLink').addEventListener('click', async () => {
    $('#gErr').textContent = '';
    try {
      await saveSheet();
      const { url } = await api('POST', '/api/google/link', {});
      location.href = url;
    } catch (err) {
      $('#gErr').textContent = err.message;
    }
  });
  $('#gUnlink').addEventListener('click', async () => {
    if (!confirm('구글 계정 연동을 해제할까요? 시트 동기화도 꺼집니다.')) return;
    try {
      state.google = await api('POST', '/api/google/unlink', {});
      state.sync = await api('GET', B('/sync'));
      renderSync();
      renderGoogle();
      toast('구글 계정 연동을 해제했어요.');
    } catch (err) {
      $('#gErr').textContent = err.message;
    }
  });
  // 구글 동의 화면에서 돌아온 결과 (/?google=linked 등)
  function handleGoogleReturn() {
    const q = new URLSearchParams(location.search);
    const r = q.get('google');
    if (!r) return;
    history.replaceState(null, '', location.pathname);
    if (r === 'linked') {
      toast('구글 계정을 연동했어요. 시트 주소를 확인하고 "시트 동기화"를 켜 주세요.');
      openGoogle();
    } else if (r === 'denied') {
      toast('구글 연동이 취소되었어요.');
    } else {
      toast(q.get('msg') || '구글 연동에 실패했어요. 다시 시도해 주세요.');
    }
  }

  // ---------- 탭(보드) ----------
  function renderTabs() {
    $('#tabs').replaceChildren(
      ...state.boards.map((b) => {
        const active = b.id === state.boardId;
        const issue = b.sync.conflicts ? `충돌 ${b.sync.conflicts}` : b.sync.error ? '오류' : '';
        return h(
          'button',
          {
            type: 'button',
            role: 'tab',
            class: `tab${active ? ' active' : ''}`,
            'aria-selected': String(active),
            title: b.sync.error || b.tab,
            onclick: () => switchBoard(b.id),
          },
          h('span', { text: b.title }),
          issue ? h('span', { class: 'tab-badge', text: issue }) : null,
        );
      }),
    );
  }
  async function loadBoards() {
    state.boards = (await api('GET', '/api/boards')).boards;
    if (!state.boards.some((b) => b.id === state.boardId)) {
      let saved = null;
      try {
        saved = localStorage.getItem(LAST_TAB_KEY);
      } catch {
        /* 저장소를 쓸 수 없으면 첫 탭 */
      }
      state.boardId = state.boards.some((b) => b.id === saved) ? saved : state.boards[0].id;
    }
    renderTabs();
  }
  async function switchBoard(id) {
    if (id === state.boardId) return;
    state.boardId = id;
    state.board = null;
    try {
      localStorage.setItem(LAST_TAB_KEY, id);
    } catch {
      /* 무시 */
    }
    renderTabs();
    try {
      await load();
      scrollToNow();
    } catch (err) {
      toast(err.message);
    }
  }

  // ---------- 비밀번호 변경 ----------
  // forced=true: 첫 로그인 직후. 닫을 수 없고, 변경해야 보드를 볼 수 있다.
  function openPw(forced) {
    state.pwForced = forced;
    const haveCurrent = !!(forced && state.loginPass);
    $('#pwTitle').textContent = forced ? '비밀번호 설정' : '비밀번호 변경';
    $('#pwHint').textContent = forced
      ? '처음 로그인하셨어요. 사용할 새 비밀번호를 설정해 주세요. (8자 이상, 아이디와 다르게)'
      : '';
    $('#pwCancel').hidden = forced;
    $('#pwLogout').hidden = !forced;
    $('#pwCurRow').hidden = haveCurrent;
    $('#pwCur').required = !haveCurrent;
    for (const id of ['#pwCur', '#pwNew', '#pwNew2']) $(id).value = '';
    $('#pwErr').textContent = '';
    if (!$('#pwDlg').open) $('#pwDlg').showModal();
    (haveCurrent ? $('#pwNew') : $('#pwCur')).focus();
  }
  $('#pwDlg').addEventListener('cancel', (e) => {
    if (state.pwForced) e.preventDefault(); // 첫 비밀번호 설정 중에는 Esc 로 닫을 수 없음
  });
  $('#pwBtn').addEventListener('click', () => openPw(false));
  $('#pwCancel').addEventListener('click', () => $('#pwDlg').close());
  $('#pwLogout').addEventListener('click', () => {
    $('#pwDlg').close();
    $('#logout').click();
  });
  $('#pwForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const next = $('#pwNew').value;
    if (next !== $('#pwNew2').value) {
      $('#pwErr').textContent = '새 비밀번호가 서로 다릅니다.';
      return;
    }
    const current = state.pwForced && state.loginPass ? state.loginPass : $('#pwCur').value;
    try {
      const r = await api('POST', '/api/password', { current, next });
      const wasForced = state.pwForced;
      state.me = r.user;
      state.loginPass = null;
      state.pwForced = false;
      $('#pwDlg').close();
      toast('비밀번호를 변경했어요.');
      if (wasForced) {
        await loadBoards();
        await load();
        scrollToNow();
      }
    } catch (err) {
      $('#pwErr').textContent = err.message;
    }
  });

  function showLogin() {
    state.me = null;
    state.loginPass = null;
    if ($('#pwDlg').open) $('#pwDlg').close();
    $('#app').hidden = true;
    $('#login').hidden = false;
    $('#loginPass').value = '';
    $('#loginUser').focus();
  }

  async function showApp() {
    $('#login').hidden = true;
    $('#app').hidden = false;
    $('#who').textContent = `${state.me.username} (${isAdmin() ? '관리자' : '조회'})`;
    if (state.me.mustChange) {
      openPw(true); // 비밀번호를 바꾸기 전에는 보드를 불러오지 않음
      return;
    }
    $('#googleBtn').hidden = !isAdmin();
    await loadBoards();
    await load();
    scrollToNow();
    handleGoogleReturn();
  }

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#loginErr').textContent = '';
    try {
      const r = await api('POST', '/api/login', { username: $('#loginUser').value, password: $('#loginPass').value });
      state.me = r.user;
      state.loginPass = $('#loginPass').value; // 첫 비밀번호 설정 팝업에서 현재 비밀번호 재입력을 생략하기 위해 메모리에만 보관
      $('#loginPass').value = '';
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
    if (!state.me || !state.boardId || document.hidden || state.dragging != null || dialogOpen()) return;
    try {
      const r = await api('GET', B('/rev'));
      state.sync = r.sync;
      state.boards = (await api('GET', '/api/boards')).boards; // 다른 탭의 충돌/오류 배지도 갱신
      renderTabs();
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
