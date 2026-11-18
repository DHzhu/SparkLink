import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundService } from '../src/background.js';

const now = Date.UTC(2026, 10, 17, 6);
const day = 86400000;
const popup = { id: 'ext', url: 'chrome-extension://ext/src/popup/popup.html' };
const sender = (id) => ({ id: 'ext', frameId: 0, origin: 'https://x.com', url: 'https://x.com/alice', documentId: 'doc_' + id, tab: { id, active: true } });
function area() {
  const items = {};
  return {
    async setAccessLevel() {},
    async get(key) { return structuredClone(key in items ? { [key]: items[key] } : {}); },
    async set(values) { Object.assign(items, structuredClone(values)); }
  };
}

test('Manual history uses only the confirmed job tab, exact seven-day bounds, deduplication and cancellation', async () => {
  let clock = now;
  let activeId = 1;
  let nextId = 7;
  const opened = [];
  const api = {
    storage: { local: area(), session: area() },
    runtime: { id: 'ext', getURL: (p) => 'chrome-extension://ext/' + p },
    tabs: {
      async query() { return [{ id: activeId }]; },
      async sendMessage() { return { ok: true, alive: true }; },
      async create() { activeId = ++nextId; return { id: activeId }; },
      async update(id, opts) { opened.push([id, opts.url]); }
    }
  };
  let bg = createBackgroundService(api, { nowFn: () => clock });
  const call = (type, args = {}, from = popup) => bg.handleMessage({ type, ...args }, from);
  const start = () => call('START_HISTORY_SYNC', { actorUserId: '101' });
  assert.equal((await start()).ok, false);
  await call('SET_COLLECTION_ENABLED', { enabled: true });
  const bind = (id, actor = '101') => call('BIND_VIEWER', {
    captureSessionId: 1, viewer: { actorUserId: actor, handle: actor === '101' ? 'alice' : 'bob' }
  }, sender(id));
  await bind(1);
  assert.equal((await call('START_HISTORY_SYNC', { actorUserId: '102' })).ok, false);
  const { job } = await start();
  assert.equal(job.since, now - 7 * day);
  assert.equal(job.until, now);
  assert.deepEqual(opened, [[8, 'https://x.com/alice']]);
  assert.equal((await call('GET_HISTORY_SYNC_TASK', {}, sender(1))).job, null);
  assert.equal((await call('GET_HISTORY_SYNC_TASK', {}, sender(8))).job.id, job.id);
  assert.equal((await start()).job.id, job.id);
  const { bindingContext } = await bind(8);
  const ev = (replyTweetId, createdAt) => ({ actorUserId: '101', targetUserId: '202', parentTweetId: '303', replyTweetId, source: 'history', createdAt, observedAt: now });
  const page = {
    jobId: job.id, pageId: 'page-1', bindingContext,
    historyPage: { newestAt: now, pageKey: '10', ended: false },
    events: [ev('501', job.since), ev('502', now), ev('503', job.since - 1), ev('504', now + 1)]
  };
  assert.equal((await call('SYNC_HISTORY_PAGE', page, sender(1))).ok, false);
  const otherProfile = { ...sender(8), url: 'https://x.com/bob/with_replies' };
  assert.equal((await call('HELLO', {}, otherProfile)).historyScope, null);
  assert.equal((await call('SYNC_HISTORY_PAGE', page, otherProfile)).code, 'STALE_DOCUMENT');
  await call('SYNC_HISTORY_PAGE', page, sender(8));
  bg = createBackgroundService(api, { nowFn: () => clock });
  await call('SYNC_HISTORY_PAGE', page, sender(8));
  await call('SYNC_HISTORY_PAGE', { ...page, pageId: 'page-2', historyPage: { newestAt: null, pageKey: null, ended: true } }, sender(8));
  const result = await call('GET_POPUP_SNAPSHOT');
  assert.equal(result.historySync.status, 'done');
  assert.equal(result.historySync.pages, 2);
  assert.equal(result.historySync.added, 2);
  assert.equal(result.historySync.duplicates, 2);
  assert.equal(result.selectedAccount.summary.totalReplies, 2);
  await call('SUBMIT_OBSERVED_BATCH', { bindingContext, events: [ev('503', job.since - 1)] }, sender(8));
  assert.equal((await call('GET_POPUP_SNAPSHOT')).selectedAccount.summary.totalReplies, 2);
  assert.equal((await start()).code, 'COOLDOWN');
  clock += 15 * 60000;
  const next = (await start()).job;
  assert.notEqual(next.id, job.id);
  const retryAt = clock + 2 * 3600000;
  await bind(9);
  await call('STOP_HISTORY_SYNC_TASK', { jobId: next.id, reason: 'rate_limited', retryAt }, sender(9));
  assert.equal((await call('GET_POPUP_SNAPSHOT')).historyNextStart, retryAt);
  clock += 3600000;
  assert.equal((await start()).code, 'COOLDOWN');
  clock = retryAt;
  const third = (await start()).job;
  await call('CANCEL_HISTORY_SYNC', { jobId: third.id });
  const rebound = await bind(9);
  assert.equal((await call('SYNC_HISTORY_PAGE', { ...page, jobId: next.id, bindingContext: rebound.bindingContext }, sender(9))).ok, false);
  assert.equal((await call('GET_POPUP_SNAPSHOT')).historySync.status, 'cancelled');
});

