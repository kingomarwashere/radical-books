// Radical Books — SPA. Vanilla JS, no build step (matches Sound/Structura style).
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (h) => { const t = document.createElement('template'); t.innerHTML = h.trim(); return t.content.firstChild; };
const api = async (p, opts) => {
  const r = await fetch(p, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), { status: r.status, body: j });
  return j;
};
const fmt = (s) => { s = Math.floor(s || 0); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`; };
const runtime = (s) => { if (!s) return ''; const h = Math.floor(s / 3600), m = Math.round(s % 3600 / 60); return h ? `${h}h ${m}m` : `${m}m`; };
const toast = (msg) => { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('on'), 2200); };

let ME = { user: null, access: null };

// ── Book card ────────────────────────────────────────────────────────────────
function card(b, prog) {
  const badges = [b.hasAudio && '<span class="badge audio">Audio</span>', b.hasEbook && '<span class="badge ebook">Ebook</span>'].filter(Boolean).join('');
  const c = el(`<div class="card" data-slug="${b.slug}">
    <div class="cover">
      <img loading="lazy" src="${b.cover || ''}" alt="" onerror="this.style.opacity=.15;this.src='/favicon.svg'">
      <div class="badges">${badges}</div>
      <div class="play"><span><svg class="i" viewBox="0 0 24 24" fill="#fff"><path d="M8 5v14l11-7z"/></svg></span></div>
    </div>
    <div class="title">${esc(b.title)}</div>
    <div class="author">${esc(b.author || '')}</div>
    ${prog != null ? `<div class="prog"><i style="width:${Math.round(prog * 100)}%"></i></div>` : ''}
  </div>`);
  c.onclick = () => nav(`/book/${b.slug}`);
  return c;
}
const esc = (s) => String(s ?? '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

function rowOf(title, books, opts = {}) {
  if (!books?.length) return null;
  const r = el(`<section class="row"><h2>${esc(title)}${opts.more ? `<a class="more" href="${opts.more}">See all →</a>` : ''}</h2><div class="hscroll"></div></section>`);
  const scroll = $('.hscroll', r);
  books.forEach(b => scroll.appendChild(card(b, opts.progress?.(b))));
  return r;
}

// ── Views ────────────────────────────────────────────────────────────────────
async function viewHome(app) {
  const data = await api('/api/home');
  app.innerHTML = '';
  if (data.continue?.length) {
    const r = rowOf('Continue', data.continue, { progress: b => b.percent || 0 });
    app.appendChild(r);
  }
  for (const s of data.sections) {
    const more = s.subject ? `/browse?subject=${encodeURIComponent(s.subject)}` : (s.title === 'Audiobooks' ? '/audiobooks' : s.title === 'Ebooks' ? '/ebooks' : null);
    const r = rowOf(s.title, s.books, { more });
    if (r) app.appendChild(r);
  }
  if (!data.sections.length) app.appendChild(emptyState('The library is empty', 'Sign in and use Discover to add free audiobooks and ebooks.'));
}

async function viewBrowse(app, { media = 'any', subject = null, title }) {
  app.innerHTML = '<div class="spin"></div>';
  const [{ subjects }, { books }] = await Promise.all([api('/api/subjects'), api(`/api/books?media=${media}${subject ? `&subject=${encodeURIComponent(subject)}` : ''}&limit=100`)]);
  app.innerHTML = `<section class="row"><h2>${esc(title)}</h2></section>`;
  const chips = el('<div class="chips"></div>');
  const mk = (label, active, on) => { const c = el(`<button class="chip ${active ? 'active' : ''}">${esc(label)}</button>`); c.onclick = on; return c; };
  chips.appendChild(mk('All', !subject, () => nav(media === 'audio' ? '/audiobooks' : media === 'ebook' ? '/ebooks' : '/browse')));
  subjects.slice(0, 24).forEach(s => chips.appendChild(mk(`${s.name}`, subject === s.name, () => nav(`/browse?subject=${encodeURIComponent(s.name)}${media !== 'any' ? `&media=${media}` : ''}`))));
  app.appendChild(chips);
  const grid = el('<div class="grid"></div>');
  books.forEach(b => grid.appendChild(card(b)));
  app.appendChild(books.length ? grid : emptyState('Nothing here yet', 'Try Discover to add titles.'));
}

async function viewBook(app, slug) {
  app.innerHTML = '<div class="spin"></div>';
  let data;
  try { data = await api(`/api/book/${slug}`); } catch { app.innerHTML = ''; app.appendChild(emptyState('Not found', 'This book isn’t in the library.')); return; }
  const b = data.book;
  const paid = ME.access?.paid;
  const meta = [b.year, runtime(b.audioRuntime), ...(b.subjects || []).slice(0, 3)].filter(Boolean).map(m => `<span class="chip">${esc(m)}</span>`).join('');
  const wrap = el(`<div>
    <div class="detail">
      <div class="dcover"><img src="${b.cover || ''}" alt="" onerror="this.style.opacity=.15"></div>
      <div>
        <h1>${esc(b.title)}</h1>
        <div class="by">${esc(b.author || '')}</div>
        <div class="meta">${meta}</div>
        <div class="desc">${esc(b.description || 'No description available.')}</div>
        <div class="actions" id="bookActions"></div>
      </div>
    </div>
    <div id="chapterList"></div>
  </div>`);
  const actions = $('#bookActions', wrap);
  if (b.hasAudio && data.chapters.length) {
    const btn = el(`<button class="btn primary"><svg class="i" viewBox="0 0 24 24" fill="#fff"><path d="M8 5v14l11-7z"/></svg> Listen</button>`);
    btn.onclick = () => paid ? playBook(b, data.chapters, data.progress?.audio) : showPaywall();
    actions.appendChild(btn);
  }
  if (b.hasEbook && data.editions.length) {
    const btn = el(`<button class="btn ${b.hasAudio ? 'ghost' : 'primary'}"><svg class="i" viewBox="0 0 24 24"><path d="M4 4h9a3 3 0 013 3v13a2 2 0 00-2-2H4zM20 4h-2a3 3 0 00-3 3v11a2 2 0 012-2h3z"/></svg> Read</button>`);
    btn.onclick = () => paid ? (location.href = `/reader?book=${b.id}`) : showPaywall();
    actions.appendChild(btn);
  }
  // Like + shelf
  const like = el(`<button class="btn icon ghost" title="Favourite">${heart(data.liked)}</button>`);
  like.onclick = async () => { if (!ME.user) return openAuth(); const r = await api(`/api/book/${b.id}/like`, { method: 'POST' }); like.innerHTML = heart(r.liked); toast(r.liked ? 'Added to favourites' : 'Removed'); };
  actions.appendChild(like);
  const shelf = el(`<button class="btn icon ghost" title="Add to shelf"><svg class="i" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" fill="none"/></svg></button>`);
  shelf.onclick = () => ME.user ? shelfPicker(b.id) : openAuth();
  actions.appendChild(shelf);

  // Chapter list (audiobook)
  if (b.hasAudio && data.chapters.length) {
    const cl = $('#chapterList', wrap);
    cl.appendChild(el(`<h2 style="font-size:18px;font-weight:700;margin:10px 0">${data.chapters.length} chapters · ${runtime(b.audioRuntime)}</h2>`));
    const list = el('<div class="chapters"></div>');
    data.chapters.forEach(ch => {
      const row = el(`<div class="ch" data-idx="${ch.idx}"><span class="n">${ch.idx + 1}</span><span class="t">${esc(ch.title)}</span><span class="d">${ch.duration ? fmt(ch.duration) : ''}</span></div>`);
      row.onclick = () => paid ? playBook(b, data.chapters, { chapter_idx: ch.idx, position_sec: 0 }) : showPaywall();
      list.appendChild(row);
    });
    cl.appendChild(list);
  }
  app.innerHTML = ''; app.appendChild(wrap);
}
const heart = (on) => `<svg class="i" viewBox="0 0 24 24" fill="${on ? 'var(--red)' : 'none'}" stroke="${on ? 'var(--red)' : 'currentColor'}" stroke-width="2"><path d="M12 21s-7-4.5-9.5-8.5C.5 9 2 5.5 5.5 5.5c2 0 3.2 1 3.5 2 .3-1 1.5-2 3.5-2 3.5 0 5 3.5 3 7C19 16.5 12 21 12 21z"/></svg>`;

