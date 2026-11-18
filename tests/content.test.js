'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { installContentBadges, getTierMeta } = require('../src/content.js');

// Minimal deterministic DOM implementation for testing content.js without external libraries
class FakeElement {
  constructor(tagName, namespaceURI = null) {
    this.nodeType = 1;
    this.tagName = String(tagName).toUpperCase();
    this.namespaceURI = namespaceURI;
    this.attributes = new Map();
    this.children = [];
    this.parentNode = null;
    this._textContent = '';
    this.classList = this._createClassList();
    this.dataset = new Proxy(
      {},
      {
        get: (_target, prop) => {
          const attr =
            'data-' + String(prop).replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
          return this.attributes.get(attr);
        },
        set: (_target, prop, val) => {
          const attr =
            'data-' + String(prop).replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
          this.attributes.set(attr, String(val));
          return true;
        },
        deleteProperty: (_target, prop) => {
          const attr =
            'data-' + String(prop).replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
          this.attributes.delete(attr);
          return true;
        }
      }
    );
  }

  _createClassList() {
    const getSet = () =>
      new Set((this.attributes.get('class') || '').split(/\s+/).filter(Boolean));
    const saveSet = (s) => this.attributes.set('class', Array.from(s).join(' '));
    return {
      add: (...tokens) => {
        const s = getSet();
        tokens.forEach((t) => s.add(t));
        saveSet(s);
      },
      remove: (...tokens) => {
        const s = getSet();
        tokens.forEach((t) => s.delete(t));
        saveSet(s);
      },
      contains: (token) => getSet().has(token)
    };
  }

  get className() {
    return this.attributes.get('class') || '';
  }

  set className(val) {
    this.attributes.set('class', String(val));
  }

  get isConnected() {
    let cur = this;
    while (cur.parentNode) {
      cur = cur.parentNode;
    }
    return cur.isRoot === true;
  }

  get textContent() {
    if (this.children.length === 0) {
      return this._textContent;
    }
    return this.children.map((c) => c.textContent).join('');
  }

  set textContent(val) {
    this.children = [];
    this._textContent = String(val);
  }

  set innerHTML(_val) {
    throw new Error('innerHTML is forbidden by SparkLink security rules');
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  appendChild(child) {
    if (child.parentNode) {
      child.parentNode.removeChild(child);
    }
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  prepend(child) {
    if (child.parentNode) child.remove();
    child.parentNode = this;
    this.children.unshift(child);
  }

  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx !== -1) {
      this.children.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }

  remove() {
    if (this.parentNode) {
      this.parentNode.removeChild(this);
    }
  }

  insertAdjacentElement(position, element) {
    if (element.parentNode) {
      element.parentNode.removeChild(element);
    }
    if (position === 'afterend' && this.parentNode) {
      const idx = this.parentNode.children.indexOf(this);
      element.parentNode = this.parentNode;
      this.parentNode.children.splice(idx + 1, 0, element);
      return element;
    }
    if (position === 'beforeend') {
      return this.appendChild(element);
    }
    return null;
  }

  matches(selector) {
    if (selector === 'path') return this.tagName === 'PATH';
    if (selector === '[data-testid="User-Name"]') {
      return this.getAttribute('data-testid') === 'User-Name';
    }
    if (selector === 'article[data-testid="tweet"]') {
      return this.tagName === 'ARTICLE' && this.getAttribute('data-testid') === 'tweet';
    }
    if (selector === 'svg[data-testid="icon-verified"]') {
      return this.tagName === 'SVG' && this.getAttribute('data-testid') === 'icon-verified';
    }
    if (selector.startsWith('.')) {
      return this.classList.contains(selector.slice(1));
    }
    if (selector === 'a[href*="/status/"]') {
      const href = this.getAttribute('href') || '';
      return this.tagName === 'A' && href.includes('/status/');
    }
    if (selector === 'a[href^="/"]') {
      const href = this.getAttribute('href') || '';
      return this.tagName === 'A' && href.startsWith('/');
    }
    if (selector === 'div[role="link"]') {
      return this.tagName === 'DIV' && this.getAttribute('role') === 'link';
    }
    return false;
  }

  closest(selector) {
    let cur = this;
    while (cur && cur.nodeType === 1) {
      if (cur.matches(selector)) {
        return cur;
      }
      cur = cur.parentNode;
    }
    return null;
  }

  querySelectorAll(selector) {
    const results = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (child.matches(selector)) {
          results.push(child);
        }
        visit(child);
      }
    };
    visit(this);
    return results;
  }

  querySelector(selector) {
    const all = this.querySelectorAll(selector);
    return all.length > 0 ? all[0] : null;
  }
}

