(function (root) {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const FLAME_PATH_D =
    'M8.6 1.2c.3 2.1-.6 3.5-1.8 4.8-1.1 1.2-2.1 2.4-2.1 4.2 0 2.3 1.8 4.1 4.1 4.1 2.6 0 4.5-2.1 4.5-4.8 0-2.6-1.6-4.7-3.1-6.1-.2 1.1-.8 1.9-1.6 2.4.3-1.4.4-2.9 0-4.6z';

  const DEFAULT_DEBOUNCE_MS = 150;
  const DEFAULT_FRAME_BUDGET_MS = 8;
  const DEFAULT_WINDOW_REFRESH_MS = 30 * 1000;
  const MAX_WINDOW_REFRESH_MS = 60 * 1000;
  const QUERY_CHUNK_SIZE = 200;

  const RESERVED_PATHS = new Set([
    'home',
    'explore',
    'notifications',
    'messages',
    'search',
    'settings',
    'compose',
    'i',
    'intent',
    'tos',
    'privacy',
    'jobs',
    'lists',
    'bookmarks',
    'communities'
  ]);

  const PROFILE_HREF_RE = /^\/([A-Za-z0-9_]{1,64})\/?$/;
  const STATUS_HREF_RE = /^\/([A-Za-z0-9_]{1,64})\/status\/([1-9][0-9]{0,31})(?:[/?#]|$)/;
  const BIDI_FORMAT_RE = /[‎‏‪-‮⁦-⁩]/g;
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

  const installedControllers = new WeakMap();

  function getTierMeta(count) {
    if (!Number.isInteger(count) || count <= 0) {
      return {
        key: 'none',
        className: null,
        showCount: false,
        ariaLabel: null
      };
    }
    const ariaLabel = `近30天已记录你回复TA ${count} 次（含导入）`;
    if (count <= 10) {
      return {
        key: 'acquaintance',
        className: 'sparklink-tier-acquaintance',
        showCount: false,
        ariaLabel
      };
    }
    if (count <= 50) {
      return {
        key: 'active',
        className: 'sparklink-tier-active',
        showCount: false,
        ariaLabel
      };
    }
    return {
      key: 'deep',
      className: 'sparklink-tier-deep',
      showCount: true,
      ariaLabel
    };
  }

  function isSparklinkNode(node) {
    if (!node || node.nodeType !== 1) {
      return false;
    }
    if (node.classList && node.classList.contains('sparklink-badge')) {
      return true;
    }
    if (typeof node.closest === 'function' && node.closest('.sparklink-badge')) {
      return true;
    }
    return false;
  }

  function isOnlySparklinkNodes(nodeList) {
    if (!nodeList || nodeList.length === 0) {
      return true;
    }
    for (let i = 0; i < nodeList.length; i += 1) {
      if (!isSparklinkNode(nodeList[i])) {
        return false;
      }
    }
    return true;
  }

  function collectCoalescedAuthorTextSegments(rootEl) {
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
        !/\s$/.test(current) &&
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
      if ((!isRoot && node.nodeType !== 1) || isSparklinkNode(node)) {
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

  function extractCandidateIdentity(container, bridge) {
    if (!container || typeof container.querySelectorAll !== 'function') {
      return null;
    }

    let profileHandle = null;
    const links = container.querySelectorAll('a[href^="/"]');
    for (let i = 0; i < links.length; i += 1) {
      const href = links[i].getAttribute('href') || '';
      const match = PROFILE_HREF_RE.exec(href);
      if (!match) {
        continue;
      }
      const candidate = match[1];
      const lower = candidate.toLowerCase();
      if (RESERVED_PATHS.has(lower)) {
        continue;
      }
      if (profileHandle && profileHandle.toLowerCase() !== lower) {
        // Conflicting profile links in the same author header -> refuse to guess
        return null;
      }
      profileHandle = candidate;
    }

    // Cross-check visible @handle text across coalesced inline text runs (including middle-dot/timestamp suffixes)
    let textHandle = null;
    const recordTextHandle = (h) => {
      if (!h) {
        return true;
      }
      if (textHandle && textHandle.toLowerCase() !== h.toLowerCase()) {
        return false;
      }
      textHandle = h;
      return true;
    };
    const segments = collectCoalescedAuthorTextSegments(container);
    for (let i = 0; i < segments.length; i += 1) {
      if (!scanCoalescedHandleTokens(segments[i], recordTextHandle)) {
        return null;
      }
    }

    if (profileHandle && textHandle && profileHandle.toLowerCase() !== textHandle.toLowerCase()) {
      return null;
    }

    const effectiveHandle = profileHandle || textHandle;
    const handleUserId =
      effectiveHandle && typeof bridge.resolveUserIdByHandle === 'function'
        ? bridge.resolveUserIdByHandle(effectiveHandle)
        : null;

    // Check status link inside the author container if available
    const statusLinks = container.querySelectorAll('a[href*="/status/"]');
    let tweetUserId = null;
    for (let i = 0; i < statusLinks.length; i += 1) {
      const href = statusLinks[i].getAttribute('href') || '';
      const sMatch = STATUS_HREF_RE.exec(href);
      if (!sMatch) {
        continue;
      }
      const statusHandle = sMatch[1];
      const tweetId = sMatch[2];
      if (effectiveHandle && statusHandle.toLowerCase() !== effectiveHandle.toLowerCase()) {
        // Stale or mismatched status link during DOM node recycling -> conflict
        return null;
      }
      if (typeof bridge.resolveAuthorByTweetId === 'function') {
        const authorInfo = bridge.resolveAuthorByTweetId(tweetId);
        if (authorInfo && authorInfo.authorUserId) {
          if (
            effectiveHandle &&
            authorInfo.handle &&
            authorInfo.handle.toLowerCase() !== effectiveHandle.toLowerCase()
          ) {
            return null;
          }
          if (tweetUserId && tweetUserId !== authorInfo.authorUserId) {
            return null;
          }
          tweetUserId = authorInfo.authorUserId;
        }
      }
    }

    if (tweetUserId && handleUserId && tweetUserId !== handleUserId) {
      return null;
    }

    return tweetUserId || handleUserId || null;
  }

  function createBadgeElement(doc, count, tier, userId, bindingId, revision) {
    const badge = doc.createElement('span');
    badge.className = `sparklink-badge ${tier.className}`;
    badge.setAttribute('role', 'img');
    badge.setAttribute('aria-label', tier.ariaLabel);
    badge.setAttribute('title', tier.ariaLabel);
    badge.dataset.sparklinkUserId = userId;
    badge.dataset.sparklinkBindingId = bindingId;
    badge.dataset.sparklinkRevision = String(revision);
    badge.dataset.sparklinkTier = tier.key;
    badge.dataset.sparklinkCount = String(count);

    const svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('class', 'sparklink-flame-icon');

    const path = doc.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', FLAME_PATH_D);
    path.setAttribute('fill', 'currentColor');
    svg.appendChild(path);
    badge.appendChild(svg);

    if (tier.showCount) {
      const countSpan = doc.createElement('span');
      countSpan.className = 'sparklink-badge-count';
      countSpan.textContent = String(count);
      badge.appendChild(countSpan);
    }

    return badge;
  }

  function removeContainerBadges(container) {
    if (!container || typeof container.querySelectorAll !== 'function') {
      return;
    }
    const existing = container.querySelectorAll('.sparklink-badge');
    for (let i = 0; i < existing.length; i += 1) {
      existing[i].remove();
    }
  }

  function insertBadgeIntoContainer(container, badge) {
    const verifiedIcon = container.querySelector('svg[data-testid="icon-verified"]');
    if (verifiedIcon) {
      const enclosingLink =
        typeof verifiedIcon.closest === 'function'
          ? verifiedIcon.closest('a[href^="/"]')
          : null;
      if (
        enclosingLink &&
        enclosingLink !== container &&
        typeof enclosingLink.insertAdjacentElement === 'function'
      ) {
        const insertedAfterLink = enclosingLink.insertAdjacentElement('afterend', badge);
        if (insertedAfterLink) {
          return;
        }
      }
      if (typeof verifiedIcon.insertAdjacentElement === 'function') {
        const insertedAfterIcon = verifiedIcon.insertAdjacentElement('afterend', badge);
        if (insertedAfterIcon) {
          return;
        }
      }
    }

    if (typeof container.insertAdjacentElement === 'function') {
      container.insertAdjacentElement('beforeend', badge);
    } else {
      container.appendChild(badge);
    }
  }

  function installContentBadges(win, bridge, options) {
    const targetWin = win || root;
    if (!targetWin || !targetWin.document) {
      return null;
    }
    const targetBridge = bridge || targetWin.__sparklinkIsolatedBridge;
    if (!targetBridge || typeof targetBridge.queryCounts !== 'function') {
      return null;
    }
    if (installedControllers.has(targetWin)) {
      return installedControllers.get(targetWin);
    }

    const opts = options || {};
    const doc = targetWin.document;
    const debounceMs =
      Number.isInteger(opts.debounceMs) && opts.debounceMs >= 0
        ? opts.debounceMs
        : DEFAULT_DEBOUNCE_MS;
    const frameBudgetMs =
      typeof opts.frameBudgetMs === 'number' && opts.frameBudgetMs > 0
        ? opts.frameBudgetMs
        : DEFAULT_FRAME_BUDGET_MS;
    const rawRefreshMs =
      Number.isInteger(opts.windowRefreshMs) && opts.windowRefreshMs > 0
        ? opts.windowRefreshMs
        : DEFAULT_WINDOW_REFRESH_MS;
    const windowRefreshMs = Math.min(rawRefreshMs, MAX_WINDOW_REFRESH_MS);
    const nowFn =
      typeof opts.nowFn === 'function'
        ? opts.nowFn
        : () => (typeof performance === 'object' && performance ? performance.now() : Date.now());

    const dirtyContainers = new Set();
    const renderQueue = [];
    const queuedSet = new Set();
    const containerMeta = new WeakMap();

    let cachedBindingId = null;
    let cachedRevision = -1;
    const cachedCounts = new Map();

    let debounceTimer = null;
    let rafId = null;
    let refreshIntervalId = null;
    let queryInFlight = false;
    let destroyed = false;

    const raf =
      typeof targetWin.requestAnimationFrame === 'function'
        ? (cb) => targetWin.requestAnimationFrame(cb)
        : (cb) => setTimeout(() => cb(nowFn()), 0);
    const caf =
      typeof targetWin.cancelAnimationFrame === 'function'
        ? (id) => targetWin.cancelAnimationFrame(id)
        : (id) => clearTimeout(id);

    function invalidateCountCache() {
      cachedCounts.clear();
      cachedBindingId = null;
      cachedRevision = -1;
    }

    function clearAllBadges() {
      const allBadges = doc.querySelectorAll('.sparklink-badge');
      for (let i = 0; i < allBadges.length; i += 1) {
        allBadges[i].remove();
      }
    }

    function collectFromSubtree(node) {
      if (!node || node.nodeType !== 1 || isSparklinkNode(node)) {
        return;
      }
      if (typeof node.matches === 'function' && node.matches('[data-testid="User-Name"]')) {
        dirtyContainers.add(node);
        return;
      }
      if (typeof node.closest === 'function') {
        const ancestor = node.closest('[data-testid="User-Name"]');
        if (ancestor) {
          dirtyContainers.add(ancestor);
          return;
        }
      }
      if (typeof node.querySelectorAll === 'function') {
        const descendants = node.querySelectorAll('[data-testid="User-Name"]');
        for (let i = 0; i < descendants.length; i += 1) {
          dirtyContainers.add(descendants[i]);
        }
      }
    }

    function scheduleFlush(immediate) {
      if (destroyed) {
        return;
      }
      if (immediate) {
        if (debounceTimer !== null) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
        flushDirtyContainers();
        return;
      }
      if (debounceTimer !== null) {
        return;
      }
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        flushDirtyContainers();
      }, debounceMs);
    }

    function scanAllContainers(forceInvalidate, immediate) {
      if (destroyed) {
        return;
      }
      if (forceInvalidate) {
        invalidateCountCache();
      }
      const containers = doc.querySelectorAll('[data-testid="User-Name"]');
      for (let i = 0; i < containers.length; i += 1) {
        dirtyContainers.add(containers[i]);
      }
      scheduleFlush(Boolean(immediate));
    }

    function reconcileSingleContainer(container, bindingCtx, revision) {
      if (!container || !container.isConnected) {
        containerMeta.delete(container);
        return;
      }
      if (!bindingCtx) {
        removeContainerBadges(container);
        containerMeta.delete(container);
        return;
      }

      const userId = extractCandidateIdentity(container, targetBridge);
      if (!userId || userId === bindingCtx.actorUserId) {
        removeContainerBadges(container);
        containerMeta.delete(container);
        return;
      }

      if (!cachedCounts.has(userId)) {
        // Count vanished due to cache invalidation mid-frame -> re-queue cleanly
        dirtyContainers.add(container);
        scheduleFlush(false);
        return;
      }

      const count = cachedCounts.get(userId) || 0;
      const tier = getTierMeta(count);
      if (tier.key === 'none') {
        removeContainerBadges(container);
        containerMeta.set(container, {
          userId,
          bindingId: bindingCtx.bindingId,
          revision,
          count: 0,
          tierKey: 'none'
        });
        return;
      }

      const existingBadges = container.querySelectorAll('.sparklink-badge');
      if (existingBadges.length === 1) {
        const currentBadge = existingBadges[0];
        if (
          currentBadge.dataset.sparklinkUserId === userId &&
          currentBadge.dataset.sparklinkBindingId === bindingCtx.bindingId &&
          currentBadge.dataset.sparklinkTier === tier.key &&
          currentBadge.dataset.sparklinkCount === String(count)
        ) {
          currentBadge.dataset.sparklinkRevision = String(revision);
          containerMeta.set(container, {
            userId,
            bindingId: bindingCtx.bindingId,
            revision,
            count,
            tierKey: tier.key
          });
          return;
        }
      }

      removeContainerBadges(container);
      const nextBadge = createBadgeElement(
        doc,
        count,
        tier,
        userId,
        bindingCtx.bindingId,
        revision
      );
      insertBadgeIntoContainer(container, nextBadge);
      containerMeta.set(container, {
        userId,
        bindingId: bindingCtx.bindingId,
        revision,
        count,
        tierKey: tier.key
      });
    }

    function scheduleRenderFrame() {
      if (destroyed || rafId !== null || renderQueue.length === 0) {
        return;
      }
      rafId = raf(() => {
        rafId = null;
        if (destroyed) {
          return;
        }
        const bindingCtx = targetBridge.getBindingContext();
        if (!bindingCtx) {
          renderQueue.length = 0;
          queuedSet.clear();
          clearAllBadges();
          return;
        }
        const revision = targetBridge.getRevision();
        const start = nowFn();
        let processed = 0;

        while (renderQueue.length > 0) {
          const container = renderQueue.shift();
          queuedSet.delete(container);
          reconcileSingleContainer(container, bindingCtx, revision);
          processed += 1;
          if (processed >= 1 && nowFn() - start >= frameBudgetMs) {
            break;
          }
        }

        if (renderQueue.length > 0) {
          scheduleRenderFrame();
        }
      });
    }

    async function flushDirtyContainers() {
      if (destroyed || dirtyContainers.size === 0) {
        return;
      }
      const bindingCtx = targetBridge.getBindingContext();
      if (!bindingCtx) {
        dirtyContainers.clear();
        renderQueue.length = 0;
        queuedSet.clear();
        clearAllBadges();
        return;
      }

      if (queryInFlight) {
        scheduleFlush(false);
        return;
      }

      const currentRevision = targetBridge.getRevision();
      if (cachedBindingId !== bindingCtx.bindingId || cachedRevision !== currentRevision) {
        cachedCounts.clear();
        cachedBindingId = bindingCtx.bindingId;
        cachedRevision = currentRevision;
      }

      const batch = Array.from(dirtyContainers);
      dirtyContainers.clear();

      const missingIdsSet = new Set();
      const liveContainers = [];

      for (let i = 0; i < batch.length; i += 1) {
        const container = batch[i];
        if (!container || !container.isConnected) {
          continue;
        }
        liveContainers.push(container);
        const userId = extractCandidateIdentity(container, targetBridge);
        if (userId && userId !== bindingCtx.actorUserId && !cachedCounts.has(userId)) {
          missingIdsSet.add(userId);
        }
      }

      if (missingIdsSet.size > 0) {
        queryInFlight = true;
        try {
          const allMissing = Array.from(missingIdsSet);
          for (let offset = 0; offset < allMissing.length; offset += QUERY_CHUNK_SIZE) {
            const chunk = allMissing.slice(offset, offset + QUERY_CHUNK_SIZE);
            const res = await targetBridge.queryCounts(chunk);
            if (destroyed) {
              return;
            }
            const activeAfter = targetBridge.getBindingContext();
            if (
              !activeAfter ||
              activeAfter.bindingId !== bindingCtx.bindingId ||
              !res ||
              !res.ok ||
              (res.bindingId && res.bindingId !== bindingCtx.bindingId)
            ) {
              // Stale or unbound query response: discard without rendering
              if (!activeAfter) {
                clearAllBadges();
              }
              return;
            }
            if (Number.isInteger(res.revision) && res.revision >= 0) {
              cachedRevision = res.revision;
            }
            const countsObj = res.counts || {};
            for (let k = 0; k < chunk.length; k += 1) {
              const id = chunk[k];
              const val = Number.isInteger(countsObj[id]) && countsObj[id] >= 0 ? countsObj[id] : 0;
              cachedCounts.set(id, val);
            }
          }
        } finally {
          queryInFlight = false;
        }
      }

      for (let i = 0; i < liveContainers.length; i += 1) {
        const c = liveContainers[i];
        if (c.isConnected && !queuedSet.has(c)) {
          queuedSet.add(c);
          renderQueue.push(c);
        }
      }

      scheduleRenderFrame();

      if (dirtyContainers.size > 0) {
        scheduleFlush(false);
      }
    }

    function onMutations(records) {
      if (destroyed || !Array.isArray(records)) {
        return;
      }
      let hasRelevantChange = false;
      for (let i = 0; i < records.length; i += 1) {
        const rec = records[i];
        if (!rec || isSparklinkNode(rec.target)) {
          continue;
        }
        if (rec.type === 'childList') {
          const onlyOurs =
            isOnlySparklinkNodes(rec.addedNodes) && isOnlySparklinkNodes(rec.removedNodes);
          if (onlyOurs) {
            continue;
          }
          if (rec.addedNodes) {
            for (let j = 0; j < rec.addedNodes.length; j += 1) {
              collectFromSubtree(rec.addedNodes[j]);
            }
          }
        }
        collectFromSubtree(rec.target);
        hasRelevantChange = true;
      }

      if (hasRelevantChange && dirtyContainers.size > 0) {
        scheduleFlush(false);
      }
    }

    const observer =
      typeof targetWin.MutationObserver === 'function'
        ? new targetWin.MutationObserver(onMutations)
        : null;

    if (observer && (doc.body || doc.documentElement)) {
      observer.observe(doc.body || doc.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['href']
      });
    }

    const unsubscribeBridge = targetBridge.subscribe((ev) => {
      if (destroyed || !ev) {
        return;
      }
      if (
        ev.type === 'BINDING_REVOKED' ||
        ev.type === 'COLLECTION_PAUSED' ||
        ev.type === 'BINDING_REQUIRED'
      ) {
        invalidateCountCache();
        dirtyContainers.clear();
        renderQueue.length = 0;
        queuedSet.clear();
        clearAllBadges();
        return;
      }
      if (ev.type === 'BINDING_READY' || ev.type === 'REVISION_UPDATED') {
        scanAllContainers(true, false);
        return;
      }
      if (ev.type === 'MAPPINGS_UPDATED') {
        scanAllContainers(false, false);
      }
    });

    function onVisibilityChange() {
      if (!destroyed && doc.visibilityState === 'visible') {
        scanAllContainers(true, true);
      }
    }

    function onPageShow() {
      if (!destroyed) {
        scanAllContainers(true, true);
      }
    }

    if (typeof doc.addEventListener === 'function') {
      doc.addEventListener('visibilitychange', onVisibilityChange);
    }
    if (typeof targetWin.addEventListener === 'function') {
      targetWin.addEventListener('pageshow', onPageShow);
    }

    refreshIntervalId = setInterval(() => {
      if (destroyed) {
        return;
      }
      if (doc.visibilityState && doc.visibilityState !== 'visible') {
        return;
      }
      if (targetBridge.getBindingContext()) {
        scanAllContainers(true, true);
      }
    }, windowRefreshMs);
    if (refreshIntervalId && typeof refreshIntervalId.unref === 'function') {
      refreshIntervalId.unref();
    }

    // Initial idle scan
    scanAllContainers(false, false);

    const controller = Object.freeze({
      refreshNow() {
        scanAllContainers(true, true);
      },
      destroy() {
        if (destroyed) {
          return;
        }
        destroyed = true;
        if (observer) {
          observer.disconnect();
        }
        unsubscribeBridge();
        if (debounceTimer !== null) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
        if (rafId !== null) {
          caf(rafId);
          rafId = null;
        }
        if (refreshIntervalId !== null) {
          clearInterval(refreshIntervalId);
          refreshIntervalId = null;
        }
        if (typeof doc.removeEventListener === 'function') {
          doc.removeEventListener('visibilitychange', onVisibilityChange);
        }
        if (typeof targetWin.removeEventListener === 'function') {
          targetWin.removeEventListener('pageshow', onPageShow);
        }
        dirtyContainers.clear();
        renderQueue.length = 0;
        queuedSet.clear();
        invalidateCountCache();
        clearAllBadges();
        installedControllers.delete(targetWin);
      }
    });

    installedControllers.set(targetWin, controller);
    return controller;
  }

  // Auto-install in browser ISOLATED content script environment
  if (
    typeof window === 'object' &&
    window &&
    window === window.top &&
    window.__sparklinkIsolatedBridge &&
    window.location &&
    (window.location.origin === 'https://x.com' ||
      window.location.origin === 'https://twitter.com')
  ) {
    installContentBadges(window, window.__sparklinkIsolatedBridge);
  }

  if (typeof module === 'object' && module && module.exports) {
    module.exports = {
      installContentBadges,
      getTierMeta
    };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