test('Two distinct old pages are required for the seven-day boundary; the eighth page ends a partial run', async () => {
  const { createHistorySync } = await import('../src/history-sync.js');
  for (const reason of ['boundary', 'page_limit']) {
    const api = { storage: { local: area(), session: area() },
      tabs: { create: async () => ({ id: 7 }), update: async () => {} } };
    const service = createHistorySync(api, { mergeObservedBatch: async () => ({ ok: true, added: 0, duplicates: 0 }) }, () => now);
    const binding = { actorUserId: '4', captureSessionId: 1, accountGeneration: 1, collectionGeneration: 1 };
    const { job } = await service.start(binding, 'alice');
    const keys = reason === 'boundary' ? ['2', '2', '1'] : Array(8).fill('2');
    for (let index = 0; index < keys.length; index++) {
      const current = await service.read();
      assert.equal(current.status, 'running');
      await service.mergePage(current, { jobId: job.id, pageId: String(index), events: [],
        historyPage: { newestAt: job.since - 1, pageKey: keys[index], ended: false } }, binding);
    }
    assert.equal((await service.read()).reason, reason);
    assert.equal((await service.read()).status, reason === 'boundary' ? 'done' : 'partial');
  }
});

test('Foreground pagination grants one cursor per page, opens an active sync tab, and navigates across UTC day boundaries while keeping Worker logs silent by default', async (t) => {
  const { createHistorySync, matchesHistoryUrl, DEBUG_LOGS_KEY } = await import('../src/history-sync.js');
  let clock = Date.UTC(2026, 0, 2, 1);
  const urls = [];
  const workerLogs = [];
  t.mock.method(console, 'info', (...args) => {
    if (String(args[0] || '').includes('[SparkLink Sync/Worker]')) {
      workerLogs.push(args);
    }
  });
  const localArea = area();
  const api = { storage: { local: localArea, session: area() }, tabs: {
    async create(options) { assert.equal(options.active, true); return { id: 17 }; },
    async update(tab, options) { assert.equal(tab, 17); urls.push(options.url); }
  } };
  const sync = createHistorySync(api, { mergeObservedBatch: async () => ({ ok: true, added: 0, duplicates: 0 }) }, () => clock);
  const binding = { actorUserId: '17', captureSessionId: 1, accountGeneration: 1, collectionGeneration: 1 };
  await sync.start(binding, 'sam');
  assert.equal(workerLogs.length, 0);
  const merge = async (id, meta) => {
    const job = await sync.read();
    return sync.mergePage(job, { jobId: job.id, pageId: id, events: [], historyPage: meta }, binding);
  };
  await merge('first', { canPage: true });
  assert.equal(workerLogs.length, 0);
  await localArea.set({ [DEBUG_LOGS_KEY]: true });
  clock += 11999;
  assert.equal((await sync.advance(await sync.read(), 'next')).next, undefined);
  clock++;
  assert.equal((await sync.advance(await sync.read(), 'next')).next, true);
  assert.ok(workerLogs.length > 0);
  clock += 12000;
  assert.equal((await sync.advance(await sync.read(), 'next')).next, undefined);
  await merge('second', { canPage: false });
  clock += 12000;
  await sync.advance(await sync.read(), 'search');
  const firstDay = await sync.read();
  assert.ok(matchesHistoryUrl(firstDay, urls.at(-1)));
  assert.equal(matchesHistoryUrl(firstDay, 'https://x.com/search?f=live'), false);
  await sync.advance(firstDay, 'search');
  assert.equal(urls.length, 2);
  assert.equal((await merge('old', { searchQuery: 'old' })).code, 'STALE_DAY');
  await merge('today', { searchQuery: firstDay.searchQuery, ended: true });
  await merge('same day again', { searchQuery: firstDay.searchQuery });
  assert.equal((await sync.read()).pages, 3);
  clock += 12000;
  await sync.advance(await sync.read(), 'search');
  assert.match((await sync.read()).searchQuery, /since:2026-01-01 until:2026-01-02/);
  assert.equal(urls.length, 3);
});