function buildTweetCard({ handle, displayName, tweetId, verified = false }) {
  const article = new FakeElement('article');
  article.setAttribute('data-testid', 'tweet');

  const userNameBox = new FakeElement('div');
  userNameBox.setAttribute('data-testid', 'User-Name');

  const nameRow = new FakeElement('div');
  const profileLink = new FakeElement('a');
  profileLink.setAttribute('href', `/${handle}`);
  const nameSpan = new FakeElement('span');
  nameSpan.textContent = displayName;
  profileLink.appendChild(nameSpan);

  if (verified) {
    const verifiedSvg = new FakeElement('svg', 'http://www.w3.org/2000/svg');
    verifiedSvg.setAttribute('data-testid', 'icon-verified');
    verifiedSvg.setAttribute('aria-label', 'Verified account');
    const original = new FakeElement('path', 'http://www.w3.org/2000/svg');
    original.setAttribute('fill', '#1d9bf0');
    verifiedSvg.appendChild(original);
    profileLink.appendChild(verifiedSvg);
  }
  nameRow.appendChild(profileLink);
  userNameBox.appendChild(nameRow);

  const handleRow = new FakeElement('div');
  const handleLink = new FakeElement('a');
  handleLink.setAttribute('href', `/${handle}`);
  const handleSpan = new FakeElement('span');
  handleSpan.textContent = `@${handle}`;
  handleLink.appendChild(handleSpan);
  handleRow.appendChild(handleLink);

  if (tweetId) {
    const statusLink = new FakeElement('a');
    statusLink.setAttribute('href', `/${handle}/status/${tweetId}`);
    handleRow.appendChild(statusLink);
  }
  userNameBox.appendChild(handleRow);

  article.appendChild(userNameBox);
  return { article, userNameBox, profileLink, handleLink, handleSpan };
}

function createFakeDomAndBridge(countsMap) {
  const body = new FakeElement('body');
  body.isRoot = true;
  const docListeners = new Map();
  let observerCallback = null;

  class FakeMutationObserver {
    constructor(cb) {
      observerCallback = cb;
    }
    observe() {}
    disconnect() {
      observerCallback = null;
    }
  }

  const doc = {
    body,
    documentElement: body,
    visibilityState: 'visible',
    createElement(tag) {
      return new FakeElement(tag);
    },
    createElementNS(ns, tag) {
      return new FakeElement(tag, ns);
    },
    querySelectorAll(sel) {
      return body.querySelectorAll(sel);
    },
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      if (docListeners.has(type)) docListeners.get(type).delete(fn);
    }
  };

  let activeBinding = {
    bindingId: 'bind_1',
    actorUserId: '1001001',
    captureSessionId: 1,
    collectionGeneration: 1,
    accountGeneration: 1
  };
  let currentRevision = 1;
  const handleMap = new Map([
    ['user_t1', '2001'],
    ['user_t2', '2002'],
    ['user_t3', '2003'],
    ['user_zero', '2004']
  ]);
  const tweetMap = new Map([
    ['9001', { authorUserId: '2001', handle: 'user_t1' }]
  ]);
  const subscribers = new Set();

  const bridge = {
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    getBindingContext: () => activeBinding,
    getRevision: () => currentRevision,
    isCollectionEnabled: () => Boolean(activeBinding),
    resolveAuthorByTweetId: (tid) => tweetMap.get(tid) || null,
    resolveUserIdByHandle: (h) => handleMap.get(String(h).toLowerCase()) || null,
    async queryCounts(ids) {
      if (!activeBinding) {
        return { ok: false, code: 'UNBOUND' };
      }
      const out = {};
      for (const id of ids) {
        out[id] = countsMap[id] || 0;
      }
      return {
        ok: true,
        counts: out,
        revision: currentRevision,
        bindingId: activeBinding.bindingId
      };
    },
    emitEvent(ev) {
      for (const fn of subscribers) {
        fn(ev);
      }
    },
    setBinding(nextBinding, rev = currentRevision + 1) {
      activeBinding = nextBinding;
      currentRevision = rev;
    }
  };

  const win = {
    document: doc,
    MutationObserver: FakeMutationObserver,
    requestAnimationFrame(cb) {
      return setTimeout(() => cb(Date.now()), 0);
    },
    cancelAnimationFrame(id) {
      clearTimeout(id);
    },
    addEventListener() {},
    removeEventListener() {},
    __sparklinkIsolatedBridge: bridge,
    triggerMutations(records) {
      if (observerCallback) {
        observerCallback(records);
      }
    },
    triggerDocEvent(type) {
      const set = docListeners.get(type);
      if (set) {
        for (const fn of set) fn();
      }
    }
  };

  return { win, doc, body, bridge };
}

