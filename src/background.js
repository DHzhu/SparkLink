import {
  SESSION_BINDINGS_KEY,
  isPlainObject,
  hasDangerousKeys,
  isValidDecimalId
} from './schema.js';
import { createStorageController } from './storage.js';
import { DEBUG_LOGS_KEY, createHistorySync, describeHistorySync, matchesHistoryUrl } from './history-sync.js';

const ALLOWED_X_ORIGINS = new Set(['https://x.com', 'https://twitter.com']);
const MAX_TRACKED_TABS = 64;

const POPUP_ONLY_TYPES = new Set([
  'GET_POPUP_SNAPSHOT',
  'SET_POPUP_ACCOUNT',
  'START_HISTORY_SYNC',
  'CANCEL_HISTORY_SYNC',
  'SET_COLLECTION_ENABLED',
  'SET_DEBUG_LOGS',
  'CLEANUP_EXPIRED',
  'EXPORT_BACKUP',
  'PREVIEW_IMPORT',
  'COMMIT_IMPORT',
  'CLEAR_ACCOUNT',
  'CLEAR_ALL'
]);

const CONTENT_SCRIPT_TYPES = new Set([
  'HELLO',
  'BIND_VIEWER',
  'REVOKE_VIEWER_BINDING',
  'SUBMIT_OBSERVED_BATCH',
  'GET_HISTORY_SYNC_TASK',
  'STOP_HISTORY_SYNC_TASK',
  'ADVANCE_HISTORY_SYNC',
  'SYNC_HISTORY_PAGE',
  'QUERY_TARGET_COUNTS',
  'REPORT_DIAGNOSTIC'
]);