test('An unobserved timeline falls back to eight search dates; a genuinely empty search day advances once', async () => {
  const { createHistorySync } = await import('../src/history-sync.js');
  let clock = now;
  const api = { storage: { local: area(), session: area() }, tabs: { create: async () => ({ id: 8 }), update: async () => {} } };
  const sync = createHistorySync(api, { mergeObservedBatch: async () => ({ ok: true, added: 0, duplicates: 0 }) }, () => clock);
  const binding = { actorUserId: '17', captureSessionId: 1, accountGeneration: 1, collectionGeneration: 1 };
  await sync.start(binding, 'sam');
  clock += 45000;
  const queries = new Set();
  for (let i = 0; i < 8; ++i) {
    await sync.advance(await sync.read(), 'search');
    const job = await sync.read();
    queries.add(job.searchQuery);
    await sync.mergePage(job, { jobId: job.id, pageId: String(i), events: [], historyPage: { searchQuery: job.searchQuery } }, binding);
    clock += 12000;
  }
  assert.equal(queries.size, 8);
  const result = await sync.read();
  assert.equal(result.reason, 'searched');
  assert.equal(result.added, 0);
});

test('Search mode paginates multi-page UTC days before advancing and completes all 8 days even after timeline pages', async () => {
  const { createHistorySync } = await import('../src/history-sync.js');
  let clock = now;
  const updatedUrls = [];
  const api = {
    storage: { local: area(), session: area() },
    tabs: { create: async () => ({ id: 8 }), update: async (_id, opts) => updatedUrls.push(opts.url) }
  };
  const sync = createHistorySync(api, { mergeObservedBatch: async () => ({ ok: true, added: 1, duplicates: 0 }) }, () => clock);
  const binding = { actorUserId: '17', captureSessionId: 1, accountGeneration: 1, collectionGeneration: 1 };
  await sync.start(binding, 'sam');

  // Read 2 timeline pages, then transition to search mode
  await sync.mergePage(await sync.read(), { jobId: (await sync.read()).id, pageId: 't1', events: [], historyPage: { canPage: true } }, binding);
  clock += 12000;
  assert.equal((await sync.advance(await sync.read(), 'next')).next, true);
  await sync.mergePage(await sync.read(), { jobId: (await sync.read()).id, pageId: 't2', events: [], historyPage: { canPage: false } }, binding);

  clock += 12000;
  await sync.advance(await sync.read(), 'search');
  let job = await sync.read();
  assert.equal(job.mode, 'search');

  // Day 1 has 2 pages via search cursor
  await sync.mergePage(job, { jobId: job.id, pageId: 's1a', events: [], historyPage: { searchQuery: job.searchQuery, canPage: true } }, binding);
  job = await sync.read();
  assert.equal(job.dayRead, false);
  assert.equal(job.hasNext, true);
  clock += 12000;
  assert.equal((await sync.advance(job, 'next')).next, true);
  await sync.mergePage(await sync.read(), { jobId: job.id, pageId: 's1b', events: [], historyPage: { searchQuery: job.searchQuery, canPage: false } }, binding);
  job = await sync.read();
  assert.equal(job.dayRead, true);
  assert.equal(job.hasNext, false);

  // Remaining 7 days each complete 1 page without hitting the timeline 8-page cap
  for (let d = 1; d < 8; d += 1) {
    clock += 12000;
    await sync.advance(await sync.read(), 'search');
    job = await sync.read();
    await sync.mergePage(job, { jobId: job.id, pageId: 'sd_' + d, events: [], historyPage: { searchQuery: job.searchQuery, canPage: false } }, binding);
  }
  const finalJob = await sync.read();
  assert.equal(finalJob.status, 'done');
  assert.equal(finalJob.reason, 'searched');
  assert.equal(finalJob.pages, 11);
});

