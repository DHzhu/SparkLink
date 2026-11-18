import { isPlainObject, isValidDecimalId, sanitizeHandle } from './schema.js';

export const HISTORY_SYNC_KEY = 'sparklink_history_sync';
export const DEBUG_LOGS_KEY = 'sparklink_debug_logs';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RUNTIME_MS = 20 * 60 * 1000;
const MAX_IDLE_RUNTIME_MS = 5 * 60 * 1000;
export const MAX_PAGES = 80;
export const MAX_ITEMS = 1000;
const MAX_SEARCH_PAGES = 80;
const DAY_MS = 86400000;
const PACE_MS = 12000;
const utcDay = (ms) => Math.floor(ms / DAY_MS) * DAY_MS;
function queryForDay(handle, day) {
  const date = (ms) => new Date(ms).toISOString().slice(0, 10);
  return 'from:' + handle + ' filter:replies since:' + date(day) + ' until:' + date(day + DAY_MS);
}
export function matchesHistoryUrl(job, href) {
  try {
    const url = new URL(href);
    if (url.origin !== 'https://x.com' && url.origin !== 'https://twitter.com') return false;
    if (job.mode === 'search') return Boolean(job.searchQuery) && url.pathname === '/search' &&
      url.searchParams.get('f') === 'live' && url.searchParams.get('q') === job.searchQuery;
    const path = url.pathname.replace(/\/$/, '').toLowerCase();
    const profile = '/' + job.handle.toLowerCase();
    return path === profile || path === profile + '/with_replies';
  } catch { return false; }
}
const START_INTERVAL_MS = 15 * 60 * 1000;
const BLOCKED_INTERVAL_MS = 60 * 60 * 1000;
const COOLDOWN_KEY = 'sparklink_history_next_start';

export function describeHistorySync(job) {
  if (!job) return null;
  const { id, status, reason, actorUserId, handle, captureSessionId, since, until, pages, added, duplicates } = job;
  const actionAt = job.actionAt || until;
  const pageAt = job.pageAt || until;
  const lastActiveAt = Math.max(until, pageAt, actionAt);
  const deadline = until + MAX_RUNTIME_MS;
  const idleDeadline = lastActiveAt + MAX_IDLE_RUNTIME_MS;
  return { id, status, reason, actorUserId, handle, captureSessionId, since, until,
    mode: job.mode || 'timeline', searchQuery: job.searchQuery || null, dayRead: Boolean(job.dayRead),
    hasNext: Boolean(job.hasNext), missingTimeline: Boolean(job.missingTimeline), actionAt, pageAt,
    deadline, idleDeadline, nextTimeoutAt: Math.min(deadline, idleDeadline), pages, added, duplicates };
}