function generateBindingId() {
  if (typeof crypto === 'object' && crypto && typeof crypto.randomUUID === 'function') {
    return `bind_${crypto.randomUUID()}`;
  }
  return `bind_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

function bindingMatchesState(bindingCtx, ctrlState) {
  if (!isPlainObject(bindingCtx) || !ctrlState || !ctrlState.ok) {
    return false;
  }
  if (!ctrlState.settings.collectionEnabled || ctrlState.settings.captureSessionId === null) {
    return false;
  }
  if (
    bindingCtx.captureSessionId !== ctrlState.settings.captureSessionId ||
    bindingCtx.collectionGeneration !== ctrlState.collectionGeneration
  ) {
    return false;
  }
  const expectedAccGen = ctrlState.accountGenerations[bindingCtx.actorUserId];
  if (!expectedAccGen || bindingCtx.accountGeneration !== expectedAccGen) {
    return false;
  }
  return true;
}

function bindingEquals(a, b) {
  return (
    isPlainObject(a) &&
    isPlainObject(b) &&
    a.bindingId === b.bindingId &&
    a.actorUserId === b.actorUserId &&
    a.captureSessionId === b.captureSessionId &&
    a.collectionGeneration === b.collectionGeneration &&
    a.accountGeneration === b.accountGeneration
  );
}

export function createBackgroundService(chromeApi, options = {}) {
  if (!chromeApi || !chromeApi.storage || !chromeApi.runtime) {
    throw new TypeError('Valid chrome extension API required');
  }

  const nowFn = typeof options.nowFn === 'function' ? options.nowFn : () => Date.now();
  const storage =
    options.storageController ||
    createStorageController(chromeApi.storage.local, {
      nowFn,
      ...options.storageOptions
    });

  const history = createHistorySync(chromeApi, storage, nowFn);
  let bootPromise = null;
  let sessionTabsCache = null; // Map<string(tabId), TabSessionRecord>
  let sessionWriteTail = Promise.resolve();

  async function persistSessionTabs() {
    if (!chromeApi.storage.session) {
      return;
    }
    const obj = {};
    for (const [k, v] of sessionTabsCache.entries()) {
      obj[k] = v;
    }
    await chromeApi.storage.session.set({
      [SESSION_BINDINGS_KEY]: obj
    });
  }

  function createAccessLevelInitError() {
    const err = new Error(
      '本地存储访问隔离初始化失败（TRUSTED_CONTEXTS 未生效），暂不允许开启采集，请重试。'
    );
    err.code = 'ACCESS_LEVEL_INIT_FAILED';
    return err;
  }

  function enqueueSessionOp(fn) {
    const run = async () => {
      try {
        await ensureBooted();
        return await fn();
      } catch (err) {
        if (err && err.code === 'ACCESS_LEVEL_INIT_FAILED') {
          return { ok: false, code: 'ACCESS_LEVEL_INIT_FAILED', message: err.message };
        }
        throw err;
      }
    };
    const p = sessionWriteTail.then(run, run);
    sessionWriteTail = p.then(
      () => undefined,
      () => undefined
    );
    return p;
  }

  async function doBoot() {
    // Section 6.3: Enforce TRUSTED_CONTEXTS on both storage areas BEFORE handling business messages
    if (
      !chromeApi.storage.local ||
      typeof chromeApi.storage.local.setAccessLevel !== 'function' ||
      !chromeApi.storage.session ||
      typeof chromeApi.storage.session.setAccessLevel !== 'function'
    ) {
      throw createAccessLevelInitError();
    }
    try {
      await chromeApi.storage.local.setAccessLevel({
        accessLevel: 'TRUSTED_CONTEXTS'
      });
      await chromeApi.storage.session.setAccessLevel({
        accessLevel: 'TRUSTED_CONTEXTS'
      });
    } catch (_err) {
      throw createAccessLevelInitError();
    }

    const storageBoot = await storage.init();
    sessionTabsCache = new Map();

    if (chromeApi.storage.session) {
      if (storageBoot.migratedOnBoot) {
        // Section 7.1: Legacy v1 -> v2 migration requires all documents to rebind
        await persistSessionTabs();
      } else {
        try {
          const raw = await chromeApi.storage.session.get(SESSION_BINDINGS_KEY);
          const storedTabs =
            isPlainObject(raw) && isPlainObject(raw[SESSION_BINDINGS_KEY])
              ? raw[SESSION_BINDINGS_KEY]
              : {};
          for (const [tabKey, entry] of Object.entries(storedTabs)) {
            if (isPlainObject(entry) && Number.isInteger(entry.tabId)) {
              sessionTabsCache.set(tabKey, entry);
            }
          }
        } catch (_err) {
          sessionTabsCache = new Map();
        }
      }
    }
  }

  function ensureBooted() {
    if (!bootPromise) {
      bootPromise = doBoot().catch((err) => {
        bootPromise = null;
        throw err;
      });
    }
    return bootPromise;
  }

  function syncExclusiveActiveTab(tabKey, isActive) {
    if (!isActive || !sessionTabsCache) {
      return;
    }
    for (const [k, entry] of sessionTabsCache.entries()) {
      if (k !== tabKey && entry.active) {
        entry.active = false;
      }
    }
  }

  function upsertSessionTab(tabKey, record) {
    syncExclusiveActiveTab(tabKey, Boolean(record.active));
    if (sessionTabsCache.has(tabKey)) {
      sessionTabsCache.delete(tabKey);
    }
    sessionTabsCache.set(tabKey, record);
    while (sessionTabsCache.size > MAX_TRACKED_TABS) {
      const oldestKey = sessionTabsCache.keys().next().value;
      sessionTabsCache.delete(oldestKey);
    }
  }

  function notifyTabs(filterFn, message) {
    if (!chromeApi.tabs || typeof chromeApi.tabs.sendMessage !== 'function' || !sessionTabsCache) {
      return;
    }
    for (const entry of sessionTabsCache.values()) {
      if (!filterFn || filterFn(entry)) {
        try {
          const p = chromeApi.tabs.sendMessage(entry.tabId, message);
          if (p && typeof p.catch === 'function') {
            p.catch(() => {});
          }
        } catch (_err) {
          // Tab may already be closed
        }
      }
    }
  }

  function isPopupSender(sender) {
    if (!isPlainObject(sender) || sender.id !== chromeApi.runtime.id) {
      return false;
    }
    if (sender.tab) {
      return false;
    }
    if (typeof sender.url !== 'string') {
      return false;
    }
    const popupBaseUrl = chromeApi.runtime.getURL('src/popup/popup.html');
    return sender.url === popupBaseUrl || sender.url.startsWith(`${popupBaseUrl}?`) || sender.url.startsWith(`${popupBaseUrl}#`);
  }

  function extractTopXContentSender(sender) {
    if (!isPlainObject(sender) || sender.id !== chromeApi.runtime.id) {
      return null;
    }
    if (!isPlainObject(sender.tab) || !Number.isInteger(sender.tab.id) || sender.tab.id < 0) {
      return null;
    }
    // Must be top-level frame only (Section 6.1)
    if (sender.frameId !== 0) {
      return null;
    }
    let senderOrigin = typeof sender.origin === 'string' ? sender.origin : null;
    if (!senderOrigin && typeof sender.url === 'string') {
      try {
        senderOrigin = new URL(sender.url).origin;
      } catch (_err) {
        senderOrigin = null;
      }
    }
    if (!senderOrigin || !ALLOWED_X_ORIGINS.has(senderOrigin)) {
      return null;
    }
    return {
      tabId: sender.tab.id,
      tabKey: String(sender.tab.id),
      active: Boolean(sender.tab.active),
      documentId: typeof sender.documentId === 'string' && sender.documentId ? sender.documentId : null,
      href: sender.url,
      origin: senderOrigin
    };
  }

  function scopedHistoryId(job, sender, existing, actorUserId = null) {
    if (job?.status === 'running' && job.tabId === sender.tabId) {
      return !actorUserId || job.actorUserId === actorUserId ? job.id : null;
    }
    // Retain the filter for late responses from the manual document of the same viewer only.
    if (existing?.documentId !== sender.documentId || !existing?.historySyncId) {
      return null;
    }
    const existingActorId = existing.bindingContext?.actorUserId || existing.lastConfirmedActorUserId || null;
    if (actorUserId && existingActorId && existingActorId !== actorUserId) {
      return null;
    }
    if (actorUserId && job && existing.historySyncId === job.id && job.actorUserId !== actorUserId) {
      return null;
    }
    return existing.historySyncId;
  }

  function emptyDiagnostics() {
    return {
      liveCaptureAnomaly: false,
      historyBackfillAnomaly: false,
      partialUnrecognized: false,
      incompleteObservation: false,
      observationDropped: false
    };
  }

  async function resolveForegroundTabEntry() {
    if (chromeApi.tabs && typeof chromeApi.tabs.query === 'function') {
      let queriedTabs = [];
      try {
        queriedTabs = await chromeApi.tabs.query({ active: true, lastFocusedWindow: true });
        if (!Array.isArray(queriedTabs) || queriedTabs.length === 0) {
          queriedTabs = await chromeApi.tabs.query({ active: true, currentWindow: true });
        }
      } catch (_err) {
        queriedTabs = [];
      }
      const fgTab = Array.isArray(queriedTabs) && queriedTabs.length > 0 ? queriedTabs[0] : null;
      if (!fgTab || !Number.isInteger(fgTab.id)) {
        return null;
      }
      if (typeof fgTab.url === 'string' && fgTab.url.length > 0) {
        try {
          if (!ALLOWED_X_ORIGINS.has(new URL(fgTab.url).origin)) {
            return null;
          }
        } catch (_err) {
          return null;
        }
      }
      const tabKey = String(fgTab.id);
      const cachedEntry = sessionTabsCache.get(tabKey) || null;
      if (
        cachedEntry &&
        typeof fgTab.url !== 'string' &&
        typeof chromeApi.tabs.sendMessage === 'function'
      ) {
        try {
          await chromeApi.tabs.sendMessage(fgTab.id, { type: 'PING_X_TAB' }, { frameId: 0 });
        } catch (_err) {
          sessionTabsCache.delete(tabKey);
          await persistSessionTabs();
          return null;
        }
      }
      return cachedEntry;
    }

    const activeCandidates = Array.from(sessionTabsCache.values())
      .filter((entry) => Boolean(entry.active))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return activeCandidates.length > 0 ? activeCandidates[0] : null;
  }

  async function resolveActivePopupContext() {
    const ctrl = await storage.getControlState();
    if (!ctrl.ok) {
      return {
        activeActorUserId: null,
        manualSelectedActorUserId: null,
        lastConfirmedActorUserId: null,
        viewerStatus: 'storage_error',
        diagnostics: emptyDiagnostics()
      };
    }

    const fgEntry = await resolveForegroundTabEntry();
    const lastConfirmedActorUserId =
      fgEntry &&
      isValidDecimalId(fgEntry.lastConfirmedActorUserId) &&
      ctrl.accountGenerations &&
      ctrl.accountGenerations[fgEntry.lastConfirmedActorUserId]
        ? fgEntry.lastConfirmedActorUserId
        : null;
    const manualSelectedActorUserId =
      fgEntry &&
      isValidDecimalId(fgEntry.manualSelectedActorUserId) &&
      ctrl.accountGenerations &&
      ctrl.accountGenerations[fgEntry.manualSelectedActorUserId]
        ? fgEntry.manualSelectedActorUserId
        : null;

    if (!ctrl.settings.collectionEnabled) {
      return {
        activeActorUserId: null,
        allowLocalSelection: !fgEntry,
        manualSelectedActorUserId,
        lastConfirmedActorUserId,
        viewerStatus: 'paused',
        diagnostics: emptyDiagnostics()
      };
    }

    if (!fgEntry) {
      return {
        activeActorUserId: null,
        allowLocalSelection: true,
        manualSelectedActorUserId: null,
        lastConfirmedActorUserId: null,
        viewerStatus: 'no_x_tab',
        diagnostics: emptyDiagnostics()
      };
    }

    const diagnostics = {
      liveCaptureAnomaly: Boolean(fgEntry.diagnostics && fgEntry.diagnostics.liveCaptureAnomaly),
      historyBackfillAnomaly: Boolean(
        fgEntry.diagnostics && fgEntry.diagnostics.historyBackfillAnomaly
      ),
      partialUnrecognized: Boolean(fgEntry.diagnostics && fgEntry.diagnostics.partialUnrecognized),
      incompleteObservation: Boolean(
        fgEntry.diagnostics && fgEntry.diagnostics.incompleteObservation
      ),
      observationDropped: Boolean(fgEntry.diagnostics && fgEntry.diagnostics.observationDropped)
    };

    if (fgEntry.bindingContext && bindingMatchesState(fgEntry.bindingContext, ctrl)) {
      return {
        activeActorUserId: fgEntry.bindingContext.actorUserId,
        manualSelectedActorUserId,
        lastConfirmedActorUserId: fgEntry.bindingContext.actorUserId,
        viewerStatus: 'bound',
        diagnostics
      };
    }

    return {
      activeActorUserId: null,
      manualSelectedActorUserId,
      lastConfirmedActorUserId,
      viewerStatus: 'unconfirmed',
      diagnostics
    };
  }

  async function getDebugLogsEnabled() {
    try {
      const raw = await chromeApi.storage.local.get(DEBUG_LOGS_KEY);
      return Boolean(raw && raw[DEBUG_LOGS_KEY] === true);
    } catch (_err) {
      return false;
    }
  }

  async function handlePopupMessage(msg) {
    if (msg.type === 'START_HISTORY_SYNC' || msg.type === 'CANCEL_HISTORY_SYNC') {
      return enqueueSessionOp(async () => {
        const job = await history.read();
        if (msg.type === 'CANCEL_HISTORY_SYNC') {
          return job?.id === msg.jobId ? history.stop(job, 'cancelled') : { ok: false, code: 'STALE_JOB' };
        }
        if (job?.status === 'running') return { ok: true, job: describeHistorySync(job) };
        const entry = await resolveForegroundTabEntry();
        const binding = entry?.bindingContext;
        if (!binding || msg.actorUserId !== binding.actorUserId ||
            !bindingMatchesState(binding, await storage.getControlState())) {
          return { ok: false, message: '请在已开启采集的 X 页面确认当前账号后再同步。' };
        }
        const snap = await storage.getPopupSnapshot(binding.actorUserId);
        return history.start(binding, snap.selectedAccount?.handle);
      });
    }
    if (msg.type === 'GET_POPUP_SNAPSHOT') {
      const ctx = await resolveActivePopupContext();
      const canHonorPreferred =
        isValidDecimalId(msg.preferredActorUserId) &&
        (msg.preferredWhenActiveActorId === undefined ||
          ctx.allowLocalSelection ||
          (ctx.manualSelectedActorUserId === msg.preferredActorUserId &&
            (!ctx.activeActorUserId || ctx.activeActorUserId === msg.preferredWhenActiveActorId)));
      let preferredId = null;
      if (canHonorPreferred) {
        preferredId = msg.preferredActorUserId;
      } else if (ctx.activeActorUserId) {
        preferredId = ctx.activeActorUserId;
      } else if (ctx.manualSelectedActorUserId) {
        preferredId = ctx.manualSelectedActorUserId;
      } else if (ctx.allowLocalSelection && isValidDecimalId(msg.fallbackActorUserId)) {
        preferredId = msg.fallbackActorUserId;
      } else if (ctx.lastConfirmedActorUserId) {
        preferredId = ctx.lastConfirmedActorUserId;
      }
      const snap = await storage.getPopupSnapshot(preferredId, undefined, {
        allowDefaultFallback: ctx.viewerStatus !== 'unconfirmed'
      });
      if (!snap.ok) {
        return snap;
      }
      return {
        ...snap,
        debugLogsEnabled: await getDebugLogsEnabled(),
        historySync: describeHistorySync(await history.read()),
        historyNextStart: await history.nextStart(),
        activeTabActorUserId: ctx.activeActorUserId,
        manualTabActorUserId: ctx.manualSelectedActorUserId,
        confirmedTabActorUserId: ctx.activeActorUserId || ctx.lastConfirmedActorUserId || null,
        viewerStatus: ctx.viewerStatus,
        diagnostics: ctx.diagnostics
      };
    }

    if (msg.type === 'SET_DEBUG_LOGS') {
      return enqueueSessionOp(async () => {
        const nextDebug = Boolean(msg.enabled);
        try {
          await chromeApi.storage.local.set({ [DEBUG_LOGS_KEY]: nextDebug });
        } catch (_err) {
          return { ok: false, code: 'STORAGE_FAILURE', message: '无法保存调试日志开关状态' };
        }
        notifyTabs(null, {
          type: 'DEBUG_LOGS_CHANGED',
          debugLogsEnabled: nextDebug
        });
        return { ok: true, debugLogsEnabled: nextDebug };
      });
    }

    if (msg.type === 'SET_POPUP_ACCOUNT') {
      return enqueueSessionOp(async () => {
        const fgEntry = await resolveForegroundTabEntry();
        if (!fgEntry) {
          return { ok: true, saved: false, manualTabActorUserId: null };
        }
        const requestedId = isValidDecimalId(msg.actorUserId) ? msg.actorUserId : null;
        let validActorId = null;
        if (requestedId) {
          const ctrl = await storage.getControlState();
          if (ctrl.ok && ctrl.accountGenerations && ctrl.accountGenerations[requestedId]) {
            validActorId = requestedId;
          }
        }
        fgEntry.manualSelectedActorUserId = validActorId;
        fgEntry.updatedAt = nowFn();
        await persistSessionTabs();
        return { ok: true, saved: true, manualTabActorUserId: validActorId };
      });
    }

    if (msg.type === 'SET_COLLECTION_ENABLED') {
      return enqueueSessionOp(async () => {
        const res = await storage.setCollectionEnabled(Boolean(msg.enabled));
        if (!res.ok) {
          return res;
        }
        if (!res.settings.collectionEnabled) {
          await history.stop(await history.read(), 'paused');
          for (const entry of sessionTabsCache.values()) {
            entry.bindingContext = null;
            entry.diagnostics = null;
          }
          await persistSessionTabs();
        }
        notifyTabs(null, {
          type: 'STATE_CHANGED',
          collectionEnabled: res.settings.collectionEnabled,
          captureSessionId: res.settings.captureSessionId,
          revision: res.revision
        });
        return res;
      });
    }

    if (msg.type === 'CLEANUP_EXPIRED') {
      const res = await storage.cleanupExpired();
      if (res.ok && res.removedReplies > 0) {
        notifyTabs(null, { type: 'REVISION_UPDATED', revision: res.revision });
      }
      return res;
    }

    if (msg.type === 'EXPORT_BACKUP') {
      return storage.exportBackup();
    }

    if (msg.type === 'PREVIEW_IMPORT') {
      return storage.previewImport(msg.rawText);
    }

    if (msg.type === 'COMMIT_IMPORT') {
      const res = await storage.commitImport(msg.rawText, msg.baseline);
      if (res.ok) {
        notifyTabs(null, { type: 'REVISION_UPDATED', revision: res.revision });
      }
      return res;
    }

    if (msg.type === 'CLEAR_ACCOUNT') {
      return enqueueSessionOp(async () => {
        const actorId = msg.actorUserId;
        const res = await storage.clearAccount(actorId, msg.accountGeneration);
        if (!res.ok) {
          return res;
        }
        const affectedTabIds = [];
        const activeJob = await history.read();
        const clearedJobId = activeJob?.actorUserId === actorId ? activeJob.id : null;
        if (clearedJobId) await history.forget();
        for (const entry of sessionTabsCache.values()) {
          if (clearedJobId && entry.historySyncId === clearedJobId) {
            entry.historySyncId = null;
          }
          if (entry.lastConfirmedActorUserId === actorId) {
            entry.lastConfirmedActorUserId = null;
          }
          if (entry.manualSelectedActorUserId === actorId) {
            entry.manualSelectedActorUserId = null;
          }
          if (entry.bindingContext && entry.bindingContext.actorUserId === actorId) {
            const oldBindingId = entry.bindingContext.bindingId;
            entry.historySyncId = null;
            entry.bindingContext = null;
            entry.diagnostics = null;
            affectedTabIds.push({ tabId: entry.tabId, bindingId: oldBindingId });
          }
        }
        await persistSessionTabs();
        for (const item of affectedTabIds) {
          notifyTabs(
            (e) => e.tabId === item.tabId,
            {
              type: 'BINDING_INVALIDATED',
              actorUserId: actorId,
              bindingId: item.bindingId,
              revision: res.revision
            }
          );
        }
        return res;
      });
    }

    if (msg.type === 'CLEAR_ALL') {
      return enqueueSessionOp(async () => {
        const res = await storage.clearAllData();
        if (!res.ok) {
          return res;
        }
        const previousTabIds = Array.from(sessionTabsCache.values()).map((e) => e.tabId);
        try {
          await chromeApi.storage.local.set({ [DEBUG_LOGS_KEY]: false });
        } catch (_err) {
          // Best-effort reset of debug log toggle
        }
        await history.forget();
        sessionTabsCache.clear();
        await persistSessionTabs();
        if (chromeApi.tabs && typeof chromeApi.tabs.sendMessage === 'function') {
          for (const tabId of previousTabIds) {
            try {
              const p = chromeApi.tabs.sendMessage(tabId, {
                type: 'STATE_CHANGED',
                debugLogsEnabled: false,
                collectionEnabled: false,
                captureSessionId: null,
                revision: res.revision
              });
              if (p && typeof p.catch === 'function') p.catch(() => {});
            } catch (_e) {
              // Ignore closed tab
            }
          }
        }
        return res;
      });
    }

    return { ok: false, code: 'UNKNOWN_OPERATION' };
  }

  async function handleContentScriptMessage(msg, xSender) {
    if (['GET_HISTORY_SYNC_TASK', 'ADVANCE_HISTORY_SYNC', 'STOP_HISTORY_SYNC_TASK', 'SYNC_HISTORY_PAGE'].includes(msg.type)) {
      return enqueueSessionOp(async () => {
        const job = await history.read();
        const ownTab = job && job.tabId === xSender.tabId;
        if (msg.type === 'GET_HISTORY_SYNC_TASK') {
          return {
            ok: true,
            debugLogsEnabled: await getDebugLogsEnabled(),
            job: ownTab ? describeHistorySync(job) : null
          };
        }
        if (!ownTab || msg.jobId !== job.id) return { ok: false, code: 'STALE_JOB' };
        const entry = sessionTabsCache.get(xSender.tabKey);
        if (!entry || entry.documentId !== xSender.documentId) return { ok: false, code: 'STALE_DOCUMENT' };
        if (msg.type === 'STOP_HISTORY_SYNC_TASK') {
          const reasons = ['account_changed', 'navigation', 'stalled', 'timeout', 'rate_limited', 'verification', 'unavailable', 'unrecognized', 'first_page', 'search_stalled'];
          return reasons.includes(msg.reason) ? history.stop(job, msg.reason, msg.retryAt) : { ok: false, code: 'INVALID_ARGS' };
        }
        if (!bindingEquals(entry.bindingContext, msg.bindingContext) || !history.matches(job, entry.bindingContext)) {
          return { ok: false, code: 'STALE_BINDING' };
        }
        if (!matchesHistoryUrl(job, xSender.href)) return { ok: false, code: 'STALE_DOCUMENT' };
        if (msg.type === 'ADVANCE_HISTORY_SYNC') return history.advance(job, msg.action);
        const merged = await history.mergePage(job, msg, entry.bindingContext);
        if (merged.added > 0) notifyTabs((e) => e.bindingContext?.actorUserId === job.actorUserId,
          { type: 'REVISION_UPDATED', revision: merged.revision });
        return merged;
      });
    }
    if (msg.type === 'HELLO') {
      return enqueueSessionOp(async () => {
        const ctrl = await storage.getControlState();
        if (!ctrl.ok) {
          return ctrl;
        }
        const existing = sessionTabsCache.get(xSender.tabKey) || null;
        const job = await history.read();
        const historySyncId = scopedHistoryId(job, xSender, existing);
        let restoredBinding = null;

        if (
          msg.revalidateViewer !== true &&
          existing &&
          existing.documentId === xSender.documentId &&
          existing.bindingContext &&
          bindingMatchesState(existing.bindingContext, ctrl)
        ) {
          restoredBinding = existing.bindingContext;
        }

        const isActiveSyncTab = Boolean(
          msg.revalidateViewer !== true &&
          job?.status === 'running' &&
          job.tabId === xSender.tabId &&
          matchesHistoryUrl(job, xSender.href) &&
          ctrl.settings.collectionEnabled &&
          ctrl.settings.captureSessionId === job.captureSessionId &&
          ctrl.collectionGeneration === job.collectionGeneration &&
          ctrl.accountGenerations?.[job.actorUserId] === job.accountGeneration
        );
        if (!restoredBinding && isActiveSyncTab) {
          if (
            existing?.bindingContext &&
            existing.bindingContext.actorUserId === job.actorUserId &&
            bindingMatchesState(existing.bindingContext, ctrl)
          ) {
            restoredBinding = existing.bindingContext;
          } else {
            restoredBinding = Object.freeze({
              bindingId: generateBindingId(),
              actorUserId: job.actorUserId,
              captureSessionId: ctrl.settings.captureSessionId,
              collectionGeneration: ctrl.collectionGeneration,
              accountGeneration: ctrl.accountGenerations[job.actorUserId]
            });
          }
        }

        const sameDoc = Boolean(existing && existing.documentId === xSender.documentId);
        const preservedLastActorId = restoredBinding
          ? restoredBinding.actorUserId
          : sameDoc && isValidDecimalId(existing.lastConfirmedActorUserId)
          ? existing.lastConfirmedActorUserId
          : null;
        const preservedManualActorId =
          sameDoc && isValidDecimalId(existing.manualSelectedActorUserId)
            ? existing.manualSelectedActorUserId
            : null;

        upsertSessionTab(xSender.tabKey, {
          tabId: xSender.tabId,
          active: xSender.active,
          documentId: xSender.documentId,
          origin: xSender.origin,
          historySyncId,
          bindingContext: restoredBinding,
          lastConfirmedActorUserId: preservedLastActorId,
          manualSelectedActorUserId: preservedManualActorId,
          diagnostics: restoredBinding && existing ? existing.diagnostics : null,
          updatedAt: nowFn()
        });
        await persistSessionTabs();

        return {
          ok: true,
          debugLogsEnabled: await getDebugLogsEnabled(),
          historySyncId,
          historyScope: job?.status === 'running' && job.tabId === xSender.tabId && matchesHistoryUrl(job, xSender.href)
            ? { id: job.id, actor: job.actorUserId, since: job.since, deadline: describeHistorySync(job).deadline, query: job.searchQuery || null }
            : null,
          collectionEnabled: ctrl.settings.collectionEnabled,
          captureSessionId: ctrl.settings.captureSessionId,
          bindingContext: restoredBinding,
          bindRequired: Boolean(ctrl.settings.collectionEnabled && !restoredBinding),
          revision: ctrl.revision
        };
      });
    }

    if (msg.type === 'BIND_VIEWER') {
      return enqueueSessionOp(async () => {
        const ctrlBefore = await storage.getControlState();
        if (!ctrlBefore.ok) {
          return ctrlBefore;
        }
        if (
          !ctrlBefore.settings.collectionEnabled ||
          ctrlBefore.settings.captureSessionId === null ||
          msg.captureSessionId !== ctrlBefore.settings.captureSessionId
        ) {
          return { ok: false, code: 'SESSION_MISMATCH' };
        }
        if (!isPlainObject(msg.viewer) || !isValidDecimalId(msg.viewer.actorUserId)) {
          return { ok: false, code: 'INVALID_VIEWER' };
        }

        const accRes = await storage.ensureViewerAccount(msg.viewer);
        if (!accRes.ok) {
          return accRes;
        }

        const ctrlAfter = await storage.getControlState();
        if (
          !ctrlAfter.ok ||
          !ctrlAfter.settings.collectionEnabled ||
          ctrlAfter.settings.captureSessionId !== msg.captureSessionId
        ) {
          return { ok: false, code: 'SESSION_MISMATCH' };
        }

        const existing = sessionTabsCache.get(xSender.tabKey) || null;
        let job = await history.read();
        if (job?.tabId === xSender.tabId && job.actorUserId !== msg.viewer.actorUserId) {
          await history.stop(job, 'account_changed');
          job = await history.read();
        }
        const historySyncId = scopedHistoryId(job, xSender, existing, msg.viewer.actorUserId);
        const historyScope =
          job?.status === 'running' &&
          job.tabId === xSender.tabId &&
          job.actorUserId === msg.viewer.actorUserId &&
          matchesHistoryUrl(job, xSender.href)
            ? {
                id: job.id,
                actor: job.actorUserId,
                since: job.since,
                deadline: describeHistorySync(job).deadline,
                query: job.searchQuery || null
              }
            : null;
        if (
          existing &&
          existing.documentId === xSender.documentId &&
          existing.bindingContext &&
          existing.bindingContext.actorUserId === msg.viewer.actorUserId &&
          bindingMatchesState(existing.bindingContext, ctrlAfter)
        ) {
          syncExclusiveActiveTab(xSender.tabKey, xSender.active);
          existing.active = xSender.active;
          existing.historySyncId = historySyncId;
          existing.lastConfirmedActorUserId = msg.viewer.actorUserId;
          existing.updatedAt = nowFn();
          await persistSessionTabs();
          return {
            ok: true,
            bindingContext: existing.bindingContext,
            historySyncId,
            historyScope,
            revision: accRes.revision
          };
        }

        const bindingContext = Object.freeze({
          bindingId: generateBindingId(),
          actorUserId: msg.viewer.actorUserId,
          captureSessionId: ctrlAfter.settings.captureSessionId,
          collectionGeneration: ctrlAfter.collectionGeneration,
          accountGeneration: accRes.accountGeneration
        });

        upsertSessionTab(xSender.tabKey, {
          tabId: xSender.tabId,
          active: xSender.active,
          documentId: xSender.documentId,
          origin: xSender.origin,
          historySyncId,
          bindingContext,
          lastConfirmedActorUserId: msg.viewer.actorUserId,
          manualSelectedActorUserId: null,
          diagnostics: null,
          updatedAt: nowFn()
        });
        await persistSessionTabs();

        return {
          ok: true,
          bindingContext,
          historySyncId,
          historyScope,
          revision: accRes.revision
        };
      });
    }

    if (msg.type === 'REVOKE_VIEWER_BINDING') {
      return enqueueSessionOp(async () => {
        const targetId = typeof msg.bindingId === 'string' ? msg.bindingId : null;
        const existing = sessionTabsCache.get(xSender.tabKey);
        if (
          existing &&
          existing.bindingContext &&
          (!targetId || existing.bindingContext.bindingId === targetId)
        ) {
          existing.bindingContext = null;
          existing.diagnostics = null;
          existing.updatedAt = nowFn();
          await persistSessionTabs();
        }
        return { ok: true };
      });
    }

    if (msg.type === 'SUBMIT_OBSERVED_BATCH') {
      return enqueueSessionOp(async () => {
        const sessionEntry = sessionTabsCache.get(xSender.tabKey) || null;
        if (
          !sessionEntry ||
          sessionEntry.documentId !== xSender.documentId ||
          !sessionEntry.bindingContext
        ) {
          return { ok: false, code: 'BIND_REQUIRED' };
        }
        if (!bindingEquals(sessionEntry.bindingContext, msg.bindingContext)) {
          return { ok: false, code: 'STALE_BINDING' };
        }

        const mergeRes = await storage.mergeObservedBatch({
          bindingContext: sessionEntry.bindingContext,
          events: sessionEntry.historySyncId && Array.isArray(msg.events)
            ? msg.events.filter((event) => event?.source !== 'history') : msg.events,
          observedUsers: msg.observedUsers
        });

        if (!mergeRes.ok) {
          if (mergeRes.code === 'STALE_BINDING' || mergeRes.code === 'PAUSED') {
            sessionEntry.bindingContext = null;
            await persistSessionTabs();
          }
          return mergeRes;
        }

        if (
          msg.liveCaptureAnomaly ||
          msg.historyBackfillAnomaly ||
          msg.partialUnrecognized ||
          msg.incompleteObservation
        ) {
          sessionEntry.diagnostics = {
            ...(sessionEntry.diagnostics || {}),
            liveCaptureAnomaly: Boolean(
              (sessionEntry.diagnostics && sessionEntry.diagnostics.liveCaptureAnomaly) ||
                msg.liveCaptureAnomaly
            ),
            historyBackfillAnomaly: Boolean(
              (sessionEntry.diagnostics && sessionEntry.diagnostics.historyBackfillAnomaly) ||
                msg.historyBackfillAnomaly
            ),
            partialUnrecognized: Boolean(
              (sessionEntry.diagnostics && sessionEntry.diagnostics.partialUnrecognized) ||
                msg.partialUnrecognized
            ),
            incompleteObservation: Boolean(
              (sessionEntry.diagnostics && sessionEntry.diagnostics.incompleteObservation) ||
                msg.incompleteObservation
            )
          };
        }
        syncExclusiveActiveTab(xSender.tabKey, xSender.active);
        sessionEntry.active = xSender.active;
        sessionEntry.updatedAt = nowFn();
        await persistSessionTabs();

        if (mergeRes.added > 0) {
          const actorId = sessionEntry.bindingContext.actorUserId;
          notifyTabs(
            (e) =>
              e.tabId !== xSender.tabId &&
              e.bindingContext &&
              e.bindingContext.actorUserId === actorId,
            {
              type: 'REVISION_UPDATED',
              revision: mergeRes.revision
            }
          );
        }

        return mergeRes;
      });
    }

    if (msg.type === 'QUERY_TARGET_COUNTS') {
      await ensureBooted();
      const sessionEntry = sessionTabsCache.get(xSender.tabKey) || null;
      if (
        !sessionEntry ||
        sessionEntry.documentId !== xSender.documentId ||
        !sessionEntry.bindingContext
      ) {
        return { ok: false, code: 'BIND_REQUIRED' };
      }
      if (msg.bindingContext && !bindingEquals(sessionEntry.bindingContext, msg.bindingContext)) {
        return { ok: false, code: 'STALE_BINDING' };
      }
      const ctrl = await storage.getControlState();
      if (!bindingMatchesState(sessionEntry.bindingContext, ctrl)) {
        return { ok: false, code: 'STALE_BINDING' };
      }
      return storage.queryCountsForAccount(
        sessionEntry.bindingContext.actorUserId,
        msg.targetUserIds
      );
    }

    if (msg.type === 'REPORT_DIAGNOSTIC') {
      return enqueueSessionOp(async () => {
        const entry = sessionTabsCache.get(xSender.tabKey);
        if (entry && typeof msg.category === 'string') {
          entry.diagnostics = {
            ...(entry.diagnostics || {}),
            observationDropped:
              Boolean(entry.diagnostics && entry.diagnostics.observationDropped) ||
              msg.category === 'observation_dropped'
          };
          entry.updatedAt = nowFn();
          await persistSessionTabs();
        }
        return { ok: true };
      });
    }

    return { ok: false, code: 'UNKNOWN_OPERATION' };
  }

  async function handleMessage(msg, sender) {
    if (!isPlainObject(msg) || typeof msg.type !== 'string' || hasDangerousKeys(msg)) {
      return { ok: false, code: 'INVALID_MESSAGE' };
    }

    if (POPUP_ONLY_TYPES.has(msg.type)) {
      if (!isPopupSender(sender)) {
        return { ok: false, code: 'FORBIDDEN_SENDER' };
      }
      try {
        await ensureBooted();
      } catch (err) {
        if (err && err.code === 'ACCESS_LEVEL_INIT_FAILED') {
          return { ok: false, code: 'ACCESS_LEVEL_INIT_FAILED', message: err.message };
        }
        throw err;
      }
      return handlePopupMessage(msg);
    }

    if (CONTENT_SCRIPT_TYPES.has(msg.type)) {
      const xSender = extractTopXContentSender(sender);
      if (!xSender) {
        return { ok: false, code: 'FORBIDDEN_SENDER' };
      }
      try {
        await ensureBooted();
      } catch (err) {
        if (err && err.code === 'ACCESS_LEVEL_INIT_FAILED') {
          return { ok: false, code: 'ACCESS_LEVEL_INIT_FAILED', message: err.message };
        }
        throw err;
      }
      return handleContentScriptMessage(msg, xSender);
    }

    return { ok: false, code: 'UNKNOWN_OPERATION' };
  }

  if (
    chromeApi.runtime.onMessage &&
    typeof chromeApi.runtime.onMessage.addListener === 'function'
  ) {
    chromeApi.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      handleMessage(msg, sender).then(
        (res) => sendResponse(res),
        () => sendResponse({ ok: false, code: 'INTERNAL_ERROR' })
      );
      return true;
    });
  }

  if (
    chromeApi.tabs &&
    chromeApi.tabs.onRemoved &&
    typeof chromeApi.tabs.onRemoved.addListener === 'function'
  ) {
    chromeApi.tabs.onRemoved.addListener((tabId) => {
      enqueueSessionOp(async () => {
        const key = String(tabId);
        const job = await history.read();
        if (job?.tabId === tabId) await history.stop(job, 'closed');
        if (sessionTabsCache.has(key)) {
          sessionTabsCache.delete(key);
          await persistSessionTabs();
        }
      }).catch(() => {});
    });
  }

  return Object.freeze({
    handleMessage,
    getStorageController: () => storage
  });
}

if (
  typeof chrome === 'object' &&
  chrome &&
  chrome.runtime &&
  chrome.storage &&
  chrome.storage.local
) {
  createBackgroundService(chrome);
}
