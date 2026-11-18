(function (root) {
  'use strict';

  const PROTOCOL = 'SPARKLINK_BRIDGE_V1';
  const ALLOWED_ORIGINS = new Set(['https://x.com', 'https://twitter.com']);
  const DEFAULT_MAX_CONCURRENT_CLONES = 4;
  const DEFAULT_MAX_REQUEST_BYTES = 256 * 1024;
  const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const DEFAULT_CLONE_TIMEOUT_MS = 2000;
  const HANDLE_FIELD_RE = /^[\s\p{P}]*@[A-Za-z0-9_]+(?![A-Za-z0-9_])[\s\p{P}]*(?:$|[@·•‧・]|\d+[smhdw]\s*$)/u;
  const INLINE_CONTINUATION_TAGS = new Set([
    'SPAN',
    'BDI',
    'BDO',
    'B',
    'I',
    'EM',
    'STRONG',
    'SMALL',
    'MARK',
    'U',
    'S',
    'SUB',
    'SUP',
    'CODE',
    'FONT',
    'ABBR',
    'CITE',
    'Q',
    'WBR'
  ]);

  function collectCoalescedTextSegments(rootEl) {
    const segments = [];
    let current = '';

    function flush() {
      if (current.length > 0) {
        segments.push(current);
        current = '';
      }
    }

    function appendInlinePiece(piece, splitLeadingAt) {
      if (!piece) {
        return;
      }
      if (
        splitLeadingAt &&
        current.length > 0 &&
        !/[\s\p{Ps}\p{Pi}]$/u.test(current) &&
        piece.charCodeAt(0) === 64
      ) {
        flush();
      }
      current += piece;
    }

    function walk(node, isRoot, splitNextLeadingAt) {
      if (!node) {
        return;
      }
      if (node.nodeType === 3) {
        const val =
          node.nodeValue !== undefined && node.nodeValue !== null
            ? String(node.nodeValue)
            : node.textContent || '';
        appendInlinePiece(val, splitNextLeadingAt);
        return;
      }
      if (!isRoot && node.nodeType !== 1) {
        return;
      }
      const tag = typeof node.tagName === 'string' ? node.tagName.toUpperCase() : '';
      const isInline = !isRoot && INLINE_CONTINUATION_TAGS.has(tag);
      if (!isInline) {
        flush();
      }
      const childNodes = node.childNodes;
      const hasChildNodes = Boolean(childNodes && typeof childNodes.length === 'number');
      const children = !hasChildNodes ? node.children : null;
      const hasChildren = Boolean(
        children && typeof children.length === 'number' && children.length > 0
      );
      if (hasChildNodes) {
        let firstTextInInline = isInline;
        for (let i = 0; i < childNodes.length; i += 1) {
          const prevLen = current.length;
          walk(childNodes[i], false, firstTextInInline);
          if (firstTextInInline && current.length !== prevLen) {
            firstTextInInline = false;
          }
        }
      } else if (hasChildren) {
        let firstTextInInline = isInline;
        for (let i = 0; i < children.length; i += 1) {
          const prevLen = current.length;
          walk(children[i], false, firstTextInInline);
          if (firstTextInInline && current.length !== prevLen) {
            firstTextInInline = false;
          }
        }
      } else {
        appendInlinePiece(
          typeof node.textContent === 'string' ? node.textContent : '',
          isInline
        );
      }
      if (!isInline) {
        flush();
      }
    }

    walk(rootEl, true, false);
    flush();
    return segments;
  }

  const BIDI_FORMAT_RE = /[‎‏‪-‮⁦-⁩]/g;

  function isHandleCharCode(code) {
    return (
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      code === 95
    );
  }

  function scanCoalescedHandleTokens(raw, recordHandle) {
    if (typeof raw !== 'string' || raw.indexOf('@') === -1) {
      return true;
    }
    const clean = raw.replace(BIDI_FORMAT_RE, '');
    const len = clean.length;
    let idx = 0;
    let prevTokenWasHandle = false;
    let prevTokenEnd = -1;

    while (idx < len) {
      if (clean.charCodeAt(idx) !== 64) {
        idx += 1;
        continue;
      }

      let leftBlocked = false;
      if (idx > 0 && !(prevTokenWasHandle && prevTokenEnd === idx)) {
        let checkIdx = idx - 1;
        while (
          checkIdx >= 0 &&
          (clean[checkIdx] === '.' || clean[checkIdx] === '+' || clean[checkIdx] === '-')
        ) {
          checkIdx -= 1;
        }
        if (checkIdx >= 0 && isHandleCharCode(clean.charCodeAt(checkIdx))) {
          leftBlocked = true;
        }
      }

      let end = idx + 1;
      while (end < len && isHandleCharCode(clean.charCodeAt(end))) {
        end += 1;
      }
      const handleLen = end - (idx + 1);

      if (leftBlocked || handleLen === 0 || handleLen > 64) {
        prevTokenWasHandle = false;
        prevTokenEnd = -1;
        idx = end > idx + 1 ? end : idx + 1;
        continue;
      }

      if (
        end < len &&
        clean[end] === '.' &&
        end + 1 < len &&
        isHandleCharCode(clean.charCodeAt(end + 1))
      ) {
        prevTokenWasHandle = false;
        prevTokenEnd = -1;
        idx = end;
        continue;
      }

      if (!recordHandle(clean.slice(idx + 1, end))) {
        return false;
      }
      prevTokenWasHandle = true;
      prevTokenEnd = end;
      idx = end;
    }
    return true;
  }

  const installedWindows = new WeakMap();
  const textEncoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;
  const textDecoder = typeof TextDecoder === 'function' ? new TextDecoder('utf-8', { fatal: false }) : null;

  function utf8ByteLength(str) {
    if (typeof str !== 'string') {
      return 0;
    }
    if (textEncoder) {
      return textEncoder.encode(str).byteLength;
    }
    return str.length * 3;
  }

  function extractFetchUrlAndMethod(input, init) {
    let url = null;
    let defaultMethod = 'GET';
    if (typeof input === 'string') {
      url = input;
    } else if (input && typeof input === 'object') {
      if (typeof input.url === 'string') {
        url = input.url;
        if (typeof input.method === 'string' && input.method) {
          defaultMethod = input.method;
        }
      } else if (typeof input.href === 'string') {
        url = input.href;
      }
    }
    const method =
      init && typeof init === 'object' && typeof init.method === 'string' && init.method
        ? init.method
        : defaultMethod;
    return { url, method };
  }

  function installMainInterceptor(win, explicitAdapter, options) {
    if (!win || typeof win !== 'object') {
      return null;
    }
    if (installedWindows.has(win)) {
      return installedWindows.get(win);
    }

    const adapter =
      explicitAdapter ||
      (typeof win.__sparklinkConsumeAdapter === 'function'
        ? win.__sparklinkConsumeAdapter()
        : null);
    if (!adapter) {
      return null;
    }

    const opts = adapter.isPlainObject(options) ? options : {};
    const maxConcurrentClones =
      Number.isInteger(opts.maxConcurrentClones) && opts.maxConcurrentClones > 0
        ? opts.maxConcurrentClones
        : DEFAULT_MAX_CONCURRENT_CLONES;
    const maxRequestBytes =
      Number.isInteger(opts.maxRequestBytes) && opts.maxRequestBytes > 0
        ? opts.maxRequestBytes
        : DEFAULT_MAX_REQUEST_BYTES;
    const maxResponseBytes =
      Number.isInteger(opts.maxResponseBytes) && opts.maxResponseBytes > 0
        ? opts.maxResponseBytes
        : DEFAULT_MAX_RESPONSE_BYTES;
    const cloneTimeoutMs =
      Number.isInteger(opts.cloneTimeoutMs) && opts.cloneTimeoutMs > 0
        ? opts.cloneTimeoutMs
        : DEFAULT_CLONE_TIMEOUT_MS;

    const engine = adapter.createAdapterEngine(opts.adapterOptions);

    const state = {
      nonce: null,
      debugLogsEnabled: false,
      stateConfirmed: false,
      observedPaused: false,
      collectionEnabled: false,
      captureSessionId: null,
      documentEpoch: 0,
      bindingContext: null,
      latestGraphqlViewer: null,
      hasPausedOnce: false,
      needsPostPauseVerification: false,
      hasSeenGraphqlViewer: false,
      hasSeenDynamicStateViewer: false,
      supersededDynamicActorId: null,
      activeClones: 0
    };

    // Only the dedicated sync document holds its latest observed cursor in memory to pace native scrolling.
    // Neither cursors nor raw payloads cross into extension storage.
    let scope = null;
    let cursor = null;
    let pendingSearch = null;
    let pendingTimeline = null;
    const pendingPreConfirmPayloads = [];
    const MAX_PRE_CONFIRM_PAYLOADS = 16;
    let pageRequest = null;
    const usedCursors = new Set();
    let lastFetchAt = 0;
    let lastNativePageAt = 0;
    let nativeRequestsInFlight = 0;
    let wakeScrollWaiter = null;
    function notifyScrollWaiter() {
      const fn = wakeScrollWaiter;
      if (fn) {
        wakeScrollWaiter = null;
        fn();
      }
    }
    function logSync(...args) {
      if (!state.debugLogsEnabled) {
        return;
      }
      try {
        if (win.console && typeof win.console.info === 'function') {
          const formatted = args.map((arg) => {
            if (arg && typeof arg === 'object') {
              try {
                return JSON.stringify(arg);
              } catch {
                return String(arg);
              }
            }
            return arg;
          });
          win.console.info('[SparkLink Sync/Main]', ...formatted);
        }
      } catch {}
    }
    function canScrollDocument() {
      try {
        return Boolean(typeof win.scrollTo === 'function' && win.document);
      } catch {
        return false;
      }
    }
    function triggerScrollStep() {
      const doc = win.document;
      if (!doc) return false;
      const se = doc.scrollingElement || doc.documentElement || doc.body;
      if (!se) return false;
      const curTop = Number(se.scrollTop) || Number(win.scrollY) || 0;
      const targetHeight = Math.max(Number(se.scrollHeight) || 0, curTop + 1200);
      win.scrollTo(0, targetHeight);
      try {
        const primary = typeof doc.querySelector === 'function' ? doc.querySelector('[data-testid="primaryColumn"]') : null;
        const cells = primary && typeof primary.querySelectorAll === 'function'
          ? primary.querySelectorAll('[data-testid="cellInnerDiv"]')
          : !primary && typeof doc.querySelectorAll === 'function'
          ? doc.querySelectorAll('[data-testid="cellInnerDiv"]')
          : null;
        const lastCell = cells && cells.length > 0 ? cells[cells.length - 1] : null;
        if (lastCell && typeof lastCell.scrollIntoView === 'function') {
          lastCell.scrollIntoView({ block: 'end' });
        }
      } catch {}
      if ((Number(se.scrollTop) || Number(win.scrollY) || 0) < targetHeight) {
        win.scrollTo(0, targetHeight);
      }
      try {
        if (typeof Event === 'function' && typeof win.dispatchEvent === 'function') {
          win.dispatchEvent(new Event('scroll'));
        }
      } catch {}
      return true;
    }
    function triggerScrollUpNudge(distancePx) {
      const doc = win.document;
      if (!doc) return false;
      const se = doc.scrollingElement || doc.documentElement || doc.body;
      if (!se) return false;
      const curTop = Number(se.scrollTop) || Number(win.scrollY) || 0;
      const step = Number.isInteger(distancePx) && distancePx > 0 ? distancePx : 300;
      if (curTop <= 300) return false;
      win.scrollTo(0, Math.max(0, curTop - step));
      try {
        if (typeof Event === 'function' && typeof win.dispatchEvent === 'function') {
          win.dispatchEvent(new Event('scroll'));
        }
      } catch {}
      return true;
    }
    function clearHistoryTransport() {
      pageRequest?.abort();
      pageRequest = null;
      notifyScrollWaiter();
      cursor = null;
      pendingSearch = null;
      pendingTimeline = null;
      pendingPreConfirmPayloads.length = 0;
      usedCursors.clear();
      lastFetchAt = 0;
      lastNativePageAt = 0;
      nativeRequestsInFlight = 0;
    }
    function isScopedSearch(match) {
      if (match?.category !== 'manual_search' || !scope?.query || Date.now() >= scope.deadline || match.searchQuery !== scope.query) return false;
      const location = new URL(win.location.href);
      return location.pathname === '/search' && location.searchParams.get('q') === scope.query &&
        location.searchParams.get('f') === 'live';
    }
    function isCandidateSearchPage(match) {
      if (match?.category !== 'manual_search') return false;
      if (scope) return isScopedSearch(match);
      try {
        const location = new URL(win.location.href);
        return (
          location.pathname === '/search' &&
          location.searchParams.get('f') === 'live' &&
          typeof match.searchQuery === 'string' &&
          match.searchQuery === location.searchParams.get('q')
        );
      } catch {
        return false;
      }
    }
    function isCandidateRepliesPage(match) {
      if (match?.category !== 'replies_timeline') return false;
      if (scope) {
        return !scope.query && Date.now() < scope.deadline && match.requestedUserId === scope.actor;
      }
      if (state.bindingContext) {
        return !match.requestedUserId || match.requestedUserId === state.bindingContext.actorUserId;
      }
      if (adapter.isValidDecimalId(match.requestedUserId)) {
        return true;
      }
      try {
        return /\/with_replies\/?$/i.test(new URL(win.location.href).pathname);
      } catch {
        return false;
      }
    }
    function isEligiblePreConfirmMatch(match) {
      if (!match || state.stateConfirmed || state.observedPaused || state.hasPausedOnce) {
        return false;
      }
      return (
        match.category === 'viewer' ||
        isCandidateRepliesPage(match) ||
        isCandidateSearchPage(match)
      );
    }
    async function scrollNextPage(data) {
      const binding = state.bindingContext;
      const nowAtStart = Date.now();
      if (
        !cursor ||
        pageRequest ||
        !scope ||
        nowAtStart >= scope.deadline ||
        scope.id !== data.jobId ||
        !binding ||
        binding.bindingId !== data.bindingId ||
        binding.actorUserId !== scope.actor ||
        usedCursors.has(cursor) ||
        usedCursors.size >= 120 ||
        nowAtStart - lastFetchAt < 12000 ||
        !canScrollDocument()
      ) {
        logSync('HISTORY_NEXT ignored', {
          hasCursor: Boolean(cursor),
          hasPageRequest: Boolean(pageRequest),
          hasScope: Boolean(scope),
          scopeMatchesJob: Boolean(scope && scope.id === data?.jobId),
          usedCursor: cursor ? usedCursors.has(cursor) : false,
          sinceLastFetchMs: lastFetchAt ? nowAtStart - lastFetchAt : null
        });
        return;
      }
      const op = scope.query ? 'SearchTimeline' : 'UserTweetsAndReplies';
      const expectedCursor = cursor;
      usedCursors.add(expectedCursor);
      cursor = null;
      lastFetchAt = nowAtStart;

      const context = captureContext();
      const abort = new AbortController();
      pageRequest = abort;
      const pageBaseline = lastNativePageAt;
      try {
        logSync('HISTORY_NEXT -> scrollScan start', {
          op,
          cursorLen: expectedCursor.length,
          inFlight: nativeRequestsInFlight
        });
        triggerScrollStep();
        let prevLoopMs = Date.now();
        let realTimeExtended = false;
        let scrollDeadline = prevLoopMs + 3500;
        let nextNudgeAt = nowAtStart + 1200;
        let pendingDownNudge = false;
        let nudgeCount = 0;
        while (isContextStillActive(context) && pageRequest === abort && !abort.signal.aborted) {
          if (lastNativePageAt > pageBaseline) {
            logSync('HISTORY_NEXT -> scrollScan captured native page', {
              op,
              hasNextCursor: Boolean(cursor)
            });
            return;
          }
          const nowMs = Date.now();
          const stepDelta = nowMs - prevLoopMs;
          prevLoopMs = nowMs;
          if (
            !realTimeExtended &&
            stepDelta >= 0 &&
            stepDelta < 1000 &&
            nowMs >= scrollDeadline - 500 &&
            nativeRequestsInFlight === 0
          ) {
            scrollDeadline = nowAtStart + 10500;
            realTimeExtended = true;
            logSync('HISTORY_NEXT -> extending real-time scroll retries', { op, nudgeCount });
          }
          const hardLimit = nativeRequestsInFlight > 0 ? scrollDeadline + 5000 : scrollDeadline;
          if (nowMs >= hardLimit) break;
          if (pendingDownNudge) {
            pendingDownNudge = false;
            triggerScrollStep();
          } else if (nativeRequestsInFlight === 0 && nowMs >= nextNudgeAt && nudgeCount < 4) {
            nudgeCount += 1;
            nextNudgeAt = nowMs + 2200;
            const upDist = nudgeCount === 1 ? 300 : nudgeCount === 2 ? 600 : 1000;
            if (triggerScrollUpNudge(upDist)) {
              pendingDownNudge = true;
            } else {
              triggerScrollStep();
            }
          }
          await new Promise((r) => {
            let timer = null;
            wakeScrollWaiter = () => {
              if (timer !== null) clearTimeout(timer);
              r();
            };
            timer = setTimeout(() => {
              if (wakeScrollWaiter) wakeScrollWaiter = null;
              r();
            }, 200);
            if (timer && typeof timer.unref === 'function') {
              timer.unref();
            }
          });
        }
        if (isContextStillActive(context) && pageRequest === abort) {
          logSync('HISTORY_NEXT -> scrollScan timeout without native page', {
            op,
            inFlight: nativeRequestsInFlight
          });
        }
      } catch (err) {
        logSync('scrollNextPage error', { op, error: String(err?.message || err) });
      } finally {
        if (pageRequest === abort) pageRequest = null;
      }
    }

    const activeReaders = new Set(); // Set<{ captureSessionId, bindingId, cancel }>

    function getTargetOrigin() {
      const origin = win.location && win.location.origin;
      return ALLOWED_ORIGINS.has(origin) ? origin : null;
    }

    function sendToBridge(type, payload) {
      const targetOrigin = getTargetOrigin();
      if (!targetOrigin || typeof win.postMessage !== 'function') {
        return;
      }
      if (type !== 'MAIN_HELLO' && !state.nonce) {
        return;
      }
      win.postMessage(
        {
          protocol: PROTOCOL,
          type,
          nonce: state.nonce,
          documentEpoch: state.documentEpoch,
          ...payload
        },
        targetOrigin
      );
    }

    function cancelActiveReaders(filterFn) {
      for (const task of Array.from(activeReaders)) {
        if (!filterFn || filterFn(task)) {
          activeReaders.delete(task);
          try {
            task.cancel();
          } catch (_err) {
            // Ignore cancellation errors
          }
        }
      }
    }

    function captureContext() {
      return {
        sessionId: state.captureSessionId,
        binding: state.bindingContext,
        documentEpoch: state.documentEpoch,
        preConfirm: !state.stateConfirmed
      };
    }

    function isContextStillActive(context) {
      if (state.documentEpoch !== context.documentEpoch) {
        return false;
      }
      if (context.preConfirm) {
        if (state.observedPaused || state.hasPausedOnce) {
          return false;
        }
        if (state.stateConfirmed) {
          return Boolean(state.collectionEnabled && state.captureSessionId !== null);
        }
        return true;
      }
      if (
        !state.collectionEnabled ||
        state.captureSessionId !== context.sessionId
      ) {
        return false;
      }
      const frozenBinding = context.binding;
      if (frozenBinding) {
        const cur = state.bindingContext;
        if (
          !cur ||
          cur.bindingId !== frozenBinding.bindingId ||
          cur.actorUserId !== frozenBinding.actorUserId ||
          cur.captureSessionId !== frozenBinding.captureSessionId ||
          cur.collectionGeneration !== frozenBinding.collectionGeneration ||
          cur.accountGeneration !== frozenBinding.accountGeneration
        ) {
          return false;
        }
      }
      return true;
    }

    function readDynamicStateViewer() {
      const dynViewer = adapter.extractViewerFromWindow(win, { allowInlineScript: false });
      if (dynViewer && dynViewer.actorUserId) {
        state.hasSeenDynamicStateViewer = true;
        if (
          state.supersededDynamicActorId &&
          dynViewer.actorUserId !== state.supersededDynamicActorId
        ) {
          state.supersededDynamicActorId = null;
        }
        return dynViewer;
      }
      return null;
    }

    function readWindowViewerCandidate() {
      const dynViewer = readDynamicStateViewer();
      if (dynViewer) {
        return dynViewer;
      }
      const allowInlineBootstrap =
        !state.hasPausedOnce &&
        !state.hasSeenGraphqlViewer &&
        !state.hasSeenDynamicStateViewer;
      if (!allowInlineBootstrap) {
        return null;
      }
      return adapter.extractViewerFromWindow(win, { allowInlineScript: true });
    }

    function markWindowSnapshotStale() {
      state.hasPausedOnce = true;
      state.needsPostPauseVerification = true;
    }

    function inspectAccountSwitcherHandle() {
      if (!win.document || typeof win.document.querySelector !== 'function') {
        return { status: 'missing', handle: null };
      }
      try {
        const switcherEl = win.document.querySelector(
          '[data-testid="SideNav_AccountSwitcher_Button"]'
        );
        if (!switcherEl) {
          return { status: 'missing', handle: null };
        }

        let foundHandle = null;
        const recordHandle = (h) => {
          if (!h) {
            return true;
          }
          if (foundHandle && foundHandle.toLowerCase() !== h.toLowerCase()) {
            return false;
          }
          foundHandle = h;
          return true;
        };

        const segments = collectCoalescedTextSegments(switcherEl);
        const fields = segments.filter((segment) =>
          HANDLE_FIELD_RE.test(segment.replace(BIDI_FORMAT_RE, ''))
        );
        // A mention in display-name prose can flag a mismatch but cannot confirm a cached viewer.
        const candidates = fields.length ? fields : segments;
        for (const candidate of candidates) {
          if (!scanCoalescedHandleTokens(candidate, recordHandle)) {
            return { status: 'conflict', handle: null };
          }
        }

        if (foundHandle) {
          return { status: 'present', handle: foundHandle, corroborates: fields.length > 0 };
        }
      } catch (_err) {
        // Ignore DOM query errors
      }
      return { status: 'missing', handle: null };
    }

    function canTrustWindowSnapshot(winViewer) {
      if (!winViewer || !winViewer.actorUserId) {
        return false;
      }

      const switcher = inspectAccountSwitcherHandle();
      if (switcher.status === 'conflict') {
        return false;
      }
      let switcherConfirmed = false;
      if (switcher.status === 'present') {
        if (!winViewer.handle) {
          return false;
        }
        if (switcher.handle.toLowerCase() !== winViewer.handle.toLowerCase()) {
          return false;
        }
        switcherConfirmed = switcher.corroborates;
      }

      if (state.needsPostPauseVerification) {
        if (!switcherConfirmed) {
          return false;
        }
        state.needsPostPauseVerification = false;
        if (state.supersededDynamicActorId === winViewer.actorUserId) {
          state.supersededDynamicActorId = null;
        }
        return true;
      }

      if (
        state.supersededDynamicActorId &&
        winViewer.actorUserId === state.supersededDynamicActorId
      ) {
        return false;
      }
      return true;
    }

    function maybeProbeInitialViewer() {
      if (!state.collectionEnabled || state.captureSessionId === null || !state.nonce) {
        return;
      }
      let viewer = state.latestGraphqlViewer;
      if (!viewer) {
        const winViewer = readWindowViewerCandidate();
        if (canTrustWindowSnapshot(winViewer)) {
          viewer = winViewer;
        }
      }
      if (viewer) {
        sendToBridge('VIEWER_EVIDENCE', {
          captureSessionId: state.captureSessionId,
          viewer
        });
      }
    }

    function applyStateSync(data) {
      if (typeof data.debugLogsEnabled === 'boolean') {
        state.debugLogsEnabled = data.debugLogsEnabled;
      }
      const nextEnabled = Boolean(data.collectionEnabled);
      const nextSessionId =
        nextEnabled && Number.isInteger(data.captureSessionId) && data.captureSessionId > 0
          ? data.captureSessionId
          : null;
      const nextBinding =
        nextEnabled && nextSessionId && adapter.isValidBindingContext(data.bindingContext)
          ? Object.freeze({
              bindingId: data.bindingContext.bindingId,
              actorUserId: data.bindingContext.actorUserId,
              captureSessionId: data.bindingContext.captureSessionId,
              collectionGeneration: data.bindingContext.collectionGeneration,
              accountGeneration: data.bindingContext.accountGeneration
            })
          : null;

      const prevEnabled = state.collectionEnabled;
      const prevBindingId = state.bindingContext ? state.bindingContext.bindingId : null;
      const prevActorId = state.bindingContext ? state.bindingContext.actorUserId : null;
      const prevSessionId = state.captureSessionId;

      const nextScope = nextEnabled && data.historyScope?.id && adapter.isValidDecimalId(data.historyScope.actor)
        ? data.historyScope : null;
      const scopeChanged = Boolean(
        scope && (nextScope?.id !== scope.id || nextScope?.query !== scope.query)
      );
      const sessionChanged = Boolean(prevSessionId !== null && prevSessionId !== nextSessionId);
      const bindingSwitched = Boolean(prevBindingId && prevBindingId !== nextBinding?.bindingId);
      if (scopeChanged || sessionChanged || bindingSwitched || (!nextScope && scope)) {
        if (!nextScope && scope) {
          logSync('state sync cleared active scope', {
            prevScopeId: scope.id,
            prevScopeQuery: scope.query || null,
            nextEnabled,
            path: win.location?.pathname || null
          });
        }
        clearHistoryTransport();
      }
      const scopeJustActivated = Boolean(nextScope && (!scope || nextScope.id !== scope.id || nextScope.query !== scope.query));
      scope = nextScope;
      const confirmed = data.stateConfirmed !== false;
      if (confirmed) {
        state.stateConfirmed = true;
      }
      if (typeof data.observedPaused === 'boolean') {
        state.observedPaused = data.observedPaused;
      } else if (confirmed && nextEnabled) {
        state.observedPaused = false;
      }
      state.collectionEnabled = nextEnabled && nextSessionId !== null;
      state.captureSessionId = state.collectionEnabled ? nextSessionId : null;
      state.bindingContext = state.collectionEnabled ? nextBinding : null;
      if (scopeJustActivated || (scope && !prevBindingId && nextBinding)) {
        logSync('state synced', {
          enabled: state.collectionEnabled,
          bindingActor: state.bindingContext?.actorUserId || null,
          scopeId: scope?.id || null,
          scopeQuery: scope?.query || null,
          path: win.location?.pathname || null
        });
      }

      if (data.observedPaused === true || (!state.collectionEnabled && confirmed)) {
        markWindowSnapshotStale();
        pendingPreConfirmPayloads.length = 0;
        pendingSearch = null;
        pendingTimeline = null;
      }

      if (!state.collectionEnabled || (prevSessionId !== null && prevSessionId !== state.captureSessionId)) {
        if (prevEnabled || prevSessionId !== null) {
          markWindowSnapshotStale();
        }
        state.latestGraphqlViewer = null;
        cancelActiveReaders(() => true);
        engine.revokeBinding(null);
      } else if (prevBindingId && (!nextBinding || nextBinding.bindingId !== prevBindingId)) {
        if (!nextBinding) {
          state.latestGraphqlViewer = null;
        }
        cancelActiveReaders((t) => t.bindingId === prevBindingId);
        engine.revokeBinding(prevBindingId);
      }

      if (state.collectionEnabled && state.captureSessionId !== null && pendingPreConfirmPayloads.length > 0) {
        const queuedPreConfirm = pendingPreConfirmPayloads.splice(0);
        for (let i = 0; i < queuedPreConfirm.length; i += 1) {
          const entry = queuedPreConfirm[i];
          if (entry.documentEpoch !== state.documentEpoch) {
            continue;
          }
          handleParsedPayload(entry.match, entry.payload, entry.requestMeta, captureContext(), () => null);
        }
      }

      if (pendingSearch && nextBinding && scope) {
        const held = pendingSearch;
        pendingSearch = null;
        if (nextBinding.actorUserId === scope.actor && isScopedSearch(held.match)) {
          handleParsedPayload(held.match, held.payload, null, captureContext(), () => null);
        }
      }
      if (pendingTimeline && nextBinding && scope) {
        const held = pendingTimeline;
        pendingTimeline = null;
        if (!scope.query && nextBinding.actorUserId === scope.actor && held.match.requestedUserId === scope.actor) {
          handleParsedPayload(held.match, held.payload, null, captureContext(), () => null);
        }
      }
      if (state.collectionEnabled && state.bindingContext) {
        state.needsPostPauseVerification = false;
        if (
          !prevEnabled ||
          prevSessionId !== state.captureSessionId ||
          prevActorId !== state.bindingContext.actorUserId
        ) {
          const dynViewer = readDynamicStateViewer();
          if (dynViewer && dynViewer.actorUserId !== state.bindingContext.actorUserId) {
            state.supersededDynamicActorId = dynViewer.actorUserId;
          } else if (state.bindingContext.actorUserId === state.supersededDynamicActorId) {
            state.supersededDynamicActorId = null;
          }
        }
      } else if (state.collectionEnabled && !state.bindingContext) {
        maybeProbeInitialViewer();
      }
    }

    function onWindowMessage(event) {
      if (!event || event.source !== win) {
        return;
      }
      const expectedOrigin = getTargetOrigin();
      if (!expectedOrigin || event.origin !== expectedOrigin) {
        return;
      }
      const data = event.data;
      if (
        !adapter.isPlainObject(data) ||
        data.protocol !== PROTOCOL ||
        (data.documentEpoch ?? 0) !== state.documentEpoch
      ) {
        return;
      }
      if (adapter.hasDangerousOwnKeys(data, 0)) {
        return;
      }

      if (data.type === 'BRIDGE_INIT') {
        if (typeof data.nonce !== 'string' || data.nonce.length < 6 || data.nonce.length > 128) {
          return;
        }
        state.nonce = data.nonce;
        sendToBridge('MAIN_READY', {});
        applyStateSync(data);
        return;
      }

      if (!state.nonce || data.nonce !== state.nonce) {
        return;
      }

      if (data.type === 'HISTORY_NEXT') {
        scrollNextPage(data);
      } else if (data.type === 'SYNC_STATE') {
        applyStateSync(data);
      } else if (data.type === 'REVOKE_BINDING') {
        const targetId = typeof data.bindingId === 'string' ? data.bindingId : null;
        if (!targetId || (state.bindingContext && state.bindingContext.bindingId === targetId)) {
          state.bindingContext = null;
          state.latestGraphqlViewer = null;
          clearHistoryTransport();
          scope = null;
          cancelActiveReaders((t) => !targetId || t.bindingId === targetId);
          engine.revokeBinding(targetId);
        } else {
          cancelActiveReaders((t) => t.bindingId === targetId);
          engine.revokeBinding(targetId);
        }
      } else if (data.type === 'PROBE_VIEWER') {
        maybeProbeInitialViewer();
      }
    }

    // Only forward stop signals. The isolated bridge scopes them to a manual job.
    function signalHistoryStop(reason, context, readHeader) {
      const retryAfter = readHeader('Retry-After');
      const reset = readHeader('x-rate-limit-reset');
      let retryAt = null;
      if (typeof retryAfter === 'string') {
        retryAt = /^\d+$/.test(retryAfter) ? Date.now() + Number(retryAfter) * 1000 : Date.parse(retryAfter);
      }
      if (typeof reset === 'string' && /^\d+$/.test(reset)) {
        retryAt = Math.max(Number.isSafeInteger(retryAt) ? retryAt : 0, Number(reset) * 1000);
      }
      logSync('signalHistoryStop', { reason, retryAt: Number.isSafeInteger(retryAt) ? retryAt : null });
      sendToBridge('HISTORY_STOP', {
        reason, retryAt: Number.isSafeInteger(retryAt) ? retryAt : null,
        captureSessionId: context.sessionId
      });
    }

    function checkHistoryHttpStatus(status, context, readHeader) {
      let reason;
      if (status === 429) reason = 'rate_limited';
      else if (status === 401 || status === 403) reason = 'verification';
      else if (status >= 500 && status < 600) reason = 'unavailable';
      else return false;
      signalHistoryStop(reason, context, readHeader);
      return true;
    }

    function handleParsedPayload(match, payload, requestMeta, context, readHeader) {
      if (!isContextStillActive(context)) {
        return;
      }
      if (!state.collectionEnabled || state.captureSessionId === null) {
        if (context.preConfirm && isEligiblePreConfirmMatch(match)) {
          if (pendingPreConfirmPayloads.length < MAX_PRE_CONFIRM_PAYLOADS) {
            pendingPreConfirmPayloads.push({
              match,
              payload,
              requestMeta,
              documentEpoch: context.documentEpoch
            });
            logSync('buffered pre-confirm payload', {
              op: match.operationName,
              category: match.category,
              buffered: pendingPreConfirmPayloads.length
            });
          }
        }
        return;
      }
      const errors = Array.isArray(payload?.errors) ? payload.errors : [];
      const hasFatalErrors = errors.some((error) => !Array.isArray(error?.path) || error.path.length === 0);
      if (errors.some(error => error?.code === 88)) {
        signalHistoryStop('rate_limited', context, readHeader);
        return;
      }
      if (errors.some(error => [32, 89, 326, 353].includes(error?.code))) {
        signalHistoryStop('verification', context, readHeader);
        return;
      }
      if (
        state.documentEpoch === context.documentEpoch &&
        (context.preConfirm || (!context.binding && state.bindingContext && state.captureSessionId === context.sessionId))
      ) {
        context = captureContext();
      }
      const frozenBinding = context.binding;

      // Always inspect Viewer operations to establish or verify viewer identity
      if (match.category === 'viewer') {
        const viewer = adapter.extractViewerFromGraphql(payload);
        if (viewer) {
          state.hasSeenGraphqlViewer = true;
          state.needsPostPauseVerification = false;
          const dynViewer = readDynamicStateViewer();
          if (dynViewer && dynViewer.actorUserId !== viewer.actorUserId) {
            state.supersededDynamicActorId = dynViewer.actorUserId;
          } else if (
            (dynViewer && dynViewer.actorUserId === viewer.actorUserId) ||
            state.supersededDynamicActorId === viewer.actorUserId
          ) {
            state.supersededDynamicActorId = null;
          }
          state.latestGraphqlViewer = viewer;
          sendToBridge('VIEWER_EVIDENCE', {
            captureSessionId: context.sessionId,
            viewer
          });
        }
        return;
      }

      if (match.category === 'manual_search' && !(isScopedSearch(match) || (!frozenBinding && isCandidateSearchPage(match)))) {
        return;
      }
      if (!frozenBinding) {
        if (isCandidateSearchPage(match) && !hasFatalErrors) {
          if (scope && isScopedSearch(match) && state.bindingContext?.actorUserId === scope.actor) {
            handleParsedPayload(match, payload, null, captureContext(), readHeader);
          } else if (!state.bindingContext && !pendingSearch) {
            pendingSearch = { match, payload };
          }
        } else if (match.category === 'replies_timeline' && !hasFatalErrors && isCandidateRepliesPage(match)) {
          if (state.bindingContext) {
            handleParsedPayload(match, payload, null, captureContext(), readHeader);
          } else if (!pendingTimeline) {
            pendingTimeline = { match, payload };
          }
        }
        return;
      }

      const observedAt = Date.now();
      if (match.category === 'create_tweet') {
        const res = engine.processCreateTweetResponse({
          payload,
          requestMeta,
          bindingContext: frozenBinding,
          observedAt
        });
        if (
          res.events.length > 0 ||
          res.incompleteObservation ||
          res.anomalies.length > 0
        ) {
          sendToBridge('OBSERVED_EVENTS', {
            bindingContext: frozenBinding,
            events: res.events,
            observedUsers: res.observedUsers,
            observedTweets: res.observedTweets,
            liveCaptureAnomaly: Boolean(res.incompleteObservation || res.anomalies.length > 0),
            historyBackfillAnomaly: false,
            partialUnrecognized: res.anomalies.length > 0,
            incompleteObservation: res.incompleteObservation,
            anomalies: res.anomalies
          });
        } else if (res.observedUsers.length > 0 || res.observedTweets.length > 0) {
          sendToBridge('AUTHOR_MAPPINGS', {
            bindingContext: frozenBinding,
            observedUsers: res.observedUsers,
            observedTweets: res.observedTweets
          });
        }
        return;
      }

      if (match.category === 'replies_timeline' || match.category === 'author_mapping' || isScopedSearch(match)) {
        const res = engine.processTimelineResponse({
          operationName: match.operationName, requestedUserId: match.requestedUserId,
          repliesTimeline: match.category === 'replies_timeline',
          manualSearch: isScopedSearch(match), payload,
          bindingContext: frozenBinding,
          observedAt
        });
        if (res.historyPage && (match.category === 'replies_timeline' || isScopedSearch(match))) {
          const candidate = engine.getRepliesCursor(payload);
          cursor = candidate && !usedCursors.has(candidate) ? candidate : null;
          const hasTweets = res.events.length > 0 || res.observedTweets.length > 0 || Boolean(res.historyPage.pageKey);
          const hasTransport = canScrollDocument();
          if (match.category === 'replies_timeline' && hasTransport) {
            if ((usedCursors.size > 0 && !hasTweets && !res.partialUnrecognized) || (hasTweets && !cursor)) {
              res.historyPage.ended = true;
            }
          }
          if (res.historyPage.ended) {
            cursor = null;
          }
          const searchHasRows = !isScopedSearch(match) || res.events.length > 0 || res.observedTweets.length > 0;
          res.historyPage.canPage = Boolean(hasTransport && cursor && !res.historyPage.ended && searchHasRows);
          const pageNow = Date.now();
          lastNativePageAt = pageNow;
          lastFetchAt = pageNow;
          notifyScrollWaiter();
          logSync('parsed history page', {
            op: match.operationName,
            events: res.events.length,
            observedTweets: res.observedTweets.length,
            candidateCursor: Boolean(candidate),
            reusedCursor: Boolean(candidate && usedCursors.has(candidate)),
            canPage: res.historyPage.canPage,
            ended: res.historyPage.ended,
            newestAt: res.historyPage.newestAt ? new Date(res.historyPage.newestAt).toISOString() : null,
            anomalies: res.anomalies
          });
        } else if (scope && (match.category === 'replies_timeline' || isScopedSearch(match))) {
          logSync('parsed timeline WITHOUT historyPage', {
            op: match.operationName,
            requestedUserId: match.requestedUserId || null,
            bindingActor: frozenBinding.actorUserId,
            events: res.events.length,
            observedTweets: res.observedTweets.length,
            partialUnrecognized: res.partialUnrecognized,
            anomalies: res.anomalies,
            errors: errors.length
          });
        }
        if (res.historyPage && isScopedSearch(match)) res.historyPage.searchQuery = scope.query;
        const combinedEvents = res.events.concat(res.resolvedPendingEvents);
        if (
          res.historyPage ||
          combinedEvents.length > 0 ||
          res.partialUnrecognized ||
          res.anomalies.length > 0
        ) {
          sendToBridge('OBSERVED_EVENTS', {
            bindingContext: frozenBinding,
            events: combinedEvents,
            historyPage: res.historyPage || null,
            observedUsers: res.observedUsers,
            observedTweets: res.observedTweets,
            liveCaptureAnomaly: false,
            historyBackfillAnomaly: Boolean(
              (match.category === 'replies_timeline' || isScopedSearch(match)) &&
                (res.partialUnrecognized || res.anomalies.length > 0)
            ),
            partialUnrecognized: res.partialUnrecognized,
            incompleteObservation: false,
            anomalies: res.anomalies
          });
        } else if (res.observedUsers.length > 0 || res.observedTweets.length > 0) {
          sendToBridge('AUTHOR_MAPPINGS', {
            bindingContext: frozenBinding,
            observedUsers: res.observedUsers,
            observedTweets: res.observedTweets
          });
        }
      }
    }

    async function readBoundedBodyStream(bodyStream, maxBytes, context) {
      state.activeClones += 1;
      let reader = null;
      let aborted = false;
      let timeoutId = null;

      const taskRecord = {
        captureSessionId: context.sessionId,
        bindingId: context.binding?.bindingId || null,
        cancel() {
          aborted = true;
          if (reader) {
            reader.cancel('sparklink_aborted').catch(() => {});
          }
        }
      };
      activeReaders.add(taskRecord);

      try {
        reader = bodyStream.getReader();
        timeoutId = setTimeout(() => {
          aborted = true;
          if (reader) {
            reader.cancel('sparklink_timeout').catch(() => {});
          }
        }, cloneTimeoutMs);
        if (timeoutId && typeof timeoutId.unref === 'function') {
          timeoutId.unref();
        }

        const chunks = [];
        let totalBytes = 0;

        while (!aborted) {
          const step = await reader.read();
          if (aborted || !isContextStillActive(context)) {
            await reader.cancel('sparklink_stale').catch(() => {});
            return { ok: false, text: '' };
          }
          if (step.done) {
            break;
          }
          const chunk = step.value;
          if (!(chunk instanceof Uint8Array)) {
            await reader.cancel('sparklink_unsupported_chunk').catch(() => {});
            return { ok: false, text: '' };
          }
          totalBytes += chunk.byteLength;
          if (totalBytes > maxBytes) {
            await reader.cancel('sparklink_size_exceeded').catch(() => {});
            return { ok: false, text: '' };
          }
          chunks.push(chunk);
        }

        if (aborted || !isContextStillActive(context)) {
          return { ok: false, text: '' };
        }

        const merged = new Uint8Array(totalBytes);
        let offset = 0;
        for (let i = 0; i < chunks.length; i += 1) {
          merged.set(chunks[i], offset);
          offset += chunks[i].byteLength;
        }
        const text = textDecoder
          ? textDecoder.decode(merged)
          : String.fromCharCode.apply(null, merged);
        return { ok: true, text };
      } catch (_err) {
        return { ok: false, text: '' };
      } finally {
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
        }
        activeReaders.delete(taskRecord);
        state.activeClones = Math.max(0, state.activeClones - 1);
      }
    }

    async function readBoundedResponseClone(response, context) {
      if (
        !response ||
        typeof response.clone !== 'function' ||
        response.bodyUsed ||
        !response.ok
      ) {
        return null;
      }
      if (state.activeClones >= maxConcurrentClones) {
        sendToBridge('DIAGNOSTIC', {
          category: 'concurrency_limit_skipped',
          captureSessionId: context.sessionId
        });
        return null;
      }

      let cloned;
      try {
        cloned = response.clone();
      } catch (_err) {
        return null;
      }
      if (!cloned || !cloned.body || typeof cloned.body.getReader !== 'function') {
        return null;
      }

      const bodyResult = await readBoundedBodyStream(
        cloned.body,
        maxResponseBytes,
        context
      );
      if (!bodyResult.ok || !bodyResult.text.trim()) {
        return null;
      }
      try {
        return JSON.parse(bodyResult.text);
      } catch (_err) {
        return null;
      }
    }

    function evaluateCaptureEligibility(url, method) {
      const activeState = state.collectionEnabled && state.captureSessionId !== null;
      const allowPreConfirm = Boolean(
        !state.stateConfirmed && !state.observedPaused && !state.hasPausedOnce
      );
      if (!url || (!activeState && !allowPreConfirm)) {
        return null;
      }
      let match = adapter.matchWhitelistedRequest(url, method);
      let currentPath = '';
      try {
        currentPath = win.location?.href
          ? new URL(win.location.href).pathname
          : win.location?.pathname || '';
      } catch {
        currentPath = win.location?.pathname || '';
      }
      if (!match) {
        if ((scope || !state.stateConfirmed) && /\/graphql\/[^/]+\/([^/?#]+)/i.test(url)) {
          const opMatch = url.match(/\/graphql\/[^/]+\/([^/?#]+)/i);
          const rawOp = opMatch ? opMatch[1] : '';
          if (rawOp && !/^(?:HomeTimeline|HomeLatestTimeline)$/i.test(rawOp)) {
            logSync('unmatched GraphQL request', { op: rawOp, method, path: currentPath || null });
          }
        }
        return null;
      }
      if (
        match.category === 'author_mapping' &&
        /^(?:User|Profile)[A-Za-z0-9_]*(?:Tweets|Posts|Timeline)[A-Za-z0-9_]*$/i.test(match.operationName) &&
        !/Highlight|Article|Media|Likes|SuperFollow/i.test(match.operationName) &&
        /\/with_replies\/?$/i.test(currentPath)
      ) {
        match = { ...match, category: 'replies_timeline' };
      }
      if (activeState) {
        if ((match.category === 'replies_timeline' || match.category === 'manual_search') && scope) {
          if (match.category === 'manual_search' && !isScopedSearch(match)) {
            logSync('ignored SearchTimeline (scope mismatch)', {
              reqQuery: match.searchQuery || null,
              scopeQuery: scope.query || null,
              href: (win.location?.pathname || '') + (win.location?.search || '')
            });
          }
        }
        const searchAllowed =
          match.category !== 'manual_search' ||
          isScopedSearch(match) ||
          (!state.bindingContext && isCandidateSearchPage(match));
        const allowed =
          searchAllowed &&
          (state.bindingContext ||
            match.category === 'viewer' ||
            searchAllowed && match.category === 'manual_search' ||
            isCandidateRepliesPage(match));
        if (!allowed && (match.category === 'replies_timeline' || match.category === 'manual_search')) {
          logSync('skipped native candidate request', {
            op: match.operationName,
            requestedUserId: match.requestedUserId || null,
            scopeActor: scope?.actor || null,
            scopeQuery: scope?.query || null,
            hasBinding: Boolean(state.bindingContext),
            path: currentPath || null
          });
        }
        return allowed ? match : null;
      }
      return isEligiblePreConfirmMatch(match) ? match : null;
    }

    // 1. Wrap window.fetch once without altering Function.prototype.toString
    if (typeof win.fetch === 'function') {
      const originalFetch = win.fetch;
      win.fetch = function sparklinkFetchWrapper(input, init) {
        let captured = null;
        try {
          const { url, method } = extractFetchUrlAndMethod(input, init);
          const match = evaluateCaptureEligibility(url, method);
          if (match) {
            const context = captureContext();
            let requestMeta = null;
            let requestMetaPromise = null;
            let skipObservation = false;
            const trackNativeHistory = match.category === 'replies_timeline' || match.category === 'manual_search';
            if (trackNativeHistory && (scope || !state.stateConfirmed)) {
              logSync('intercepted native fetch', {
                op: match.operationName,
                category: match.category,
                requestedUserId: match.requestedUserId || null,
                hasBinding: Boolean(state.bindingContext),
                preConfirm: !state.stateConfirmed,
                path: win.location?.pathname || null
              });
            }
              if (match.category === 'create_tweet') {
                const hasNonNullInitBody = Boolean(
                  init && typeof init === 'object' && init.body !== undefined && init.body !== null
                );
                if (hasNonNullInitBody) {
                  if (typeof init.body === 'string') {
                    if (utf8ByteLength(init.body) <= maxRequestBytes) {
                      requestMeta = adapter.parseCreateTweetRequest(init.body);
                    } else {
                      skipObservation = true;
                    }
                  } else {
                    // Non-string streaming/binary body: do not consume original Request/stream
                    skipObservation = true;
                  }
                } else if (input && typeof input === 'object' && typeof input.clone === 'function') {
                  if (input.bodyUsed) {
                    skipObservation = true;
                  } else if (input.body !== null && input.body !== undefined) {
                    if (state.activeClones >= maxConcurrentClones) {
                      sendToBridge('DIAGNOSTIC', {
                        category: 'concurrency_limit_skipped',
                        captureSessionId: context.sessionId
                      });
                      skipObservation = true;
                    } else {
                      let clonedReq = null;
                      try {
                        clonedReq = input.clone();
                      } catch (_cloneErr) {
                        clonedReq = null;
                      }
                      if (!clonedReq || !clonedReq.body || typeof clonedReq.body.getReader !== 'function') {
                        skipObservation = true;
                      } else {
                        requestMetaPromise = readBoundedBodyStream(
                          clonedReq.body,
                          maxRequestBytes,
                          context
                        ).then((res) => {
                          if (!res.ok) {
                            if (captured) {
                              captured.skipObservation = true;
                            }
                            return { skipObservation: true, requestMeta: null };
                          }
                          const parsedMeta = res.text.trim()
                            ? adapter.parseCreateTweetRequest(res.text)
                            : null;
                          return { skipObservation: false, requestMeta: parsedMeta };
                        });
                      }
                    }
                  }
                }
              }
              if (!skipObservation) {
                if (trackNativeHistory) {
                  nativeRequestsInFlight += 1;
                }
                captured = {
                  match,
                  requestMeta,
                  requestMetaPromise,
                  skipObservation: false,
                  trackNativeHistory,
                  context
                };
              }
            }
        } catch (_prepErr) {
          captured = null;
        }

        // Preserve exact synchronous throw and Promise return semantics
        const responsePromise = originalFetch.apply(this, arguments);

        if (captured && responsePromise && typeof responsePromise.then === 'function') {
          let settledInFlight = false;
          const finishInFlight = () => {
            if (!settledInFlight && captured.trackNativeHistory) {
              settledInFlight = true;
              nativeRequestsInFlight = Math.max(0, nativeRequestsInFlight - 1);
            }
          };
          responsePromise.then(
            (response) => {
              if (
                captured.skipObservation ||
                !isContextStillActive(captured.context)
              ) {
                finishInFlight();
                return;
              }
              const readHeader = (name) => response?.headers?.get?.(name);
              if (checkHistoryHttpStatus(response?.status, captured.context, readHeader)) {
                finishInFlight();
                return;
              }
              if (captured.trackNativeHistory && response && !response.ok) {
                logSync('native fetch non-ok response', { op: captured.match.operationName, status: response.status });
              }
              const responseJsonPromise = readBoundedResponseClone(
                response,
                captured.context
              );
              if (captured.requestMetaPromise) {
                Promise.all([captured.requestMetaPromise, responseJsonPromise]).then(
                  ([reqInfo, parsedJson]) => {
                    try {
                      if (!reqInfo || reqInfo.skipObservation || !parsedJson) {
                        return;
                      }
                      handleParsedPayload(
                        captured.match,
                        parsedJson,
                        reqInfo.requestMeta,
                        captured.context, readHeader
                      );
                    } finally {
                      finishInFlight();
                    }
                  },
                  finishInFlight
                );
              } else {
                responseJsonPromise.then(
                  (parsedJson) => {
                    try {
                      if (parsedJson) {
                        handleParsedPayload(
                          captured.match,
                          parsedJson,
                          captured.requestMeta,
                          captured.context, readHeader
                        );
                      }
                    } finally {
                      finishInFlight();
                    }
                  },
                  finishInFlight
                );
              }
            },
            () => {
              finishInFlight();
              // Swallow rejection on side-effect chain only; caller still receives original rejection
            }
          );
        }

        return responsePromise;
      };
    }

    // 2. Wrap XMLHttpRequest.prototype.open & send once with instance reuse safety
    if (typeof win.XMLHttpRequest === 'function' && win.XMLHttpRequest.prototype) {
      const xhrProto = win.XMLHttpRequest.prototype;
      const originalOpen = xhrProto.open;
      const originalSend = xhrProto.send;
      const xhrMetaMap = new WeakMap();
      const xhrBoundListeners = new WeakSet();

      xhrProto.open = function sparklinkXhrOpen(method, url) {
        // Call original first so synchronous errors propagate identically
        const result = originalOpen.apply(this, arguments);
        try {
          xhrMetaMap.set(this, {
            method: typeof method === 'string' ? method : 'GET',
            url: typeof url === 'string' ? url : url && typeof url.href === 'string' ? url.href : null,
            activeCapture: null
          });
        } catch (_err) {
          // Ignore metadata tracking errors
        }
        return result;
      };

      xhrProto.send = function sparklinkXhrSend(body) {
        try {
          const meta = xhrMetaMap.get(this);
          if (meta) {
            meta.activeCapture = null;
            const match = evaluateCaptureEligibility(meta.url, meta.method);
            if (match) {
              let requestMeta = null;
              let skip = false;
              if (match.category === 'create_tweet' && body !== undefined && body !== null) {
                if (typeof body === 'string') {
                  if (utf8ByteLength(body) <= maxRequestBytes) {
                    requestMeta = adapter.parseCreateTweetRequest(body);
                  } else {
                    skip = true;
                  }
                } else {
                  skip = true;
                }
              }
              if (!skip) {
                const trackNativeHistory = match.category === 'replies_timeline' || match.category === 'manual_search';
                if (trackNativeHistory) {
                  nativeRequestsInFlight += 1;
                  if (scope || !state.stateConfirmed) {
                    let xhrPath = null;
                    try {
                      xhrPath = win.location?.href
                        ? new URL(win.location.href).pathname
                        : win.location?.pathname || null;
                    } catch {
                      xhrPath = win.location?.pathname || null;
                    }
                    logSync('intercepted native XHR', {
                      op: match.operationName,
                      category: match.category,
                      requestedUserId: match.requestedUserId || null,
                      hasBinding: Boolean(state.bindingContext),
                      preConfirm: !state.stateConfirmed,
                      path: xhrPath
                    });
                  }
                }
                  meta.activeCapture = {
                    match,
                    requestMeta,
                    trackNativeHistory,
                    inFlightSettled: false,
                    context: captureContext()
                  };
                  if (!xhrBoundListeners.has(this) && typeof this.addEventListener === 'function') {
                    xhrBoundListeners.add(this);
                    const settleXhr = (xhrInst) => {
                      const currentMeta = xhrMetaMap.get(xhrInst);
                      const cap = currentMeta && currentMeta.activeCapture;
                      if (cap && cap.trackNativeHistory && !cap.inFlightSettled) {
                        cap.inFlightSettled = true;
                        nativeRequestsInFlight = Math.max(0, nativeRequestsInFlight - 1);
                      }
                    };
                    this.addEventListener('error', () => settleXhr(this));
                    this.addEventListener('abort', () => settleXhr(this));
                    this.addEventListener('load', function onSparklinkXhrLoad() {
                      try {
                        const currentMeta = xhrMetaMap.get(this);
                        const cap = currentMeta && currentMeta.activeCapture;
                        if (!cap) {
                          return;
                        }
                        if (!isContextStillActive(cap.context)) {
                          return;
                        }
                        const readHeader = (name) => this.getResponseHeader?.(name);
                        if (checkHistoryHttpStatus(this.status, cap.context, readHeader)) return;
                        if (typeof this.status !== 'number' || this.status < 200 || this.status >= 300) {
                          if (cap.trackNativeHistory) {
                            logSync('native XHR non-2xx', { op: cap.match.operationName, status: this.status });
                          }
                          return;
                        }
                        const resType = this.responseType || '';
                        let parsed = null;
                        if (resType === '' || resType === 'text') {
                          const text = this.responseText;
                          if (typeof text === 'string' && text.length > 0 && utf8ByteLength(text) <= maxResponseBytes) {
                            parsed = JSON.parse(text);
                          }
                        } else if (resType === 'json') {
                          const obj = this.response;
                          if (adapter.isPlainObject(obj)) {
                            const serialized = JSON.stringify(obj);
                            if (utf8ByteLength(serialized) <= maxResponseBytes) {
                              parsed = obj;
                            }
                          }
                        }
                        // Other responseTypes ('blob', 'arraybuffer', 'document') are safely ignored
                        if (parsed) {
                          handleParsedPayload(
                            cap.match,
                            parsed,
                            cap.requestMeta,
                            cap.context, readHeader
                          );
                        }
                      } catch (_loadErr) {
                        // Never disrupt page XHR listeners
                      } finally {
                        settleXhr(this);
                      }
                    });
                  }
              }
            }
          }
        } catch (_sendPrepErr) {
          // Ignore prep errors
        }
        return originalSend.apply(this, arguments);
      };
    }

    if (typeof win.addEventListener === 'function') {
      win.addEventListener('message', onWindowMessage);
      win.addEventListener('pagehide', () => { clearHistoryTransport(); scope = null; });
      win.addEventListener('pageshow', (ev) => {
        if (ev && ev.persisted) {
          clearHistoryTransport();
          scope = null;
          state.documentEpoch += 1;
          state.bindingContext = null;
          cancelActiveReaders();
          engine.revokeBinding(null);
          markWindowSnapshotStale();
          state.latestGraphqlViewer = null;
        }
      });
      win.addEventListener('DOMContentLoaded', () => {
        if (state.collectionEnabled && !state.bindingContext) {
          maybeProbeInitialViewer();
        }
      });
    }

    // Announce readiness to ISOLATED bridge if bridge loaded first
    sendToBridge('MAIN_HELLO', {});

    const controller = Object.freeze({
      getStateSnapshot() {
        return {
          collectionEnabled: state.collectionEnabled,
          captureSessionId: state.captureSessionId,
          bindingContext: state.bindingContext,
          activeClones: state.activeClones
        };
      }
    });

    installedWindows.set(win, controller);
    return controller;
  }

  if (typeof module === 'object' && module !== null && module.exports) {
    module.exports = {
      PROTOCOL,
      installMainInterceptor
    };
  }

  if (
    root &&
    typeof root === 'object' &&
    root.location &&
    ALLOWED_ORIGINS.has(root.location.origin) &&
    !(typeof module === 'object' && module !== null && module.exports)
  ) {
    installMainInterceptor(root, null);
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