test('HELLO on the active sync tab restores binding immediately across /with_replies navigation', async () => {
  const api = {
    storage: { local: area(), session: area() },
    runtime: { id: 'ext', getURL: (p) => 'chrome-extension://ext/' + p },
    tabs: {
      async query() { return [{ id: 1 }]; },
      async sendMessage() { return { ok: true, alive: true }; },
      async create() { return { id: 8 }; },
      async update() {}
    }
  };
  const bg = createBackgroundService(api, { nowFn: () => now });
  const call = (type, args = {}, from = popup) => bg.handleMessage({ type, ...args }, from);
  await call('SET_COLLECTION_ENABLED', { enabled: true });
  await call('BIND_VIEWER', { captureSessionId: 1, viewer: { actorUserId: '101', handle: 'alice' } }, sender(1));
  const { job } = await call('START_HISTORY_SYNC', { actorUserId: '101' });
  const navSender = { ...sender(8), url: 'https://x.com/alice/with_replies', documentId: 'doc_nav_2' };
  const hello = await call('HELLO', { origin: 'https://x.com' }, navSender);
  assert.equal(hello.ok, true);
  assert.equal(hello.historySyncId, job.id);
  assert.equal(hello.bindingContext.actorUserId, '101');
  assert.equal(hello.historyScope.actor, '101');

  const bindRes = await call('BIND_VIEWER', { captureSessionId: 1, viewer: { actorUserId: '101', handle: 'alice' } }, navSender);
  assert.equal(bindRes.ok, true);
  assert.equal(bindRes.historySyncId, job.id);
  assert.equal(bindRes.historyScope?.id, job.id);
  assert.equal(bindRes.historyScope?.actor, '101');
});

