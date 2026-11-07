// Public bearer token used by the x.com web client itself.
const BEARER =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
const MUTE_DELAY_MS = 5000;
const SCROLL_DELAY_MS = 1500;
const IDLE_SCROLLS_BEFORE_DONE = 10;
const LIST_PATH = /^\/i\/lists\/(\d+)(\/members)?\/?$/;
const MUTED_KEY = 'muteListMembers.muted';
const AUTOSTART_KEY = 'muteListMembers.autostart';
const LIST_KEY_PREFIX = 'muteListMembers.list.';
const REQUEST_KEY = 'muteListMembers.request';

const STATUS_LABELS = {
  queued: 'Waiting',
  muting: 'Muting',
  muted: 'Muted',
  skipped: 'Already muted',
  failed: 'Failed',
};

let phase = 'intro'; // intro | running | done
let stopRequested = false;
let collecting = false;
const members = new Map(); // lowercase handle -> { handle, name, avatar, status, detail, row }
const queue = [];
let saved = null; // the current list's stored scan: { id, members, cursor, complete }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sleepUnlessStopped(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until && !stopRequested) await sleep(Math.min(250, until - Date.now()));
}

function csrfToken() {
  const m = document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/);
  return m ? m[1] : null;
}

function myHandle() {
  const link = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
  return link ? link.getAttribute('href').slice(1).toLowerCase() : null;
}

// Handles muted in earlier runs, kept in x.com's localStorage so reruns skip them.
function loadMuted() {
  try {
    return new Set(JSON.parse(localStorage.getItem(MUTED_KEY)) || []);
  } catch {
    return new Set();
  }
}

function saveMuted(muted) {
  localStorage.setItem(MUTED_KEY, JSON.stringify([...muted]));
}

function currentListId() {
  return location.pathname.match(LIST_PATH)?.[1];
}

// Members found in earlier scans of a list, so reruns don't load it again.
function loadList(id) {
  try {
    const list = JSON.parse(localStorage.getItem(LIST_KEY_PREFIX + id));
    if (Array.isArray(list?.members)) return list;
  } catch {}
  return { id, members: [], cursor: null, complete: false };
}

function persistList() {
  saved.members = [...members.values()].map(({ handle, name, avatar }) => ({ handle, name, avatar }));
  localStorage.setItem(LIST_KEY_PREFIX + saved.id, JSON.stringify(saved));
}

// ---------------------------------------------------------------------------
// Reading the member list
// ---------------------------------------------------------------------------

// Members render either as a full page or as a modal, depending on layout.
// Our own UI lives in a shadow root, so it never matches these selectors.
function memberCells() {
  const root =
    document.querySelector('[role="dialog"]') ||
    document.querySelector('[data-testid="primaryColumn"]') ||
    document;
  return [...root.querySelectorAll('[data-testid="UserCell"]')];
}

function readCell(cell) {
  let handle = null;
  for (const span of cell.querySelectorAll('span')) {
    const text = span.textContent.trim();
    if (/^@\w{1,15}$/.test(text)) {
      handle = text.slice(1);
      break;
    }
  }
  if (!handle) return null;

  let name = handle;
  for (const link of cell.querySelectorAll('a[role="link"]')) {
    const text = link.textContent.trim();
    if (text && !text.startsWith('@')) {
      name = text;
      break;
    }
  }
  const avatar = cell.querySelector('img[src*="profile_images"]')?.src || '';
  return { handle, name, avatar };
}

function addMember(info, muted, me) {
  const key = info.handle.toLowerCase();
  if (members.has(key) || key === me) return false;
  const member = { ...info, status: muted.has(key) ? 'skipped' : 'queued', detail: '' };
  members.set(key, member);
  if (member.status === 'queued') queue.push(member);
  ui.addRow(member);
  return true;
}

// Members are handed to the mute loop as soon as they're found.
async function collectLoop(muted) {
  collecting = true;
  try {
    try {
      await collectViaApi(muted);
    } catch (err) {
      ui.setNote(`Couldn't load the member list directly (${err.message}), scrolling it instead.`);
      await sleep(3000);
      await collectByScrolling(muted);
    }
    if (!stopRequested) {
      saved.complete = true;
      persistList();
    }
  } finally {
    collecting = false;
    ui.update();
  }
}