async function viewLibrary(app) {
  if (!ME.user) { app.innerHTML = ''; app.appendChild(emptyState('Sign in to build your library', 'Save books, track progress, sync across devices.', 'Sign in', openAuth)); return; }
  app.innerHTML = '<div class="spin"></div>';
  const [{ books: liked }, { shelves }, { books: cont }] = await Promise.all([api('/api/me/likes'), api('/api/shelves'), api('/api/me/continue')]);
  app.innerHTML = '';
  const r1 = rowOf('Continue', cont, { progress: b => b.percent || 0 }); if (r1) app.appendChild(r1);
  const r2 = rowOf('Favourites', liked); if (r2) app.appendChild(r2);
  const sh = el(`<section class="row"><h2>Shelves <button class="more" id="newShelf" style="cursor:pointer;background:none">+ New</button></h2><div class="grid" id="shelfGrid"></div></section>`);
  const grid = $('#shelfGrid', sh);
  shelves.forEach(s => {
    const c = el(`<div class="card"><div class="cover" style="display:flex;align-items:center;justify-content:center;text-align:center;padding:10px"><div><div class="mono" style="font-size:11px;color:var(--dim)">${s.count} book${s.count === 1 ? '' : 's'}</div><div style="font-weight:700;margin-top:6px">${esc(s.name)}</div></div></div></div>`);
    c.onclick = () => nav(`/shelf/${s.id}`);
    grid.appendChild(c);
  });
  app.appendChild(sh);
  $('#newShelf', sh).onclick = async () => { const name = prompt('Shelf name'); if (!name) return; await api('/api/shelves', { method: 'POST', body: JSON.stringify({ name }) }); route(); };
  if (!liked.length && !cont.length && shelves.every(s => !s.count)) app.appendChild(emptyState('Your library is empty', 'Browse and tap ♥ or + to save books here.'));
}