async function waitForBadgeState(predicate, description) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(description);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('Content badges render SVG tiers (0/5/25/55), respect verified layout, handle virtual-list node reuse A->B, drop stale bindings, and refresh expired counts within 60s', async (t) => {
  const counts = {
    '2001': 5,  // acquaintance (1-10)
    '2002': 25, // active (11-50)
    '2003': 55, // deep (>=51)
    '2004': 0   // none (not rendered)
  };

  const { win, body, bridge } = createFakeDomAndBridge(counts);

  const card1 = buildTweetCard({ handle: 'user_t1', displayName: 'Acquaintance', tweetId: '9001', verified: true });
  const card2 = buildTweetCard({ handle: 'user_t2', displayName: 'Active', verified: false });
  const card3 = buildTweetCard({ handle: 'user_t3', displayName: 'Deep', verified: true });
  const cardZero = buildTweetCard({ handle: 'user_zero', displayName: 'Zero', verified: false });
  const cardUnmapped = buildTweetCard({ handle: 'unknown_stranger', displayName: 'Unknown', verified: false });

  body.appendChild(card1.article);
  body.appendChild(card2.article);
  body.appendChild(card3.article);
  body.appendChild(cardZero.article);
  body.appendChild(cardUnmapped.article);

  const controller = installContentBadges(win, bridge, {
    debounceMs: 10,
    windowRefreshMs: 40
  });

  t.after(() => controller.destroy());
  await waitForBadgeState(
    () => [card1, card2, card3].every((card) => card.userNameBox.querySelector('.sparklink-badge')),
    'All three initial badge tiers should render'
  );

  const badge1 = card1.userNameBox.querySelector('.sparklink-badge');
  const badge2 = card2.userNameBox.querySelector('.sparklink-badge');
  const badge3 = card3.userNameBox.querySelector('.sparklink-badge');

  const native = card1.profileLink.querySelector('svg[data-testid="icon-verified"]');
  const overlay = native.querySelector('.sparklink-native-fire');
  assert.ok(overlay, 'Paint flames on the existing blue check');
  assert.equal(overlay.getAttribute('aria-hidden'), 'true');
  assert.equal(native.parentNode, card1.profileLink);
  assert.equal(native.getAttribute('aria-label'), 'Verified account');
  assert.equal(badge1.querySelector('.sparklink-fire-art'), null);
  assert.ok(badge2.querySelector('.sparklink-fire-core'), 'Unverified authors have a blank white core');

  assert.ok(badge1);
  assert.equal(badge1.classList.contains('sparklink-tier-acquaintance'), true);
  assert.equal(badge1.getAttribute('aria-label'), '近30天已记录你回复TA 5 次（含导入）');
  assert.equal(badge1.textContent, ''); // Tier 1-10 shows flame only, no number

  assert.ok(badge2);
  assert.equal(badge2.classList.contains('sparklink-tier-active'), true);
  assert.equal(badge2.textContent, '');

  assert.ok(badge3);
  assert.equal(badge3.classList.contains('sparklink-tier-deep'), true);
  assert.equal(badge3.textContent, '');
  assert.equal(badge3.getAttribute('aria-label'), '近30天已记录你回复TA 55 次（含导入）');
  assert.ok(badge3.querySelector('svg[data-testid="icon-verified"]') === null);

  // Zero count & unmapped handle must NOT render any badge
  assert.equal(cardZero.userNameBox.querySelector('.sparklink-badge'), null);
  assert.equal(cardUnmapped.userNameBox.querySelector('.sparklink-badge'), null);

  // Virtual list reuse: card3 (Deep 55, user_t3) is recycled in-place by React for user_zero (0 replies)!
  card3.profileLink.setAttribute('href', '/user_zero');
  card3.handleLink.setAttribute('href', '/user_zero');
  card3.handleSpan.textContent = '@user_zero';
  win.triggerMutations([{ type: 'attributes', target: card3.profileLink }]);

  await waitForBadgeState(() => !card3.userNameBox.querySelector('.sparklink-badge'), 'Recycled zero-count row');
  // Old badge from user_t3 MUST be removed, and no duplicate inserted!
  assert.equal(card3.userNameBox.querySelectorAll('.sparklink-badge').length, 0);

  // Recycle card3 again for user_t2 (Active 25) -> exactly 1 active badge rendered
  card3.profileLink.setAttribute('href', '/user_t2');
  card3.handleLink.setAttribute('href', '/user_t2');
  card3.handleSpan.textContent = '@user_t2';
  win.triggerMutations([{ type: 'attributes', target: card3.profileLink }]);

  await waitForBadgeState(() => card3.userNameBox.querySelector('.sparklink-tier-active'), 'Recycled active row');
  const recycledBadges = card3.userNameBox.querySelectorAll('.sparklink-badge');
  assert.equal(recycledBadges.length, 1);
  assert.equal(recycledBadges[0].classList.contains('sparklink-tier-active'), true);

  // Window expiration refresh without network events (within <=60s; configured to 40ms here):
  // Suppose user_t2's replies expire from 25 down to 8 (downgrade active -> acquaintance) and user_t1 drops to 0 (remove)!
  counts['2002'] = 8;
  counts['2001'] = 0;

  await waitForBadgeState(
    () => !card1.userNameBox.querySelector('.sparklink-badge') && card2.userNameBox.querySelector('.sparklink-tier-acquaintance'),
    'Expired counts should remove or downgrade the affected badges'
  );
  assert.equal(card1.userNameBox.querySelector('.sparklink-badge'), null);
  assert.equal(
    card2.userNameBox.querySelector('.sparklink-badge').classList.contains('sparklink-tier-acquaintance'),
    true
  );

  // Account switch / binding revocation immediately clears all badges on page
  bridge.setBinding(null, 99);
  bridge.emitEvent({ type: 'BINDING_REVOKED', bindingId: 'bind_1' });
  assert.equal(body.querySelectorAll('.sparklink-badge').length, 0);
  assert.equal(body.querySelectorAll('.sparklink-native-fire').length, 0);
});

