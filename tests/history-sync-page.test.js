'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { installHistorySyncPage } = require('../src/history-sync-page.js');

function createFakeTimerHarness(startMs = 1_700_000_000_000) {
  let now = startMs;
  let nextId = 1;
  const timers = new Map();

  function nowFn() {
    return now;
  }

  function setTimeoutFn(fn, delayMs) {
    const id = nextId;
    nextId += 1;
    timers.set(id, {
      id,
      fn,
      runAt: now + Math.max(0, delayMs || 0)
    });
    return id;
  }

  function clearTimeoutFn(id) {
    timers.delete(id);
  }

  async function flushMicrotasks(rounds = 24) {
    for (let i = 0; i < rounds; i += 1) {
      await Promise.resolve();
    }
  }

  async function advanceBy(ms) {
    const target = now + ms;
    while (true) {
      let earliest = null;
      for (const entry of timers.values()) {
        if (entry.runAt <= target && (!earliest || entry.runAt < earliest.runAt)) {
          earliest = entry;
        }
      }
      if (!earliest) {
        break;
      }
      timers.delete(earliest.id);
      now = earliest.runAt;
      earliest.fn();
      await flushMicrotasks();
    }
    now = target;
    await flushMicrotasks();
  }

  return {
    nowFn,
    setTimeoutFn,
    clearTimeoutFn,
    advanceBy,
    flushMicrotasks,
    pendingCount: () => timers.size
  };
}

function makeAnchor({ href, role = null, hidden = false, ariaHidden = null, onClick = null }) {
  let clicks = 0;
  return {
    href,
    hidden,
    getAttribute(name) {
      if (name === 'href') return href;
      if (name === 'role') return role;
      if (name === 'aria-hidden') return ariaHidden;
      return null;
    },
    click() {
      clicks += 1;
      if (typeof onClick === 'function') {
        onClick(clicks);
      }
    },
    get clickCount() {
      return clicks;
    }
  };
}

function createMockPageEnv({
  url = 'https://x.com/Alice',
  isTop = true,
  visibilityState = 'visible',
  bindingContext = {
    bindingId: 'bind_1',
    actorUserId: '1001001',
    captureSessionId: 7,
    collectionGeneration: 1,
    accountGeneration: 1
  },
  anchors = [],
  scrollHeight = 4000,
  innerHeight = 800,
  taskHandler
} = {}) {
  const winListeners = new Map();
  const docListeners = new Map();
  const runtimeMessages = [];
  const scrollCalls = [];

  let currentUrl = new URL(url);
  let currentAnchors = anchors;
  let currentBinding = bindingContext;
  let currentVisibility = visibilityState;

  const scrollingElement = {
    scrollHeight,
    clientHeight: innerHeight,
    scrollTop: 0
  };

  const doc = {
    get visibilityState() {
      return currentVisibility;
    },
    set visibilityState(val) {
      currentVisibility = val;
    },
    scrollingElement,
    documentElement: scrollingElement,
    querySelectorAll(selector) {
      if (selector === 'a[href]') {
        return currentAnchors;
      }
      return [];
    },
    querySelector() {
      return null;
    },
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      if (docListeners.has(type)) docListeners.get(type).delete(fn);
    },
    emit(type, ev = {}) {
      const set = docListeners.get(type);
      if (set) {
        for (const fn of Array.from(set)) fn(ev);
      }
    }
  };

  const win = {
    document: doc,
    innerHeight,
    scrollY: 0,
    pageYOffset: 0,
    location: {
      get href() {
        return currentUrl.href;
      },
      get origin() {
        return currentUrl.origin;
      },
      get pathname() {
        return currentUrl.pathname;
      },
      get search() {
        return currentUrl.search;
      },
      get hash() {
        return currentUrl.hash;
      }
    },
    scrollTo(x, y) {
      scrollCalls.push({ kind: 'scrollTo', x, y });
      win.scrollY = y;
      win.pageYOffset = y;
      scrollingElement.scrollTop = y;
    },
    scrollBy(dx, dy) {
      scrollCalls.push({ kind: 'scrollBy', dx, dy });
      win.scrollY += dy;
      win.pageYOffset = win.scrollY;
      scrollingElement.scrollTop = win.scrollY;
    },
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, new Set());
      winListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      if (winListeners.has(type)) winListeners.get(type).delete(fn);
    },
    emit(type, ev = {}) {
      const set = winListeners.get(type);
      if (set) {
        for (const fn of Array.from(set)) fn(ev);
      }
    },
    __sparklinkIsolatedBridge: {
      getBindingContext() {
        return currentBinding;
      }
    }
  };
  win.top = isTop ? win : { other: true };

  const chromeObj = {
    runtime: {
      async sendMessage(msg) {
        runtimeMessages.push(msg);
        if (typeof taskHandler === 'function') {
          return taskHandler(msg);
        }
        return { ok: true, job: null };
      }
    }
  };

  return {
    win,
    doc,
    chromeObj,
    runtimeMessages,
    scrollCalls,
    scrollingElement,
    setUrl(nextUrl) {
      currentUrl = new URL(nextUrl);
    },
    setAnchors(nextAnchors) {
      currentAnchors = nextAnchors;
    },
    setBinding(nextBinding) {
      currentBinding = nextBinding;
    },
    setVisibility(nextVis) {
      currentVisibility = nextVis;
      doc.emit('visibilitychange');
    }
  };
}