async function viewShelf(app, id) {
  app.innerHTML = '<div class="spin"></div>';
  const { shelf, books } = await api(`/api/shelf/${id}`);
  app.innerHTML = `<section class="row"><h2>${esc(shelf.name)}</h2></section>`;
  const grid = el('<div class="grid"></div>'); books.forEach(b => grid.appendChild(card(b)));
  app.appendChild(books.length ? grid : emptyState('Empty shelf', 'Add books from their detail page.'));
}

async function viewSearch(app, q) {
  app.innerHTML = '<div class="spin"></div>';
  const { books } = await api(`/api/search?q=${encodeURIComponent(q)}`);
  app.innerHTML = `<section class="row"><h2>Results for “${esc(q)}”</h2></section>`;
  const grid = el('<div class="grid"></div>'); books.forEach(b => grid.appendChild(card(b)));
  if (books.length) app.appendChild(grid);
  else { app.appendChild(emptyState('No matches in the library', 'Search the free public-domain catalog instead?', 'Discover “' + q + '”', () => openDiscover(q))); }
}

function emptyState(title, sub, btn, on) {
  const e = el(`<div class="empty"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.5"><path d="M4 5h16v14H4z"/><path d="M12 5v14"/></svg><h2 style="margin-bottom:8px">${esc(title)}</h2><p>${esc(sub)}</p></div>`);
  if (btn) { const b = el(`<button class="btn primary" style="margin-top:20px">${esc(btn)}</button>`); b.onclick = on; e.appendChild(b); }
  return e;
}