// Pages through the same ListMembers request X's members page makes, which
// returns every member rather than only the ones X renders while scrolling.
// Resumes from the cursor of an unfinished earlier scan.
async function collectViaApi(muted) {
  const base = await listMembersUrl();
  if (!base) throw new Error('no member request to copy');
  const me = myHandle();
  const seenCursors = new Set();
  let cursor = saved.cursor;
  while (!stopRequested) {
    const url = new URL(base);
    const variables = JSON.parse(url.searchParams.get('variables'));
    if (cursor) variables.cursor = cursor;
    else delete variables.cursor;
    url.searchParams.set('variables', JSON.stringify(variables));

    const res = await apiFetch(url, { headers: { 'content-type': 'application/json' } });
    if (!res) return;
    const { users, cursor: next } = parseMembersPage(await res.json());
    for (const user of users) addMember(user, muted, me);
    saved.cursor = next;
    persistList();
    ui.update();

    if (!users.length || !next || seenCursors.has(next)) return;
    seenCursors.add(next);
    cursor = next;
    await sleepUnlessStopped(1000);
  }
}

// Copies X's own ListMembers request, seen by capture.js. Waits briefly for
// it, scrolling once to make X fetch another page, and otherwise reuses the
// last one seen for any list with this list's id swapped in.
async function listMembersUrl() {
  const listId = currentListId();
  for (let i = 0; i < 20; i++) {
    const seen = document.documentElement.dataset.muteListMembersUrl;
    if (seen) {
      localStorage.setItem(REQUEST_KEY, seen);
      break;
    }
    if (i === 4) memberCells().at(-1)?.scrollIntoView({ block: 'start' });
    await sleep(250);
  }
  const template = localStorage.getItem(REQUEST_KEY);
  if (!template) return null;
  const url = new URL(template);
  const variables = JSON.parse(url.searchParams.get('variables'));
  variables.listId = listId;
  url.searchParams.set('variables', JSON.stringify(variables));
  return url;
}

function parseMembersPage(json) {
  const users = [];
  let cursor = null;
  const entries = [];
  (function findEntries(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.entries)) entries.push(...node.entries);
    for (const value of Object.values(node)) findEntries(value);
  })(json);

  for (const entry of entries) {
    const content = entry.content || {};
    if (content.cursorType === 'Bottom') cursor = content.value;
    const user = content.itemContent?.user_results?.result;
    if (user?.__typename !== 'User') continue;
    const handle = user.core?.screen_name ?? user.legacy?.screen_name;
    if (!handle) continue;
    users.push({
      handle,
      name: user.core?.name ?? user.legacy?.name ?? handle,
      avatar: user.avatar?.image_url ?? user.legacy?.profile_image_url_https ?? '',
    });
  }
  return { users, cursor };
}

// The list is virtualized, so this fallback picks members up while scrolling.
async function collectByScrolling(muted) {
  const me = myHandle();
  const membersPath = location.pathname;
  let idle = 0;
  while (idle < IDLE_SCROLLS_BEFORE_DONE && !stopRequested) {
    // Other pages have user cells too; only read members from the members page.
    if (location.pathname !== membersPath) {
      ui.setNote('Go back to the list members page to keep finding members.');
      await sleep(SCROLL_DELAY_MS);
      continue;
    }
    ui.setNote('');

    const cells = memberCells();
    let added = 0;
    for (const cell of cells) {
      const info = readCell(cell);
      if (info && addMember(info, muted, me)) added++;
    }
    if (added) persistList();
    idle = added ? 0 : idle + 1;
    ui.update();
    cells.at(-1)?.scrollIntoView({ block: 'start' });
    await sleep(SCROLL_DELAY_MS);
  }
}

// ---------------------------------------------------------------------------
// Muting
// ---------------------------------------------------------------------------

// Calls X's web API as the logged-in user, waiting out rate limits.
// Resolves null when stopped during a rate-limit wait.
async function apiFetch(url, { headers, ...init } = {}) {
  for (;;) {
    const res = await fetch(url, {
      credentials: 'include',
      ...init,
      headers: {
        authorization: `Bearer ${BEARER}`,
        'x-csrf-token': csrfToken(),
        'x-twitter-active-user': 'yes',
        'x-twitter-auth-type': 'OAuth2Session',
        ...headers,
      },
    });
    if (res.ok) return res;
    if (res.status !== 429) throw new Error(`HTTP ${res.status}`);

    const reset = Number(res.headers.get('x-rate-limit-reset')) * 1000;
    const until = reset > Date.now() ? reset + 1000 : Date.now() + 60_000;
    while (Date.now() < until && !stopRequested) {
      ui.setNote(`X rate limit reached. Resuming in ${formatDuration(until - Date.now())}.`);
      await sleep(1000);
    }
    ui.setNote('');
    if (stopRequested) return null;
  }
}

