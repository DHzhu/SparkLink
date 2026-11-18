(function (root) {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const VERIFIED_SELECTOR = 'svg[data-testid="icon-verified"]';
  const BLUE_CHECK_PAINTS = new Set(['rgb(29,155,240)', '#1d9bf0', 'rgb(29,161,242)', '#1da1f2']);

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
  // A username field may include punctuation, another handle, or a timestamp after the handle.
  const HANDLE_FIELD_RE = /^[\s\p{P}]*@[A-Za-z0-9_]+(?![A-Za-z0-9_])[\s\p{P}]*(?:$|[@·•‧・]|\d+[smhdw]\s*$)/u;
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
      showCount: false,
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
    if (typeof node.closest === 'function' &&
        (node.closest('.sparklink-badge') || node.closest('.sparklink-native-fire'))) {
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
    if (!HANDLE_FIELD_RE.test(clean)) {
      return true;
    }
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

  function findBlueCheck(container, win) {
    const icon = container.querySelector(VERIFIED_SELECTOR);
    if (!icon) return null;
    const nativePaths = Array.from(icon.querySelectorAll('path')).filter((path) => !isSparklinkNode(path));
    for (const node of nativePaths.length ? nativePaths : [icon]) {
      const paint = win.getComputedStyle?.(node).fill || node.getAttribute('fill') || '';
      if (BLUE_CHECK_PAINTS.has(paint.toLowerCase().replace(/\s/g, ''))) return icon;
    }
    return null;
  }

  function createFireArt(doc, tier, onCheck) {
    const svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', `sparklink-fire-art ${tier.className}${onCheck ? ' sparklink-native-fire' : ''}`);
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    if (!onCheck) {
      const core = doc.createElementNS(SVG_NS, 'circle');
      core.setAttribute('class', 'sparklink-fire-core');
      core.setAttribute('cx', '12');
      core.setAttribute('cy', '12');
      core.setAttribute('r', '8.2');
      svg.appendChild(core);
    }
    const plume = doc.createElementNS(SVG_NS, 'path');
    plume.setAttribute('class', 'sparklink-fire-shape');
    svg.appendChild(plume);
    return svg;
  }

  function createBadgeElement(doc, count, tier, userId, bindingId, revision, blueCheck) {
    const badge = doc.createElement('span');
    badge.className = `sparklink-badge ${tier.className}${blueCheck ? ' sparklink-badge-on-check' : ''}`;
    badge.setAttribute('role', 'img');
    badge.setAttribute('aria-label', tier.ariaLabel);
    badge.setAttribute('title', tier.ariaLabel);
    badge.dataset.sparklinkUserId = userId;
    badge.dataset.sparklinkBindingId = bindingId;
    badge.dataset.sparklinkRevision = String(revision);
    badge.dataset.sparklinkTier = tier.key;
    badge.dataset.sparklinkCount = String(count);

    const art = createFireArt(doc, tier, Boolean(blueCheck));
    if (blueCheck) {
      blueCheck.prepend(art);
    } else {
      badge.appendChild(art);
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
    for (const art of Array.from(container.querySelectorAll('.sparklink-native-fire'))) art.remove();
  }

  function canPlaceInlineAfter(el, win) {
    const parent = el && el.parentNode;
    if (!parent || parent.nodeType !== 1 || typeof el.insertAdjacentElement !== 'function') {
      return false;
    }
    const getStyle =
      win && typeof win.getComputedStyle === 'function' ? (n) => win.getComputedStyle(n) : null;
    if (!getStyle) {
      return true;
    }
    const parentStyle = getStyle(parent);
    const parentDisplay = (parentStyle && parentStyle.display) || '';
    if (parentDisplay === 'flex' || parentDisplay === 'inline-flex') {
      const dir = (parentStyle && parentStyle.flexDirection) || 'row';
      return !dir.startsWith('column');
    }
    if (parentDisplay === 'grid' || parentDisplay === 'inline-grid') {
      return false;
    }
    const elStyle = getStyle(el);
    const elDisplay = (elStyle && elStyle.display) || '';
    if (
      elDisplay === 'block' ||
      elDisplay === 'flex' ||
      elDisplay === 'grid' ||
      elDisplay === 'table'
    ) {
      return false;
    }
    return true;
  }

  function findDisplayNameAnchor(container) {
    if (!container || typeof container.querySelectorAll !== 'function') {
      return null;
    }
    const links = container.querySelectorAll('a[href^="/"]');
    let fallback = null;
    for (let i = 0; i < links.length; i += 1) {
      const link = links[i];
      if (isSparklinkNode(link)) continue;
      const href = link.getAttribute('href') || '';
      const match = PROFILE_HREF_RE.exec(href);
      if (!match || RESERVED_PATHS.has(match[1].toLowerCase())) {
        continue;
      }
      if (!fallback) {
        fallback = link;
      }
      const text = (typeof link.textContent === 'string' ? link.textContent : '')
        .replace(BIDI_FORMAT_RE, '')
        .trim();
      if (text && !text.startsWith('@')) {
        return link;
      }
    }
    return fallback;
  }

  function insertInsideInlineRow(hostEl, badge, win) {
    if (!hostEl) {
      return false;
    }
    const kids = hostEl.children;
    if (kids && typeof kids.length === 'number') {
      for (let i = kids.length - 1; i >= 0; i -= 1) {
        const child = kids[i];
        if (!child || isSparklinkNode(child)) continue;
        const tag = typeof child.tagName === 'string' ? child.tagName.toUpperCase() : '';
        if (tag === 'SVG' || child.namespaceURI === SVG_NS) {
          if (tag === 'SVG' && canPlaceInlineAfter(child, win)) {
            const inserted = child.insertAdjacentElement('afterend', badge);
            if (inserted) return true;
          }
          continue;
        }
        if (canPlaceInlineAfter(child, win)) {
          const inserted = child.insertAdjacentElement('afterend', badge);
          if (inserted) return true;
        }
        if (insertInsideInlineRow(child, badge, win)) {
          return true;
        }
      }
    }
    if (typeof hostEl.insertAdjacentElement === 'function') {
      const inserted = hostEl.insertAdjacentElement('beforeend', badge);
      if (inserted) return true;
    }
    return false;
  }

  function insertBadgeIntoContainer(container, badge, win) {
    const verifiedIcon = container.querySelector(VERIFIED_SELECTOR);
    if (verifiedIcon) {
      const enclosingLink =
        typeof verifiedIcon.closest === 'function'
          ? verifiedIcon.closest('a[href^="/"]')
          : null;
      if (enclosingLink && enclosingLink !== container && canPlaceInlineAfter(enclosingLink, win)) {
        const insertedAfterLink = enclosingLink.insertAdjacentElement('afterend', badge);
        if (insertedAfterLink) {
          return;
        }
      }
      const iconWrap =
        verifiedIcon.parentNode &&
        verifiedIcon.parentNode !== container &&
        verifiedIcon.parentNode !== enclosingLink &&
        canPlaceInlineAfter(verifiedIcon.parentNode, win)
          ? verifiedIcon.parentNode
          : null;
      if (iconWrap) {
        const insertedAfterWrap = iconWrap.insertAdjacentElement('afterend', badge);
        if (insertedAfterWrap) {
          return;
        }
      }
      if (canPlaceInlineAfter(verifiedIcon, win)) {
        const insertedAfterIcon = verifiedIcon.insertAdjacentElement('afterend', badge);
        if (insertedAfterIcon) {
          return;
        }
      }
    }

    const displayLink = findDisplayNameAnchor(container);
    if (displayLink && displayLink !== container) {
      if (canPlaceInlineAfter(displayLink, win)) {
        const inserted = displayLink.insertAdjacentElement('afterend', badge);
        if (inserted) {
          return;
        }
      }
      if (insertInsideInlineRow(displayLink, badge, win)) {
        return;
      }
    }

    const firstRow = container.children && container.children.length > 0 ? container.children[0] : null;
    if (firstRow && !isSparklinkNode(firstRow)) {
      if (canPlaceInlineAfter(firstRow, win)) {
        const inserted = firstRow.insertAdjacentElement('afterend', badge);
        if (inserted) {
          return;
        }
      }
      if (insertInsideInlineRow(firstRow, badge, win)) {
        return;
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
      removeContainerBadges(doc);
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

      const blueCheck = findBlueCheck(container, targetWin);
      const existingBadges = container.querySelectorAll('.sparklink-badge');
      if (existingBadges.length === 1) {
        const currentBadge = existingBadges[0];
        const overlay = container.querySelector('.sparklink-native-fire');
        if (
          currentBadge.classList.contains('sparklink-badge-on-check') === Boolean(blueCheck) &&
          (overlay?.parentNode || null) === blueCheck &&
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
        revision,
        blueCheck
      );
      insertBadgeIntoContainer(container, nextBadge, targetWin);
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
        if (rec.type === 'attributes' && rec.attributeName && rec.attributeName !== 'href' &&
            !rec.target.closest?.('[data-testid="User-Name"]')) continue;
        if (rec.type === 'childList') {
          const onlyOurs =
            isOnlySparklinkNodes(rec.addedNodes) && isOnlySparklinkNodes(rec.removedNodes);
          if (onlyOurs) {
            if (rec.removedNodes?.length && rec.target.matches?.(VERIFIED_SELECTOR)) {
              collectFromSubtree(rec.target);
              hasRelevantChange = true;
            }
            continue;
          }
          for (const node of Array.from(rec.removedNodes || [])) {
            if (node.nodeType === 1 && (!node.isConnected || !node.closest?.('[data-testid="User-Name"]'))) {
              removeContainerBadges(node);
            }
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
        attributeFilter: ['href', 'data-testid', 'fill', 'color', 'class', 'style']
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
