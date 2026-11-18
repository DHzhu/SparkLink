(function (root) {
  'use strict';

  const PROTOCOL = 'SPARKLINK_BRIDGE_V1';
  const ALLOWED_ORIGINS = new Set(['https://x.com', 'https://twitter.com']);
  const DECIMAL_ID_RE = /^[1-9][0-9]{0,31}$/;
  const SAFE_HANDLE_RE = /^[A-Za-z0-9_]{1,64}$/;
  const MAX_DISPLAY_NAME_LEN = 256;

  const ALLOWED_MAIN_TYPES = new Set([
    'MAIN_HELLO',
    'MAIN_READY',
    'VIEWER_EVIDENCE',
    'OBSERVED_EVENTS',
    'AUTHOR_MAPPINGS',
    'HISTORY_STOP',
    'DIAGNOSTIC'
  ]);

  const DEFAULT_MAX_BATCH_SIZE = 100;
  const DEFAULT_MAX_PENDING_QUEUE = 128;
  const DEFAULT_PENDING_TTL_MS = 60 * 1000;
  const DEFAULT_MAX_RETRIES = 3;
  const DEFAULT_RETRY_DELAY_MS = 300;
  const DEFAULT_HANDSHAKE_INTERVAL_MS = 50;
  const DEFAULT_MAX_HANDSHAKE_ATTEMPTS = 6;
  const DEFAULT_MAX_MAP_SIZE = 5000;

  const installedBridges = new WeakMap();

  function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }

  function hasDangerousOwnKeys(value, depth) {
    const currentDepth = typeof depth === 'number' ? depth : 0;
    if (currentDepth > 128) {
      return true;
    }
    if (value === null || typeof value !== 'object') {
      return false;
    }
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        if (hasDangerousOwnKeys(value[i], currentDepth + 1)) {
          return true;
        }
      }
      return false;
    }
    const keys = Object.getOwnPropertyNames(value);
    for (let i = 0; i < keys.length; i += 1) {
      const k = keys[i];
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') {
        return true;
      }
      if (hasDangerousOwnKeys(value[k], currentDepth + 1)) {
        return true;
      }
    }
    return false;
  }

  function isValidDecimalId(value) {
    return typeof value === 'string' && DECIMAL_ID_RE.test(value);
  }

  function sanitizeHandle(value) {
    if (typeof value !== 'string') {
      return null;
    }
    const trimmed = value.startsWith('@') ? value.slice(1).trim() : value.trim();
    return SAFE_HANDLE_RE.test(trimmed) ? trimmed : null;
  }

  function sanitizeDisplayName(value) {
    if (typeof value !== 'string') {
      return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    return trimmed.length > MAX_DISPLAY_NAME_LEN
      ? trimmed.slice(0, MAX_DISPLAY_NAME_LEN)
      : trimmed;
  }

  function isValidBindingContext(ctx) {
    return (
      isPlainObject(ctx) &&
      typeof ctx.bindingId === 'string' &&
      ctx.bindingId.length > 0 &&
      ctx.bindingId.length <= 128 &&
      isValidDecimalId(ctx.actorUserId) &&
      Number.isInteger(ctx.captureSessionId) &&
      ctx.captureSessionId > 0 &&
      Number.isInteger(ctx.collectionGeneration) &&
      ctx.collectionGeneration >= 0 &&
      Number.isInteger(ctx.accountGeneration) &&
      ctx.accountGeneration > 0
    );
  }

  function bindingEquals(a, b) {
    return (
      Boolean(a) &&
      Boolean(b) &&
      a.bindingId === b.bindingId &&
      a.actorUserId === b.actorUserId &&
      a.captureSessionId === b.captureSessionId &&
      a.collectionGeneration === b.collectionGeneration &&
      a.accountGeneration === b.accountGeneration
    );
  }

  function generateNonce() {
    if (typeof crypto === 'object' && crypto && typeof crypto.getRandomValues === 'function') {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      let hex = '';
      for (let i = 0; i < bytes.length; i += 1) {
        hex += bytes[i].toString(16).padStart(2, '0');
      }
      return `sl_${hex}`;
    }
    return `sl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
  }

  function setBoundedMap(map, key, value, maxSize) {
    if (map.has(key)) {
      map.delete(key);
    }
    map.set(key, value);
    while (map.size > maxSize) {
      const oldestKey = map.keys().next().value;
      map.delete(oldestKey);
    }
  }

  function sanitizeObservedEvent(raw, expectedActorId) {
    if (!isPlainObject(raw)) {
      return null;
    }
    const actorUserId = raw.actorUserId;
    const replyTweetId = raw.replyTweetId;
    const parentTweetId = raw.parentTweetId;
    const targetUserId = raw.targetUserId;
    const createdAt = raw.createdAt;
    const observedAt = raw.observedAt;
    const source = raw.source;

    if (
      !isValidDecimalId(actorUserId) ||
      actorUserId !== expectedActorId ||
      !isValidDecimalId(replyTweetId) ||
      !isValidDecimalId(parentTweetId) ||
      !isValidDecimalId(targetUserId) ||
      targetUserId === actorUserId
    ) {
      return null;
    }
    if (
      !Number.isSafeInteger(createdAt) ||
      createdAt <= 0 ||
      !Number.isSafeInteger(observedAt) ||
      observedAt <= 0
    ) {
      return null;
    }
    if (source !== 'live' && source !== 'history') {
      return null;
    }

    return {
      actorUserId,
      replyTweetId,
      parentTweetId,
      targetUserId,
      targetHandle: sanitizeHandle(raw.targetHandle),
      targetDisplayName: sanitizeDisplayName(raw.targetDisplayName),
      createdAt,
      observedAt,
      source
    };
  }

  function sanitizeObservedUsers(rawUsers) {
    if (!Array.isArray(rawUsers)) {
      return [];
    }
    const clean = [];
    const cap = Math.min(rawUsers.length, 500);
    for (let i = 0; i < cap; i += 1) {
      const u = rawUsers[i];
      if (!isPlainObject(u) || !isValidDecimalId(u.userId)) {
        continue;
      }
      clean.push({
        userId: u.userId,
        handle: sanitizeHandle(u.handle),
        displayName: sanitizeDisplayName(u.displayName)
      });
    }
    return clean;
  }

  function sanitizeObservedTweets(rawTweets) {
    if (!Array.isArray(rawTweets)) {
      return [];
    }
    const clean = [];
    const cap = Math.min(rawTweets.length, 500);
    for (let i = 0; i < cap; i += 1) {
      const t = rawTweets[i];
      if (
        !isPlainObject(t) ||
        !isValidDecimalId(t.tweetId) ||
        !isValidDecimalId(t.authorUserId)
      ) {
        continue;
      }
      clean.push({
        tweetId: t.tweetId,
        authorUserId: t.authorUserId,
        handle: sanitizeHandle(t.handle)
      });
    }
    return clean;
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      if (t && typeof t.unref === 'function') {
        t.unref();
      }
    });
  }

  function installIsolatedBridge(win, explicitChrome, options) {
    if (!win || typeof win !== 'object') {
      return null;
    }
    // Top-level frame only (spec Section 6.1)
    if (win.top && win.top !== win) {
      return null;
    }
    const origin = win.location && win.location.origin;
    if (!ALLOWED_ORIGINS.has(origin)) {
      return null;
    }
    if (installedBridges.has(win)) {
      return installedBridges.get(win);
    }

    const chromeApi =
      explicitChrome || (typeof chrome !== 'undefined' && chrome ? chrome : null);
    if (!chromeApi || !chromeApi.runtime || typeof chromeApi.runtime.sendMessage !== 'function') {
      return null;
    }

    const opts = isPlainObject(options) ? options : {};
    const maxBatchSize =
      Number.isInteger(opts.maxBatchSize) && opts.maxBatchSize > 0
        ? opts.maxBatchSize
        : DEFAULT_MAX_BATCH_SIZE;
    const maxPendingQueue =
      Number.isInteger(opts.maxPendingQueue) && opts.maxPendingQueue > 0
        ? opts.maxPendingQueue
        : DEFAULT_MAX_PENDING_QUEUE;
    const pendingTtlMs =
      Number.isInteger(opts.pendingTtlMs) && opts.pendingTtlMs > 0
        ? opts.pendingTtlMs
        : DEFAULT_PENDING_TTL_MS;
    const maxRetries =
      Number.isInteger(opts.maxRetries) && opts.maxRetries >= 0
        ? opts.maxRetries
        : DEFAULT_MAX_RETRIES;
    const retryDelayMs =
      Number.isInteger(opts.retryDelayMs) && opts.retryDelayMs >= 0
        ? opts.retryDelayMs
        : DEFAULT_RETRY_DELAY_MS;
    const maxMapSize =
      Number.isInteger(opts.maxMapSize) && opts.maxMapSize > 0
        ? opts.maxMapSize
        : DEFAULT_MAX_MAP_SIZE;
    const nowFn = typeof opts.nowFn === 'function' ? opts.nowFn : () => Date.now();

    const channelNonce = generateNonce();

    const state = {
      mainReady: false,
      debugLogsEnabled: false,
      backendStateConfirmed: false,
      observedPausedFromBackend: false,
      pendingViewerRevalidation: false,
      historySyncId: null,
      historyScope: null,
      historyStop: null,
      documentEpoch: 0,
      collectionEnabled: false,
      captureSessionId: null,
      bindingContext: null,
      revision: 0,
      bindAttemptSeq: 0,
      flushing: false,
      destroyed: false
    };

    // Pending unconfirmed events (bounded to maxPendingQueue = 128, TTL = 60s)
    const pendingQueue = []; // Array<{ event, bindingContext, enqueuedAt, attempts }>
    let pendingAuxiliaryMeta = null;

    // Bounded verified page mappings for content.js badge rendering
    const tweetToAuthorMap = new Map();
    const userByIdMap = new Map();
    const handleToUserIdMap = new Map();
    const subscribers = new Set();

    function notifySubscribers(eventPayload) {
      for (const listener of Array.from(subscribers)) {
        try {
          listener(eventPayload);
        } catch (_err) {
          // Isolate subscriber errors
        }
      }
    }

    function postToMain(type, payload) {
      if (state.destroyed || typeof win.postMessage !== 'function') {
        return;
      }
      win.postMessage(
        {
          protocol: PROTOCOL,
          type,
          nonce: channelNonce,
          documentEpoch: state.documentEpoch,
          ...payload
        },
        origin
      );
    }

    function sendBridgeInitToMain() {
      postToMain('BRIDGE_INIT', {
        debugLogsEnabled: state.debugLogsEnabled,
        collectionEnabled: state.collectionEnabled,
        captureSessionId: state.captureSessionId,
        bindingContext: state.bindingContext,
        historyScope: state.historyScope,
        stateConfirmed: state.backendStateConfirmed,
        observedPaused: state.observedPausedFromBackend
      });
    }

    function syncMainState() {
      postToMain('SYNC_STATE', {
        debugLogsEnabled: state.debugLogsEnabled,
        collectionEnabled: state.collectionEnabled,
        captureSessionId: state.captureSessionId,
        bindingContext: state.bindingContext,
        historyScope: state.historyScope,
        stateConfirmed: state.backendStateConfirmed,
        observedPaused: state.observedPausedFromBackend
      });
    }

    async function sendRuntimeMessageSafe(message) {
      try {
        return await chromeApi.runtime.sendMessage(message);
      } catch (_err) {
        return { ok: false, transient: true };
      }
    }

    function reportDiagnostic(category, detail) {
      sendRuntimeMessageSafe({
        type: 'REPORT_DIAGNOSTIC',
        category,
        detail: typeof detail === 'string' ? detail.slice(0, 128) : null,
        captureSessionId: state.captureSessionId
      });
    }

    function recordVerifiedMappings(users, tweets) {
      let updated = false;
      for (let i = 0; i < users.length; i += 1) {
        const u = users[i];
        const prev = userByIdMap.get(u.userId) || null;
        const nextHandle = u.handle || (prev ? prev.handle : null);
        const nextLower = nextHandle ? nextHandle.toLowerCase() : null;
        const nextDisplayName = u.displayName || (prev ? prev.displayName : null);

        if (prev && prev.lowerHandle && prev.lowerHandle !== nextLower) {
          if (handleToUserIdMap.get(prev.lowerHandle) === u.userId) {
            handleToUserIdMap.delete(prev.lowerHandle);
          }
        }
        if (nextLower) {
          const oldHolderId = handleToUserIdMap.get(nextLower);
          if (oldHolderId && oldHolderId !== u.userId) {
            const oldHolder = userByIdMap.get(oldHolderId);
            if (oldHolder) {
              oldHolder.handle = null;
              oldHolder.lowerHandle = null;
            }
          }
          setBoundedMap(handleToUserIdMap, nextLower, u.userId, maxMapSize);
        }
        setBoundedMap(
          userByIdMap,
          u.userId,
          {
            userId: u.userId,
            handle: nextHandle,
            lowerHandle: nextLower,
            displayName: nextDisplayName
          },
          maxMapSize
        );
        updated = true;
      }

      for (let i = 0; i < tweets.length; i += 1) {
        const t = tweets[i];
        setBoundedMap(
          tweetToAuthorMap,
          t.tweetId,
          { authorUserId: t.authorUserId, handle: t.handle },
          maxMapSize
        );
        if (t.handle) {
          const existingUser = userByIdMap.get(t.authorUserId);
          if (!existingUser || existingUser.handle !== t.handle) {
            recordVerifiedMappings(
              [{ userId: t.authorUserId, handle: t.handle, displayName: null }],
              []
            );
          }
        }
        updated = true;
      }

      if (updated && state.bindingContext) {
        notifySubscribers({
          type: 'MAPPINGS_UPDATED',
          bindingContext: state.bindingContext,
          revision: state.revision
        });
      }
    }

    function dropQueueItemsByFilter(predicate) {
      for (let i = pendingQueue.length - 1; i >= 0; i -= 1) {
        if (predicate(pendingQueue[i])) {
          pendingQueue.splice(i, 1);
        }
      }
    }

    function pruneExpiredQueueItems() {
      const now = nowFn();
      let dropped = 0;
      dropQueueItemsByFilter((item) => {
        if (now - item.enqueuedAt > pendingTtlMs) {
          dropped += 1;
          return true;
        }
        return false;
      });
      if (dropped > 0) {
        reportDiagnostic('observation_dropped', 'pending_ttl_expired');
      }
    }

    function revokeLocalBinding(targetBindingId, notifyBackend) {
      const current = state.bindingContext;
      if (targetBindingId && current && current.bindingId !== targetBindingId) {
        dropQueueItemsByFilter((item) => item.bindingContext.bindingId === targetBindingId);
        postToMain('REVOKE_BINDING', { bindingId: targetBindingId });
        return;
      }

      const revokedId = current ? current.bindingId : targetBindingId || null;
      state.bindAttemptSeq += 1;
      state.bindingContext = null;

      if (revokedId) {
        dropQueueItemsByFilter((item) => item.bindingContext.bindingId === revokedId);
      } else {
        pendingQueue.length = 0;
      }
      pendingAuxiliaryMeta = null;

      // MAIN resets on pageshow itself. A second reset could erase a fresh Viewer during the handshake.
      if (!state.pendingViewerRevalidation) {
        postToMain('REVOKE_BINDING', { bindingId: revokedId });
      }
      notifySubscribers({
        type: 'BINDING_REVOKED',
        bindingId: revokedId
      });

      if (notifyBackend && revokedId) {
        sendRuntimeMessageSafe({
          type: 'REVOKE_VIEWER_BINDING',
          bindingId: revokedId
        });
      }
    }

    function logSync(...args) {
      const isRealBrowser = Boolean(win.navigator && typeof win.navigator.userAgent === 'string');
      if (!state.debugLogsEnabled && !(isRealBrowser && (state.historySyncId || state.historyScope))) {
        return;
      }
      try {
        if (win.console && typeof win.console.info === 'function') {
          win.console.info('[SparkLink Sync/Bridge]', ...args);
        }
      } catch {}
    }

    async function performHello(retriesLeft = maxRetries) {
      const attemptSeq = ++state.bindAttemptSeq;
      const res = await sendRuntimeMessageSafe({
        type: 'HELLO',
        origin,
        revalidateViewer: state.pendingViewerRevalidation
      });
      if (!state.destroyed && isPlainObject(res) && res.ok) {
        state.backendStateConfirmed = true;
        if (!res.collectionEnabled) {
          state.observedPausedFromBackend = true;
        }
      }
      if (state.destroyed || attemptSeq !== state.bindAttemptSeq) {
        return;
      }
      if (!isPlainObject(res) || !res.ok) {
        if (state.pendingViewerRevalidation && res?.transient && retriesLeft > 0) {
          setTimeout(() => {
            if (!state.destroyed && attemptSeq === state.bindAttemptSeq) performHello(retriesLeft - 1);
          }, retryDelayMs);
        }
        return;
      }
      state.pendingViewerRevalidation = false;
      state.debugLogsEnabled = Boolean(res.debugLogsEnabled);
      state.historyScope = res.historyScope || null;
      state.historySyncId = res.historySyncId || null;
      if (state.historyScope || state.historySyncId) {
        logSync('HELLO scope updated', {
          historySyncId: state.historySyncId,
          scopeQuery: state.historyScope?.query || null,
          hasBinding: isValidBindingContext(res.bindingContext),
          actor: res.bindingContext?.actorUserId || state.historyScope?.actor || null
        });
      }

      if (Number.isInteger(res.revision) && res.revision >= 0) {
        state.revision = res.revision;
      }

      const enabled = Boolean(res.collectionEnabled);
      const sessionId =
        enabled && Number.isInteger(res.captureSessionId) && res.captureSessionId > 0
          ? res.captureSessionId
          : null;

      if (!enabled || sessionId === null) {
        state.collectionEnabled = false;
        state.captureSessionId = null;
        state.bindingContext = null;
        pendingQueue.length = 0;
        pendingAuxiliaryMeta = null;
        syncMainState();
        notifySubscribers({ type: 'COLLECTION_PAUSED', revision: state.revision });
        return;
      }

      state.collectionEnabled = true;
      state.captureSessionId = sessionId;

      if (isValidBindingContext(res.bindingContext)) {
        const restored = Object.freeze({
          bindingId: res.bindingContext.bindingId,
          actorUserId: res.bindingContext.actorUserId,
          captureSessionId: res.bindingContext.captureSessionId,
          collectionGeneration: res.bindingContext.collectionGeneration,
          accountGeneration: res.bindingContext.accountGeneration
        });
        state.bindingContext = restored;
        // Discard any queued items that do not match the restored binding
        dropQueueItemsByFilter((item) => !bindingEquals(item.bindingContext, restored));
        syncMainState();
        notifySubscribers({
          type: 'BINDING_READY',
          bindingContext: restored,
          revision: state.revision
        });
        flushQueue();
      } else {
        // Session requires fresh binding; stale pending items cannot be re-stamped!
        state.bindingContext = null;
        pendingQueue.length = 0;
        pendingAuxiliaryMeta = null;
        syncMainState();
        postToMain('PROBE_VIEWER', {});
        notifySubscribers({ type: 'BINDING_REQUIRED', revision: state.revision });
      }
    }

    async function handleViewerEvidence(captureSessionId, rawViewer) {
      if (state.pendingViewerRevalidation || !state.collectionEnabled || state.captureSessionId === null) {
        return;
      }
      if (captureSessionId !== state.captureSessionId) {
        return;
      }
      if (!isPlainObject(rawViewer) || !isValidDecimalId(rawViewer.actorUserId)) {
        return;
      }
      const cleanViewer = {
        actorUserId: rawViewer.actorUserId,
        handle: sanitizeHandle(rawViewer.handle),
        displayName: sanitizeDisplayName(rawViewer.displayName)
      };

      // If already bound to the exact same viewer in the same session, keep binding
      if (
        state.bindingContext &&
        state.bindingContext.captureSessionId === state.captureSessionId &&
        state.bindingContext.actorUserId === cleanViewer.actorUserId
      ) {
        return;
      }

      // Account switch detected on active page: revoke old binding first!
      if (state.bindingContext && state.bindingContext.actorUserId !== cleanViewer.actorUserId) {
        revokeLocalBinding(state.bindingContext.bindingId, true);
      }

      const attemptSeq = ++state.bindAttemptSeq;
      const res = await sendRuntimeMessageSafe({
        type: 'BIND_VIEWER',
        captureSessionId: state.captureSessionId,
        viewer: cleanViewer
      });
      if (state.destroyed || attemptSeq !== state.bindAttemptSeq) {
        // Ignore late response from superseded bind attempt
        return;
      }
      if (!isPlainObject(res) || !res.ok || !isValidBindingContext(res.bindingContext)) {
        return;
      }
      if (Number.isInteger(res.revision) && res.revision >= 0) {
        state.revision = res.revision;
      }
      const nextBinding = Object.freeze({
        bindingId: res.bindingContext.bindingId,
        actorUserId: res.bindingContext.actorUserId,
        captureSessionId: res.bindingContext.captureSessionId,
        collectionGeneration: res.bindingContext.collectionGeneration,
        accountGeneration: res.bindingContext.accountGeneration
      });
      state.historySyncId = res.historySyncId || null;
      if (res.historyScope !== undefined) {
        state.historyScope = res.historyScope || null;
      } else if (!state.historySyncId) {
        state.historyScope = null;
      }
      state.bindingContext = nextBinding;
      syncMainState();
      notifySubscribers({
        type: 'BINDING_READY',
        bindingContext: nextBinding,
        revision: state.revision
      });
    }

    async function flushQueue() {
      if (state.flushing || state.destroyed) {
        return;
      }
      state.flushing = true;

      try {
        while (!state.destroyed) {
          pruneExpiredQueueItems();

          if (pendingQueue.length === 0 && !pendingAuxiliaryMeta) {
            break;
          }

          if (!state.collectionEnabled || !state.bindingContext) {
            pendingQueue.length = 0;
            pendingAuxiliaryMeta = null;
            break;
          }

          // Drop any head items whose binding does not match active state
          dropQueueItemsByFilter(
            (item) => !bindingEquals(item.bindingContext, state.bindingContext)
          );

          if (pendingQueue.length === 0 && !pendingAuxiliaryMeta) {
            break;
          }

          const activeBinding = state.bindingContext;
          const batchItems = pendingQueue.slice(0, maxBatchSize);
          const metaSnapshot = pendingAuxiliaryMeta;
          pendingAuxiliaryMeta = null;

          if (
            metaSnapshot &&
            !bindingEquals(metaSnapshot.bindingContext, activeBinding)
          ) {
            continue;
          }

          const payloadMsg = {
            type: 'SUBMIT_OBSERVED_BATCH',
            bindingContext: activeBinding,
            events: batchItems.map((b) => b.event),
            observedUsers: metaSnapshot ? metaSnapshot.observedUsers : [],
            liveCaptureAnomaly: Boolean(metaSnapshot && metaSnapshot.liveCaptureAnomaly),
            historyBackfillAnomaly: Boolean(metaSnapshot && metaSnapshot.historyBackfillAnomaly),
            partialUnrecognized: Boolean(metaSnapshot && metaSnapshot.partialUnrecognized),
            incompleteObservation: Boolean(metaSnapshot && metaSnapshot.incompleteObservation),
            anomalies: metaSnapshot ? metaSnapshot.anomalies : []
          };

          const res = await sendRuntimeMessageSafe(payloadMsg);

          if (isPlainObject(res) && res.ok) {
            // Remove confirmed items from pendingQueue
            const confirmedSet = new Set(batchItems);
            dropQueueItemsByFilter((item) => confirmedSet.has(item));
            if (Number.isInteger(res.revision) && res.revision >= 0) {
              state.revision = res.revision;
            }
            notifySubscribers({
              type: 'REVISION_UPDATED',
              bindingContext: activeBinding,
              revision: state.revision
            });
            continue;
          }

          const code = isPlainObject(res) ? res.code : null;
          if (code === 'STALE_BINDING' || code === 'PAUSED') {
            // Permanently invalid batch: discard without re-stamping
            const invalidSet = new Set(batchItems);
            dropQueueItemsByFilter((item) => invalidSet.has(item));
            await performHello();
            break;
          }

          if (code === 'BIND_REQUIRED') {
            // Worker restarted: attempt HELLO recovery.
            // If exact binding is restored, loop will retry; if lost, performHello clears queue!
            await performHello();
            if (!bindingEquals(state.bindingContext, activeBinding)) {
              break;
            }
            // Count as a retry attempt to prevent infinite BIND_REQUIRED loops
          }

          if (code === 'QUOTA_EXCEEDED' || code === 'STORAGE_FAILURE') {
            const failedSet = new Set(batchItems);
            dropQueueItemsByFilter((item) => failedSet.has(item));
            break;
          }

          // Transient failure: increment retry count up to maxRetries (3)
          let exhaustedCount = 0;
          for (let i = 0; i < batchItems.length; i += 1) {
            batchItems[i].attempts += 1;
            if (batchItems[i].attempts > maxRetries) {
              exhaustedCount += 1;
            }
          }
          if (exhaustedCount > 0) {
            dropQueueItemsByFilter((item) => item.attempts > maxRetries);
            reportDiagnostic('observation_dropped', 'max_retries_exceeded');
          } else {
            if (metaSnapshot && !pendingAuxiliaryMeta) {
              pendingAuxiliaryMeta = metaSnapshot;
            }
            await sleep(retryDelayMs);
          }
        }
      } finally {
        state.flushing = false;
      }
    }

    async function submitHistoryPage(payload) {
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        if (state.destroyed || state.historySyncId !== payload.jobId ||
            !bindingEquals(state.bindingContext, payload.bindingContext)) return;
        const res = await sendRuntimeMessageSafe(payload);
        if (!res?.transient) {
          if (res?.ok) {
            notifySubscribers({ type: 'HISTORY_PAGE_SYNCED', jobId: payload.jobId, revision: state.revision });
          }
          return;
        }
        if (attempt < maxRetries) await sleep(retryDelayMs);
      }
      await sendRuntimeMessageSafe({ type: 'STOP_HISTORY_SYNC_TASK', jobId: payload.jobId, reason: 'stalled' });
    }

    function enqueueObservedPayload(data) {
      if (!state.collectionEnabled || !state.bindingContext) {
        return;
      }
      if (!isValidBindingContext(data.bindingContext)) {
        return;
      }
      if (!bindingEquals(data.bindingContext, state.bindingContext)) {
        return;
      }
      if (Array.isArray(data.events) && data.events.length > 1000) {
        // Reject malformed oversized array
        return;
      }

      const cleanUsers = sanitizeObservedUsers(data.observedUsers);
      const cleanTweets = sanitizeObservedTweets(data.observedTweets);
      if (cleanUsers.length > 0 || cleanTweets.length > 0) {
        recordVerifiedMappings(cleanUsers, cleanTweets);
      }

      const rawEvents = Array.isArray(data.events) ? data.events : [];
      const cleanEvents = [];
      const historyEvents = [];
      for (let i = 0; i < rawEvents.length; i += 1) {
        const clean = sanitizeObservedEvent(
          rawEvents[i],
          state.bindingContext.actorUserId
        );
        if (clean && state.historySyncId && clean.source === 'history') {
          historyEvents.push(clean);
        } else if (clean) {
          cleanEvents.push(clean);
        }
      }
      if (state.historySyncId && data.historyBackfillAnomaly && !isPlainObject(data.historyPage)) {
        logSync('stopping job due to historyBackfillAnomaly without historyPage', {
          jobId: state.historySyncId,
          anomalies: data.anomalies
        });
        sendRuntimeMessageSafe({ type: 'STOP_HISTORY_SYNC_TASK', jobId: state.historySyncId, reason: 'unrecognized' });
      }
      if (state.historySyncId && isPlainObject(data.historyPage)) {
        logSync('forwarding SYNC_HISTORY_PAGE', {
          jobId: state.historySyncId,
          events: historyEvents.length,
          canPage: data.historyPage?.canPage === true,
          ended: data.historyPage?.ended === true,
          searchQuery: data.historyPage?.searchQuery || null
        });
        submitHistoryPage({
          type: 'SYNC_HISTORY_PAGE', jobId: state.historySyncId, pageId: generateNonce(),
          bindingContext: state.bindingContext, events: historyEvents,
          partial: Boolean(data.partialUnrecognized || data.historyBackfillAnomaly),
          historyPage: {
            newestAt: data.historyPage?.newestAt ?? null,
            pageKey: data.historyPage?.pageKey ?? null,
            ended: data.historyPage?.ended === true,
            canPage: data.historyPage?.canPage === true,
            searchQuery: data.historyPage?.searchQuery || null
          }
        });
      }

      pruneExpiredQueueItems();
      const now = nowFn();
      let overflowDropped = 0;
      for (let i = 0; i < cleanEvents.length; i += 1) {
        if (pendingQueue.length >= maxPendingQueue) {
          pendingQueue.shift();
          overflowDropped += 1;
        }
        pendingQueue.push({
          event: cleanEvents[i],
          bindingContext: state.bindingContext,
          enqueuedAt: now,
          attempts: 0
        });
      }

      if (overflowDropped > 0) {
        reportDiagnostic('observation_dropped', 'pending_queue_overflow');
      }

      const hasDiagFlags = Boolean(
        data.liveCaptureAnomaly ||
          data.historyBackfillAnomaly ||
          data.partialUnrecognized ||
          data.incompleteObservation ||
          (Array.isArray(data.anomalies) && data.anomalies.length > 0)
      );

      if (cleanEvents.length > 0 || hasDiagFlags || cleanUsers.length > 0) {
        const prevMeta =
          pendingAuxiliaryMeta &&
          bindingEquals(pendingAuxiliaryMeta.bindingContext, state.bindingContext)
            ? pendingAuxiliaryMeta
            : null;
        const incomingAnomalies = Array.isArray(data.anomalies)
          ? data.anomalies.filter((a) => typeof a === 'string' && a.length <= 64)
          : [];
        pendingAuxiliaryMeta = {
          bindingContext: state.bindingContext,
          observedUsers: prevMeta
            ? prevMeta.observedUsers.concat(cleanUsers).slice(0, 500)
            : cleanUsers,
          liveCaptureAnomaly: Boolean(
            (prevMeta && prevMeta.liveCaptureAnomaly) || data.liveCaptureAnomaly
          ),
          historyBackfillAnomaly: Boolean(
            (prevMeta && prevMeta.historyBackfillAnomaly) || data.historyBackfillAnomaly
          ),
          partialUnrecognized: Boolean(
            (prevMeta && prevMeta.partialUnrecognized) || data.partialUnrecognized
          ),
          incompleteObservation: Boolean(
            (prevMeta && prevMeta.incompleteObservation) || data.incompleteObservation
          ),
          anomalies: (prevMeta ? prevMeta.anomalies.concat(incomingAnomalies) : incomingAnomalies).slice(
            0,
            10
          )
        };
        flushQueue();
      }
    }

    function onWindowMessage(event) {
      if (state.destroyed || !event || event.source !== win || event.origin !== origin) {
        return;
      }
      const data = event.data;
      if (
        !isPlainObject(data) ||
        data.protocol !== PROTOCOL ||
        (data.documentEpoch ?? 0) !== state.documentEpoch
      ) {
        return;
      }
      if (hasDangerousOwnKeys(data, 0)) {
        return;
      }
      if (!ALLOWED_MAIN_TYPES.has(data.type)) {
        return;
      }

      if (data.type === 'MAIN_HELLO') {
        sendBridgeInitToMain();
        return;
      }

      if (data.nonce !== channelNonce) {
        return;
      }

      if (data.type === 'MAIN_READY') {
        state.mainReady = true;
        return;
      }

      if (data.type === 'VIEWER_EVIDENCE') {
        handleViewerEvidence(data.captureSessionId, data.viewer);
        return;
      }

      if (data.type === 'HISTORY_STOP') {
        if (state.historySyncId && state.collectionEnabled && data.captureSessionId === state.captureSessionId) {
          logSync('received HISTORY_STOP from MAIN', { jobId: state.historySyncId, reason: data.reason, retryAt: data.retryAt || null });
          if (['rate_limited', 'verification', 'unavailable'].includes(data.reason)) {
            state.historyStop = { jobId: state.historySyncId, reason: data.reason,
              retryAt: Number.isSafeInteger(data.retryAt) ? data.retryAt : null };
            sendRuntimeMessageSafe({ type: 'STOP_HISTORY_SYNC_TASK', ...state.historyStop });
          } else if (data.reason === 'unrecognized') {
            sendRuntimeMessageSafe({ type: 'STOP_HISTORY_SYNC_TASK', jobId: state.historySyncId, reason: 'unrecognized' });
          }
        }
        return;
      }

      if (data.type === 'OBSERVED_EVENTS') {
        enqueueObservedPayload(data);
        return;
      }

      if (data.type === 'AUTHOR_MAPPINGS') {
        if (
          state.collectionEnabled &&
          state.bindingContext &&
          bindingEquals(data.bindingContext, state.bindingContext)
        ) {
          recordVerifiedMappings(
            sanitizeObservedUsers(data.observedUsers),
            sanitizeObservedTweets(data.observedTweets)
          );
        }
        return;
      }

      if (data.type === 'DIAGNOSTIC') {
        if (typeof data.category === 'string' && data.category.length <= 64) {
          reportDiagnostic(data.category, null);
        }
      }
    }

    function onRuntimeMessage(msg, sender, sendResponse) {
      if (state.destroyed || !isPlainObject(msg)) {
        return;
      }
      if (sender && chromeApi.runtime.id && sender.id && sender.id !== chromeApi.runtime.id) {
        return;
      }

      if (msg.type === 'PING_X_TAB') {
        if (typeof sendResponse === 'function') {
          sendResponse({ ok: true, alive: true });
        }
        return;
      }

      if (msg.type === 'END_HISTORY_TRANSPORT' && msg.jobId === state.historySyncId) {
        state.historyScope = null;
        if (msg.clearSyncId === true) {
          state.historySyncId = null;
        }
        syncMainState();
        notifySubscribers({ type: 'HISTORY_SYNC_ENDED', jobId: msg.jobId });
        return;
      }
      if (msg.type === 'DEBUG_LOGS_CHANGED') {
        state.debugLogsEnabled = Boolean(msg.debugLogsEnabled);
        syncMainState();
        return;
      }
      if (msg.type === 'STATE_CHANGED') {
        if (typeof msg.debugLogsEnabled === 'boolean') {
          state.debugLogsEnabled = msg.debugLogsEnabled;
        }
        if (msg.collectionEnabled === false) {
          state.backendStateConfirmed = true;
          state.observedPausedFromBackend = true;
        }
        performHello();
        return;
      }

      if (msg.type === 'BINDING_INVALIDATED') {
        const targetBindingId = typeof msg.bindingId === 'string' ? msg.bindingId : null;
        const targetActorId = isValidDecimalId(msg.actorUserId) ? msg.actorUserId : null;
        if (
          !targetBindingId &&
          targetActorId &&
          state.bindingContext &&
          state.bindingContext.actorUserId === targetActorId
        ) {
          revokeLocalBinding(state.bindingContext.bindingId, false);
        } else if (targetBindingId) {
          revokeLocalBinding(targetBindingId, false);
        }
        return;
      }

      if (msg.type === 'REVISION_UPDATED') {
        if (Number.isInteger(msg.revision) && msg.revision >= 0) {
          state.revision = msg.revision;
        }
        if (state.bindingContext) {
          notifySubscribers({
            type: 'REVISION_UPDATED',
            bindingContext: state.bindingContext,
            revision: state.revision
          });
        }
      }
    }

    win.addEventListener('message', onWindowMessage);
    win.addEventListener('pageshow', (ev) => {
      if (ev && ev.persisted) {
        // Both worlds advance before queued messages from the frozen document can be delivered.
        state.documentEpoch += 1;
        state.pendingViewerRevalidation = true;
        revokeLocalBinding(null, false);
        performHello();
      }
    });
    if (win.document && typeof win.document.addEventListener === 'function') {
      win.document.addEventListener('visibilitychange', () => {
        if (win.document.visibilityState === 'visible') {
          performHello();
        }
      });
    }

    if (
      chromeApi.runtime.onMessage &&
      typeof chromeApi.runtime.onMessage.addListener === 'function'
    ) {
      chromeApi.runtime.onMessage.addListener(onRuntimeMessage);
    }

    // Bounded handshake loop with MAIN world
    let handshakeCount = 0;
    function stepHandshake() {
      if (state.destroyed || state.mainReady || handshakeCount >= DEFAULT_MAX_HANDSHAKE_ATTEMPTS) {
        return;
      }
      handshakeCount += 1;
      sendBridgeInitToMain();
      const timer = setTimeout(stepHandshake, DEFAULT_HANDSHAKE_INTERVAL_MS);
      if (timer && typeof timer.unref === 'function') {
        timer.unref();
      }
    }
    stepHandshake();
    performHello();

    const bridgeApi = Object.freeze({
      subscribe(fn) {
        if (typeof fn !== 'function') {
          return () => {};
        }
        subscribers.add(fn);
        return () => {
          subscribers.delete(fn);
        };
      },
      requestHistoryNext(jobId) {
        if (state.collectionEnabled && state.bindingContext && state.historySyncId === jobId) {
          logSync('posting HISTORY_NEXT to MAIN', { jobId });
          postToMain('HISTORY_NEXT', { jobId, bindingId: state.bindingContext.bindingId });
        }
      },
      getHistoryStop(jobId) {
        return state.historyStop?.jobId === jobId ? state.historyStop : null;
      },
      getBindingContext() {
        return state.bindingContext;
      },
      getRevision() {
        return state.revision;
      },
      isCollectionEnabled() {
        return state.collectionEnabled;
      },
      isDebugLogsEnabled() {
        return state.debugLogsEnabled;
      },
      getPendingQueueSize() {
        return pendingQueue.length;
      },
      resolveAuthorByTweetId(tweetId) {
        if (!isValidDecimalId(tweetId)) {
          return null;
        }
        return tweetToAuthorMap.get(tweetId) || null;
      },
      resolveUserIdByHandle(handle) {
        const clean = sanitizeHandle(handle);
        if (!clean) {
          return null;
        }
        return handleToUserIdMap.get(clean.toLowerCase()) || null;
      },
      async queryCounts(targetUserIds) {
        const currentBinding = state.bindingContext;
        if (!state.collectionEnabled || !currentBinding) {
          return { ok: false, code: 'UNBOUND' };
        }
        if (!Array.isArray(targetUserIds)) {
          return { ok: false, code: 'INVALID_TARGETS' };
        }
        const uniqueTargets = Array.from(
          new Set(targetUserIds.filter(isValidDecimalId))
        ).slice(0, 200);
        if (uniqueTargets.length === 0) {
          return {
            ok: true,
            counts: {},
            revision: state.revision,
            bindingId: currentBinding.bindingId
          };
        }
        const res = await sendRuntimeMessageSafe({
          type: 'QUERY_TARGET_COUNTS',
          bindingContext: currentBinding,
          targetUserIds: uniqueTargets
        });
        if (!isPlainObject(res) || !res.ok) {
          if (isPlainObject(res) && res.code === 'BIND_REQUIRED') {
            performHello();
          }
          return { ok: false, code: (res && res.code) || 'QUERY_FAILED' };
        }
        if (!bindingEquals(state.bindingContext, currentBinding)) {
          return { ok: false, code: 'STALE_BINDING' };
        }
        return {
          ok: true,
          counts: isPlainObject(res.counts) ? res.counts : {},
          revision: Number.isInteger(res.revision) ? res.revision : state.revision,
          bindingId: currentBinding.bindingId
        };
      },
      destroy() {
        state.destroyed = true;
        subscribers.clear();
        pendingQueue.length = 0;
        tweetToAuthorMap.clear();
        userByIdMap.clear();
        handleToUserIdMap.clear();
        win.removeEventListener('message', onWindowMessage);
        if (
          chromeApi.runtime.onMessage &&
          typeof chromeApi.runtime.onMessage.removeListener === 'function'
        ) {
          chromeApi.runtime.onMessage.removeListener(onRuntimeMessage);
        }
      }
    });

    try {
      Object.defineProperty(win, '__sparklinkIsolatedBridge', {
        value: bridgeApi,
        configurable: true,
        enumerable: false,
        writable: false
      });
    } catch (_err) {
      // Ignore if defineProperty fails on synthetic test objects
    }

    installedBridges.set(win, bridgeApi);
    return bridgeApi;
  }

  if (typeof module === 'object' && module !== null && module.exports) {
    module.exports = {
      PROTOCOL,
      installIsolatedBridge
    };
  }

  if (
    root &&
    typeof root === 'object' &&
    root.location &&
    ALLOWED_ORIGINS.has(root.location.origin) &&
    !(typeof module === 'object' && module !== null && module.exports)
  ) {
    installIsolatedBridge(root, null);
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