function makeJob(overrides = {}) {
  return {
    id: 'job_7d_1',
    handle: 'Alice',
    actorUserId: '1001001',
    captureSessionId: 7,
    status: 'running',
    pages: 0,
    since: 1_699_000_000_000,
    until: 1_700_000_000_000,
    ...overrides
  };
}

function fixture(options = {}) {
  const timers = createFakeTimerHarness();
  const job = makeJob({ mode: 'timeline', actionAt: timers.nowFn(), pageAt: timers.nowFn(), deadline: timers.nowFn() + 300000 });
  const env = createMockPageEnv({ taskHandler: async () => ({ ok: true, job }), ...options });
  const start = () => installHistorySyncPage(env.win, env.chromeObj, timers);
  const stops = () => env.runtimeMessages.filter(m => m.type === 'STOP_HISTORY_SYNC_TASK');
  return { timers, job, env, start, stops };
}

test('Ordinary pages never scroll or keep polling; other origins and subframes are ignored', async () => {
  const f = fixture({ taskHandler: async () => ({ ok: true, job: null }) });
  await f.start().ready;
  await f.timers.advanceBy(120000);
  assert.equal(f.env.runtimeMessages.length, 1);
  assert.equal(f.env.scrollCalls.length, 0);
  assert.equal(fixture({ url: 'https://example.com/Alice' }).start(), null);
  assert.equal(fixture({ isTop: false }).start(), null);
});

test('The background tab opens the native Replies link, then asks the worker for a cursor grant without scrolling', async () => {
  const f = fixture({ bindingContext: null, visibilityState: 'hidden' });
  const link = makeAnchor({ href: '/Alice/with_replies', onClick: () => f.env.setUrl('https://x.com/Alice/with_replies') });
  f.env.setAnchors([makeAnchor({href: 'https://example.com/Alice/with_replies'}), link]);
  await f.start().ready;
  f.env.setBinding({ actorUserId: f.job.actorUserId, captureSessionId: f.job.captureSessionId });
  await f.timers.advanceBy(11999);
  assert.equal(link.clickCount, 0);
  await f.timers.advanceBy(1);
  assert.equal(link.clickCount, 1);
  Object.assign(f.job, { pages: 1, hasNext: true, pageAt: f.timers.nowFn() });
  await f.timers.advanceBy(11999);
  const advances = () => f.env.runtimeMessages.filter(m => m.type === 'ADVANCE_HISTORY_SYNC');
  assert.equal(advances().length, 0);
  await f.timers.advanceBy(1);
  assert.equal(advances()[0].action, 'next');
  assert.equal(f.env.scrollCalls.length, 0);
  f.env.setBinding({ actorUserId: '222', captureSessionId: f.job.captureSessionId });
  await f.timers.advanceBy(1500);
  assert.deepEqual(f.stops().map(m => m.reason), ['account_changed']);
});

