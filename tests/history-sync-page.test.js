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

  async function flushMicrotasks(rounds = 8) {
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