test('The same author can gain, replace and lose a blue check at the same count', async (t) => {
  const { win, bridge, body } = createFakeDomAndBridge({ '2001': 25 });
  const row = buildTweetCard({ handle: 'user_t1', displayName: 'Author', verified: true });
  body.appendChild(row.article);
  const native = row.profileLink.querySelector('svg[data-testid="icon-verified"]');
  const paint = native.children[0];
  const controller = installContentBadges(win, bridge, { debounceMs: 1 });
  t.after(() => controller.destroy());
  await waitForBadgeState(() => native.querySelector('.sparklink-native-fire'), 'Initial blue check');

  paint.setAttribute('fill', '#c8a400');
  win.triggerMutations([{ type: 'attributes', attributeName: 'fill', target: paint }]);
  await waitForBadgeState(() => row.userNameBox.querySelector('.sparklink-fire-core'), 'Gold check uses standalone flames');
  assert.equal(native.querySelector('.sparklink-native-fire'), null);
  const replacement = new FakeElement('svg', 'http://www.w3.org/2000/svg');
  replacement.setAttribute('data-testid', 'icon-verified');
  replacement.setAttribute('fill', '#1d9bf0');
  native.remove();
  row.profileLink.appendChild(replacement);
  win.triggerMutations([{ type: 'childList', target: row.profileLink, addedNodes: [replacement], removedNodes: [native] }]);
  await waitForBadgeState(() => replacement.querySelector('.sparklink-native-fire'), 'Moved back to a blue check');
  assert.equal(row.userNameBox.querySelector('.sparklink-fire-core'), null);
  replacement.remove();
  win.triggerMutations([{ type: 'childList', target: row.profileLink, addedNodes: [], removedNodes: [replacement] }]);
  await waitForBadgeState(() => row.userNameBox.querySelector('.sparklink-fire-core'), 'Blue check removed');
  assert.equal(replacement.querySelector('.sparklink-native-fire'), null);
  assert.equal(row.userNameBox.querySelectorAll('.sparklink-badge').length, 1);
});