// ── Audiobook player ─────────────────────────────────────────────────────────
const audio = $('#audio');
const P = { book: null, chapters: [], idx: 0, rates: [1, 1.25, 1.5, 1.75, 2], ri: 0 };

async function chapterUrl(bookId, idx) {
  // Paid: URLs are embedded in book detail; but we always resolve via the gated
  // endpoint so it works even if the payload was url-stripped (defensive).
  try { const r = await api(`/api/book/${bookId}/audio/${idx}/url`); return r.url; }
  catch (e) { if (e.status === 402) showPaywall(); throw e; }
}
async function playBook(book, chapters, prog) {
  P.book = book; P.chapters = chapters; P.idx = prog?.chapter_idx || 0;
  await loadChapter(P.idx, prog?.position_sec || 0);
  $('#pCover').src = book.cover || ''; $('#pTitle').textContent = book.title; $('#pAuthor').textContent = book.author || '';
  $('#player').classList.add('on');
}
async function loadChapter(idx, seek = 0) {
  P.idx = idx;
  const ch = P.chapters[idx]; if (!ch) return;
  const url = ch.url || await chapterUrl(P.book.id, idx);
  audio.src = url; audio.currentTime = 0;
  audio.playbackRate = P.rates[P.ri];
  try { await audio.play(); } catch {}
  if (seek) audio.currentTime = seek;
  highlightChapter();
  if ('mediaSession' in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: ch.title, artist: P.book.author, album: P.book.title, artwork: P.book.cover ? [{ src: P.book.cover, sizes: '512x512' }] : [] });
}
function highlightChapter() { $$('.ch').forEach(r => r.classList.toggle('playing', +r.dataset.idx === P.idx)); }
$('#pPlay').onclick = () => audio.paused ? audio.play() : audio.pause();
$('#pPrev').onclick = () => P.idx > 0 && loadChapter(P.idx - 1);
$('#pNext').onclick = () => P.idx < P.chapters.length - 1 && loadChapter(P.idx + 1);
$('#pRate').onclick = () => { P.ri = (P.ri + 1) % P.rates.length; audio.playbackRate = P.rates[P.ri]; $('#pRate').textContent = P.rates[P.ri] + '×'; };
$('#pSeek').onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(); audio.currentTime = (e.clientX - r.left) / r.width * audio.duration; };
audio.addEventListener('play', () => $('#pPlay').innerHTML = `<svg class="i" viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>`);
audio.addEventListener('pause', () => $('#pPlay').innerHTML = `<svg class="i" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>`);
audio.addEventListener('ended', () => P.idx < P.chapters.length - 1 ? loadChapter(P.idx + 1) : saveProg(true));
audio.addEventListener('timeupdate', () => {
  $('#pCur').textContent = fmt(audio.currentTime); $('#pDur').textContent = fmt(audio.duration);
  $('#pSeekFill').style.width = (audio.currentTime / audio.duration * 100 || 0) + '%';
  if (Math.floor(audio.currentTime) % 10 === 0) saveProg();
});
let lastSave = 0;
function saveProg(finished = false) {
  if (!P.book || !ME.user) return;
  const now = Date.now(); if (!finished && now - lastSave < 8000) return; lastSave = now;
  const doneChapters = P.chapters.slice(0, P.idx).reduce((a, c) => a + (c.duration || 0), 0);
  const percent = P.book.audioRuntime ? Math.min(1, (doneChapters + audio.currentTime) / P.book.audioRuntime) : 0;
  api(`/api/book/${P.book.id}/progress`, { method: 'POST', body: JSON.stringify({ mediaType: 'audio', chapterIdx: P.idx, positionSec: audio.currentTime, percent, finished }) }).catch(() => {});
}

