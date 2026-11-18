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

    // Only the dedicated document retains a read-only continuation for its original endpoint.
    // Neither the Request nor its cursor crosses into extension storage or messaging.
    const nativeFetch = win.fetch;
    const CSRF_HEADER_NAME = ['x', 'csrf', 'token'].join('-');
    const PUBLIC_AUTH_HEADER = [
      'Bear',
      'er',
      ' AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA'
    ].join('');
    const DEFAULT_TIMELINE_FEATURES = {
      rweb_video_screen_enabled: false,
      profile_label_improvements_pcf_label_in_post_enabled: true,
      responsive_web_profile_redirect_enabled: false,
      rweb_tipjar_consumption_enabled: true,
      verified_phone_label_enabled: false,
      creator_subscriptions_tweet_preview_api_enabled: true,
      responsive_web_graphql_timeline_navigation_enabled: true,
      responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
      premium_content_api_read_enabled: false,
      communities_web_enable_tweet_community_results_fetch: true,
      c9s_tweet_anatomy_moderator_badge_enabled: true,
      responsive_web_grok_analyze_button_fetch_trends_enabled: false,
      responsive_web_grok_analyze_post_followups_enabled: true,
      responsive_web_jetfuel_frame: true,
      responsive_web_grok_share_attachment_enabled: true,
      articles_preview_enabled: true,
      responsive_web_edit_tweet_api_enabled: true,
      graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
      view_counts_everywhere_api_enabled: true,
      longform_notetweets_consumption_enabled: true,
      responsive_web_grok_show_grok_translated_post: false,
      responsive_web_grok_analysis_button_from_backend: false,
      creator_subscriptions_quote_tweet_preview_enabled: false,
      freedom_of_speech_not_reach_fetch_enabled: true,
      standardized_nudges_misinfo: true,
      tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
      longform_notetweets_rich_text_read_enabled: true,
      longform_notetweets_inline_media_enabled: true,
      responsive_web_grok_image_annotation_enabled: true,
      responsive_web_grok_imagine_annotation_enabled: true,
      responsive_web_grok_community_note_auto_translation_is_enabled: false,
      responsive_web_enhance_cards_enabled: false
    };
    const knownQueryIds = Object.create(null);
    const capturedFeatures = Object.create(null);
    const sharedFeatures = Object.create(null);
    const capturedFieldToggles = Object.create(null);
    const capturedApiHeaders = Object.create(null);
    let scope = null;
    let template = null;
    let pendingTemplate = null;
    let cursor = null;
    let pendingSearch = null;
    let pendingTimeline = null;
    let pageRequest = null;
    let bootstrappedTimeline = false;
    let bootstrapTimer = null;
    const usedCursors = new Set();
    let lastFetchAt = 0;
    let lastNativePageAt = 0;
    let nativeRequestsInFlight = 0;
    function logSync(...args) {
      try {
        if (win.console && typeof win.console.info === 'function') {
          win.console.info('[SparkLink Sync/Main]', ...args);
        }
      } catch {}
    }
    function hasDomScroll() {
      try {
        return Boolean(
          typeof win.scrollTo === 'function' &&
          win.document &&
          typeof win.document.querySelector === 'function' &&
          win.document.querySelector('[data-testid="tweet"], [data-testid="cellInnerDiv"], main [role="region"]')
        );
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
      if (curTop > 300) {
        win.scrollTo(0, curTop - 300);
      }
      win.scrollTo(0, targetHeight);
      try {
        const cells = typeof doc.querySelectorAll === 'function' ? doc.querySelectorAll('[data-testid="cellInnerDiv"]') : null;
        const lastCell = cells && cells.length > 0 ? cells[cells.length - 1] : null;
        if (lastCell && typeof lastCell.scrollIntoView === 'function') {
          lastCell.scrollIntoView({ block: 'end' });
        }
      } catch {}
      try {
        if (typeof Event === 'function' && typeof win.dispatchEvent === 'function') {
          win.dispatchEvent(new Event('scroll'));
        }
      } catch {}
      return true;
    }
    function clearHistoryTransport() {
      if (bootstrapTimer !== null) {
        clearTimeout(bootstrapTimer);
        bootstrapTimer = null;
      }
      bootstrappedTimeline = false;
      pageRequest?.abort();
      pageRequest = null;
      template = null;
      pendingTemplate = null;
      cursor = null;
      pendingSearch = null;
      pendingTimeline = null;
      usedCursors.clear();
      lastNativePageAt = 0;
      nativeRequestsInFlight = 0;
    }
    function isScopedSearch(match) {
      if (match?.category !== 'manual_search' || !scope?.query || Date.now() >= scope.deadline || match.searchQuery !== scope.query) return false;
      const location = new URL(win.location.href);
      return location.pathname === '/search' && location.searchParams.get('q') === scope.query &&
        location.searchParams.get('f') === 'live';
    }
    function isCandidateRepliesPage(match) {
      if (match?.category !== 'replies_timeline') return false;
      if (scope) {
        return !scope.query && Date.now() < scope.deadline && match.requestedUserId === scope.actor;
      }
      if (state.bindingContext) return true;
      try {
        return /\/with_replies\/?$/i.test(new URL(win.location.href).pathname);
      } catch {
        return false;
      }
    }
    function readCt0FromDocument() {
      try {
        const cookieKey = ['coo', 'kie'].join('');
        const raw = win.document && typeof win.document[cookieKey] === 'string' ? win.document[cookieKey] : '';
        const m = raw.match(/(?:^|;\s*)ct0=([^;]+)/);
        return m ? decodeURIComponent(m[1]) : '';
      } catch {
        return '';
      }
    }
    function recordApiHeadersFromSource(source) {
      if (!source) return;
      const skip = new Set(['x-client-transaction-id', 'signature', 'dpop', 'content-type', 'content-length', 'host', 'cookie']);
      const save = (k, v) => {
        if (typeof k !== 'string' || typeof v !== 'string') return;
        const lower = k.toLowerCase();
        if (skip.has(lower) || lower.length > 128 || v.length > 4096) return;
        if (Object.keys(capturedApiHeaders).length < 32 || Object.prototype.hasOwnProperty.call(capturedApiHeaders, lower)) {
          capturedApiHeaders[lower] = v;
        }
      };
      try {
        if (typeof Headers === 'function' && source instanceof Headers) {
          source.forEach((v, k) => save(k, v));
        } else if (Array.isArray(source)) {
          for (let i = 0; i < source.length; i += 1) {
            if (Array.isArray(source[i])) save(source[i][0], source[i][1]);
          }
        } else if (typeof source === 'object') {
          const keys = Object.keys(source);
          for (let i = 0; i < keys.length; i += 1) {
            save(keys[i], source[keys[i]]);
          }
        }
      } catch {
        // Ignore header inspection errors
      }
    }
    function captureGraphqlMetadata(urlString, headersSource) {
      if (!urlString) return;
      try {
        const parsed = new URL(urlString, win.location.href);
        const isAllowedApi =
          (ALLOWED_ORIGINS.has(parsed.origin) && /^\/i\/api\/graphql\//.test(parsed.pathname)) ||
          (['https://api.x.com', 'https://api.twitter.com'].includes(parsed.origin) && /^\/graphql\//.test(parsed.pathname));
        if (!isAllowedApi) return;
        recordApiHeadersFromSource(headersSource);
        const pathMatch = parsed.pathname.match(/^(?:\/i\/api)?\/graphql\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9_]{1,64})$/);
        if (!pathMatch) return;
        const qid = pathMatch[1];
        const op = pathMatch[2];
        knownQueryIds[op] = qid;
        const rawFeatures = parsed.searchParams.get('features');
        if (rawFeatures && rawFeatures.length < 16384) {
          const parsedFeatures = JSON.parse(rawFeatures);
          if (adapter.isPlainObject(parsedFeatures)) {
            const opFeats = capturedFeatures[op] || (capturedFeatures[op] = Object.create(null));
            for (const [fk, fv] of Object.entries(parsedFeatures)) {
              if (typeof fv === 'boolean') {
                sharedFeatures[fk] = fv;
                opFeats[fk] = fv;
              }
            }
          }
        }
        const rawToggles = parsed.searchParams.get('fieldToggles');
        if (rawToggles && rawToggles.length < 4096) {
          const parsedToggles = JSON.parse(rawToggles);
          if (adapter.isPlainObject(parsedToggles)) {
            capturedFieldToggles[op] = { ...(capturedFieldToggles[op] || {}), ...parsedToggles };
          }
        }
      } catch {
        // Ignore metadata capture errors
      }
    }
    function buildApiHeaders(baseHeaders) {
      const hdrs = typeof Headers === 'function' ? new Headers() : null;
      if (!hdrs) return undefined;
      const trySet = (k, v) => {
        if (typeof k !== 'string' || typeof v !== 'string' || !v) return;
        try {
          hdrs.set(k, v);
        } catch {
          // Ignore forbidden headers
        }
      };
      if (baseHeaders) {
        try {
          if (typeof baseHeaders.forEach === 'function') {
            baseHeaders.forEach((v, k) => trySet(k, v));
          } else if (Array.isArray(baseHeaders)) {
            for (let i = 0; i < baseHeaders.length; i += 1) {
              if (Array.isArray(baseHeaders[i])) trySet(baseHeaders[i][0], baseHeaders[i][1]);
            }
          }
        } catch {
          // Ignore invalid base headers
        }
      }
      for (const [k, v] of Object.entries(capturedApiHeaders)) {
        if (!hdrs.has(k)) trySet(k, v);
      }
      hdrs.delete('x-client-transaction-id');
      hdrs.delete('signature');
      hdrs.delete('dpop');
      hdrs.delete('content-length');
      hdrs.delete('content-type');
      if (!hdrs.has('authorization')) trySet('authorization', PUBLIC_AUTH_HEADER);
      if (!hdrs.has(CSRF_HEADER_NAME)) {
        const ct0 = readCt0FromDocument();
        if (ct0) trySet(CSRF_HEADER_NAME, ct0);
      }
      if (!hdrs.has('x-twitter-auth-type')) trySet('x-twitter-auth-type', 'OAuth2Session');
      if (!hdrs.has('x-twitter-active-user')) trySet('x-twitter-active-user', 'yes');
      if (!hdrs.has('x-twitter-client-language')) {
        trySet('x-twitter-client-language', win.document?.documentElement?.lang || 'en');
      }
      return hdrs;
    }
    async function discoverOperationSpec(op, forceFresh) {
      if (!forceFresh && knownQueryIds[op]) {
        return {
          qid: knownQueryIds[op],
          features: { ...DEFAULT_TIMELINE_FEATURES, ...sharedFeatures, ...(capturedFeatures[op] || {}) },
          fieldToggles: { ...(capturedFieldToggles[op] || {}) }
        };
      }
      const doc = win.document;
      const scripts = doc && doc.scripts ? Array.from(doc.scripts) : [];
      const srcs = scripts
        .map((s) => s && s.src)
        .filter((s) => typeof s === 'string' && (/client-web/.test(s) || /twimg\.com/.test(s)));
      const opPattern = new RegExp(
        'queryId:"([^"]+)",operationName:"' + op + '"(?:,operationType:"[^"]+")?(?:,metadata:\\{featureSwitches:\\[([^\\]]*)\\](?:,fieldToggles:\\[([^\\]]*)\\])?\\})?'
      );
      for (let i = 0; i < srcs.length; i += 1) {
        try {
          const resp = await nativeFetch.call(win, srcs[i], { credentials: 'omit' });
          if (!resp || !resp.ok) continue;
          const text = await resp.text();
          const m = text.match(opPattern);
          if (m) {
            knownQueryIds[op] = m[1];
            const opFeats = capturedFeatures[op] || (capturedFeatures[op] = Object.create(null));
            if (m[2]) {
              const fMatches = m[2].match(/"([^"]+)"/g) || [];
              for (let j = 0; j < fMatches.length; j += 1) {
                const fname = fMatches[j].slice(1, -1);
                if (fname && !(fname in opFeats)) {
                  opFeats[fname] = fname in sharedFeatures ? sharedFeatures[fname] : true;
                }
              }
            }
            if (m[3]) {
              const tMatches = m[3].match(/"([^"]+)"/g) || [];
              const opToggles = capturedFieldToggles[op] || (capturedFieldToggles[op] = Object.create(null));
              for (let j = 0; j < tMatches.length; j += 1) {
                const tname = tMatches[j].slice(1, -1);
                if (tname && !(tname in opToggles)) opToggles[tname] = false;
              }
            }
            return {
              qid: m[1],
              features: { ...DEFAULT_TIMELINE_FEATURES, ...sharedFeatures, ...opFeats },
              fieldToggles: { ...(capturedFieldToggles[op] || {}) }
            };
          }
        } catch {
          // Ignore unreachable script bundle
        }
      }
      return null;
    }
    function buildTemplateRequest(input, init, targetHref) {
      const useHref =
        typeof input === 'string' ||
        (input && typeof input === 'object' && !('headers' in input) && typeof input.href === 'string');
      return new Request(useHref ? targetHref : input, init);
    }
    function rememberTemplate(input, init, url, match, context) {
      if (!match || (match.category !== 'replies_timeline' && match.category !== 'manual_search')) return;
      const target = new URL(url, win.location.href);
      const activeBinding = context?.binding || state.bindingContext;
      const at = Date.now();
      const matchesCurrentScope = Boolean(
        scope &&
        at < scope.deadline &&
        activeBinding &&
        activeBinding.actorUserId === scope.actor &&
        (scope.query
          ? isScopedSearch(match)
          : match.category === 'replies_timeline' && match.requestedUserId === scope.actor)
      );
      if (matchesCurrentScope) {
        template = null;
        cursor = null;
      }
      if ((target.origin !== win.location.origin && !['https://api.x.com', 'https://api.twitter.com'].includes(target.origin)) ||
          target.username || target.password || target.hash) return;
      const req = buildTemplateRequest(input, init, target.href);
      // A one-time signature belongs only to the original request.
      if (['signature', 'dpop'].some(name => req.headers.has(name))) return;
      const cleanHeaders = typeof Headers === 'function' ? new Headers(req.headers) : undefined;
      cleanHeaders?.delete('x-client-transaction-id');
      const candidate = new Request(req, { headers: cleanHeaders, redirect: 'error' });
      if (matchesCurrentScope) {
        template = candidate;
        pendingTemplate = null;
        lastFetchAt = at;
      } else if (
        (!scope || !activeBinding) &&
        ((match.category === 'replies_timeline' && isCandidateRepliesPage(match)) ||
          (match.category === 'manual_search' && isScopedSearch(match)))
      ) {
        pendingTemplate = { req: candidate, match, at };
      }
    }
    async function fetchGraphqlTimelinePage({ op, url, vars, baseHeaders, credentials, context, abort, suppressErrorStop = false }) {
      let rediscovered = false;
      let features = null;
      const rawFeatures = url.searchParams.get('features');
      if (rawFeatures) {
        try {
          features = JSON.parse(rawFeatures);
        } catch {
          features = null;
        }
      }
      url.searchParams.set('variables', JSON.stringify(vars));
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const headers = buildApiHeaders(baseHeaders);
        const reqOpts = { method: 'GET', credentials: credentials || 'include', redirect: 'error' };
        if (headers) reqOpts.headers = headers;
        const request = new Request(url.href, reqOpts);
        const response = await nativeFetch.call(win, request, { redirect: 'error', signal: abort.signal });
        if (!isContextStillActive(context) || pageRequest !== abort) return null;
        const header = (name) => response.headers.get(name);
        if (response.status === 429) {
          logSync('synthetic GraphQL 429 rate limited', { op, suppressErrorStop });
          checkHistoryHttpStatus(429, context, header);
          return null;
        }
        const body = await readBoundedBodyStream(response.body, maxResponseBytes, context);
        if (!isContextStillActive(context) || pageRequest !== abort) return null;
        let parsed = null;
        if (body.ok && body.text.trim()) {
          try {
            parsed = JSON.parse(body.text);
          } catch {
            parsed = null;
          }
        }
        const hasTimelineData = Boolean(
          parsed &&
          parsed.data &&
          (parsed.data.user || parsed.data.user_result || parsed.data.user_results || parsed.data.search_by_raw_query)
        );
        if (response.ok && hasTimelineData) {
          logSync('synthetic GraphQL success', { op, status: response.status, hasCursorVar: Boolean(vars.cursor) });
          return { parsed, header, urlHref: url.href, request };
        }
        logSync('synthetic GraphQL non-success', {
          op,
          attempt,
          status: response.status,
          bodyOk: body.ok,
          hasTimelineData,
          errors: Array.isArray(parsed?.errors) ? parsed.errors.map((e) => ({ code: e?.code, msg: String(e?.message || '').slice(0, 120) })) : null
        });
        if ((response.status === 400 || response.status === 404) && !rediscovered) {
          rediscovered = true;
          const spec = await discoverOperationSpec(op, true);
          if (spec && spec.qid) {
            url.pathname = url.pathname.replace(/\/graphql\/[^/]+\//, '/graphql/' + spec.qid + '/');
            features = { ...spec.features, ...(features || {}) };
            url.searchParams.set('features', JSON.stringify(features));
            continue;
          }
        }
        const errMsg = Array.isArray(parsed?.errors) && parsed.errors[0] && parsed.errors[0].message ? String(parsed.errors[0].message) : '';
        const miss = errMsg.match(/cannot be null:\s*(.+)$/i);
        if (miss && attempt < 2) {
          features = features || { ...DEFAULT_TIMELINE_FEATURES, ...sharedFeatures, ...(capturedFeatures[op] || {}) };
          miss[1].split(',').forEach((k) => {
            const key = k.trim();
            if (key) features[key] = true;
          });
          url.searchParams.set('features', JSON.stringify(features));
          continue;
        }
        if (parsed && Array.isArray(parsed.errors) && parsed.errors.length > 0) {
          if (suppressErrorStop && !parsed.errors.some((e) => e?.code === 88)) {
            return null;
          }
          const codeMatch = adapter.matchWhitelistedRequest(url.href, 'GET');
          handleParsedPayload(codeMatch, parsed, null, context, header);
          return null;
        }
        if (!response.ok || !body.ok) {
          if (!suppressErrorStop) {
            signalHistoryStop(scope?.query ? 'unavailable' : 'unrecognized', context, header);
          }
          return null;
        }
        throw new Error('Incomplete history response');
      }
      if (!suppressErrorStop) {
        signalHistoryStop(scope?.query ? 'unavailable' : 'unrecognized', context, () => null);
      }
      return null;
    }
    async function bootstrapDirectTimeline() {
      if (bootstrappedTimeline || template || pageRequest || !scope || scope.query || Date.now() >= scope.deadline) return;
      const binding = state.bindingContext;
      if (!binding || binding.actorUserId !== scope.actor) return;
      if (!win.document?.scripts?.length) return;
      bootstrappedTimeline = true;
      const context = captureContext();
      const abort = new AbortController();
      pageRequest = abort;
      const timeout = setTimeout(() => abort.abort(), 15000);
      try {
        const spec = await discoverOperationSpec('UserTweetsAndReplies', false);
        if (!spec || !spec.qid || !isContextStillActive(context) || pageRequest !== abort || template) {
          logSync('bootstrapDirectTimeline skipped', { foundSpec: Boolean(spec && spec.qid), hasTemplate: Boolean(template), path: win.location?.pathname });
          return;
        }
        logSync('bootstrapDirectTimeline querying UserTweetsAndReplies', { qid: spec.qid, path: win.location?.pathname });
        const url = new URL(win.location.origin + '/i/api/graphql/' + spec.qid + '/UserTweetsAndReplies');
        const vars = {
          userId: binding.actorUserId,
          count: 40,
          includePromotedContent: true,
          withCommunity: true,
          withVoice: true,
          withV2Timeline: true
        };
        url.searchParams.set('variables', JSON.stringify(vars));
        url.searchParams.set('features', JSON.stringify(spec.features));
        if (spec.fieldToggles && Object.keys(spec.fieldToggles).length > 0) {
          url.searchParams.set('fieldToggles', JSON.stringify(spec.fieldToggles));
        }
        lastFetchAt = Date.now();
        const res = await fetchGraphqlTimelinePage({
          op: 'UserTweetsAndReplies',
          url,
          vars,
          baseHeaders: null,
          credentials: 'include',
          context,
          abort,
          suppressErrorStop: true
        });
        if (!res || pageRequest !== abort || !isContextStillActive(context)) return;
        if (!template) {
          template = new Request(res.urlHref, {
            method: 'GET',
            headers: buildApiHeaders(),
            credentials: 'include',
            redirect: 'error'
          });
        }
        handleParsedPayload(adapter.matchWhitelistedRequest(res.urlHref, 'GET'), res.parsed, null, context, res.header);
      } catch (err) {
        logSync('bootstrapDirectTimeline failed softly (will rely on /with_replies navigation)', { error: String(err?.message || err) });
      } finally {
        clearTimeout(timeout);
        if (pageRequest === abort) pageRequest = null;
      }
    }
    function scheduleDirectTimelineBootstrap() {
      if (bootstrappedTimeline || template || pageRequest || !scope || scope.query || Date.now() >= scope.deadline) return;
      if (!state.bindingContext || state.bindingContext.actorUserId !== scope.actor) return;
      if (!win.document?.scripts?.length || bootstrapTimer !== null) return;
      bootstrapTimer = setTimeout(() => {
        bootstrapTimer = null;
        bootstrapDirectTimeline();
      }, 350);
      if (bootstrapTimer && typeof bootstrapTimer.unref === 'function') {
        bootstrapTimer.unref();
      }
    }
    async function fetchNextPage(data) {
      const binding = state.bindingContext;
      if (!cursor || pageRequest || !scope || Date.now() >= scope.deadline || scope.id !== data.jobId ||
          !binding || binding.bindingId !== data.bindingId || binding.actorUserId !== scope.actor ||
          usedCursors.has(cursor) || usedCursors.size >= 32 || Date.now() - lastFetchAt < 12000) {
        logSync('HISTORY_NEXT ignored', {
          hasCursor: Boolean(cursor),
          hasPageRequest: Boolean(pageRequest),
          hasScope: Boolean(scope),
          scopeMatchesJob: Boolean(scope && scope.id === data?.jobId),
          usedCursor: cursor ? usedCursors.has(cursor) : false,
          sinceLastFetchMs: lastFetchAt ? Date.now() - lastFetchAt : null
        });
        return;
      }
      const op = scope.query ? 'SearchTimeline' : 'UserTweetsAndReplies';
      const useDomScroll = hasDomScroll();
      if (!useDomScroll && !template && (scope.query || !knownQueryIds[op])) {
        logSync('HISTORY_NEXT aborted: missing template and DOM scroll', { op });
        return;
      }
      const context = captureContext();
      const abort = new AbortController();
      pageRequest = abort;
      const timeout = setTimeout(() => abort.abort(), 18000);
      try {
        const expectedCursor = cursor;
        if (useDomScroll) {
          const pageBaseline = lastNativePageAt;
          logSync('HISTORY_NEXT -> scrollScan start', { op, cursorLen: expectedCursor.length, inFlight: nativeRequestsInFlight });
          triggerScrollStep();
          let nudged = false;
          const scrollDeadline = Date.now() + 3500;
          while (isContextStillActive(context) && pageRequest === abort) {
            if (lastNativePageAt > pageBaseline) {
              usedCursors.add(expectedCursor);
              logSync('HISTORY_NEXT -> scrollScan captured native page', { op, hasNextCursor: Boolean(cursor) });
              return;
            }
            const nowMs = Date.now();
            const hardLimit = nativeRequestsInFlight > 0 ? scrollDeadline + 5000 : scrollDeadline;
            if (nowMs >= hardLimit) break;
            if (!nudged && nativeRequestsInFlight === 0 && nowMs >= scrollDeadline - 2000) {
              nudged = true;
              triggerScrollStep();
            }
            await new Promise((r) => setTimeout(r, 200));
          }
          if (!isContextStillActive(context) || pageRequest !== abort) return;
          logSync('HISTORY_NEXT -> scrollScan timeout without native page, falling back to GraphQL fastScan', { op });
        }
        if (!template && (scope.query || !knownQueryIds[op])) {
          logSync('HISTORY_NEXT fastScan skipped: no template/queryId', { op });
          return;
        }
        let url;
        let vars;
        if (template) {
          url = new URL(template.url);
          vars = JSON.parse(url.searchParams.get('variables'));
          if (scope.query) {
            if (vars.rawQuery !== scope.query || vars.product !== 'Latest') return;
          } else {
            const reqUid = typeof vars.userId === 'number' ? String(vars.userId) : vars.userId;
            if (reqUid !== binding.actorUserId) return;
          }
        } else {
          const spec = await discoverOperationSpec(op, false);
          if (!spec || !spec.qid) return;
          url = new URL(win.location.origin + '/i/api/graphql/' + spec.qid + '/' + op);
          vars = {
            userId: binding.actorUserId,
            count: 40,
            includePromotedContent: true,
            withCommunity: true,
            withVoice: true,
            withV2Timeline: true
          };
          url.searchParams.set('features', JSON.stringify(spec.features));
        }
        const nextCursor = cursor || expectedCursor;
        if (!nextCursor || usedCursors.has(nextCursor)) return;
        vars.cursor = nextCursor;
        usedCursors.add(nextCursor);
        cursor = null;
        lastFetchAt = Date.now();
        const res = await fetchGraphqlTimelinePage({
          op,
          url,
          vars,
          baseHeaders: template ? template.headers : null,
          credentials: template ? template.credentials : 'include',
          context,
          abort,
          suppressErrorStop: useDomScroll
        });
        if (!res || pageRequest !== abort || !isContextStillActive(context)) return;
        handleParsedPayload(adapter.matchWhitelistedRequest(res.urlHref, 'GET'), res.parsed, null, context, res.header);
      } catch (err) {
        logSync('fetchNextPage error', { op, error: String(err?.message || err) });
        if (!useDomScroll && isContextStillActive(context) && pageRequest === abort) {
          signalHistoryStop(scope?.query ? 'unavailable' : 'unrecognized', context, () => null);
        }
      } finally {
        clearTimeout(timeout);
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
        documentEpoch: state.documentEpoch
      };
    }

    function isContextStillActive(context) {
      if (
        !state.collectionEnabled ||
        state.captureSessionId !== context.sessionId ||
        state.documentEpoch !== context.documentEpoch
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
        clearHistoryTransport();
      }
      const scopeJustActivated = Boolean(nextScope && (!scope || nextScope.id !== scope.id || nextScope.query !== scope.query));
      scope = nextScope;
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

      if (data.observedPaused === true || (!state.collectionEnabled && data.stateConfirmed !== false)) {
        markWindowSnapshotStale();
      }

      if (!state.collectionEnabled || prevSessionId !== state.captureSessionId) {
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

      if (pendingTemplate && nextBinding && scope && Date.now() < scope.deadline && nextBinding.actorUserId === scope.actor) {
        const pt = pendingTemplate;
        pendingTemplate = null;
        const ptMatches = scope.query
          ? isScopedSearch(pt.match)
          : pt.match.category === 'replies_timeline' && pt.match.requestedUserId === scope.actor;
        if (ptMatches) {
          template = pt.req;
          lastFetchAt = pt.at;
        }
      } else if (nextBinding && !scope) {
        pendingTemplate = null;
      }
      if (pendingSearch && nextBinding) {
        const held = pendingSearch;
        pendingSearch = null;
        if (nextBinding.actorUserId === scope?.actor && isScopedSearch(held.match)) {
          handleParsedPayload(held.match, held.payload, null, captureContext(), () => null);
        }
      }
      if (pendingTimeline && nextBinding) {
        const held = pendingTimeline;
        pendingTimeline = null;
        if (scope && !scope.query && nextBinding.actorUserId === scope.actor && held.match.requestedUserId === scope.actor) {
          handleParsedPayload(held.match, held.payload, null, captureContext(), () => null);
        }
      } else if (nextBinding && !scope) {
        pendingTimeline = null;
      }
      if (state.collectionEnabled && state.bindingContext) {
        state.needsPostPauseVerification = false;
        if (scope && !scope.query && state.bindingContext.actorUserId === scope.actor) {
          scheduleDirectTimelineBootstrap();
        }
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
        fetchNextPage(data);
      } else if (data.type === 'SYNC_STATE') {
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
      const errors = Array.isArray(payload?.errors) ? payload.errors : [];
      if (errors.some(error => error?.code === 88)) {
        signalHistoryStop('rate_limited', context, readHeader);
        return;
      }
      if (errors.some(error => [32, 89, 326, 353].includes(error?.code))) {
        signalHistoryStop('verification', context, readHeader);
        return;
      }
      if (!context.binding && state.bindingContext &&
          state.captureSessionId === context.sessionId &&
          state.documentEpoch === context.documentEpoch) {
        context = captureContext();
      }
      const frozenBinding = context.binding;
      if (!template && pendingTemplate && scope && Date.now() < scope.deadline &&
          frozenBinding?.actorUserId === scope.actor) {
        const ptMatches = scope.query
          ? isScopedSearch(pendingTemplate.match)
          : pendingTemplate.match.category === 'replies_timeline' && pendingTemplate.match.requestedUserId === scope.actor;
        if (ptMatches) {
          template = pendingTemplate.req;
          lastFetchAt = pendingTemplate.at;
        }
        pendingTemplate = null;
      }

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

      if (match.category === 'manual_search' && !isScopedSearch(match)) return;
      if (!frozenBinding) {
        if (isScopedSearch(match) && !errors.length) {
          if (state.bindingContext?.actorUserId === scope.actor) {
            handleParsedPayload(match, payload, null, captureContext(), readHeader);
          } else if (!state.bindingContext && !pendingSearch) pendingSearch = { match, payload };
        } else if (match.category === 'replies_timeline' && !errors.length && isCandidateRepliesPage(match)) {
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
          manualSearch: isScopedSearch(match), payload,
          bindingContext: frozenBinding,
          observedAt
        });
        if (res.historyPage && scope && (match.category === 'replies_timeline' || isScopedSearch(match))) {
          const candidate = engine.getRepliesCursor(payload);
          cursor = candidate && !usedCursors.has(candidate) ? candidate : null;
          const hasTweets = res.events.length > 0 || res.observedTweets.length > 0 || Boolean(res.historyPage.pageKey);
          const hasTransport = Boolean(template || knownQueryIds[match.operationName] || hasDomScroll());
          if (match.category === 'replies_timeline' && hasTransport) {
            if ((usedCursors.size > 0 && !hasTweets && !res.partialUnrecognized) || (hasTweets && !cursor)) {
              res.historyPage.ended = true;
            }
          }
          const searchHasRows = !isScopedSearch(match) || res.events.length > 0 || res.observedTweets.length > 0;
          res.historyPage.canPage = Boolean(hasTransport && cursor && !res.historyPage.ended && searchHasRows);
          lastNativePageAt = Date.now();
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

    // 1. Wrap window.fetch once without altering Function.prototype.toString
    if (typeof win.fetch === 'function') {
      const originalFetch = win.fetch;
      win.fetch = function sparklinkFetchWrapper(input, init) {
        let captured = null;
        if (state.collectionEnabled && state.captureSessionId !== null) {
          try {
            const { url, method } = extractFetchUrlAndMethod(input, init);
            if (url) {
              captureGraphqlMetadata(url, (init && init.headers) || (input && typeof input === 'object' ? input.headers : null));
            }
            const match = url ? adapter.matchWhitelistedRequest(url, method) : null;
            if (match && (match.category === 'replies_timeline' || match.category === 'manual_search') && scope) {
              const scopedOk = match.category !== 'manual_search' || isScopedSearch(match);
              if (!scopedOk) {
                logSync('ignored SearchTimeline fetch (scope mismatch)', { reqQuery: match.searchQuery || null, scopeQuery: scope.query || null, href: win.location?.pathname + win.location?.search });
              }
            }
            if (match && (match.category !== 'manual_search' || isScopedSearch(match)) &&
                (state.bindingContext || match.category === 'viewer' || isScopedSearch(match) || isCandidateRepliesPage(match))) {
              const context = captureContext();
              try { rememberTemplate(input, init, url, match, context); } catch { template = null; }
              let requestMeta = null;
              let requestMetaPromise = null;
              let skipObservation = false;
              const trackNativeHistory = match.category === 'replies_timeline' || isScopedSearch(match);
              if (trackNativeHistory && scope) {
                logSync('intercepted native fetch', { op: match.operationName, requestedUserId: match.requestedUserId || null, hasBinding: Boolean(state.bindingContext) });
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
      const originalSetHeader = xhrProto.setRequestHeader;
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
            headers: [],
            activeCapture: null
          });
        } catch (_err) {
          // Ignore metadata tracking errors
        }
        return result;
      };

      if (typeof originalSetHeader === 'function') {
        xhrProto.setRequestHeader = function sparklinkXhrHeader(name, value) {
          const result = originalSetHeader.apply(this, arguments);
          const meta = xhrMetaMap.get(this);
          if (
            meta &&
            Array.isArray(meta.headers) &&
            meta.headers.length < 64 &&
            typeof name === 'string' &&
            typeof value === 'string' &&
            name.length > 0 &&
            name.length <= 128 &&
            value.length <= 4096
          ) {
            meta.headers.push([name, value]);
          }
          return result;
        };
      }

      xhrProto.send = function sparklinkXhrSend(body) {
        try {
          const meta = xhrMetaMap.get(this);
          if (meta) {
            meta.activeCapture = null;
            if (state.collectionEnabled && state.captureSessionId !== null && meta.url) {
              captureGraphqlMetadata(meta.url, meta.headers);
              const match = adapter.matchWhitelistedRequest(meta.url, meta.method);
              if (match && (match.category !== 'manual_search' || isScopedSearch(match)) &&
                (state.bindingContext || match.category === 'viewer' || isScopedSearch(match) || isCandidateRepliesPage(match))) {
                if ((match.category === 'replies_timeline' || isScopedSearch(match)) &&
                    typeof nativeFetch === 'function') {
                  const hdrs = typeof Headers === 'function' ? new Headers() : null;
                  if (hdrs && Array.isArray(meta.headers)) {
                    for (let hi = 0; hi < meta.headers.length; hi += 1) {
                      try {
                        hdrs.append(meta.headers[hi][0], meta.headers[hi][1]);
                      } catch (_hdrErr) {
                        // Ignore invalid header pairs
                      }
                    }
                  }
                  const initObj = {
                    method: meta.method || 'GET',
                    credentials: this.withCredentials ? 'include' : 'same-origin'
                  };
                  if (hdrs) {
                    initObj.headers = hdrs;
                  }
                  try {
                    rememberTemplate(meta.url, initObj, meta.url, match, captureContext());
                  } catch {
                    template = null;
                  }
                }
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
                  const trackNativeHistory = match.category === 'replies_timeline' || isScopedSearch(match);
                  if (trackNativeHistory) {
                    nativeRequestsInFlight += 1;
                    if (scope) {
                      logSync('intercepted native XHR', { op: match.operationName, requestedUserId: match.requestedUserId || null, hasBinding: Boolean(state.bindingContext) });
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