test('Audit regressions: BIND_VIEWER account switch clears historySyncId, read() persists timeout with END_HISTORY_TRANSPORT, and CLEAR_ACCOUNT / CLEAR_ALL tear down active sync and reset debugLogsEnabled', async () => {
  let clock = now;
  let activeId = 1;
  let nextId = 20;
  const tabMessages = [];
  const localArea = area();
  const sessionArea = area();
  const api = {
    storage: { local: localArea, session: sessionArea },
    runtime: { id: 'ext', getURL: (p) => 'chrome-extension://ext/' + p },
    tabs: {
      async query() { return [{ id: activeId }]; },
      async sendMessage(tabId, msg) { tabMessages.push({ tabId, msg }); return { ok: true, alive: true }; },
      async create() { activeId = ++nextId; return { id: activeId }; },
      async update() {}
    }
  };
  const bg = createBackgroundService(api, { nowFn: () => clock });
  const call = (type, args = {}, from = popup) => bg.handleMessage({ type, ...args }, from);

  await call('SET_COLLECTION_ENABLED', { enabled: true });
  await call('SET_DEBUG_LOGS', { enabled: true });
  await call('BIND_VIEWER', { captureSessionId: 1, viewer: { actorUserId: '101', handle: 'alice' } }, sender(1));

  // 1. Account switch on sync tab stops job first and does NOT leak alice's historySyncId onto bob
  const started1 = await call('START_HISTORY_SYNC', { actorUserId: '101' });
  const syncTab1 = activeId;
  await call('HELLO', { origin: 'https://x.com' }, sender(syncTab1));
  const bobBind = await call(
    'BIND_VIEWER',
    { captureSessionId: 1, viewer: { actorUserId: '102', handle: 'bob' } },
    sender(syncTab1)
  );
  assert.equal(bobBind.ok, true);
  assert.equal(bobBind.historySyncId, null);

  // Passive history event for bob (10 days old, within 30d window) on that tab must NOT be dropped
  const bobOldPassiveReply = {
    actorUserId: '102',
    targetUserId: '303',
    parentTweetId: '404',
    replyTweetId: '9001',
    source: 'history',
    createdAt: clock - 10 * day,
    observedAt: clock
  };
  const batchRes = await call(
    'SUBMIT_OBSERVED_BATCH',
    { bindingContext: bobBind.bindingContext, events: [bobOldPassiveReply], observedUsers: [] },
    sender(syncTab1)
  );
  assert.equal(batchRes.ok, true);
  assert.equal(batchRes.added, 1);
  assert.equal((await call('GET_POPUP_SNAPSHOT')).historySync.reason, 'account_changed');

  // 2. Timeout in read() persists status='partial', reason='timeout' into session storage and notifies sync tab
  clock += 16 * 60000;
  activeId = 1;
  await call('BIND_VIEWER', { captureSessionId: 1, viewer: { actorUserId: '101', handle: 'alice' } }, sender(1));
  const started2 = await call('START_HISTORY_SYNC', { actorUserId: '101' });
  const syncTab2 = activeId;
  assert.ok(started2.job?.id);
  tabMessages.length = 0;
  clock += 5 * 60000 + 1;
  const timedOutSnap = await call('GET_POPUP_SNAPSHOT');
  assert.equal(timedOutSnap.historySync.status, 'partial');
  assert.equal(timedOutSnap.historySync.reason, 'timeout');
  const rawStoredAfterTimeout = (await sessionArea.get('sparklink_history_sync')).sparklink_history_sync;
  assert.equal(rawStoredAfterTimeout.status, 'partial');
  assert.equal(rawStoredAfterTimeout.reason, 'timeout');
  assert.equal(
    tabMessages.some((m) => m.tabId === syncTab2 && m.msg?.type === 'END_HISTORY_TRANSPORT' && m.msg.jobId === started2.job.id),
    true
  );

  // 3. CLEAR_ACCOUNT while sync is running notifies END_HISTORY_TRANSPORT; CLEAR_ALL resets debugLogsEnabled in storage
  clock += 16 * 60000;
  activeId = 1;
  await call('BIND_VIEWER', { captureSessionId: 1, viewer: { actorUserId: '101', handle: 'alice' } }, sender(1));
  const started3 = await call('START_HISTORY_SYNC', { actorUserId: '101' });
  const syncTab3 = activeId;
  tabMessages.length = 0;
  const aliceSnap = await call('GET_POPUP_SNAPSHOT', { preferredActorUserId: '101' });
  const aliceAcc = aliceSnap.savedAccounts.find((a) => a.actorUserId === '101');
  const clearAccRes = await call('CLEAR_ACCOUNT', { actorUserId: '101', accountGeneration: aliceAcc.accountGeneration });
  assert.equal(clearAccRes.ok, true);
  assert.equal(
    tabMessages.some((m) => m.tabId === syncTab3 && m.msg?.type === 'END_HISTORY_TRANSPORT' && m.msg.jobId === started3.job.id),
    true
  );

  assert.equal((await call('GET_POPUP_SNAPSHOT')).debugLogsEnabled, true);
  const clearAllRes = await call('CLEAR_ALL');
  assert.equal(clearAllRes.ok, true);
  const afterClearAllSnap = await call('GET_POPUP_SNAPSHOT');
  assert.equal(afterClearAllSnap.debugLogsEnabled, false);
  // Rate-limit cooldown timestamp remains preserved across CLEAR_ALL
  assert.ok(afterClearAllSnap.historyNextStart > 0);
});