// ── Discover + ingest ────────────────────────────────────────────────────────
function openDiscover(q = '') {
  if (!ME.user) return openAuth();
  openModal(`<button class="close">&times;</button><h3>Discover</h3><p class="sub">Search millions of books. Add any as an audiobook or ebook — free public-domain copies when available, otherwise sourced for you.</p>
    <div class="field"><input id="dq" placeholder="Search title, author, ISBN…" value="${esc(q)}"></div>
    <div id="dresults"></div>`);
  const run = async () => {
    const query = $('#dq').value.trim(); if (!query) return;
    $('#dresults').innerHTML = '<div class="spin"></div>';
    let results = [];
    try { ({ results } = await api(`/api/discover?q=${encodeURIComponent(query)}`)); }
    catch { $('#dresults').innerHTML = '<p class="muted mono" style="font-size:13px">Search failed. Try again.</p>'; return; }
    const box = $('#dresults'); box.innerHTML = '';
    if (!results.length) { box.innerHTML = '<p class="muted mono" style="font-size:13px">No results. Try another title.</p>'; return; }
    results.forEach(it => {
      const stars = it.rating ? '★'.repeat(Math.round(it.rating)) : '';
      const card = el(`<div class="dbook">
        <img class="dbc" loading="lazy" src="${it.cover || ''}" onerror="this.style.visibility='hidden'">
        <div class="dbi">
          <div class="dt">${esc(it.title)}</div>
          <div class="da">${esc(it.authorName || '')}${it.year ? ' · ' + it.year : ''}${stars ? ' · <span style="color:var(--gold)">' + stars + '</span>' : ''}</div>
          <div class="dd">${esc((it.description || '').slice(0, 140))}${(it.description || '').length > 140 ? '…' : ''}</div>
          <div class="dbtns">
            <button data-m="audio">🎧 Audiobook</button>
            <button data-m="ebook">📖 Ebook</button>
          </div>
        </div></div>`);
      card.querySelectorAll('[data-m]').forEach(btn => btn.onclick = async () => {
        const orig = btn.textContent; btn.textContent = 'Finding…'; btn.disabled = true;
        try {
          const { jobId } = await api('/api/acquire', { method: 'POST', body: JSON.stringify({ ...it, mediaType: btn.dataset.m }) });
          pollJob(jobId, btn, orig);
        } catch (e) { btn.textContent = e.message || 'Error'; btn.disabled = false; }
      });
      box.appendChild(card);
    });
  };
  $('#dq').onkeydown = (e) => e.key === 'Enter' && run();
  if (q) run();
}
async function pollJob(jobId, btn, origLabel) {
  let tries = 0;
  const tick = async () => {
    const j = await api(`/api/job/${jobId}`).catch(() => null);
    if (!j) { if (tries++ < 400) setTimeout(tick, 2000); return; }
    if (j.status === 'done') { btn.textContent = '✓ Added'; btn.classList.add('added'); toast('Added to your library'); return; }
    if (j.status === 'error') { btn.textContent = '✕ Not found'; btn.title = j.error || ''; setTimeout(() => { if (origLabel) { btn.textContent = origLabel; btn.disabled = false; } }, 2500); return; }
    btn.textContent = j.message ? j.message.slice(0, 22) : ((j.progress || 0) + '%');
    if (tries++ < 400) setTimeout(tick, 2000);
  };
  tick();
}

// ── Shelf picker ─────────────────────────────────────────────────────────────
async function shelfPicker(bookId) {
  const { shelves } = await api('/api/shelves');
  openModal(`<button class="close">&times;</button><h3>Add to shelf</h3><div id="shelfList" style="margin-top:14px"></div>`);
  const list = $('#shelfList');
  shelves.forEach(s => {
    const r = el(`<div class="dres"><div class="di"><div class="dt">${esc(s.name)}</div><div class="da">${s.count} books</div></div><button>Add</button></div>`);
    $('button', r).onclick = async (e) => { await api(`/api/shelf/${s.id}/add`, { method: 'POST', body: JSON.stringify({ bookId }) }); e.target.textContent = '✓'; e.target.classList.add('added'); toast('Added'); };
    list.appendChild(r);
  });
}

