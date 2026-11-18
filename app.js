/* Baton flow prototype: review by exception. Plain JS, no build step, no network: it reads window.DEMO (data.js)
   and the media beside this file. Nothing here talks to the Baton API or database. */
(() => {
'use strict';
const D = window.DEMO;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const DUR = D.clip.duration_ms;
const NF = Math.floor(DUR / 1000 * D.clip.frame_fps);
const frame = (ms) => window.FRAMES[clamp(Math.round(ms / 1000 * D.clip.frame_fps) + 1, 1, NF) - 1];   // published copy: stills are inlined in frames.js
const mmss = (ms, d = 0) => { const s = ms / 1000; return `${Math.floor(s / 60)}:${(s % 60).toFixed(d).padStart(d ? 3 + d : 2, '0')}`; };
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;
const pct = (a, b) => (b ? Math.round(a / b * 100) : 0);
const STEPS = ['AI làm trước', 'Triage theo ngoại lệ', 'Duyệt nhãn', 'Biên thời gian', 'Kiểm toán', 'Kết quả'];
const ACT = Object.fromEntries(D.activities.map((a) => [a.id, a]));
const ROW = Object.fromEntries(D.actions.map((a) => [a.id, a]));
const rowsOf = (aid) => D.actions.filter((r) => r.activity === aid);

// ---------------------------------------------------------------------------------------------------------- state
const KEY = 'baton.flowdemo.v1';
const fresh = () => ({
  stage: 0, max: 0, started: false, t: [0, 0, 0, 0, 0, 0], standin: false,
  seg: {},                       // segment id -> 'keep' | 'exclude' (a person's decision)
  row: {},                       // action/activity id -> {st: 'ok'|'fixed'|'gone', label?, start_ms?, end_ms?, dwell}
  bnd: {},                       // boundary id -> {st: 'kept'|'moved', t_ms}
  audit: {},                     // id -> 'ok' | 'wrong'
  cur: null, curAct: D.activities[0]?.id ?? null, showAuto: false, undo: [],
});
let S = fresh();
try { const saved = JSON.parse(localStorage.getItem(KEY) || 'null'); if (saved && saved.v === D.build) S = { ...fresh(), ...saved.s }; } catch { /* storage may be off */ }
const save = () => { try { localStorage.setItem(KEY, JSON.stringify({ v: D.build, s: { ...S, undo: [] } })); } catch { /* ignore */ } };

const shown = (r) => (r.honeypot ? r.honeypot.shown_label : r.label);   // what the reviewer sees first
const stOf = (r) => S.row[r.id]?.st ?? (r.tier === 'A' ? 'auto' : 'pending');
const labelOf = (r) => S.row[r.id]?.label ?? shown(r);
const spanOf = (r) => ({ start_ms: S.row[r.id]?.start_ms ?? r.start_ms, end_ms: S.row[r.id]?.end_ms ?? r.end_ms });
const reviewSegs = () => D.segments.filter((s) => s.route === 'review');
const segDecision = (s) => S.seg[s.id] ?? (s.route === 'auto_drop' ? 'exclude' : s.route === 'auto_keep' ? 'keep' : null);
const pendingRows = (aid) => rowsOf(aid).filter((r) => stOf(r) === 'pending');
const allPending = () => D.actions.filter((r) => stOf(r) === 'pending').length + D.activities.filter((a) => !S.row[a.id]).length;
const bSample = () => D.boundaries.filter((b) => b.sample);
const openBounds = () => bSample().filter((b) => !S.bnd[b.id]);

// ---------------------------------------------------------------------------------------------------------- clock
let lastInput = 0, lastTick = performance.now();
const touch = () => { lastInput = performance.now(); };
['keydown', 'pointerdown', 'pointermove', 'wheel'].forEach((e) => addEventListener(e, touch, { passive: true }));
setInterval(() => {
  const now = performance.now(), dt = now - lastTick; lastTick = now;
  const live = S.started && !S.standin && S.stage >= 1 && S.stage <= 4 && !document.hidden && now - lastInput < 15000;
  if (live) S.t[S.stage] += dt;
  const total = S.t.reduce((a, b) => a + b, 0);
  $('#clock').classList.toggle('idle', !live);
  $('#clockT').textContent = mmss(total);
  $('#clockX').innerHTML = total > 1000 ? `<b>${(total / DUR).toFixed(2)}×</b> video · ≈ <b>${Math.round(total / DUR * 60)}</b> phút / giờ video` : `video ${mmss(DUR)}`;
  if (live && Math.round(total / 1000) % 5 === 0) save();
}, 250);

let toastT;
const toast = (msg) => { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 1800); };

// ---------------------------------------------------------------------------------------------------------- nav
function go(n) {
  stopLoops();
  S.stage = n; S.max = Math.max(S.max ?? 0, n); if (n >= 1) S.started = true;
  $$('.view').forEach((v, i) => v.classList.toggle('on', i === n));
  $('#steps').innerHTML = STEPS.map((s, i) => `<button class="step ${i === n ? 'on' : ''} ${stageDone(i) ? 'done' : ''}" data-go="${i}"><b>${stageDone(i) && i !== n ? '✓' : i}</b>${s}</button>`).join('');
  [render0, render1, render2, render3, render4, render5][n]();
  save();
}
const stageDone = (i) => (S.max ?? 0) > i && (
  i === 0 ? true : i === 1 ? reviewSegs().every((s) => S.seg[s.id]) : i === 2 ? allPending() === 0
  : i === 3 ? openBounds().length === 0 : i === 4 ? auditItems().every((x) => S.audit[x.id]) : false);
$('#steps').addEventListener('click', (e) => { const b = e.target.closest('[data-go]'); if (b) go(+b.dataset.go); });

// ---------------------------------------------------------------------------------------------------------- looping players
const loops = new Set();
function loopVideo(v, start_ms, end_ms, rate, onTime) {
  const a = start_ms / 1000, b = Math.max(a + 0.25, end_ms / 1000);
  const seek = () => { try { v.currentTime = a; } catch { /* not ready */ } };
  const on = () => { if (v.currentTime >= b - 0.03 || v.currentTime < a - 0.3) seek(); onTime?.((v.currentTime - a) / (b - a)); };
  v.muted = true; v.playsInline = true;
  const start = () => { seek(); v.playbackRate = rate; v.play().catch(() => {}); };
  v.addEventListener('timeupdate', on);
  if (v.readyState >= 1) start(); else v.addEventListener('loadedmetadata', start, { once: true });
  const stop = () => { v.removeEventListener('timeupdate', on); v.pause(); loops.delete(stop); };
  loops.add(stop);
  return { stop, setRate: (r) => { v.playbackRate = r; }, seekFrac: (f) => { v.currentTime = a + clamp(f, 0, 1) * (b - a); } };
}
function stopLoops() { [...loops].forEach((s) => s()); }

// ====================================================================================================== 0 · overview
function laneSpans(items, color) {
  return items.map((x) => `<i style="left:${x.start_ms / DUR * 100}%;width:${Math.max(0.15, (x.end_ms - x.start_ms) / DUR * 100)}%;background:${color(x)}" title="${esc(x.title ?? '')}"></i>`).join('');
}
function drawHands(c) {
  const w = c.width = c.clientWidth * 2, hh = c.height = c.clientHeight * 2, ctx = c.getContext('2d');
  const n = D.hands.right.length;
  for (let i = 0; i < n; i++) {
    const x = i / n * w, bw = Math.ceil(w / n);
    ctx.fillStyle = `rgba(31,102,229,${D.hands.right[i]})`; ctx.fillRect(x, 0, bw, hh / 2 - 1);
    ctx.fillStyle = `rgba(196,42,138,${D.hands.left[i]})`; ctx.fillRect(x, hh / 2 + 1, bw, hh / 2 - 1);
  }
}
function render0() {
  const seg = { keep: D.segments.filter((s) => s.route === 'auto_keep'), drop: D.segments.filter((s) => s.route === 'auto_drop'), rev: reviewSegs() };
  const tier = (t) => D.actions.filter((r) => r.tier === t).length;
  const backed = D.boundaries.filter((b) => b.supported).length, unsupported = bSample().length;
  const look = seg.rev.length + D.activities.length + tier('B') + tier('C') + unsupported;
  const total = D.segments.length + D.activities.length + D.actions.length + D.boundaries.length;
  const tcol = { A: 'var(--ai-soft-2)', B: 'var(--ai)', C: 'var(--warn)' };
  $('#v0').innerHTML = `
  <div class="hero">
    <div>
      <div class="eyebrow">${esc(D.clip.title)} · ${mmss(DUR)}</div>
      <h1 style="margin-top:8px">Một lượt người duyệt thay cho bốn lượt xem hết video</h1>
      <p class="lede">AI đã chạy thật trên đoạn video này: Triage, gán nhãn Activities và Dense actions, rồi một lượt AI thứ hai mô tả lại từng bước mà không nhìn nhãn đầu. Chỗ nào hai lượt khớp và máy đo được biên thì bạn không phải xem. Bạn chỉ xử lý phần còn lại, và đồng hồ góc phải đo đúng thời gian bạn thao tác.</p>
      <div class="cta">
        <button class="btn primary" data-act="start">Bắt đầu duyệt</button>
        <button class="btn ghost" data-act="standin">Để người thay thế (Claude) duyệt hộ</button>
        ${S.started ? '<button class="btn ghost" data-act="reset">Làm lại từ đầu</button>' : ''}
      </div>
    </div>
    <div class="then-now">
      <div class="panel tn"><div class="eyebrow">Hiện tại</div>
        <div class="passes"><div class="pass">Labeler</div><div class="pass q">QA</div><div class="pass">Labeler</div><div class="pass q">QA</div></div>
        <div class="big">≥ 4×</div><p class="muted" style="font-size:12px">Bốn lượt người, mỗi lượt xem hết video: Triage, QA, Activities + Dense, QA.</p></div>
      <div class="panel tn new"><div class="eyebrow">Bản thử</div>
        <div class="passes"><div class="pass" style="flex:2.2">AI ×2</div><div class="pass h" style="flex:1.2">Người duyệt</div><div class="pass q" style="flex:.6">Mẫu</div></div>
        <div class="big">mục tiêu ≤ 1×</div><p class="muted" style="font-size:12px">Người chỉ xem ${pct(look, total)}% số mục (${look} / ${total}); QA xem chỗ đã sửa và một mẫu ngẫu nhiên.</p></div>
    </div>
  </div>
  <div class="sec">
    <div class="stats">
      <div class="panel stat"><div class="eyebrow">Triage</div><div class="n">${seg.rev.length} <span class="muted" style="font-size:14px">/ ${D.segments.length} đoạn</span></div><div class="d">cần bạn xem · AI tự giữ ${seg.keep.length}, tự loại ${seg.drop.length}</div></div>
      <div class="panel stat"><div class="eyebrow">Activities</div><div class="n">${D.activities.length}</div><div class="d">xem bằng dải khung hình</div></div>
      <div class="panel stat"><div class="eyebrow">Dense actions</div><div class="n">${D.actions.length}</div><div class="d">tự động ${tier('A')} · liếc ${tier('B')} · cần xem ${tier('C')}</div></div>
      <div class="panel stat"><div class="eyebrow">Biên thời gian</div><div class="n">${unsupported} <span class="muted" style="font-size:14px">/ ${D.boundaries.length}</span></div><div class="d">biên bạn kiểm theo mẫu · ${backed} biên có máy xác nhận</div></div>
      <div class="panel stat"><div class="eyebrow">AI đã chạy</div><div class="n">$${D.ai.total_usd.toFixed(2)}</div><div class="d">${D.ai.calls} lượt gọi ${esc(D.ai.model)} · ≈ $${(D.ai.total_usd / DUR * 3600000).toFixed(2)} / giờ video</div></div>
    </div>
    <div class="panel map">
      <h3>Bản đồ đoạn video sau khi AI chạy</h3>
      <div class="lanes">
        <div class="lb">Triage</div><div class="lane tall">${laneSpans(D.segments.map((s) => ({ ...s, title: `${s.task ?? 'khoảng trống'} · ${mmss(s.start_ms)}–${mmss(s.end_ms)}` })), (s) => (s.route === 'auto_keep' ? 'var(--ok-line)' : s.route === 'auto_drop' ? 'var(--bad-line)' : 'var(--warn)'))}</div>
        <div class="lb">Activities</div><div class="lane tall">${laneSpans(D.activities.map((a) => ({ ...a, title: a.label })), () => 'var(--ink-3)')}</div>
        <div class="lb">Dense actions</div><div class="lane tall">${laneSpans(D.actions.map((a) => ({ ...a, title: a.label })), (a) => tcol[a.tier])}</div>
        <div class="lb">Tay phải / trái</div><div class="lane tall"><canvas id="handsLane"></canvas></div>
      </div>
      <div class="legend">
        <span><i class="sw" style="background:var(--ok-line)"></i>AI tự giữ</span><span><i class="sw" style="background:var(--warn)"></i>cần người xem</span><span><i class="sw" style="background:var(--bad-line)"></i>AI tự loại</span>
        <span><i class="sw" style="background:var(--ai-soft-2);outline:1px dashed var(--ai-line)"></i>dense: tự động</span><span><i class="sw" style="background:var(--ai)"></i>dense: liếc</span>
        <span><i class="sw" style="background:var(--hand-r)"></i>tay phải trong khung</span><span><i class="sw" style="background:var(--hand-l)"></i>tay trái trong khung</span>
      </div>
    </div>
    <div class="how">
      <div class="panel"><div class="eyebrow">1 · Triage theo ngoại lệ</div><p>Chỉ những đoạn AI không chắc mới hiện, bốn ô phát cùng lúc ở 2×. Chọn Keep hoặc Exclude cho từng ô.</p></div>
      <div class="panel"><div class="eyebrow">2 · Duyệt nhãn</div><p>Mỗi bước là một thẻ ba khung hình. Ô lớn bên phải phát lặp đúng đoạn đó. <kbd>Space</kbd> là đúng, <kbd>X</kbd> là sai và sửa.</p></div>
      <div class="panel"><div class="eyebrow">3 · Biên thời gian</div><p>Máy đánh dấu biên nào nằm sát lúc khung hình đổi mạnh. Trong số còn lại bạn kiểm một mẫu ngẫu nhiên, kèm chỗ gợi ý.</p></div>
      <div class="panel"><div class="eyebrow">4 · Kiểm toán</div><p>QA xem mọi chỗ đã sửa, một mẫu ngẫu nhiên của phần đã chấp nhận, và kết quả các nhãn bẫy.</p></div>
    </div>
    <p class="note">${esc(D.notes)}</p>
  </div>`;
  drawHands($('#handsLane'));
}

// ====================================================================================================== 1 · triage
let wall = { page: 0, sel: 0, rate: 2, ids: null, players: [] };
const CHECK_VI = { footage_authenticity: 'Tính xác thực', economic_usefulness: 'Việc có ích', safety: 'An toàn', capture_quality: 'Chất lượng quay' };
function segWhy(s) {
  const worst = Object.entries(s.checks).sort((a, b) => b[1].confidence - a[1].confidence)[0];
  if (!s.task) return { tag: 'Khoảng trống', text: s.why };
  return { tag: `${CHECK_VI[worst[0]]} · ${worst[1].confidence}`, text: worst[1].reason };
}
function render1() {
  const rev = reviewSegs();
  const ids = wall.ids ?? rev.slice(wall.page * 4, wall.page * 4 + 4).map((s) => s.id);
  const pages = Math.max(1, Math.ceil(rev.length / 4));
  const item = (s) => `<button class="seg ${ids.includes(s.id) ? 'sel' : ''}" data-seg="${s.id}"><span class="tm">${mmss(s.start_ms)}</span><span class="nm">${esc(s.task ?? 'khoảng trống')}</span>${
    segDecision(s) === 'keep' ? `<span class="chip ${S.seg[s.id] ? 'ok' : 'ai'}">Keep</span>` : segDecision(s) === 'exclude' ? `<span class="chip ${S.seg[s.id] ? 'bad' : 'ai'}">Exclude</span>` : '<span class="chip warn">chờ</span>'}</button>`;
  const group = (title, list) => (list.length ? `<h3>${title} · ${list.length}</h3>${list.map(item).join('')}` : '');
  const kept = D.segments.filter((s) => segDecision(s) === 'keep').reduce((a, s) => a + s.end_ms - s.start_ms, 0);
  const left = rev.filter((s) => !S.seg[s.id]).length;
  $('#v1').innerHTML = `
  <aside class="side">
    <div class="hd"><h2>Triage theo ngoại lệ</h2><p>AI đã quyết ${D.segments.length - rev.length} / ${D.segments.length} đoạn. Bạn chỉ xem ${rev.length} đoạn nó không chắc. Đang giữ <b>${mmss(kept)}</b> / ${mmss(DUR)}.</p></div>
    <div class="list scroll">${group('Cần bạn xem', rev)}${group('AI tự giữ', D.segments.filter((s) => s.route === 'auto_keep'))}${group('AI tự loại', D.segments.filter((s) => s.route === 'auto_drop'))}</div>
  </aside>
  <div class="work">
    <div class="bar">
      <div class="grow"><div class="hint"><span><kbd>1</kbd>–<kbd>4</kbd> chọn ô</span><span><kbd>K</kbd> Keep</span><span><kbd>X</kbd> Exclude</span><span><kbd>A</kbd> theo gợi ý AI cho cả trang</span><span><kbd>Enter</kbd> trang sau</span></div></div>
      <span class="muted" style="font-size:12px">Tốc độ</span>
      ${[2, 4, 8].map((r) => `<button class="btn sm ${wall.rate === r ? '' : 'ghost'}" data-rate="${r}">${r}×</button>`).join('')}
      ${wall.ids ? '<button class="btn sm" data-act="wallback">Quay lại các đoạn cần xem</button>' : `<span class="mono muted">trang ${wall.page + 1}/${pages}</span>`}
      <button class="btn ${left ? '' : 'primary'}" data-act="next1">${left ? `Còn ${left} đoạn` : 'Sang Duyệt nhãn'}</button>
    </div>
    ${ids.length ? `<div class="wall" style="grid-template-columns:${ids.length === 1 ? '1fr' : '1fr 1fr'}">${ids.map((id, i) => tileHtml(D.segments.find((s) => s.id === id), i)).join('')}</div>`
      : '<div class="empty"><div><h2>Không có đoạn nào cần bạn xem</h2><p style="margin-top:6px">AI chắc chắn với mọi đoạn. Bấm vào một đoạn bên trái nếu muốn kiểm tra lại.</p></div></div>'}
  </div>`;
  wall.players = $$('#v1 .tile').map((t) => {
    const s = D.segments.find((x) => x.id === t.dataset.id), bar = $('.hv b', t);
    return loopVideo($('video', t), s.start_ms, s.end_ms, wall.rate, (f) => { bar.style.width = `${f * 100}%`; });
  });
  wall.sel = clamp(wall.sel, 0, Math.max(0, ids.length - 1));
  markTile();
}
function tileHtml(s, i) {
  const w = segWhy(s), d = S.seg[s.id];
  const a = Math.floor(s.start_ms / D.hands.bin_ms), b = Math.ceil(s.end_ms / D.hands.bin_ms);
  const hv = (arr, col, top) => arr.slice(a, b).map((v, k, all) => `<i style="left:${k / all.length * 100}%;width:${100 / all.length + 0.2}%;top:${top};height:50%;background:${col};opacity:${v}"></i>`).join('');
  const tg = (v, label) => `<button class="tg ${v === 'keep' ? 'keep' : 'drop'} ${d === v ? 'on' : !d && s.suggest === v ? 'ai' : ''}" data-dec="${v}" data-id="${s.id}">${!d && s.suggest === v ? 'AI · ' : ''}${label}</button>`;
  return `<div class="tile" data-id="${s.id}" data-i="${i}">
    <div class="cap"><span class="k">${i + 1}</span><span class="mono">${mmss(s.start_ms)}–${mmss(s.end_ms)}</span><span>${esc(s.task ?? 'khoảng trống (không có việc)')}</span></div>
    <video src="${D.clip.src}" preload="auto"></video>
    <div class="why"><b>${esc(w.tag)}</b>${esc(w.text)}</div>
    <div class="ctl"><div class="hv" data-seek="1" title="Xanh: tay phải trong khung · Hồng: tay trái. Bấm để tua.">${hv(D.hands.right, 'var(--hand-r)', '0')}${hv(D.hands.left, 'var(--hand-l)', '50%')}<b style="position:absolute;left:0;top:0;bottom:0;width:0;background:rgba(255,255,255,.28);border-right:2px solid var(--accent)"></b></div>${tg('keep', 'Keep')}${tg('exclude', 'Exclude')}</div>
  </div>`;
}
const markTile = () => $$('#v1 .tile').forEach((t, i) => t.classList.toggle('sel', i === wall.sel));
function decideSeg(id, v) { S.seg[id] = v; render1(); }
function next1() {
  const rev = reviewSegs(), pages = Math.ceil(rev.length / 4);
  if (wall.ids) { wall.ids = null; return render1(); }
  if (wall.page + 1 < pages) { wall.page++; wall.sel = 0; return render1(); }
  if (rev.some((s) => !S.seg[s.id])) { wall.page = Math.floor(rev.findIndex((s) => !S.seg[s.id]) / 4); return render1(); }
  go(2);
}

// ====================================================================================================== 2 · labels
let focusLoop = null, focusSince = 0, fixing = false, rate2 = 2;
const three = (r, n = 3) => { const { start_ms: a, end_ms: b } = spanOf(r), pad = Math.min(250, (b - a) / 6); return Array.from({ length: n }, (_, i) => frame(a + pad + (b - a - 2 * pad) * i / (n - 1))); };
const tierChip = (r) => (r.tier === 'C' ? '<span class="chip warn">cần xem</span>' : r.tier === 'B' ? '<span class="chip ai">liếc</span>' : '<span class="chip ai">✦ tự động</span>');
const stMark = (st) => ({ ok: '<span class="chip ok">✓ đã duyệt</span>', fixed: '<span class="chip">✎ đã sửa</span>', gone: '<span class="chip bad">đã xóa</span>', auto: '<span class="chip ai">✦ AI · chưa ai xem</span>', pending: '' }[st]);
function cardHtml(r, isAct) {
  const st = isAct ? (S.row[r.id]?.st ?? 'pending') : stOf(r), sp = spanOf(r);
  return `<button class="card ${st} ${S.cur === r.id ? 'cur' : ''}" data-row="${r.id}" style="${isAct ? 'grid-column:1/-1' : ''}">
    <div class="fr" style="${isAct ? 'grid-template-columns:repeat(8,1fr)' : ''}">${three(r, isAct ? 8 : 3).map((f) => `<img loading="lazy" src="${f}" alt="">`).join('')}</div>
    <div class="tx">${isAct ? '<b>Activity · </b>' : ''}${esc(labelOf(r))}</div>
    <div class="mt"><span class="tm">${mmss(sp.start_ms, 1)} · ${secs(sp.end_ms - sp.start_ms)}</span>${st === 'pending' ? (isAct ? '<span class="chip ai">liếc</span>' : tierChip(r)) : stMark(st)}</div>
  </button>`;
}
function render2() {
  const aid = S.curAct ?? D.activities[0].id, a = ACT[aid], rows = rowsOf(aid);
  const autos = rows.filter((r) => stOf(r) === 'auto'), rest = rows.filter((r) => stOf(r) !== 'auto');
  if (!S.cur || (S.cur !== aid && ROW[S.cur]?.activity !== aid)) S.cur = !S.row[aid] ? aid : (pendingRows(aid)[0] ?? rest[0] ?? rows[0])?.id ?? aid;
  const left = allPending();
  $('#v2').innerHTML = `
  <aside class="rail"><div class="scroll" style="flex:1">${D.activities.map((x, i) => {
    const rs = rowsOf(x.id), n = rs.length || 1, c = (st) => rs.filter((r) => stOf(r) === st).length;
    return `<button class="act ${x.id === aid ? 'on' : ''}" data-actid="${x.id}"><div class="cd"><span>A${String(i + 1).padStart(2, '0')} · ${mmss(x.start_ms)}</span><span>${c('pending') + (S.row[x.id] ? 0 : 1) || '✓'}</span></div><div class="lb">${esc(labelOf(x))}</div>
      <div class="prog"><i style="width:${(c('ok') + c('fixed') + c('gone')) / n * 100}%;background:var(--ink)"></i><i style="width:${c('auto') / n * 100}%;background:var(--ai-soft-2)"></i><i style="width:${c('pending') / n * 100}%;background:var(--ai)"></i></div></button>`;
  }).join('')}</div></aside>
  <div class="deck">
    <div class="bar"><div class="grow"><div class="eyebrow">${mmss(a.start_ms)}–${mmss(a.end_ms)} · ${rows.length} dense actions</div><h2 style="margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(labelOf(a))}</h2></div>
      <button class="btn ${left ? '' : 'primary'}" data-act="next2">${left ? `Còn ${left} mục chờ duyệt` : 'Sang Biên thời gian'}</button></div>
    <div class="cards scroll" id="cards">${cardHtml(a, true)}${rest.map((r) => cardHtml(r)).join('')}
      ${autos.length ? `<div class="autobar"><span>✦</span><span class="grow"><b>${autos.length} dòng AI tự chấp nhận</b> trong activity này: hai lượt AI khớp nhau, điểm cao, biên có máy xác nhận. Chúng giữ dấu AI và không tính là người đã duyệt.</span><button class="btn sm" data-act="toggleAuto">${S.showAuto ? 'Ẩn' : 'Hiện'}</button></div>${S.showAuto ? autos.map((r) => cardHtml(r)).join('') : ''}` : ''}
    </div>
  </div>
  <aside class="focus" id="focus"></aside>`;
  renderFocus();
}
function renderFocus() {
  const id = S.cur, isAct = !!ACT[id], r = isAct ? ACT[id] : ROW[id];
  if (!r) return;
  focusLoop?.stop(); focusSince = performance.now();
  const st = isAct ? (S.row[id]?.st ?? 'pending') : stOf(r), sp = spanOf(r), s2 = r.second;
  const hand = (hd) => (hd === 'both' ? '<span class="chip r">R</span><span class="chip l">L</span>' : hd === 'right' ? '<span class="chip r">R</span>' : hd === 'left' ? '<span class="chip l">L</span>' : '');
  const agree = { same: ['ok', 'khớp'], minor: ['warn', 'lệch nhẹ'], different: ['bad', 'lệch'], none: ['', 'không có'] }[r.agree ?? 'none'];
  const body = fixing ? `
    <div class="fix"><div class="eyebrow" style="margin-bottom:6px">Sửa nhãn</div>
      <textarea id="fixText" spellcheck="false">${esc(labelOf(r))}</textarea>
      <div class="picks">
        ${s2 && s2.label !== labelOf(r) ? `<button class="pick" data-pick="${esc(s2.label)}"><span><span class="muted">Dùng nhãn của lượt AI thứ hai:</span> ${esc(s2.label)}</span></button>` : ''}
        ${/\b(right|left) hand\b/.test(labelOf(r)) ? '<button class="pick" data-swap="1"><span>Đổi tay phải ↔ tay trái</span></button>' : ''}
      </div>
      <div class="nudge"><span class="muted">Đầu</span><button class="btn sm" data-nudge="s-">−0,5 s</button><button class="btn sm" data-nudge="s+">+0,5 s</button><span class="muted" style="margin-left:10px">Cuối</span><button class="btn sm" data-nudge="e-">−0,5 s</button><button class="btn sm" data-nudge="e+">+0,5 s</button><span class="mono muted" id="nudgeT">${mmss(sp.start_ms, 1)}–${mmss(sp.end_ms, 1)}</span></div>
    </div>
    <div class="acts"><button class="btn primary" data-act="saveFix">Lưu · Enter</button><button class="btn" data-act="cancelFix">Hủy · Esc</button>${isAct ? '' : '<button class="btn ghost" data-act="del" style="margin-left:auto">Xóa dòng này</button>'}</div>`
    : `
    <div class="lbl ${st === 'pending' || st === 'auto' ? 'ai' : ''}">${esc(labelOf(r))}</div>
    ${s2 ? `<div class="second ${r.agree === 'different' ? 'diff' : ''}"><div class="h"><span class="eyebrow">Lượt AI thứ hai (không nhìn nhãn trên)</span><span class="chip ${agree[0]}">${agree[1]}</span></div>${esc(s2.label)}${r.agree_reason ? `<div class="muted" style="font-size:12px;margin-top:3px">${esc(r.agree_reason)}</div>` : ''}</div>` : ''}
    <div class="facts"><span class="chip">${mmss(sp.start_ms, 1)}–${mmss(sp.end_ms, 1)}</span><span class="chip">${secs(sp.end_ms - sp.start_ms)}</span><span class="chip ai">AI tự chấm ${r.confidence}</span>${s2 ? `<span class="chip">độ rõ ${s2.clarity}</span>${hand(s2.hands)}` : ''}${(r.why ?? []).map((w) => `<span class="chip warn">${esc(w)}</span>`).join('')}</div>
    <div class="acts">
      ${st === 'pending' ? '<button class="btn primary" data-act="ok">Đúng · Space</button>' : `<span>${stMark(st)}</span>`}
      <button class="btn" data-act="fix">${st === 'pending' ? 'Sai, sửa · X' : 'Sửa · X'}</button>
      ${st === 'auto' ? '<button class="btn ghost" data-act="pull">Đưa về duyệt tay</button>' : ''}
      ${S.undo.length ? '<button class="btn ghost" data-act="undo" style="margin-left:auto">Hoàn tác · U</button>' : ''}
    </div>`;
  $('#focus').innerHTML = `
    <div class="loop"><video src="${D.clip.src}" preload="auto"></video>
      <div class="tag"><span>${isAct ? 'ACTIVITY' : id.toUpperCase()}</span><span id="rateTag">${isAct ? 8 : rate2}× lặp</span></div><div class="scrub"><i id="scrubI"></i></div></div>
    <div class="fbody">${body}</div>
    <div class="keys"><span><kbd>Space</kbd> đúng, sang mục sau</span><span><kbd>X</kbd> sửa</span><span><kbd>D</kbd> xóa</span><span><kbd>←</kbd><kbd>→</kbd> di chuyển</span><span><kbd>R</kbd> tốc độ</span><span><kbd>U</kbd> hoàn tác</span></div>`;
  const bar = $('#scrubI');
  focusLoop = loopVideo($('#focus video'), sp.start_ms, sp.end_ms, isAct ? 8 : rate2, (f) => { bar.style.width = `${f * 100}%`; });
  $$('#cards .card').forEach((c) => c.classList.toggle('cur', c.dataset.row === id));
  $(`#cards .card[data-row="${id}"]`)?.scrollIntoView({ block: 'nearest' });
  if (fixing) { const t = $('#fixText'); t.focus(); t.setSelectionRange(t.value.length, t.value.length); }
}
function setRow(id, patch) {
  S.undo.push({ id, prev: S.row[id] ? { ...S.row[id] } : null });
  if (S.undo.length > 50) S.undo.shift();
  S.row[id] = { ...(S.row[id] ?? {}), ...patch, dwell: Math.round(performance.now() - focusSince) };
}
function order(aid) { return [aid, ...rowsOf(aid).filter((r) => stOf(r) !== 'auto' || S.showAuto).map((r) => r.id)]; }
function advance() {
  const aid = S.curAct, list = order(aid), i = list.indexOf(S.cur);
  const isPending = (x) => (ACT[x] ? !S.row[x] : stOf(ROW[x]) === 'pending');
  const nxt = list.slice(i + 1).find(isPending) ?? list.find(isPending);
  if (nxt) { S.cur = nxt; return render2(); }
  const more = D.activities.find((a) => !S.row[a.id] || pendingRows(a.id).length);
  if (more) { S.curAct = more.id; S.cur = null; toast('Xong activity này, sang activity kế tiếp'); return render2(); }
  toast('Đã duyệt hết. Bấm "Sang Biên thời gian".'); render2();
}
function accept() { const r = ACT[S.cur] ?? ROW[S.cur]; if (!r || fixing) return; const st = ACT[S.cur] ? (S.row[S.cur]?.st ?? 'pending') : stOf(r); if (st !== 'pending') return advance(); setRow(S.cur, { st: 'ok' }); advance(); }
function saveFix() {
  const r = ACT[S.cur] ?? ROW[S.cur], text = $('#fixText').value.trim().replace(/\s+/g, ' ');
  if (!text) return toast('Nhãn không được để trống');
  const sp = fixSpan ?? spanOf(r), changed = text !== shown(r) || sp.start_ms !== r.start_ms || sp.end_ms !== r.end_ms;
  setRow(S.cur, { st: changed ? 'fixed' : 'ok', label: text, start_ms: sp.start_ms, end_ms: sp.end_ms });
  fixing = false; fixSpan = null; advance();
}
let fixSpan = null;
function nudge(k) {
  const r = ACT[S.cur] ?? ROW[S.cur]; fixSpan ??= { ...spanOf(r) };
  const d = k[1] === '+' ? 500 : -500;
  if (k[0] === 's') fixSpan.start_ms = clamp(fixSpan.start_ms + d, 0, fixSpan.end_ms - 500); else fixSpan.end_ms = clamp(fixSpan.end_ms + d, fixSpan.start_ms + 500, DUR);
  $('#nudgeT').textContent = `${mmss(fixSpan.start_ms, 1)}–${mmss(fixSpan.end_ms, 1)}`;
  focusLoop?.stop(); const bar = $('#scrubI');
  focusLoop = loopVideo($('#focus video'), fixSpan.start_ms, fixSpan.end_ms, rate2, (f) => { bar.style.width = `${f * 100}%`; });
}
function undo() { const u = S.undo.pop(); if (!u) return; if (u.prev) S.row[u.id] = u.prev; else delete S.row[u.id]; S.cur = u.id; if (ROW[u.id]) S.curAct = ROW[u.id].activity; else S.curAct = u.id; fixing = false; render2(); }
function move(d) { const list = order(S.curAct), i = clamp(list.indexOf(S.cur) + d, 0, list.length - 1); S.cur = list[i]; fixing = false; fixSpan = null; renderFocus(); }

// ====================================================================================================== 3 · boundaries
let bcur = 0, bLoop = null;
const bT = (b) => S.bnd[b.id]?.t_ms ?? b.t_ms;
function render3() {
  const list = bSample(), ok = D.boundaries.filter((b) => b.supported).length, rest = D.boundaries.length - ok, left = openBounds().length;
  bcur = clamp(bcur, 0, Math.max(0, list.length - 1));
  $('#v3').innerHTML = `
  <div class="bar"><div class="grow"><h2>Biên thời gian</h2><div class="hint" style="margin-top:2px"><span>${ok} / ${D.boundaries.length} biên nằm sát một lúc khung hình đổi mạnh (±${String(D.boundary_rule.tol_ms / 1000).replace('.', ',')} s). ${rest} biên còn lại chưa có gì xác nhận; bạn kiểm một mẫu ${list.length} biên.</span></div></div>
    <div class="hint"><span><kbd>Space</kbd> giữ nguyên</span><span><kbd>S</kbd> dịch tới chỗ gợi ý</span><span><kbd>↑</kbd><kbd>↓</kbd></span></div>
    <button class="btn" data-act="keepAll">Giữ nguyên tất cả</button>
    <button class="btn ${left ? '' : 'primary'}" data-act="next3">${left ? `Còn ${left} biên` : 'Sang Kiểm toán'}</button></div>
  <div style="flex:1;min-height:0;display:flex">
    <div class="rows scroll" id="brows">${list.length ? list.map((b, i) => browHtml(b, i)).join('') : '<div class="empty"><div><h2>Không có biên nào cần kiểm</h2></div></div>'}</div>
    <aside class="focus" style="width:420px"><div class="loop"><video src="${D.clip.src}" preload="auto"></video><div class="tag"><span>±1,5 s quanh biên</span><span>1×</span></div><div class="scrub"><i id="bScrub"></i></div></div>
      <div class="fbody" id="bInfo"></div></aside>
  </div>`;
  $$('#brows canvas').forEach((c) => drawSpark(c, list[+c.dataset.i]));
  focusB();
}
function browHtml(b, i) {
  const t = bT(b), st = S.bnd[b.id]?.st, d = b.suggest_ms == null ? null : b.suggest_ms - b.t_ms;
  const lab = (id) => (id ? esc(labelOf(ROW[id])) : '<span class="muted">(không có dòng)</span>');
  return `<div class="panel brow ${i === bcur ? 'cur' : ''}" data-b="${i}">
    <div class="side-l"><div class="eyebrow">kết thúc</div>${lab(b.before)}</div>
    <div><div class="tri"><img loading="lazy" src="${frame(t - 400)}" alt=""><img loading="lazy" class="at" src="${frame(t)}" alt=""><img loading="lazy" src="${frame(t + 400)}" alt=""></div><canvas class="spark" data-i="${i}"></canvas></div>
    <div class="side-r"><div class="eyebrow">bắt đầu</div>${lab(b.after)}</div>
    <div class="do"><span class="mono">${mmss(t, 1)} ${st === 'moved' ? '<span class="chip">✎ đã dịch</span>' : st === 'kept' ? '<span class="chip ok">✓ giữ</span>' : '<span class="chip ai">chờ</span>'}</span>
      <button class="btn sm" data-bact="keep" data-i="${i}">Giữ nguyên</button>
      ${d == null ? '<span class="muted" style="font-size:12px">không có điểm gợi ý gần</span>' : `<button class="btn sm" data-bact="snap" data-i="${i}">Dịch ${d > 0 ? '+' : '−'}${Math.abs(d / 1000).toFixed(1)} s tới lúc khung hình đổi</button>`}</div>
  </div>`;
}
function drawSpark(c, b) {
  const w = c.width = c.clientWidth * 2, hh = c.height = c.clientHeight * 2, ctx = c.getContext('2d');
  const span = 3000, a = b.t_ms - span, bin = D.speed.bin_ms, x = (ms) => (ms - a) / (2 * span) * w;
  ctx.strokeStyle = '#9a9fab'; ctx.lineWidth = 2; ctx.beginPath();
  for (let ms = a; ms <= b.t_ms + span; ms += bin) { const v = D.speed.v[Math.round(ms / bin)] ?? 0, y = hh - 3 - v * (hh - 6); ms === a ? ctx.moveTo(x(ms), y) : ctx.lineTo(x(ms), y); }
  ctx.stroke();
  if (b.suggest_ms != null) { ctx.strokeStyle = '#6a48e0'; ctx.setLineDash([6, 5]); ctx.beginPath(); ctx.moveTo(x(b.suggest_ms), 0); ctx.lineTo(x(b.suggest_ms), hh); ctx.stroke(); ctx.setLineDash([]); }
  ctx.strokeStyle = '#e35b32'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(x(bT(b)), 0); ctx.lineTo(x(bT(b)), hh); ctx.stroke();
}
function focusB() {
  const list = bSample(), b = list[bcur];
  bLoop?.stop(); if (!b) return;
  $$('#brows .brow').forEach((r, i) => r.classList.toggle('cur', i === bcur));
  $(`#brows .brow[data-b="${bcur}"]`)?.scrollIntoView({ block: 'nearest' });
  const t = bT(b), bar = $('#bScrub');
  bLoop = loopVideo($('#v3 video'), Math.max(0, t - 1500), Math.min(DUR, t + 1500), 1, (f) => { bar.style.width = `${f * 100}%`; bar.style.background = Math.abs(f - 0.5) < 0.04 ? '#fff' : 'var(--accent)'; });
  $('#bInfo').innerHTML = `<div class="eyebrow">Biên tại ${mmss(t, 1)}</div><p style="font-size:13px;color:var(--ink-2)">Thanh chạy đổi sang trắng đúng lúc đi qua biên. Đường xám trong mỗi hàng là mức thay đổi của khung hình: khi người quay sang việc khác, đường này vọt lên. Vạch cam là biên hiện tại, vạch tím đứt là đỉnh thay đổi gần nhất.</p>
    <div class="facts"><span class="chip">cách đỉnh thay đổi gần nhất ${b.min_dist_ms == null ? '> 1,5 s' : secs(b.min_dist_ms)}</span></div>`;
}
function decideB(i, how) {
  const list = bSample(), b = list[i]; if (!b) return;
  S.bnd[b.id] = how === 'snap' && b.suggest_ms != null ? { st: 'moved', t_ms: b.suggest_ms } : { st: 'kept', t_ms: b.t_ms };
  const nxt = list.findIndex((x, k) => k > i && !S.bnd[x.id]); bcur = nxt >= 0 ? nxt : i; render3();
}

// ====================================================================================================== 4 · audit
function auditItems() {
  const edited = D.actions.filter((r) => ['fixed', 'gone'].includes(stOf(r))).map((r) => ({ id: r.id, kind: 'edit' }));
  const sample = D.actions.filter((r) => r.sample && !r.honeypot && ['ok', 'auto'].includes(stOf(r))).map((r) => ({ id: r.id, kind: 'sample' }));
  return [...edited, ...sample];
}
function render4() {
  const items = auditItems(), edits = items.filter((x) => x.kind === 'edit'), sample = items.filter((x) => x.kind === 'sample');
  const traps = D.actions.filter((r) => r.honeypot), caught = traps.filter((r) => ['fixed', 'gone'].includes(stOf(r)));
  const wrongSample = sample.filter((x) => S.audit[x.id] === 'wrong').length, wrongEdit = edits.filter((x) => S.audit[x.id] === 'wrong').length;
  const done = items.filter((x) => S.audit[x.id]).length, limit = D.audit_rule.max_errors;
  const open = allPending();
  const pass = wrongSample <= limit && caught.length >= Math.ceil(traps.length * D.audit_rule.min_trap_share);
  const row = (x) => {
    const r = ROW[x.id], st = stOf(r), v = S.audit[x.id];
    const btn = (val, label) => `<button class="btn sm ${v === val ? (val === 'ok' ? 'on-ok' : 'on-bad') : ''}" data-aud="${val}" data-id="${x.id}" style="${v === val ? `background:var(--${val === 'ok' ? 'ok' : 'bad'});border-color:transparent;color:#fff` : ''}">${label}</button>`;
    return `<div class="panel arow"><div class="fr">${three(r).map((f) => `<img loading="lazy" src="${f}" alt="">`).join('')}</div>
      <div>${x.kind === 'edit' ? `<div class="was">${esc(shown(r))}</div><div class="now">${st === 'gone' ? '(người duyệt đã xóa dòng này)' : esc(labelOf(r))}</div>` : `<div class="now">${esc(labelOf(r))}</div>`}
        <div class="mono muted" style="margin-top:3px">${r.id} · ${mmss(spanOf(r).start_ms, 1)} · ${st === 'auto' ? '✦ AI tự chấp nhận' : st === 'ok' ? 'người duyệt chấp nhận' : 'người duyệt sửa'}</div></div>
      <div style="display:flex;gap:6px">${btn('ok', x.kind === 'edit' ? 'Đồng ý' : 'Đúng')}${btn('wrong', x.kind === 'edit' ? 'Không' : 'Sai')}</div></div>`;
  };
  $('#v4').innerHTML = `
  <div class="bar"><div class="grow"><h2>Kiểm toán thay cho QA xem lại toàn bộ</h2><div class="hint" style="margin-top:2px"><span>QA không xem lại video. QA xem mọi chỗ người duyệt đã đổi, và một mẫu ngẫu nhiên của phần đã được chấp nhận, kể cả phần AI tự chấp nhận.</span></div></div>
    <button class="btn" data-act="auditStandin">Để Claude kiểm thay</button>
    <button class="btn ${done === items.length ? 'primary' : ''}" data-act="next4">${done === items.length ? 'Xem kết quả' : `Còn ${items.length - done} mục`}</button></div>
  <div class="scroll" style="flex:1"><div class="audit">
    <div>
      <div class="agroup"><h3>Chỗ người duyệt đã sửa hoặc xóa <span class="chip">${edits.length}</span></h3>${edits.length ? edits.map(row).join('') : '<p class="muted">Chưa có chỗ nào bị sửa.</p>'}</div>
      <div class="agroup"><h3>Mẫu ngẫu nhiên từ phần đã chấp nhận <span class="chip">${sample.length}</span></h3>${sample.length ? sample.map(row).join('') : '<p class="muted">Chưa có dòng nào được chấp nhận để rút mẫu.</p>'}</div>
    </div>
    <div>
      <div class="panel verdict"><div class="eyebrow">Kết luận cho video này</div>
        <div class="big" style="color:var(--${open || done < items.length ? 'ink-3' : pass ? 'ok' : 'bad'})">${open ? 'Chưa duyệt xong' : done < items.length ? 'Đang kiểm' : pass ? 'Đạt' : 'Trả về duyệt toàn bộ'}</div>
        ${open ? `<p class="note" style="margin:0 0 6px">Còn ${open} mục ở bước Duyệt nhãn chưa có quyết định, nên chưa thể kết luận.</p>` : ''}
        <div class="kv"><span>Mẫu ngẫu nhiên sai</span><b>${wrongSample} / ${sample.length} (cho phép ${limit})</b><span>Chỗ sửa bị QA bác</span><b>${wrongEdit} / ${edits.length}</b><span>Nhãn bẫy bị bắt</span><b>${caught.length} / ${traps.length}</b><span>Biên phải dịch trong mẫu</span><b>${bSample().filter((b) => S.bnd[b.id]?.st === 'moved').length} / ${bSample().length}</b></div>
        <p class="note">Quy tắc thử nghiệm: mẫu sai quá ${limit} dòng, hoặc bắt được dưới ${Math.round(D.audit_rule.min_trap_share * 100)}% nhãn bẫy, thì cả video quay về duyệt từng dòng. Ngưỡng này là giả định của bản thử, chưa hiệu chỉnh trên dữ liệu thật.</p></div>
      <div class="panel verdict" style="margin-top:12px"><div class="eyebrow">Nhãn bẫy</div>
        <p style="font-size:13px;color:var(--ink-2);margin:6px 0 8px">${traps.length} thẻ ở bước Duyệt nhãn mang nhãn cố ý sai, lấy từ một bước khác trong video. Người duyệt cẩn thận sẽ đánh dấu sai.</p>
        ${traps.map((r) => `<div style="display:flex;gap:8px;align-items:baseline;font-size:12px;margin-top:6px"><span class="chip ${['fixed', 'gone'].includes(stOf(r)) ? 'ok' : stOf(r) === 'pending' ? '' : 'bad'}">${['fixed', 'gone'].includes(stOf(r)) ? 'bắt được' : stOf(r) === 'pending' ? 'chưa tới' : 'lọt'}</span><span><span class="mono">${r.id}</span> hiện “${esc(r.honeypot.shown_label)}”</span></div>`).join('')}</div>
    </div>
  </div></div>`;
}

// ====================================================================================================== 5 · result
function render5() {
  const total = S.t.reduce((a, b) => a + b, 0), x = total / DUR;
  const c = (st) => D.actions.filter((r) => stOf(r) === st).length;
  const traps = D.actions.filter((r) => r.honeypot), caught = traps.filter((r) => ['fixed', 'gone'].includes(stOf(r))).length;
  const reviewed = D.actions.filter((r) => S.row[r.id] && !r.honeypot);
  const changed = reviewed.filter((r) => ['fixed', 'gone'].includes(stOf(r))).length;
  const fast = Object.values(S.row).filter((v) => v.st === 'ok' && v.dwell < 500).length;
  const stageCol = ['', 'var(--warn)', 'var(--ai)', 'var(--ink-3)', 'var(--ok)'];
  const max = Math.max(4, x) * 1.05;
  const agree = (v) => D.actions.filter((r) => r.agree === v).length;
  $('#v5').innerHTML = `<div class="res">
    <div class="eyebrow">Kết quả trên ${mmss(DUR)} video</div>
    <h1 style="margin-top:6px">${S.standin ? 'Người thay thế đã duyệt xong; thời gian không đo vì đó không phải người' : total < 5000 ? 'Bạn chưa duyệt gì nên chưa có số đo' : `Bạn mất ${mmss(total)} cho ${mmss(DUR)} video: ${x.toFixed(2)}×`}</h1>
    <div class="panel" style="padding:16px;margin-top:16px"><h3>Giờ người cho mỗi giờ video</h3>
      <div class="bars">
        <div class="hb"><span>Hiện tại (số bạn nêu)</span><div class="trk"><i style="width:${2 / max * 100}%;background:var(--ink-3)"></i><i style="width:${2 / max * 100}%;background:var(--ink-4)"></i></div><span class="v">≥ 4,00×</span></div>
        <div class="hb"><span>Mục tiêu</span><div class="trk"><i style="width:${1 / max * 100}%;background:var(--surface-3);outline:1px dashed var(--ink-3);outline-offset:-1px"></i></div><span class="v">1,00×</span></div>
        <div class="hb"><span>Bản thử, ${S.standin ? 'chưa đo' : 'bạn vừa làm'}</span><div class="trk">${[1, 2, 3, 4].map((i) => `<i title="${STEPS[i]}" style="width:${S.t[i] / DUR / max * 100}%;background:${stageCol[i]}"></i>`).join('')}</div><span class="v">${S.standin || total < 5000 ? '—' : `${x.toFixed(2)}×`}</span></div>
      </div>
      <div class="legend">${[1, 2, 3, 4].map((i) => `<span><i class="sw" style="background:${stageCol[i]}"></i>${STEPS[i]} · ${mmss(S.t[i])}</span>`).join('')}</div>
      <p class="note">Đồng hồ chỉ đếm khi bạn đang ở bước 1–4, tab đang mở và bạn có thao tác trong 15 giây gần nhất. Con số này đo trên ${mmss(DUR)} video với một người; đừng coi nó là năng suất trung bình.</p></div>
    <div class="grid2">
      <div class="panel" style="padding:16px"><h3>Người duyệt đã làm gì</h3><div class="kv">
        <span>Dense actions chấp nhận nguyên</span><b>${c('ok')}</b><span>Đã sửa</span><b>${c('fixed')}</b><span>Đã xóa</span><b>${c('gone')}</b>
        <span>AI tự chấp nhận, chưa ai xem</span><b>${c('auto')}</b><span>Còn chờ</span><b>${c('pending')}</b>
        <span>Tỷ lệ AI bị sửa hoặc xóa (trong phần người đã xem, trừ nhãn bẫy)</span><b>${reviewed.length ? `${pct(changed, reviewed.length)}% (${changed}/${reviewed.length})` : '—'}</b>
        <span>Nhãn bẫy bị bắt</span><b>${caught} / ${traps.length}</b><span>Lần bấm "đúng" dưới 0,5 giây</span><b>${fast}</b>
        <span>Triage: Keep / Exclude</span><b>${D.segments.filter((s) => segDecision(s) === 'keep').length} / ${D.segments.filter((s) => segDecision(s) === 'exclude').length}</b>
        <span>Biên đã dịch / giữ nguyên</span><b>${Object.values(S.bnd).filter((b) => b.st === 'moved').length} / ${Object.values(S.bnd).filter((b) => b.st === 'kept').length}</b></div></div>
      <div class="panel" style="padding:16px"><h3>AI đã làm gì (chạy thật)</h3><div class="kv">
        ${D.ai.steps.map((s) => `<span>${esc(s.name)}</span><b>$${s.cost_usd.toFixed(3)} · ${s.detail}</b>`).join('')}
        <span>Tổng Gemini cho ${mmss(DUR)}</span><b>$${D.ai.total_usd.toFixed(2)}</b><span>Quy ra mỗi giờ video (giá đến 30/11)</span><b>≈ $${(D.ai.total_usd / DUR * 3600000).toFixed(2)}</b>
        <span>Hai lượt AI: khớp / lệch nhẹ / lệch</span><b>${agree('same')} / ${agree('minor')} / ${agree('different')}</b>
        <span>Biên máy xác nhận được</span><b>${D.boundaries.filter((b) => b.supported).length} / ${D.boundaries.length}</b></div>
        ${D.standin_summary ? `<p class="note">${esc(D.standin_summary)}</p>` : ''}</div>
    </div>
    <div class="cta" style="display:flex;gap:10px;margin-top:18px"><button class="btn" data-go="2">Quay lại duyệt tiếp</button><button class="btn ghost" data-act="reset">Làm lại từ đầu</button></div>
  </div>`;
}

// ---------------------------------------------------------------------------------------------------------- stand-in
function applyStandin(all) {
  const st = D.standin ?? {};
  if (all) {
    S = { ...fresh(), started: true, standin: true };
    for (const s of reviewSegs()) S.seg[s.id] = st.segments?.[s.id] ?? s.suggest;
    for (const a of D.activities) { const v = st.reviewer?.[a.id]; S.row[a.id] = v?.v === 'wrong' && v.fix ? { st: 'fixed', label: v.fix, dwell: 9999 } : { st: 'ok', dwell: 9999 }; }
    for (const r of D.actions) { if (r.tier === 'A') continue; const v = st.reviewer?.[r.id];
      S.row[r.id] = v?.v === 'wrong' ? (v.fix ? { st: 'fixed', label: v.fix, dwell: 9999 } : { st: 'gone', dwell: 9999 }) : { st: 'ok', dwell: 9999 }; }
    for (const b of bSample()) S.bnd[b.id] = { st: 'kept', t_ms: b.t_ms };
  }
  for (const x of auditItems()) { const v = st.auditor?.[x.id]; S.audit[x.id] = x.kind === 'edit' ? 'ok' : v?.v === 'wrong' ? 'wrong' : 'ok'; }
}

// ---------------------------------------------------------------------------------------------------------- events
document.addEventListener('click', (e) => {
  const t = e.target, q = (sel) => t.closest(sel);
  let b;
  if ((b = q('[data-act]'))) {
    const a = b.dataset.act;
    if (a === 'start') go(1);
    else if (a === 'standin') { applyStandin(true); go(4); toast('Người thay thế đã duyệt xong bước 1–3'); }
    else if (a === 'reset') { S = fresh(); wall = { page: 0, sel: 0, rate: 2, ids: null, players: [] }; go(0); }
    else if (a === 'next1') next1();
    else if (a === 'wallback') { wall.ids = null; render1(); }
    else if (a === 'next2') { if (allPending()) { const m = D.activities.find((x) => !S.row[x.id] || pendingRows(x.id).length); S.curAct = m.id; S.cur = null; render2(); } else go(3); }
    else if (a === 'toggleAuto') { S.showAuto = !S.showAuto; render2(); }
    else if (a === 'ok') accept();
    else if (a === 'fix') { fixing = true; fixSpan = null; renderFocus(); }
    else if (a === 'cancelFix') { fixing = false; fixSpan = null; renderFocus(); }
    else if (a === 'saveFix') saveFix();
    else if (a === 'del') { setRow(S.cur, { st: 'gone' }); fixing = false; advance(); }
    else if (a === 'pull') { setRow(S.cur, { st: 'ok' }); delete S.row[S.cur]; ROW[S.cur].tier = 'B'; render2(); }
    else if (a === 'undo') undo();
    else if (a === 'keepAll') { for (const x of openBounds()) S.bnd[x.id] = { st: 'kept', t_ms: x.t_ms }; render3(); }
    else if (a === 'next3') { if (openBounds().length) { bcur = bSample().findIndex((x) => !S.bnd[x.id]); render3(); } else go(4); }
    else if (a === 'auditStandin') { applyStandin(false); render4(); }
    else if (a === 'next4') go(5);
    return;
  }
  if ((b = q('[data-rate]'))) { wall.rate = +b.dataset.rate; wall.players.forEach((p) => p.setRate(wall.rate)); $$('#v1 [data-rate]').forEach((x) => x.classList.toggle('ghost', +x.dataset.rate !== wall.rate)); return; }
  if ((b = q('[data-dec]'))) return decideSeg(b.dataset.id, b.dataset.dec);
  if ((b = q('[data-seek]'))) { const tile = b.closest('.tile'), r = b.getBoundingClientRect(); wall.players[+tile.dataset.i]?.seekFrac((e.clientX - r.left) / r.width); return; }
  if ((b = q('.tile'))) { wall.sel = +b.dataset.i; return markTile(); }
  if ((b = q('[data-seg]'))) { const s = D.segments.find((x) => x.id === b.dataset.seg), rev = reviewSegs(), i = rev.indexOf(s);
    if (i >= 0) { wall.ids = null; wall.page = Math.floor(i / 4); wall.sel = i % 4; } else { wall.ids = [s.id]; wall.sel = 0; } return render1(); }
  if ((b = q('[data-actid]'))) { S.curAct = b.dataset.actid; S.cur = null; fixing = false; return render2(); }
  if ((b = q('[data-row]'))) { S.cur = b.dataset.row; fixing = false; fixSpan = null; return renderFocus(); }
  if ((b = q('[data-pick]'))) { $('#fixText').value = b.dataset.pick; return $('#fixText').focus(); }
  if ((b = q('[data-swap]'))) { const x = $('#fixText'); x.value = x.value.replace(/\b(right|left)( hand)/g, (m, s, r) => (s === 'right' ? 'left' : 'right') + r); return x.focus(); }
  if ((b = q('[data-nudge]'))) return nudge(b.dataset.nudge);
  if ((b = q('[data-bact]'))) return decideB(+b.dataset.i, b.dataset.bact);
  if ((b = q('.brow'))) { bcur = +b.dataset.b; return focusB(); }
  if ((b = q('[data-aud]'))) { S.audit[b.dataset.id] = b.dataset.aud; return render4(); }
});
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const inText = e.target.matches('textarea, input'), k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (S.stage === 2 && fixing) {
    if (k === 'Enter' && !e.shiftKey) { e.preventDefault(); saveFix(); }
    else if (k === 'Escape') { fixing = false; fixSpan = null; renderFocus(); }
    return;
  }
  if (inText) return;
  if (S.stage === 1) {
    const ids = $$('#v1 .tile').map((t) => t.dataset.id);
    if ('1234'.includes(k) && ids[+k - 1]) { wall.sel = +k - 1; markTile(); }
    else if (k === 'k' && ids[wall.sel]) decideSeg(ids[wall.sel], 'keep');
    else if (k === 'x' && ids[wall.sel]) decideSeg(ids[wall.sel], 'exclude');
    else if (k === 'a') { ids.forEach((id) => { S.seg[id] ??= D.segments.find((s) => s.id === id).suggest; }); render1(); }
    else if (k === 'Enter') next1();
    else return; e.preventDefault();
  } else if (S.stage === 2) {
    if (k === ' ' || k === 'Enter') accept();
    else if (k === 'x') { fixing = true; fixSpan = null; renderFocus(); }
    else if (k === 'd' && ROW[S.cur]) { setRow(S.cur, { st: 'gone' }); advance(); }
    else if (k === 'u') undo();
    else if (k === 'ArrowRight' || k === 'ArrowDown') move(1);
    else if (k === 'ArrowLeft' || k === 'ArrowUp') move(-1);
    else if (k === 'r') { rate2 = rate2 === 2 ? 3 : rate2 === 3 ? 1 : 2; focusLoop?.setRate(rate2); const t = $('#rateTag'); if (t && !ACT[S.cur]) t.textContent = `${rate2}× lặp`; }
    else return; e.preventDefault();
  } else if (S.stage === 3) {
    if (k === ' ' || k === 'Enter') decideB(bcur, 'keep');
    else if (k === 's') decideB(bcur, 'snap');
    else if (k === 'ArrowDown') { bcur++; render3(); }
    else if (k === 'ArrowUp') { bcur--; render3(); }
    else return; e.preventDefault();
  }
});

// #stage=N opens a step directly (handy for screenshots); #fresh forgets saved progress
const hash = new URLSearchParams(location.hash.slice(1));
if (hash.has('fresh')) S = fresh();
if (hash.has('standin')) applyStandin(true);
if (hash.has('stage')) { S.started = true; S.stage = +hash.get('stage'); }
if (hash.has('cur') && ROW[hash.get('cur')]) { S.cur = hash.get('cur'); S.curAct = ROW[S.cur].activity; fixing = hash.has('fix'); }
go(clamp(S.stage, 0, 5));
})();
