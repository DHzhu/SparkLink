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
    if (selector === '[data-testid="User-Name"]') {
      return this.getAttribute('data-testid') === 'User-Name';
    }
    if (selector === 'article[data-testid="tweet"]') {
      return this.tagName === 'ARTICLE' && this.getAttribute('data-testid') === 'tweet';
    }
    if (selector === 'svg[data-testid="icon-verified"]') {
      return this.tagName === 'SVG' && this.getAttribute('data-testid') === 'icon-verified';
    }
    if (selector === '.sparklink-badge') {
      return this.classList.contains('sparklink-badge');
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

test('Content badges render SVG tiers (0/5/25/55), respect verified layout, handle virtual-list node reuse A->B, drop stale bindings, and refresh expired counts within 60s', async () => {
  const counts = {
    '2001': 5,  // acquaintance (1-10)
    '2002': 25, // active (11-50)
    '2003': 55, // deep (>=51, shows count)
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

  await new Promise((r) => setTimeout(r, 35));

  const badge1 = card1.userNameBox.querySelector('.sparklink-badge');
  const badge2 = card2.userNameBox.querySelector('.sparklink-badge');
  const badge3 = card3.userNameBox.querySelector('.sparklink-badge');

  assert.ok(badge1);
  assert.equal(badge1.classList.contains('sparklink-tier-acquaintance'), true);
  assert.equal(badge1.getAttribute('aria-label'), '近30天已记录你回复TA 5 次（含导入）');
  assert.equal(badge1.textContent, ''); // Tier 1-10 shows flame only, no number

  assert.ok(badge2);
  assert.equal(badge2.classList.contains('sparklink-tier-active'), true);
  assert.equal(badge2.textContent, '');

  assert.ok(badge3);
  assert.equal(badge3.classList.contains('sparklink-tier-deep'), true);
  assert.equal(badge3.textContent, '55');
  assert.ok(badge3.querySelector('svg[data-testid="icon-verified"]') === null);

  // Zero count & unmapped handle must NOT render any badge
  assert.equal(cardZero.userNameBox.querySelector('.sparklink-badge'), null);
  assert.equal(cardUnmapped.userNameBox.querySelector('.sparklink-badge'), null);

  // Virtual list reuse: card3 (Deep 55, user_t3) is recycled in-place by React for user_zero (0 replies)!
  card3.profileLink.setAttribute('href', '/user_zero');
  card3.handleLink.setAttribute('href', '/user_zero');
  card3.handleSpan.textContent = '@user_zero';
  win.triggerMutations([{ type: 'attributes', target: card3.profileLink }]);

  await new Promise((r) => setTimeout(r, 35));
  // Old badge from user_t3 MUST be removed, and no duplicate inserted!
  assert.equal(card3.userNameBox.querySelectorAll('.sparklink-badge').length, 0);

  // Recycle card3 again for user_t2 (Active 25) -> exactly 1 active badge rendered
  card3.profileLink.setAttribute('href', '/user_t2');
  card3.handleLink.setAttribute('href', '/user_t2');
  card3.handleSpan.textContent = '@user_t2';
  win.triggerMutations([{ type: 'attributes', target: card3.profileLink }]);

  await new Promise((r) => setTimeout(r, 35));
  const recycledBadges = card3.userNameBox.querySelectorAll('.sparklink-badge');
  assert.equal(recycledBadges.length, 1);
  assert.equal(recycledBadges[0].classList.contains('sparklink-tier-active'), true);

  // Window expiration refresh without network events (within <=60s; configured to 40ms here):
  // Suppose user_t2's replies expire from 25 down to 8 (downgrade active -> acquaintance) and user_t1 drops to 0 (remove)!
  counts['2002'] = 8;
  counts['2001'] = 0;

  await new Promise((r) => setTimeout(r, 65));
  assert.equal(card1.userNameBox.querySelector('.sparklink-badge'), null);
  assert.equal(
    card2.userNameBox.querySelector('.sparklink-badge').classList.contains('sparklink-tier-acquaintance'),
    true
  );

  // Account switch / binding revocation immediately clears all badges on page
  bridge.setBinding(null, 99);
  bridge.emitEvent({ type: 'BINDING_REVOKED', bindingId: 'bind_1' });
  assert.equal(body.querySelectorAll('.sparklink-badge').length, 0);

  controller.destroy();
});

test('Tier boundaries (0/1/10/11/50/51), conflicting/reserved handles, self-mutation ignore, chunked frame slicing, and stale async query discard', async () => {
  assert.equal(getTierMeta(0).key, 'none');
  assert.equal(getTierMeta(1).key, 'acquaintance');
  assert.equal(getTierMeta(10).key, 'acquaintance');
  assert.equal(getTierMeta(11).key, 'active');
  assert.equal(getTierMeta(50).key, 'active');
  assert.equal(getTierMeta(51).key, 'deep');
  assert.equal(getTierMeta(51).showCount, true);

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

  await new Promise((r) => setTimeout(r, 40));

  assert.equal(conflictCard.userNameBox.querySelector('.sparklink-badge'), null);
  assert.equal(
    reservedLinkCard.userNameBox.querySelector('.sparklink-badge').classList.contains('sparklink-tier-acquaintance'),
    true
  );
  const badge51 = selfCard.userNameBox.querySelector('.sparklink-badge');
  assert.ok(badge51);
  assert.equal(badge51.classList.contains('sparklink-tier-deep'), true);
  assert.equal(badge51.textContent, '51');

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
  await new Promise((r) => setTimeout(r, 35));
  assert.equal(
    selfCard.userNameBox.querySelector('.sparklink-badge').classList.contains('sparklink-tier-active'),
    true
  );
  assert.equal(selfCard.userNameBox.querySelector('.sparklink-badge').textContent, '');

  doc.visibilityState = 'visible';
  win.triggerDocEvent('visibilitychange');
  controller.refreshNow();
  await new Promise((r) => setTimeout(r, 30));

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
  await new Promise((r) => setTimeout(r, 15));

  // Switch to unbound / different account BEFORE slow query resolves
  bridge.setBinding(null, 11);
  bridge.emitEvent({ type: 'COLLECTION_PAUSED' });
  resolveSlowQuery({
    ok: true,
    counts: { '2001': 99, '2003': 99 },
    revision: 10,
    bindingId: 'bind_slow_A'
  });
  await new Promise((r) => setTimeout(r, 25));

  assert.equal(body.querySelectorAll('.sparklink-badge').length, 0);

  controller.destroy();
  controller.destroy(); // idempotent
});