// ── Auth ─────────────────────────────────────────────────────────────────────
function openAuth(mode = 'login') {
  openModal(`<button class="close">&times;</button>
    <h3>${mode === 'login' ? 'Welcome back' : 'Join Radical Books'}</h3>
    <p class="sub">${mode === 'login' ? 'Sign in to your account.' : '72 hours free — no card required.'}</p>
    <div class="field"><label>Username</label><input id="au" autocomplete="username"></div>
    <div class="field"><label>Password</label><input id="ap" type="password" autocomplete="current-password"></div>
    ${mode === 'register' ? '<div class="field"><label>Email (optional)</label><input id="ae" type="email"></div>' : ''}
    <div class="err" id="aerr"></div>
    <button class="btn primary wfull" id="asub">${mode === 'login' ? 'Sign in' : 'Create account'}</button>
    <p class="muted mono" style="font-size:12px;text-align:center;margin-top:16px;cursor:pointer" id="aswap">${mode === 'login' ? 'No account? Sign up' : 'Have an account? Sign in'}</p>`);
  $('#aswap').onclick = () => openAuth(mode === 'login' ? 'register' : 'login');
  $('#asub').onclick = async () => {
    const body = { username: $('#au').value.trim(), password: $('#ap').value, email: $('#ae')?.value };
    const off = new URLSearchParams(location.search).get('offer'); if (off) body.offerCode = off;
    try { await api(`/api/auth/${mode === 'login' ? 'login' : 'register'}`, { method: 'POST', body: JSON.stringify(body) }); await loadMe(); closeModal(); toast(`Hi ${body.username}!`); route(); }
    catch (e) { $('#aerr').textContent = e.message; }
  };
  $('#ap').onkeydown = (e) => e.key === 'Enter' && $('#asub').click();
}

function openAccount() {
  const a = ME.access || {};
  const status = a.paid ? (a.inTrial ? `Free trial — ${Math.max(0, Math.ceil((a.trialEndsAt - Date.now()) / 3600000))}h left` : (a.accessType === 'grandfathered' ? 'Member (founding)' : 'Member ✓')) : 'Browsing (free)';
  openModal(`<button class="close">&times;</button>
    <div style="display:flex;align-items:center;gap:14px;margin-bottom:18px"><img src="${ME.user.avatar}" style="width:56px;height:56px;border-radius:50%;background:var(--bg3)"><div><div style="font-weight:800;font-size:18px">${esc(ME.user.username)}</div><div class="mono muted" style="font-size:12px">${status}</div></div></div>
    ${!a.paid || a.inTrial ? `<button class="btn primary wfull" id="acsub" style="margin-bottom:10px">${a.inTrial ? 'Subscribe now' : 'Subscribe — A$5/mo'}</button>` : `<button class="btn ghost wfull" id="acportal" style="margin-bottom:10px">Manage subscription</button>`}
    <button class="btn ghost wfull" id="acdiscover" style="margin-bottom:10px">Discover free books</button>
    ${ME.user.isAdmin ? '<a class="btn ghost wfull" href="/admin" style="margin-bottom:10px">Admin panel</a>' : ''}
    <button class="btn ghost wfull" id="acfeedback" style="margin-bottom:10px">Send feedback</button>
    <button class="btn ghost wfull" id="aclogout">Log out</button>`);
  $('#acsub') && ($('#acsub').onclick = () => location.href = '/upgrade');
  $('#acportal') && ($('#acportal').onclick = async () => { const { url } = await api('/api/billing/portal', { method: 'POST' }); location.href = url; });
  $('#acdiscover').onclick = () => openDiscover();
  $('#acfeedback').onclick = openFeedback;
  $('#aclogout').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }); ME = { user: null, access: null }; renderNav(); closeModal(); route(); };
}
function openFeedback() {
  openModal(`<button class="close">&times;</button><h3>Send feedback</h3><p class="sub">Bugs, requests, anything.</p>
    <div class="field"><label>Type</label><select id="ftype"><option value="bug">Bug</option><option value="feature">Feature</option><option value="general" selected>General</option></select></div>
    <div class="field"><textarea id="fmsg" rows="4" placeholder="What's on your mind?"></textarea></div>
    <button class="btn primary wfull" id="fsub">Send</button>`);
  $('#fsub').onclick = async () => { const message = $('#fmsg').value.trim(); if (!message) return; await api('/api/feedback', { method: 'POST', body: JSON.stringify({ type: $('#ftype').value, message, page: location.pathname }) }); closeModal(); toast('Thanks for the feedback!'); };
}
function showPaywall() {
  if (!ME.user) return openAuth('register');
  openModal(`<button class="close">&times;</button><h3>Keep reading &amp; listening</h3><p class="sub">Your free access has ended. Subscribe to unlock every audiobook and ebook.</p>
    <button class="btn primary wfull" onclick="location.href='/upgrade'">See plans</button>`);
}