test('An unobserved first page requests search fallback; challenge, cancellation and navigation stop any further work', async () => {
  for (const reason of ['first_page', 'verification', 'navigation', 'cancelled']) {
    const f = fixture({ url: 'https://x.com/Alice/with_replies' });
    await f.start().ready;
    if (reason === 'verification') f.env.setUrl('https://x.com/account/access');
    if (reason === 'navigation') f.env.setUrl('https://x.com/home');
    if (reason === 'cancelled') f.job.status = 'cancelled';
    await f.timers.advanceBy(45000);
    const actions = f.env.runtimeMessages.filter(m => m.type === 'ADVANCE_HISTORY_SYNC');
    assert.equal(actions.length, reason === 'first_page' ? 1 : 0);
    if (actions.length) assert.equal(actions[0].action, 'search');
    assert.deepEqual(f.stops().map(m => m.reason), ['verification','navigation'].includes(reason) ? [reason] : []);
    assert.equal(f.env.scrollCalls.length, 0);
  }
});

test('Hidden tab missing Replies link requests direct replies navigation, and search mode paginates within a day before advancing date', async () => {
  const f = fixture({ url: 'https://x.com/Alice', anchors: [] });
  await f.start().ready;
  await f.timers.advanceBy(12000);
  const advances = () => f.env.runtimeMessages.filter(m => m.type === 'ADVANCE_HISTORY_SYNC');
  assert.equal(advances().length, 1);
  assert.equal(advances()[0].action, 'replies');

  // Switch job to search mode with hasNext=true -> requests action: 'next' first
  const query = 'from:Alice filter:replies since:2026-11-16 until:2026-11-17';
  f.env.setUrl('https://x.com/search?' + new URLSearchParams({ q: query, f: 'live' }).toString());
  Object.assign(f.job, {
    mode: 'search',
    searchQuery: query,
    hasNext: true,
    dayRead: false,
    pageAt: f.timers.nowFn()
  });
  await f.timers.advanceBy(12000);
  assert.equal(advances().at(-1).action, 'next');

  // Once page finishes with dayRead=true and hasNext=false -> requests action: 'search'
  Object.assign(f.job, { hasNext: false, dayRead: true, pageAt: f.timers.nowFn() });
  await f.timers.advanceBy(12000);
  assert.equal(advances().at(-1).action, 'search');
});

test('Clicking native Replies link on profile with missingTimeline never jumps directly to search before /with_replies opens', async () => {
  const f = fixture({ url: 'https://x.com/Alice' });
  f.job.missingTimeline = true;
  const link = makeAnchor({ href: '/Alice/with_replies', onClick: () => f.env.setUrl('https://x.com/Alice/with_replies') });
  f.env.setAnchors([link]);
  await f.start().ready;
  await f.timers.advanceBy(12000);
  assert.equal(link.clickCount, 1);
  const advances = () => f.env.runtimeMessages.filter((m) => m.type === 'ADVANCE_HISTORY_SYNC');
  assert.equal(advances().filter((m) => m.action === 'search').length, 0);
});

test('Sync page logs are completely silent by default and emit [SparkLink Sync/Page] only when debugLogsEnabled is true', async () => {
  const pageLogs = [];
  let debugFlag = false;
  const timers = createFakeTimerHarness();
  const job = makeJob({ mode: 'timeline', actionAt: timers.nowFn(), pageAt: timers.nowFn(), deadline: timers.nowFn() + 300000 });
  const env = createMockPageEnv({
    url: 'https://x.com/Alice',
    taskHandler: async () => ({ ok: true, job, debugLogsEnabled: debugFlag })
  });
  env.win.navigator = { userAgent: 'Mozilla/5.0 Chrome/120.0.0.0' };
  env.win.console = {
    info(...args) {
      if (String(args[0] || '').includes('[SparkLink Sync/Page]')) {
        pageLogs.push(args);
      }
    }
  };
  const page = installHistorySyncPage(env.win, env.chromeObj, timers);
  await page.ready;
  await timers.advanceBy(12000);
  assert.equal(pageLogs.length, 0);

  debugFlag = true;
  await timers.advanceBy(1500);
  assert.ok(pageLogs.length > 0);
  page.destroy();
});