// Resolves true when muted, false when stopped during a rate-limit wait.
async function mute(screenName) {
  const res = await apiFetch('/i/api/1.1/mutes/users/create.json', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ screen_name: screenName }),
  });
  return Boolean(res);
}

async function muteLoop(muted) {
  while (!stopRequested) {
    const member = queue.shift();
    if (!member) {
      if (!collecting) return;
      await sleep(250);
      continue;
    }

    setStatus(member, 'muting');
    try {
      if (!(await mute(member.handle))) {
        setStatus(member, 'queued');
        return;
      }
      muted.add(member.handle.toLowerCase());
      saveMuted(muted);
      setStatus(member, 'muted');
    } catch (err) {
      setStatus(member, 'failed', err.message);
    }
    await sleepUnlessStopped(MUTE_DELAY_MS);
  }
}

function setStatus(member, status, detail = '') {
  member.status = status;
  member.detail = detail;
  ui.updateRow(member);
  ui.update();
}

async function run(rescan = false) {
  if (!csrfToken()) {
    alert('You need to be logged in to X.');
    return;
  }
  phase = 'running';
  stopRequested = false;
  members.clear();
  queue.length = 0;
  ui.reset();
  ui.update();

  const muted = loadMuted();
  const listId = currentListId();
  saved = rescan ? { id: listId, members: [], cursor: null, complete: false } : loadList(listId);
  const me = myHandle();
  for (const member of saved.members) addMember(member, muted, me);
  ui.update();

  await Promise.all([saved.complete ? null : collectLoop(muted), muteLoop(muted)]);

  phase = 'done';
  ui.setNote('');
  ui.update();
}

function start(rescan = false) {
  const [, id, onMembers] = location.pathname.match(LIST_PATH);
  // A fully scanned list doesn't need the members page at all.
  if (onMembers || (!rescan && loadList(id).complete)) return run(rescan);
  // Members load on their own page; open it and start automatically there.
  sessionStorage.setItem(AUTOSTART_KEY, JSON.stringify({ id, rescan }));
  location.assign(`/i/lists/${id}/members`);
}

function counts() {
  // "muted" includes accounts that were already muted before this run.
  const c = { found: members.size, muted: 0, alreadyMuted: 0, failed: 0, remaining: 0 };
  for (const m of members.values()) {
    if (m.status === 'muted') c.muted++;
    else if (m.status === 'skipped') c.muted++, c.alreadyMuted++;
    else if (m.status === 'failed') c.failed++;
    else c.remaining++;
  }
  return c;
}