// ── Modal plumbing ───────────────────────────────────────────────────────────
function openModal(html) { $('#modal').innerHTML = html; $('#modalBg').classList.add('on'); $('.close', $('#modal'))?.addEventListener('click', closeModal); }
function closeModal() { $('#modalBg').classList.remove('on'); }
$('#modalBg').onclick = (e) => { if (e.target === $('#modalBg')) closeModal(); };

// ── Nav / routing ────────────────────────────────────────────────────────────
function renderNav() {
  const right = $('#navRight');
  if (ME.user) { right.innerHTML = `<img class="avatar" src="${ME.user.avatar}" alt="">`; $('.avatar', right).onclick = openAccount; }
  else { right.innerHTML = `<button class="signin">Sign in</button>`; $('.signin', right).onclick = () => openAuth(); }
}
function nav(path) { history.pushState({}, '', path); route(); }
document.addEventListener('click', (e) => { const a = e.target.closest('a[data-route]'); if (a) { e.preventDefault(); nav(a.getAttribute('href')); } });
window.addEventListener('popstate', route);
$('#searchForm').onsubmit = (e) => { e.preventDefault(); const q = $('#searchInput').value.trim(); if (q) nav(`/search?q=${encodeURIComponent(q)}`); };

async function route() {
  const app = $('#app'); const p = location.pathname; const params = new URLSearchParams(location.search);
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.route === p));
  window.scrollTo(0, 0);
  try {
    if (p === '/' ) return void await viewHome(app);
    if (p === '/audiobooks') return void await viewBrowse(app, { media: 'audio', title: 'Audiobooks' });
    if (p === '/ebooks') return void await viewBrowse(app, { media: 'ebook', title: 'Ebooks' });
    if (p === '/browse') return void await viewBrowse(app, { media: params.get('media') || 'any', subject: params.get('subject'), title: params.get('subject') || 'Browse' });
    if (p === '/library') return void await viewLibrary(app);
    if (p === '/search') return void await viewSearch(app, params.get('q') || '');
    if (p.startsWith('/book/')) return void await viewBook(app, decodeURIComponent(p.slice(6)));
    if (p.startsWith('/shelf/')) return void await viewShelf(app, p.slice(7));
    app.innerHTML = ''; app.appendChild(emptyState('Page not found', 'Head back home.', 'Home', () => nav('/')));
  } catch (e) { app.innerHTML = ''; app.appendChild(emptyState('Something went wrong', e.message, 'Retry', route)); }
}

async function loadMe() { try { ME = await api('/api/me'); } catch { ME = { user: null, access: null }; } renderNav(); }

(async function init() {
  await loadMe();
  route();
  const qp = new URLSearchParams(location.search);
  if (qp.get('subscribed')) toast('Welcome to Radical Books! 🎉');
  if ((qp.get('auth') || qp.get('needlogin')) && !ME.user) openAuth(qp.get('auth') === 'register' ? 'register' : 'login');
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