test('Sync page skips hidden / aria-hidden Replies anchors and falls back to UTC daily search when mid-timeline scroll stalls after 45s', async () => {
  const { createHistorySync, describeHistorySync } = await import('../src/history-sync.js');
  const timers = createFakeTimerHarness();
  const updatedUrls = [];
  const store = {};
  const area = {
    async get(k) { return k in store ? { [k]: structuredClone(store[k]) } : {}; },
    async set(v) { Object.assign(store, structuredClone(v)); }
  };
  const sync = createHistorySync(
    {
      storage: { local: area, session: area },
      tabs: { create: async () => ({ id: 9 }), update: async (_id, opts) => updatedUrls.push(opts.url) }
    },
    { mergeObservedBatch: async () => ({ ok: true, added: 1, duplicates: 0, conflicts: 0 }) },
    timers.nowFn
  );
  const binding = {
    bindingId: 'bind_1',
    actorUserId: '1001001',
    captureSessionId: 7,
    collectionGeneration: 1,
    accountGeneration: 1
  };
  await sync.start(binding, 'Alice');

  const hiddenAnchor = makeAnchor({ href: '/Alice/with_replies', hidden: true });
  const ariaHiddenAnchor = makeAnchor({ href: '/Alice/with_replies', ariaHidden: 'true' });
  let env;
  const visibleAnchor = makeAnchor({
    href: '/Alice/with_replies',
    onClick: () => env.setUrl('https://x.com/Alice/with_replies')
  });

  env = createMockPageEnv({
    url: 'https://x.com/Alice',
    bindingContext: binding,
    anchors: [hiddenAnchor, ariaHiddenAnchor, visibleAnchor],
    taskHandler: async (msg) => {
      if (msg.type === 'GET_HISTORY_SYNC_TASK') {
        return { ok: true, job: describeHistorySync(await sync.read()), debugLogsEnabled: false };
      }
      if (msg.type === 'ADVANCE_HISTORY_SYNC') {
        return sync.advance(await sync.read(), msg.action);
      }
      if (msg.type === 'STOP_HISTORY_SYNC_TASK') {
        return sync.stop(await sync.read(), msg.reason, msg.retryAt);
      }
      return { ok: true };
    }
  });
  env.win.__sparklinkIsolatedBridge.requestHistoryNext = () => {};

  const page = installHistorySyncPage(env.win, env.chromeObj, timers);
  await page.ready;
  await timers.advanceBy(12000);
  assert.equal(hiddenAnchor.clickCount, 0);
  assert.equal(ariaHiddenAnchor.clickCount, 0);
  assert.equal(visibleAnchor.clickCount, 1);

  // Page 1 arrives with canPage=true
  await sync.mergePage(
    await sync.read(),
    { jobId: (await sync.read()).id, pageId: 'p1', events: [], historyPage: { canPage: true, ended: false } },
    binding
  );

  // 12s later, 'next' scroll grant is issued
  await timers.advanceBy(12000);
  assert.equal((await sync.read()).attempts, 1);

  // 45s pass with NO Page 2 response -> must transition to 'search' mode (with partial=true) instead of terminating as 'stalled'
  await timers.advanceBy(45000);
  const afterStall = await sync.read();
  assert.equal(afterStall.status, 'running');
  assert.equal(afterStall.mode, 'search');
  assert.equal(afterStall.partial, true);
  assert.match(updatedUrls.at(-1), /^https:\/\/x\.com\/search\?/);
  page.destroy();
});