function formatDuration(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

const MUTE_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6.59V1.2L8.71 7H5.5C4.12 7 3 8.12 3 9.5v5C3 15.88 4.12 17 5.5 17h2.09l-2.3 2.29 1.42 1.42 15.5-15.5-1.42-1.42L18 6.59zm-8 8V8.55l6-3.75v3.79l-6 6zM5 9.5c0-.28.22-.5.5-.5H8v6H5.5c-.28 0-.5-.22-.5-.5v-5zm6.5 9.24l1.45-1.45L16 19.2V14l2 .02v8.78l-6.5-4.06z"/></svg>';

const STYLES = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  .root {
    --bg: #0f1419; --panel: #16181c; --line: #2f3336; --text: #e7e9ea; --muted: #8b98a5;
    --red: #f4212e; --green: #00ba7c; --blue: #1d9bf0; --amber: #ffad1f;
    font: 15px/1.4 "TwitterChirp", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: var(--text); -webkit-font-smoothing: antialiased;
  }
  .backdrop {
    position: fixed; inset: 0; z-index: 2147483646; display: grid; place-items: center; padding: 16px;
    background: rgba(91, 112, 131, 0.4); backdrop-filter: blur(2px);
    animation: fade 160ms ease-out;
  }
  .dialog {
    width: min(520px, 100%); max-height: min(720px, calc(100vh - 32px));
    display: flex; flex-direction: column; overflow: hidden;
    background: var(--bg); border: 1px solid var(--line); border-radius: 20px;
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.55);
    animation: rise 220ms cubic-bezier(0.2, 0.9, 0.3, 1);
  }
  header { display: flex; gap: 14px; align-items: flex-start; padding: 22px 22px 14px; }
  .badge {
    flex: none; width: 44px; height: 44px; border-radius: 12px; display: grid; place-items: center;
    background: rgba(244, 33, 46, 0.14); color: var(--red);
  }
  .badge svg { width: 22px; height: 22px; fill: currentColor; }
  .heading { flex: 1; min-width: 0; }
  h2 { margin: 0; font-size: 20px; font-weight: 800; letter-spacing: -0.01em; }
  .sub { margin: 4px 0 0; color: var(--muted); font-size: 14px; }
  .icon-btn {
    flex: none; width: 34px; height: 34px; border: 0; border-radius: 999px; cursor: pointer;
    background: transparent; color: var(--muted); font-size: 20px; line-height: 1;
  }
  .icon-btn:hover { background: rgba(239, 243, 244, 0.1); color: var(--text); }

  .steps { list-style: none; margin: 0; padding: 4px 22px 8px; display: grid; gap: 14px; counter-reset: step; }
  .steps li { display: grid; grid-template-columns: 28px 1fr; gap: 12px; counter-increment: step; }
  .steps li::before {
    content: counter(step); width: 28px; height: 28px; border-radius: 999px; display: grid; place-items: center;
    background: var(--panel); border: 1px solid var(--line); font-size: 13px; font-weight: 700;
  }
  .steps li:first-child::before { background: var(--red); border-color: var(--red); color: #fff; }
  .steps b { display: block; font-weight: 700; }
  .steps span { color: var(--muted); font-size: 14px; }

  .progress { flex: 1; display: flex; flex-direction: column; min-height: 0; padding: 0 22px; }
  .bar { height: 6px; border-radius: 999px; background: var(--panel); overflow: hidden; }
  .fill {
    height: 100%; width: 0; border-radius: inherit; background: linear-gradient(90deg, var(--red), #ff5c69);
    transition: width 400ms ease;
  }
  .fill.indeterminate { width: 30% !important; animation: slide 1.2s ease-in-out infinite; }
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 14px 0; }
  .stat { padding: 10px 12px; border-radius: 12px; background: var(--panel); border: 1px solid var(--line); }
  .stat b { display: block; font-size: 20px; font-weight: 800; font-variant-numeric: tabular-nums; }
  .stat span { color: var(--muted); font-size: 12px; }
  .stat.muted b { color: var(--green); }
  .stat.failed b { color: var(--red); }
  .note {
    margin-bottom: 12px; padding: 10px 12px; border-radius: 12px; font-size: 14px;
    background: rgba(255, 173, 31, 0.1); color: var(--amber); border: 1px solid rgba(255, 173, 31, 0.25);
  }
  .list {
    scrollbar-color: var(--line) transparent;
    position: relative; flex: 1; list-style: none; margin: 0; padding: 0; overflow-y: auto; min-height: 120px;
    border: 1px solid var(--line); border-radius: 14px;
  }
  .list:empty::after {
    content: "Looking for members…"; display: block; padding: 40px 0; text-align: center; color: var(--muted);
  }
  .row { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-top: 1px solid var(--line); }
  .row:first-child { border-top: 0; }
  .row.muting { background: rgba(29, 155, 240, 0.08); }
  .avatar { flex: none; width: 36px; height: 36px; border-radius: 999px; background: var(--panel); object-fit: cover; }
  .who { flex: 1; min-width: 0; }
  .name, .handle { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .name { font-weight: 700; font-size: 14px; }
  .handle { color: var(--muted); font-size: 13px; }
  .chip {
    flex: none; display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px;
    font-size: 12px; font-weight: 700; background: var(--panel); color: var(--muted);
  }
  .chip::before { content: ""; width: 6px; height: 6px; border-radius: 999px; background: currentColor; }
  .chip.muting { color: var(--blue); background: rgba(29, 155, 240, 0.12); }
  .chip.muting::before { animation: pulse 1s ease-in-out infinite; }
  .chip.muted { color: var(--green); background: rgba(0, 186, 124, 0.12); }
  .chip.failed { color: var(--red); background: rgba(244, 33, 46, 0.12); }

  footer { display: flex; justify-content: flex-end; gap: 10px; padding: 16px 22px 20px; }
  .rescan { margin-right: auto; }
  .btn {
    min-width: 96px; padding: 10px 18px; border-radius: 999px; cursor: pointer;
    font: inherit; font-weight: 700; transition: background 120ms, transform 80ms;
  }
  .btn:active { transform: scale(0.97); }
  .btn.secondary { background: transparent; color: var(--text); border: 1px solid #536471; }
  .btn.secondary:hover { background: rgba(239, 243, 244, 0.1); }
  .btn.primary { background: var(--red); color: #fff; border: 1px solid var(--red); }
  .btn.primary:hover { background: #dc1e29; }
  .btn.primary.neutral { background: var(--text); color: var(--bg); border-color: var(--text); }

  .pill {
    position: fixed; left: 16px; bottom: 16px; z-index: 2147483646;
    display: inline-flex; align-items: center; gap: 8px; padding: 10px 16px; border-radius: 999px; cursor: pointer;
    background: var(--bg); color: var(--text); border: 1px solid var(--line);
    font: inherit; font-weight: 700; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  }
  .pill svg { width: 18px; height: 18px; fill: var(--red); }
  .pill:hover { background: var(--panel); }

  @keyframes fade { from { opacity: 0; } }
  @keyframes rise { from { opacity: 0; transform: translateY(12px) scale(0.98); } }
  @keyframes pulse { 50% { opacity: 0.3; } }
  @keyframes slide { from { transform: translateX(-100%); } to { transform: translateX(340%); } }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
`;

const ui = (() => {
  let els = null;

  function mount() {
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>${STYLES}</style>
      <div class="root">
        <div class="backdrop" hidden>
          <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="title">
            <header>
              <div class="badge">${MUTE_ICON}</div>
              <div class="heading">
                <h2 id="title"></h2>
                <p class="sub"></p>
              </div>
              <button class="icon-btn minimize" title="Minimize" aria-label="Minimize">&minus;</button>
            </header>
            <ol class="steps">
              <li><div><b>Press “Start muting”.</b><span>That’s the only thing you need to do.</span></div></li>
              <li><div><b>Members are muted as they’re found.</b><span>The list scrolls on its own, and each person is muted as soon as they appear, one every ${MUTE_DELAY_MS / 1000} seconds so X doesn’t block the requests.</span></div></li>
              <li><div><b>Keep this tab open until it finishes.</b><span>People you already muted with this extension are skipped. If X rate-limits you, it waits and continues automatically.</span></div></li>
            </ol>
            <section class="progress" hidden>
              <div class="bar"><div class="fill"></div></div>
              <div class="stats">
                <div class="stat muted"><b data-stat="muted">0</b><span>Muted</span></div>
                <div class="stat"><b data-stat="remaining">0</b><span>Remaining</span></div>
                <div class="stat failed"><b data-stat="failed">0</b><span>Failed</span></div>
                <div class="stat"><b data-stat="found">0</b><span>Found</span></div>
              </div>
              <div class="note" hidden></div>
              <ul class="list"></ul>
            </section>
            <footer>
              <button class="btn secondary rescan">Rescan list</button>
              <button class="btn secondary dismiss">Not now</button>
              <button class="btn primary action">Start muting</button>
            </footer>
          </div>
        </div>
        <button class="pill" hidden>${MUTE_ICON}<span></span></button>
      </div>
    `;
    document.body.append(host);

    const $ = (sel) => shadow.querySelector(sel);
    els = {
      backdrop: $('.backdrop'),
      title: $('#title'),
      sub: $('.sub'),
      steps: $('.steps'),
      progress: $('.progress'),
      fill: $('.fill'),
      note: $('.note'),
      list: $('.list'),
      dismiss: $('.dismiss'),
      rescan: $('.rescan'),
      action: $('.action'),
      pill: $('.pill'),
      pillText: $('.pill span'),
      stats: Object.fromEntries([...shadow.querySelectorAll('[data-stat]')].map((el) => [el.dataset.stat, el])),
    };

    $('.minimize').addEventListener('click', () => setOpen(false));
    els.dismiss.addEventListener('click', () => setOpen(false));
    els.rescan.addEventListener('click', () => start(true));
    els.pill.addEventListener('click', () => setOpen(true));
    els.action.addEventListener('click', () => {
      if (phase === 'intro') start();
      else if (phase === 'running') {
        stopRequested = true;
        els.action.disabled = true;
        els.action.textContent = 'Stopping…';
      } else {
        phase = 'intro';
        update();
        setOpen(false);
      }
    });
    update();
  }

  function setOpen(open) {
    if (!els) mount();
    els.backdrop.hidden = !open;
    els.pill.hidden = open;
  }

  function hide() {
    if (!els) return;
    els.backdrop.hidden = true;
    els.pill.hidden = true;
  }

  function reset() {
    els.list.replaceChildren();
    setNote('');
  }

  function addRow(member) {
    const row = document.createElement('li');
    row.className = 'row';
    const avatar = document.createElement('img');
    avatar.className = 'avatar';
    avatar.alt = '';
    if (member.avatar) avatar.src = member.avatar;
    const who = document.createElement('div');
    who.className = 'who';
    who.innerHTML = '<span class="name"></span><span class="handle"></span>';
    who.querySelector('.name').textContent = member.name;
    who.querySelector('.handle').textContent = `@${member.handle}`;
    const chip = document.createElement('span');
    row.append(avatar, who, chip);
    member.row = row;
    els.list.append(row);
    updateRow(member);
  }

  function updateRow(member) {
    const { row, status, detail } = member;
    row.className = `row ${status}`;
    const chip = row.lastElementChild;
    chip.className = `chip ${status}`;
    chip.textContent = STATUS_LABELS[status];
    chip.title = detail;
    // Keep the account being muted in view without touching the page scroll.
    if (status === 'muting') {
      els.list.scrollTop = row.offsetTop - els.list.clientHeight / 2 + row.offsetHeight / 2;
    }
  }

  function setNote(text) {
    if (!els) return;
    els.note.textContent = text;
    els.note.hidden = !text;
  }

  function update() {
    if (!els) return;
    const c = counts();
    const processed = c.muted + c.failed;
    const intro = phase === 'intro';

    els.steps.hidden = !intro;
    els.progress.hidden = intro;
    els.dismiss.hidden = !intro;
    els.rescan.hidden = true;
    els.action.disabled = phase === 'running' && stopRequested;
    els.action.classList.toggle('neutral', phase !== 'intro');
    for (const [key, el] of Object.entries(els.stats)) el.textContent = c[key];

    if (intro) {
      els.title.textContent = 'Mute everyone on this list';
      const stored = loadList(currentListId());
      els.rescan.hidden = !stored.members.length;
      els.sub.textContent = !stored.members.length
        ? 'Every member of this X list gets muted, one by one.'
        : stored.complete
          ? `${stored.members.length} members saved from your last scan, so muting starts right away without loading the list again.`
          : `${stored.members.length} members saved from an unfinished scan. Loading picks up where it left off.`;
      els.action.textContent = 'Start muting';
      els.pillText.textContent = 'Mute list members';
      return;
    }

    if (phase === 'running') {
      els.title.textContent = 'Muting list members';
      els.sub.textContent = collecting
        ? `Loading the member list and muting members as they appear, one every ${MUTE_DELAY_MS / 1000}s.`
        : `Found all ${c.found} members. About ${formatDuration(queue.length * MUTE_DELAY_MS)} left.`;
      if (!stopRequested) els.action.textContent = 'Stop';
      els.pillText.textContent = `Muting · ${processed}/${c.found}`;
    } else {
      els.title.textContent = stopRequested ? 'Stopped' : 'All done';
      els.sub.textContent = stopRequested
        ? `Muted ${c.muted} before stopping. Start again to continue where you left off.`
        : `Muted ${c.muted} accounts${c.alreadyMuted ? ` (${c.alreadyMuted} were already muted)` : ''}${c.failed ? `, ${c.failed} failed (hover a row to see why)` : ''}.`;
      els.action.textContent = 'Close';
      els.pillText.textContent = `Muted ${c.muted}`;
    }

    els.fill.classList.toggle('indeterminate', phase === 'running' && c.found === 0);
    els.fill.style.width = c.found ? `${(processed / c.found) * 100}%` : '0';
  }

  return { setOpen, hide, reset, addRow, updateRow, setNote, update };
})();

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

// X is a single-page app, so watch for navigation instead of relying on page loads.
let lastPath = null;
setInterval(() => {
  const path = location.pathname;
  if (path === lastPath) return;
  lastPath = path;

  const match = path.match(LIST_PATH);
  if (phase === 'running') return;
  if (!match) return ui.hide();

  let autostart = null;
  try {
    autostart = JSON.parse(sessionStorage.getItem(AUTOSTART_KEY));
  } catch {}
  if (match[2] && autostart?.id === match[1]) {
    sessionStorage.removeItem(AUTOSTART_KEY);
    ui.setOpen(true);
    run(autostart.rescan);
  } else {
    ui.setOpen(true);
  }
}, 500);
