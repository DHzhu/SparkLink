(function (root) {
  'use strict';

  const PROTOCOL = 'SPARKLINK_BRIDGE_V1';
  const ALLOWED_ORIGINS = new Set(['https://x.com', 'https://twitter.com']);
  const DEFAULT_MAX_CONCURRENT_CLONES = 4;
  const DEFAULT_MAX_REQUEST_BYTES = 256 * 1024;
  const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const DEFAULT_CLONE_TIMEOUT_MS = 2000;

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
      collectionEnabled: false,
      captureSessionId: null,
      bindingContext: null,
      latestGraphqlViewer: null,
      hasPausedOnce: false,
      hasSeenGraphqlViewer: false,
      hasSeenDynamicStateViewer: false,
      supersededDynamicActorId: null,
      lastDynamicStateActorId: null,
      windowSnapshotStale: false,
      staleDynamicActorId: null,
      staleActiveActorId: null,
      activeClones: 0
    };

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

    function isContextStillActive(frozenSessionId, frozenBinding) {
      if (!state.collectionEnabled || state.captureSessionId === null) {
        return false;
      }
      if (state.captureSessionId !== frozenSessionId) {
        return false;
      }
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
        state.lastDynamicStateActorId = dynViewer.actorUserId;
        if (
          state.supersededDynamicActorId &&
          dynViewer.actorUserId !== state.supersededDynamicActorId
        ) {
          state.supersededDynamicActorId = null;
        }
        return dynViewer;
      }
      state.lastDynamicStateActorId = null;
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

    function markWindowSnapshotStale(fallbackActorId) {
      const latestGqlId =
        state.latestGraphqlViewer && state.latestGraphqlViewer.actorUserId
          ? state.latestGraphqlViewer.actorUserId
          : null;
      const activeId = fallbackActorId || latestGqlId || null;
      state.hasPausedOnce = true;
      if (!state.windowSnapshotStale || activeId) {
        state.staleDynamicActorId = state.lastDynamicStateActorId;
        state.staleActiveActorId =
          activeId || state.lastDynamicStateActorId || state.staleActiveActorId || null;
      }
      state.windowSnapshotStale = true;
    }

    function canTrustWindowSnapshot(winViewer) {
      if (!winViewer || !winViewer.actorUserId) {
        return false;
      }
      if (
        state.supersededDynamicActorId &&
        winViewer.actorUserId === state.supersededDynamicActorId
      ) {
        return false;
      }
      if (winViewer.handle && win.document && typeof win.document.querySelector === 'function') {
        try {
          const switcherEl = win.document.querySelector(
            '[data-testid="SideNav_AccountSwitcher_Button"]'
          );
          if (switcherEl && typeof switcherEl.textContent === 'string') {
            const m = /(?:^|\s)@([A-Za-z0-9_]{1,64})(?:\s|$)/.exec(switcherEl.textContent);
            if (m && m[1].toLowerCase() !== winViewer.handle.toLowerCase()) {
              return false;
            }
          }
        } catch (_err) {
          // Ignore DOM query errors
        }
      }
      if (!state.windowSnapshotStale) {
        return true;
      }
      if (state.staleDynamicActorId && winViewer.actorUserId === state.staleDynamicActorId) {
        return false;
      }
      if (state.staleActiveActorId && winViewer.actorUserId === state.staleActiveActorId) {
        return false;
      }
      state.windowSnapshotStale = false;
      state.staleDynamicActorId = null;
      state.staleActiveActorId = null;
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

      state.collectionEnabled = nextEnabled && nextSessionId !== null;
      state.captureSessionId = state.collectionEnabled ? nextSessionId : null;
      state.bindingContext = state.collectionEnabled ? nextBinding : null;

      if (data.observedPaused === true || (!state.collectionEnabled && data.stateConfirmed !== false)) {
        state.hasPausedOnce = true;
      }

      if (!state.collectionEnabled || prevSessionId !== state.captureSessionId) {
        if (prevEnabled || prevSessionId !== null) {
          markWindowSnapshotStale(prevActorId);
        }
        state.latestGraphqlViewer = null;
        cancelActiveReaders(() => true);
        engine.revokeBinding(null);
      } else if (prevBindingId && (!nextBinding || nextBinding.bindingId !== prevBindingId)) {
        cancelActiveReaders((t) => t.bindingId === prevBindingId);
        engine.revokeBinding(prevBindingId);
      }

      if (state.collectionEnabled && state.bindingContext) {
        if (
          !prevEnabled ||
          prevSessionId !== state.captureSessionId ||
          prevActorId !== state.bindingContext.actorUserId
        ) {
          state.windowSnapshotStale = false;
          state.staleDynamicActorId = null;
          state.staleActiveActorId = null;
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
      if (!adapter.isPlainObject(data) || data.protocol !== PROTOCOL) {
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

      if (data.type === 'SYNC_STATE') {
        applyStateSync(data);
      } else if (data.type === 'REVOKE_BINDING') {
        const targetId = typeof data.bindingId === 'string' ? data.bindingId : null;
        if (!targetId || (state.bindingContext && state.bindingContext.bindingId === targetId)) {
          state.bindingContext = null;
          state.latestGraphqlViewer = null;
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

    function handleParsedPayload(match, payload, requestMeta, frozenSessionId, frozenBinding) {
      if (!isContextStillActive(frozenSessionId, frozenBinding)) {
        return;
      }

      // Always inspect Viewer operations to establish or verify viewer identity
      if (match.category === 'viewer') {
        const viewer = adapter.extractViewerFromGraphql(payload);
        if (viewer) {
          state.hasSeenGraphqlViewer = true;
          state.windowSnapshotStale = false;
          state.staleDynamicActorId = null;
          state.staleActiveActorId = null;
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
            captureSessionId: frozenSessionId,
            viewer
          });
        }
        return;
      }

      if (!frozenBinding) {
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

      if (match.category === 'replies_timeline' || match.category === 'author_mapping') {
        const res = engine.processTimelineResponse({
          operationName: match.operationName,
          payload,
          bindingContext: frozenBinding,
          observedAt
        });
        const combinedEvents = res.events.concat(res.resolvedPendingEvents);
        if (
          combinedEvents.length > 0 ||
          res.partialUnrecognized ||
          res.anomalies.length > 0
        ) {
          sendToBridge('OBSERVED_EVENTS', {
            bindingContext: frozenBinding,
            events: combinedEvents,
            observedUsers: res.observedUsers,
            observedTweets: res.observedTweets,
            liveCaptureAnomaly: false,
            historyBackfillAnomaly: Boolean(
              match.category === 'replies_timeline' &&
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

    async function readBoundedBodyStream(bodyStream, maxBytes, frozenSessionId, frozenBinding) {
      state.activeClones += 1;
      let reader = null;
      let aborted = false;
      let timeoutId = null;

      const taskRecord = {
        captureSessionId: frozenSessionId,
        bindingId: frozenBinding ? frozenBinding.bindingId : null,
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
          if (aborted || !isContextStillActive(frozenSessionId, frozenBinding)) {
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

        if (aborted || !isContextStillActive(frozenSessionId, frozenBinding)) {
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

    async function readBoundedResponseClone(response, frozenSessionId, frozenBinding) {
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
          captureSessionId: frozenSessionId
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
        frozenSessionId,
        frozenBinding
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

    // 1. Wrap window.fetch once without altering Function.prototype.toString
    if (typeof win.fetch === 'function') {
      const originalFetch = win.fetch;
      win.fetch = function sparklinkFetchWrapper(input, init) {
        let captured = null;
        if (state.collectionEnabled && state.captureSessionId !== null) {
          try {
            const { url, method } = extractFetchUrlAndMethod(input, init);
            const match = url ? adapter.matchWhitelistedRequest(url, method) : null;
            if (match && (state.bindingContext || match.category === 'viewer')) {
              const frozenSessionId = state.captureSessionId;
              const frozenBinding = state.bindingContext;
              let requestMeta = null;
              let requestMetaPromise = null;
              let skipObservation = false;
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
                        captureSessionId: frozenSessionId
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
                          frozenSessionId,
                          frozenBinding
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
                captured = {
                  match,
                  requestMeta,
                  requestMetaPromise,
                  skipObservation: false,
                  frozenSessionId,
                  frozenBinding
                };
              }
            }
          } catch (_prepErr) {
            captured = null;
          }
        }

        // Preserve exact synchronous throw and Promise return semantics
        const responsePromise = originalFetch.apply(this, arguments);

        if (captured && responsePromise && typeof responsePromise.then === 'function') {
          responsePromise.then(
            (response) => {
              if (
                captured.skipObservation ||
                !isContextStillActive(captured.frozenSessionId, captured.frozenBinding)
              ) {
                return;
              }
              const responseJsonPromise = readBoundedResponseClone(
                response,
                captured.frozenSessionId,
                captured.frozenBinding
              );
              if (captured.requestMetaPromise) {
                Promise.all([captured.requestMetaPromise, responseJsonPromise]).then(
                  ([reqInfo, parsedJson]) => {
                    if (!reqInfo || reqInfo.skipObservation || !parsedJson) {
                      return;
                    }
                    handleParsedPayload(
                      captured.match,
                      parsedJson,
                      reqInfo.requestMeta,
                      captured.frozenSessionId,
                      captured.frozenBinding
                    );
                  }
                );
              } else {
                responseJsonPromise.then((parsedJson) => {
                  if (parsedJson) {
                    handleParsedPayload(
                      captured.match,
                      parsedJson,
                      captured.requestMeta,
                      captured.frozenSessionId,
                      captured.frozenBinding
                    );
                  }
                });
              }
            },
            () => {
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
            if (state.collectionEnabled && state.captureSessionId !== null && meta.url) {
              const match = adapter.matchWhitelistedRequest(meta.url, meta.method);
              if (match && (state.bindingContext || match.category === 'viewer')) {
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
                  meta.activeCapture = {
                    match,
                    requestMeta,
                    frozenSessionId: state.captureSessionId,
                    frozenBinding: state.bindingContext
                  };
                  if (!xhrBoundListeners.has(this) && typeof this.addEventListener === 'function') {
                    xhrBoundListeners.add(this);
                    this.addEventListener('load', function onSparklinkXhrLoad() {
                      try {
                        const currentMeta = xhrMetaMap.get(this);
                        const cap = currentMeta && currentMeta.activeCapture;
                        if (!cap) {
                          return;
                        }
                        if (!isContextStillActive(cap.frozenSessionId, cap.frozenBinding)) {
                          return;
                        }
                        if (typeof this.status !== 'number' || this.status < 200 || this.status >= 300) {
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
                            cap.frozenSessionId,
                            cap.frozenBinding
                          );
                        }
                      } catch (_loadErr) {
                        // Never disrupt page XHR listeners
                      }
                    });
                  }
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