// The background service serializes job mutations with binding and storage writes.
export function createHistorySync(chromeApi, storage, now) {
  const area = chromeApi.storage.session;
  async function logSync(...args) {
    try {
      const raw = await chromeApi.storage?.local?.get?.(DEBUG_LOGS_KEY);
      if (!raw || raw[DEBUG_LOGS_KEY] !== true) return;
      if (typeof console !== 'undefined' && typeof console.info === 'function') {
        console.info('[SparkLink Sync/Worker]', ...args);
      }
    } catch {}
  }
  async function save(job) {
    await area.set({ [HISTORY_SYNC_KEY]: job });
    if (job && job.status !== 'running') {
      const minCooldown = now() + START_INTERVAL_MS;
      const existingCooldown = await nextStart();
      if (minCooldown > existingCooldown) {
        await chromeApi.storage.local.set({ [COOLDOWN_KEY]: minCooldown });
      }
      chromeApi.tabs?.sendMessage?.(job.tabId, { type: 'END_HISTORY_TRANSPORT', jobId: job.id })?.catch(() => {});
    }
    return job;
  }
  async function read() {
    const job = (await area.get(HISTORY_SYNC_KEY))[HISTORY_SYNC_KEY] || null;
    if (job?.status === 'running') {
      const lastActiveAt = Math.max(job.until, job.pageAt || job.until, job.actionAt || job.until);
      if (now() - lastActiveAt >= MAX_IDLE_RUNTIME_MS || now() - job.until >= MAX_RUNTIME_MS) {
        return save({ ...job, status: 'partial', reason: 'timeout' });
      }
    }
    return job;
  }
  // Only a timestamp persists across browser restarts. It contains no account data.
  async function nextStart() {
    const timestamp = (await chromeApi.storage.local.get(COOLDOWN_KEY))[COOLDOWN_KEY];
    return Number.isSafeInteger(timestamp) ? timestamp : 0;
  }
  async function start(binding, actorHandle) {
    const handle = sanitizeHandle(actorHandle);
    if (!handle) return { ok: false, message: '尚未识别账号用户名，请先打开本人的 X 主页。' };
    const until = now();
    const allowedAt = await nextStart();
    if (until < allowedAt) return { ok: false, code: 'COOLDOWN', message: '同步处于冷却期，请在提示的时间后手动启动。' };
    let tab;
    try {
      tab = await chromeApi.tabs.create({ url: 'about:blank', active: true });
    } catch {
      return { ok: false, message: '浏览器未能打开同步标签页。' };
    }
    const job = {
      id: crypto.randomUUID(), tabId: tab.id, handle, actorUserId: binding.actorUserId,
      accountGeneration: binding.accountGeneration, collectionGeneration: binding.collectionGeneration,
      captureSessionId: binding.captureSessionId, since: until - WEEK_MS, until,
      status: 'running', reason: null, pages: 0, searchPages: 0, added: 0, duplicates: 0,
      mode: 'timeline', actionAt: until, pageAt: until, requestedAfterPage: null, attempts: 0, searchAttempts: 0,
      navigatedReplies: false, previousOldKey: null, partial: false, receipts: []
    };
    try {
      await save(job);
      await chromeApi.storage.local.set({ [COOLDOWN_KEY]: until + START_INTERVAL_MS });
      await chromeApi.tabs.update(tab.id, { url: 'https://x.com/' + handle });
      await logSync('start job', { id: job.id, tabId: tab.id, handle, since: new Date(job.since).toISOString(), until: new Date(job.until).toISOString() });
    } catch {
      await chromeApi.tabs.remove?.(tab.id).catch(() => {});
      await save({ ...job, status: 'partial', reason: 'navigation' });
      return { ok: false, message: '未能打开 X 主页，请重试。' };
    }
    return { ok: true, job: describeHistorySync(job) };
  }
  async function stop(job, reason, retryAt) {
    if (job?.status === 'running') {
      await logSync('stop signal', { id: job.id, mode: job.mode, reason, retryAt: retryAt || null, pages: job.pages, added: job.added });
      if (reason === 'unrecognized' && job.mode === 'timeline') {
        await save({ ...job, hasNext: false, missingTimeline: true, partial: true });
        return { ok: true };
      }
      const blocked = reason === 'rate_limited' || reason === 'verification';
      if (blocked || (reason === 'unavailable' && retryAt > now())) {
        const deadline = Math.max(await nextStart(), blocked ? now() + BLOCKED_INTERVAL_MS : 0,
          Number.isSafeInteger(retryAt) && retryAt <= 8640000000000000 ? retryAt : 0);
        await chromeApi.storage.local.set({ [COOLDOWN_KEY]: deadline });
      }
      await save({ ...job, status: reason === 'cancelled' ? 'cancelled' : 'partial', reason });
    }
    return { ok: true };
  }
  function matches(job, binding) {
    return Boolean(job && binding && job.actorUserId === binding.actorUserId &&
      job.captureSessionId === binding.captureSessionId && job.accountGeneration === binding.accountGeneration &&
      job.collectionGeneration === binding.collectionGeneration);
  }
  async function advance(job, action) {
    if (job.status !== 'running') return { ok: false, code: 'SYNC_STOPPED' };
    const time = now();
    if (action === 'replies') {
      if (job.mode !== 'timeline' || job.pages > 0 || job.navigatedReplies) return { ok: true };
      const next = { ...job, navigatedReplies: true, actionAt: time };
      await save(next);
      await logSync('advance -> replies', { id: job.id, url: 'https://x.com/' + job.handle + '/with_replies' });
      try {
        await chromeApi.tabs.update(job.tabId, { url: 'https://x.com/' + job.handle + '/with_replies' });
      } catch { return stop(next, 'navigation'); }
      return { ok: true, navigated: true };
    }
    if (time - Math.max(job.actionAt || job.until, job.pageAt || job.until) < PACE_MS) return { ok: true };
    if (action === 'next') {
      if (job.mode === 'search') {
        if ((job.searchAttempts || 0) >= MAX_SEARCH_PAGES) return stop(job, 'page_limit');
        if (!job.hasNext || job.requestedAfterPage === job.pages) return { ok: true };
        await save({ ...job, requestedAfterPage: job.pages, actionAt: time, searchAttempts: (job.searchAttempts || 0) + 1 });
        await logSync('advance -> next (search)', { id: job.id, pages: job.pages, searchAttempts: (job.searchAttempts || 0) + 1 });
        return { ok: true, next: true };
      }
      if ((job.attempts || 0) >= MAX_PAGES) return stop(job, 'page_limit');
      if (!job.hasNext || job.requestedAfterPage === job.pages) return { ok: true };
      await save({ ...job, requestedAfterPage: job.pages, actionAt: time, attempts: (job.attempts || 0) + 1 });
      await logSync('advance -> next (timeline)', { id: job.id, pages: job.pages, attempts: (job.attempts || 0) + 1 });
      return { ok: true, next: true };
    }
    if ((job.searchAttempts || 0) >= MAX_SEARCH_PAGES) return stop(job, 'page_limit');
    if (action !== 'search' || (job.mode === 'search' && (!job.dayRead || job.hasNext))) return { ok: true };
    if (job.mode === 'timeline') {
      const lastProgressAt = Math.max(job.actionAt || job.until, job.pageAt || job.until);
      if (job.hasNext && time - lastProgressAt < 45000) return { ok: true };
      if (!job.hasNext && !job.pages && !job.missingTimeline && time - job.until < 45000) return { ok: true };
    }
    const stalledOnTimeline = Boolean(job.timelineStalled || (job.mode === 'timeline' && job.hasNext));
    const day = job.mode === 'search' ? job.day - DAY_MS : utcDay(job.until);
    const query = queryForDay(job.handle, day);
    const next = { ...job, mode: 'search', day, searchQuery: query, dayRead: false, hasNext: false,
      partial: Boolean(job.partial || stalledOnTimeline), timelineStalled: stalledOnTimeline,
      requestedAfterPage: null, actionAt: time, searchAttempts: (job.searchAttempts || 0) + 1 };
    await save(next);
    await logSync('advance -> search', { id: job.id, prevMode: job.mode, pages: job.pages, missingTimeline: Boolean(job.missingTimeline), query });
    try {
      const url = new URL('https://x.com/search');
      url.search = new URLSearchParams({ q: query, f: 'live', src: 'typed_query' }).toString();
      await chromeApi.tabs.update(job.tabId, { url: url.href });
    } catch { return stop(next, 'navigation'); }
    return { ok: true };
  }
  async function mergePage(job, msg, binding) {
    if (!job || job.id !== msg.jobId || !matches(job, binding)) return { ok: false, code: 'STALE_BINDING' };
    if (typeof msg.pageId !== 'string' || !msg.pageId || msg.pageId.length > 128 ||
        !Array.isArray(msg.events) || msg.events.length > 1000 || !isPlainObject(msg.historyPage)) {
      return { ok: false, code: 'INVALID_PAGE' };
    }
    if (job.receipts.includes(msg.pageId)) return { ok: true };
    if (job.status !== 'running') return { ok: false, code: 'SYNC_STOPPED' };
    if (job.mode === 'search') {
      if (msg.historyPage.searchQuery !== job.searchQuery) return { ok: false, code: 'STALE_DAY' };
      if (job.dayRead) return { ok: true };
    } else if (msg.historyPage.searchQuery) return { ok: false, code: 'STALE_DAY' };
    const inWindowEvents = msg.events.filter((event) => event?.source === 'history' &&
      event.actorUserId === job.actorUserId && Number.isSafeInteger(event.createdAt) &&
      event.createdAt >= job.since && event.createdAt <= job.until);
    const remainingItems = Math.max(0, MAX_ITEMS - (job.added + job.duplicates));
    const events = inWindowEvents
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, remainingItems);
    const merged = await storage.mergeObservedBatch({ bindingContext: binding, events, observedUsers: [] });
    if (!merged.ok) {
      await stop(job, 'storage');
      return merged;
    }
    const { newestAt, pageKey, ended } = msg.historyPage;
    const oldKey = Number.isSafeInteger(newestAt) && newestAt > 0 && newestAt < job.since &&
      isValidDecimalId(pageKey) ? pageKey : null;
    const crossedBoundary = oldKey && job.previousOldKey && oldKey !== job.previousOldKey;
    const crossedWindowInSearch = Number.isSafeInteger(newestAt) && newestAt > 0 && newestAt < job.since;
    const totalItems = job.added + merged.added + job.duplicates + merged.duplicates;
    const reachedItemLimit = totalItems >= MAX_ITEMS;
    const canContinueDay = !reachedItemLimit && job.mode === 'search' && msg.historyPage.canPage === true &&
      ended !== true && !crossedWindowInSearch;
    const unrecognized = Boolean(job.unrecognized || job.missingTimeline || msg.partial === true || merged.conflicts > 0);
    const partial = Boolean(job.partial || unrecognized);
    const nextSearchPages = (job.searchPages || 0) + (job.mode === 'search' ? 1 : 0);
    const next = {
      ...job, pages: job.pages + 1, searchPages: nextSearchPages, added: job.added + merged.added, duplicates: job.duplicates + merged.duplicates,
      pageAt: now(), hasNext: reachedItemLimit ? false : (job.mode === 'search' ? canContinueDay : msg.historyPage.canPage === true),
      dayRead: job.mode === 'search' && !reachedItemLimit && !canContinueDay, previousOldKey: oldKey, partial, unrecognized, receipts: [...job.receipts, msg.pageId]
    };
    if (reachedItemLimit) {
      next.status = partial ? 'partial' : 'done';
      next.reason = partial ? 'unrecognized' : 'item_limit';
    } else if (job.mode === 'search' && next.dayRead && job.day <= utcDay(job.since)) {
      next.status = partial ? 'partial' : 'done';
      next.reason = unrecognized ? 'unrecognized' : 'searched';
    } else if (job.mode !== 'search' && (ended === true || crossedBoundary)) {
      next.status = partial ? 'partial' : 'done';
      next.reason = partial ? 'unrecognized' : ended === true ? 'end' : 'boundary';
    } else if ((job.mode !== 'search' && next.pages >= MAX_PAGES) ||
               (job.mode === 'search' && nextSearchPages >= MAX_SEARCH_PAGES)) {
      next.status = 'partial';
      next.reason = 'page_limit';
    }
    await save(next);
    await logSync('mergePage', {
      mode: job.mode,
      pages: next.pages,
      rawEvents: msg.events.length,
      inWindowEvents: events.length,
      added: merged.added,
      duplicates: merged.duplicates,
      newestAt: newestAt ? new Date(newestAt).toISOString() : null,
      canPage: msg.historyPage.canPage === true,
      hasNext: next.hasNext,
      ended: ended === true,
      crossedBoundary: Boolean(crossedBoundary),
      status: next.status,
      reason: next.reason
    });
    return merged;
  }
  async function forget() {
    const current = (await area.get(HISTORY_SYNC_KEY))[HISTORY_SYNC_KEY] || null;
    await save(null);
    if (current?.status === 'running') {
      chromeApi.tabs?.sendMessage?.(current.tabId, {
        type: 'END_HISTORY_TRANSPORT',
        jobId: current.id,
        clearSyncId: true
      })?.catch(() => {});
    }
    return null;
  }
  return { read, start, stop, matches, advance, nextStart, mergePage, forget };
}