test('Real-timer default waits 6000ms on /<handle> before direct replies navigation so late Replies links still SPA-click cleanly', async () => {
  let clock = 1_700_000_000_000;
  const start = clock;
  let bridgeSub = null;
  const job = makeJob({
    mode: 'timeline',
    actionAt: start,
    pageAt: start,
    deadline: start + 300000
  });
  const env = createMockPageEnv({
    url: 'https://x.com/Alice',
    anchors: [],
    taskHandler: async () => ({ ok: true, job })
  });
  env.win.__sparklinkIsolatedBridge.subscribe = (fn) => {
    bridgeSub = fn;
    return () => {
      bridgeSub = null;
    };
  };

  // Omit setTimeoutFn so customTimers === false (production 6000ms gate), control elapsed via nowFn
  const page = installHistorySyncPage(env.win, env.chromeObj, { nowFn: () => clock });
  await page.ready;
  const repliesActions = () => env.runtimeMessages.filter((m) => m.type === 'ADVANCE_HISTORY_SYNC' && m.action === 'replies');
  assert.equal(repliesActions().length, 0);

  // At 2500ms with no link yet -> still waits instead of jumping early
  clock = start + 2500;
  bridgeSub({ type: 'BINDING_READY' });
  await new Promise((r) => setImmediate(r));
  assert.equal(repliesActions().length, 0);

  // Late link renders at 3500ms -> clicks SPA link rather than issuing chrome.tabs.update
  const lateAnchor = makeAnchor({
    href: '/Alice/with_replies',
    onClick: () => env.setUrl('https://x.com/Alice/with_replies')
  });
  env.setAnchors([lateAnchor]);
  clock = start + 3500;
  bridgeSub({ type: 'BINDING_READY' });
  await new Promise((r) => setImmediate(r));
  assert.equal(lateAnchor.clickCount, 1);
  assert.equal(repliesActions().length, 0);
  page.destroy();

  // Separate instance reaching >= 6000ms without an anchor falls back to action: 'replies'
  let clock2 = 1_700_000_100_000;
  const start2 = clock2;
  let bridgeSub2 = null;
  const job2 = makeJob({ id: 'job_7d_2', mode: 'timeline', actionAt: start2, pageAt: start2, deadline: start2 + 300000 });
  const env2 = createMockPageEnv({
    url: 'https://x.com/Alice',
    anchors: [],
    taskHandler: async () => ({ ok: true, job: job2 })
  });
  env2.win.__sparklinkIsolatedBridge.subscribe = (fn) => {
    bridgeSub2 = fn;
    return () => {
      bridgeSub2 = null;
    };
  };
  const page2 = installHistorySyncPage(env2.win, env2.chromeObj, { nowFn: () => clock2 });
  await page2.ready;
  clock2 = start2 + 6500;
  bridgeSub2({ type: 'BINDING_READY' });
  await new Promise((r) => setImmediate(r));
  assert.equal(env2.runtimeMessages.filter((m) => m.type === 'ADVANCE_HISTORY_SYNC' && m.action === 'replies').length, 1);
  page2.destroy();
});

test('History sync page controller triggers timeout stop when job.idleDeadline expires before job.deadline', async () => {
  const timers = createFakeTimerHarness(1_700_000_000_000);
  const start = timers.nowFn();
  let bridgeSub = null;
  const env = createMockPageEnv({
    url: 'https://x.com/Alice/with_replies',
    taskHandler: async () => ({
      ok: true,
      job: makeJob({
        mode: 'timeline',
        actionAt: start,
        pageAt: start,
        idleDeadline: start + 5 * 60000,
        deadline: start + 20 * 60000
      })
    })
  });
  env.win.__sparklinkIsolatedBridge.subscribe = (fn) => {
    bridgeSub = fn;
    return () => {
      bridgeSub = null;
    };
  };

  const page = installHistorySyncPage(env.win, env.chromeObj, {
    nowFn: timers.nowFn,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn
  });
  await page.ready;

  // Advance just past 5-minute idleDeadline (still 15 minutes before hard deadline)
  await timers.advanceBy(5 * 60000 + 1);
  if (bridgeSub) {
    bridgeSub({ type: 'BINDING_READY' });
    await timers.flushMicrotasks();
  }
  const stopMsgs = env.runtimeMessages.filter((m) => m.type === 'STOP_HISTORY_SYNC_TASK');
  assert.equal(stopMsgs.length, 1);
  assert.equal(stopMsgs[0].reason, 'timeout');
  page.destroy();
});