test('Tier boundaries (0/1/10/11/50/51), conflicting/reserved handles, self-mutation ignore, chunked frame slicing, and stale async query discard', async (t) => {
  assert.equal(getTierMeta(0).key, 'none');
  assert.equal(getTierMeta(1).key, 'acquaintance');
  assert.equal(getTierMeta(10).key, 'acquaintance');
  assert.equal(getTierMeta(11).key, 'active');
  assert.equal(getTierMeta(50).key, 'active');
  assert.equal(getTierMeta(51).key, 'deep');
  assert.equal(getTierMeta(51).showCount, false);

  const counts = {
    '2001': 10,
    '2002': 50,
    '2003': 51
  };
  const { win, doc, body, bridge } = createFakeDomAndBridge(counts);

  // Guard against invalid install args & duplicate installs
  assert.equal(installContentBadges(null, null), null);

  let clock = 1000;
  const controller = installContentBadges(win, bridge, {
    debounceMs: 5,
    frameBudgetMs: 2,
    windowRefreshMs: 5000,
    nowFn: () => {
      clock += 3; // Forces frame budget yield between cards
      return clock;
    }
  });
  assert.equal(installContentBadges(win, bridge), controller);
  t.after(() => controller.destroy());

  // Conflicting card: profile link says user_t1, @handle span says @user_t2 -> must NOT render badge
  const conflictCard = buildTweetCard({ handle: 'user_t1', displayName: 'Conflict' });
  conflictCard.handleSpan.textContent = '@user_t2';

  // Reserved path link (/home) alongside valid @user_t1
  const reservedLinkCard = buildTweetCard({ handle: 'user_t1', displayName: 'WithHome' });
  const homeLink = new FakeElement('a');
  homeLink.setAttribute('href', '/home');
  reservedLinkCard.userNameBox.appendChild(homeLink);

  // Self actor card (actorUserId 1001001) -> never renders badge
  const selfCard = buildTweetCard({ handle: 'user_t3', displayName: 'Active51' });

  // Mount via childList mutation on body and verify self-mutation ignore
  body.appendChild(conflictCard.article);
  body.appendChild(reservedLinkCard.article);
  body.appendChild(selfCard.article);
  win.triggerMutations([
    {
      type: 'childList',
      target: body,
      addedNodes: [conflictCard.article, reservedLinkCard.article, selfCard.article],
      removedNodes: []
    }
  ]);

  await waitForBadgeState(
    () => reservedLinkCard.userNameBox.querySelector('.sparklink-badge') && selfCard.userNameBox.querySelector('.sparklink-badge'),
    'Both cards should finish rendering across separate frames'
  );

  assert.equal(conflictCard.userNameBox.querySelector('.sparklink-badge'), null);
  assert.equal(
    reservedLinkCard.userNameBox.querySelector('.sparklink-badge').classList.contains('sparklink-tier-acquaintance'),
    true
  );
  const badge51 = selfCard.userNameBox.querySelector('.sparklink-badge');
  assert.ok(badge51);
  assert.equal(badge51.classList.contains('sparklink-tier-deep'), true);
  assert.equal(badge51.textContent, '');

  // Self-mutation (only .sparklink-badge added/removed) is ignored cleanly
  win.triggerMutations([
    {
      type: 'childList',
      target: selfCard.userNameBox,
      addedNodes: [badge51],
      removedNodes: []
    }
  ]);

  // Simulate BINDING_READY, MAPPINGS_UPDATED, REVISION_UPDATED, visibilitychange, and refreshNow
  counts['2003'] = 50; // downgrade 51 -> 50 (active, no count text)
  bridge.emitEvent({ type: 'MAPPINGS_UPDATED' });
  bridge.emitEvent({ type: 'REVISION_UPDATED', revision: 2 });
  await waitForBadgeState(() => selfCard.userNameBox.querySelector('.sparklink-tier-active'), 'Tier downgrade after revision');
  assert.equal(
    selfCard.userNameBox.querySelector('.sparklink-badge').classList.contains('sparklink-tier-active'),
    true
  );
  assert.equal(selfCard.userNameBox.querySelector('.sparklink-badge').textContent, '');

  counts['2003'] = 5;
  doc.visibilityState = 'visible';
  win.triggerDocEvent('visibilitychange');
  controller.refreshNow();
  await waitForBadgeState(() => selfCard.userNameBox.querySelector('.sparklink-tier-acquaintance'), 'Visible document refresh');

  // Stale async queryCounts response arriving after account switch A -> B must be discarded!
  let resolveSlowQuery;
  bridge.queryCounts = () =>
    new Promise((resolve) => {
      resolveSlowQuery = resolve;
    });

  bridge.setBinding(
    {
      bindingId: 'bind_slow_A',
      actorUserId: '1001001',
      captureSessionId: 2,
      collectionGeneration: 1,
      accountGeneration: 2
    },
    10
  );
  bridge.emitEvent({ type: 'BINDING_READY' });
  await waitForBadgeState(() => Boolean(resolveSlowQuery), 'Slow query should have started');

  // Switch to unbound / different account BEFORE slow query resolves
  bridge.setBinding(null, 11);
  bridge.emitEvent({ type: 'COLLECTION_PAUSED' });
  resolveSlowQuery({
    ok: true,
    counts: { '2001': 99, '2003': 99 },
    revision: 10,
    bindingId: 'bind_slow_A'
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(body.querySelectorAll('.sparklink-badge').length, 0);

  controller.destroy();
  controller.destroy(); // idempotent
});

test('[P2] Coalesced author inline runs with middle-dot timestamps, bidi isolates, segmented handles, email display names, glued handles, and overlong tokens', async (t) => {
  const counts = {
    '3001': 12, // sample_friend -> active
    '3002': 4 // sample_me -> acquaintance
  };
  const { body, win, bridge } = createFakeDomAndBridge(counts);
  const customHandles = new Map([
    ['sample_friend', '3001'],
    ['sample_me', '3002']
  ]);
  bridge.resolveUserIdByHandle = (h) => customHandles.get(String(h).toLowerCase()) || null;

  const controller = installContentBadges(win, bridge, {
    debounceMs: 5,
    frameBudgetMs: 50,
    windowRefreshMs: 60000
  });

  t.after(() => controller.destroy());

  function makeAuthorBox() {
    const article = new FakeElement('article');
    article.setAttribute('data-testid', 'tweet');
    const box = new FakeElement('div');
    box.setAttribute('data-testid', 'User-Name');
    article.appendChild(box);
    body.appendChild(article);
    return box;
  }

  // 1. Conflicting profile link /sample_friend + inline spans `<span>@somebody_else</span><span> · 2h</span>` -> MUST refuse badge!
  const conflictSpaced = makeAuthorBox();
  const linkFriend1 = new FakeElement('a');
  linkFriend1.setAttribute('href', '/sample_friend');
  linkFriend1.textContent = 'Sample Friend';
  conflictSpaced.appendChild(linkFriend1);
  const metaRow1 = new FakeElement('div');
  const hSpan1 = new FakeElement('span');
  hSpan1.textContent = '@somebody_else';
  const tSpan1 = new FakeElement('span');
  tSpan1.textContent = ' · 2h';
  metaRow1.appendChild(hSpan1);
  metaRow1.appendChild(tSpan1);
  conflictSpaced.appendChild(metaRow1);

  // 2. Conflicting profile link /sample_friend + unspaced middle-dot `@somebody_else·2h` -> MUST refuse badge!
  const conflictTight = makeAuthorBox();
  const linkFriend2 = new FakeElement('a');
  linkFriend2.setAttribute('href', '/sample_friend');
  linkFriend2.textContent = 'Sample Friend';
  conflictTight.appendChild(linkFriend2);
  const metaRow2 = new FakeElement('div');
  const hSpan2 = new FakeElement('span');
  hSpan2.textContent = '@somebody_else·2h';
  metaRow2.appendChild(hSpan2);
  conflictTight.appendChild(metaRow2);

  // 3. Conflicting profile link /sample_friend + Unicode bidi-isolated `⁦@somebody_else⁩ • 2h` -> MUST refuse badge!
  const conflictBidi = makeAuthorBox();
  const linkFriend3 = new FakeElement('a');
  linkFriend3.setAttribute('href', '/sample_friend');
  linkFriend3.textContent = 'Sample Friend';
  conflictBidi.appendChild(linkFriend3);
  const metaRow3 = new FakeElement('div');
  const hSpan3 = new FakeElement('span');
  hSpan3.textContent = '⁦@somebody_else⁩ • 2h';
  metaRow3.appendChild(hSpan3);
  conflictBidi.appendChild(metaRow3);

  // 4. Linkless author row with coalesced `<span>@sample_friend</span><span> · 2h</span>` -> MUST render badge!
  const linklessSpans = makeAuthorBox();
  const nameDiv4 = new FakeElement('div');
  nameDiv4.textContent = 'Sample Friend';
  linklessSpans.appendChild(nameDiv4);
  const metaRow4 = new FakeElement('div');
  const hSpan4 = new FakeElement('span');
  hSpan4.textContent = '@sample_friend';
  const tSpan4 = new FakeElement('span');
  tSpan4.textContent = ' · 2h';
  metaRow4.appendChild(hSpan4);
  metaRow4.appendChild(tSpan4);
  linklessSpans.appendChild(metaRow4);

  // 5. Linkless author row with single text run `@sample_friend · 2h` -> MUST render badge!
  const linklessSingle = makeAuthorBox();
  const metaRow5 = new FakeElement('div');
  metaRow5.textContent = '@sample_friend · 2h';
  linklessSingle.appendChild(metaRow5);

  // 6. Segmented handle `<span>@sample_me</span><span>_alt</span><span> · 2h</span>` -> coalesced as @sample_me_alt, NEVER prefix-matches @sample_me!
  const segmentedSuffix = makeAuthorBox();
  const metaRow6 = new FakeElement('div');
  const segA = new FakeElement('span');
  segA.textContent = '@sample_me';
  const segB = new FakeElement('span');
  segB.textContent = '_alt';
  const segC = new FakeElement('span');
  segC.textContent = ' · 2h';
  metaRow6.appendChild(segA);
  metaRow6.appendChild(segB);
  metaRow6.appendChild(segC);
  segmentedSuffix.appendChild(metaRow6);

  // 7. Display name containing email `contact@company.com` + `/sample_friend` + `@sample_friend · 2h` -> ignores email, renders badge!
  const emailDisplay = makeAuthorBox();
  const linkFriend7 = new FakeElement('a');
  linkFriend7.setAttribute('href', '/sample_friend');
  const emailNameSpan = new FakeElement('span');
  emailNameSpan.textContent = 'contact@company.com';
  linkFriend7.appendChild(emailNameSpan);
  emailDisplay.appendChild(linkFriend7);
  const metaRow7 = new FakeElement('div');
  const hSpan7 = new FakeElement('span');
  hSpan7.textContent = '@sample_friend · 2h';
  metaRow7.appendChild(hSpan7);
  emailDisplay.appendChild(metaRow7);

  // 8. Glued handles `@sample_friend@somebody_else · 2h` and overlong `>64`-char `@` run -> both yield 0 badges!
  const gluedConflict = makeAuthorBox();
  const metaRow8 = new FakeElement('div');
  metaRow8.textContent = '@sample_friend@somebody_else · 2h';
  gluedConflict.appendChild(metaRow8);

  const overlongBox = makeAuthorBox();
  const metaRow9 = new FakeElement('div');
  metaRow9.textContent = `@sample_friend_${'x'.repeat(60)} · 2h`; // 75 handle chars (> 64)
  overlongBox.appendChild(metaRow9);

  controller.refreshNow();
  await waitForBadgeState(
    () => [linklessSpans, linklessSingle, emailDisplay].every((box) => box.querySelector('.sparklink-badge')),
    'Each unambiguous author row should render its badge'
  );

  assert.equal(
    conflictSpaced.querySelector('.sparklink-badge'),
    null,
    'Link /sample_friend with @somebody_else · 2h must NOT misbadge @somebody_else'
  );
  assert.equal(conflictTight.querySelector('.sparklink-badge'), null);
  assert.equal(conflictBidi.querySelector('.sparklink-badge'), null);
  assert.ok(
    linklessSpans.querySelector('.sparklink-badge'),
    'Linkless @sample_friend + " · 2h" spans must render Spark badge'
  );
  assert.ok(
    linklessSingle.querySelector('.sparklink-badge'),
    'Linkless single-run "@sample_friend · 2h" must render Spark badge'
  );
  assert.equal(
    segmentedSuffix.querySelector('.sparklink-badge'),
    null,
    'Segmented @sample_me + _alt + " · 2h" must coalesce as sample_me_alt and never prefix-match sample_me'
  );
  assert.ok(
    emailDisplay.querySelector('.sparklink-badge'),
    'Email inside display name must not block valid @sample_friend · 2h'
  );
  assert.equal(gluedConflict.querySelector('.sparklink-badge'), null);
  assert.equal(overlongBox.querySelector('.sparklink-badge'), null);
});

test('Display-name mentions neither identify an author nor override a separate handle field', async (t) => {
  const { win, body, bridge } = createFakeDomAndBridge({ '2001': 5 });
  const mentionRows = [
    ['Editor (@user_t1)'],
    ['@user_t1, guest editor'],
    ['Editor (', '@user_t1', ')']
  ].map((pieces) => {
    const row = new FakeElement('div');
    row.setAttribute('data-testid', 'User-Name');
    for (const text of pieces) {
      const span = new FakeElement('span');
      span.textContent = text;
      row.appendChild(span);
    }
    body.appendChild(row);
    return row;
  });
  const author = buildTweetCard({ handle: 'user_t1', displayName: 'Editor at @newsroom' });
  body.appendChild(author.article);
  const control = buildTweetCard({ handle: 'user_t1', displayName: 'Editor' });
  body.appendChild(control.article);

  const controller = installContentBadges(win, bridge, { debounceMs: 1, frameBudgetMs: 1000 });
  t.after(() => controller.destroy());
  await waitForBadgeState(() => control.userNameBox.querySelector('.sparklink-badge'), 'Control author should render');
  for (const row of mentionRows) assert.ok(!row.querySelector('.sparklink-badge'), row.textContent);
  assert.equal(author.userNameBox.querySelector('.sparklink-badge')?.dataset.sparklinkUserId, '2001');
});
