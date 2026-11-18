import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createBackgroundService } from '../src/background.js';
import { createPopupController } from '../src/popup/popup.js';

const NOW_MS = 1794794402000;
const EXT_ID = 'sparklink_ext_id';
const POPUP_URL = `chrome-extension://${EXT_ID}/src/popup/popup.html`;
const POPUP_SENDER = Object.freeze({ id: EXT_ID, url: POPUP_URL });

class FakePopupNode {
  constructor(tagName, namespaceURI = null) {
    this.nodeType = 1;
    this.tagName = String(tagName).toUpperCase();
    this.namespaceURI = namespaceURI;
    this.id = '';
    this.className = '';
    this.disabled = false;
    this.checked = false;
    this.hidden = false;
    this.value = '';
    this.files = [];
    this.attributes = new Map();
    this.dataset = {};
    this.children = [];
    this.parentNode = null;
    this._textContent = '';
    this._listeners = new Map();
    this.clickedCount = 0;
  }

  set innerHTML(_v) {
    throw new Error('innerHTML is strictly forbidden in Popup');
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

  setAttribute(k, v) {
    const str = String(v);
    this.attributes.set(k, str);
    if (k === 'id') this.id = str;
    if (k === 'class') this.className = str;
  }

  getAttribute(k) {
    return this.attributes.has(k) ? this.attributes.get(k) : null;
  }

  appendChild(child) {
    if (child.parentNode) {
      const idx = child.parentNode.children.indexOf(child);
      if (idx !== -1) child.parentNode.children.splice(idx, 1);
    }
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  replaceChildren(...nodes) {
    this.children = [];
    this._textContent = '';
    for (const n of nodes) {
      this.appendChild(n);
    }
  }

  remove() {
    if (this.parentNode) {
      const idx = this.parentNode.children.indexOf(this);
      if (idx !== -1) this.parentNode.children.splice(idx, 1);
      this.parentNode = null;
    }
  }

  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }

  async trigger(type, eventInit = {}) {
    const list = this._listeners.get(type) || [];
    for (const fn of list) {
      await fn({ target: this, preventDefault() {}, ...eventInit });
    }
  }

  click() {
    this.clickedCount += 1;
  }

  findAllByTag(tag) {
    const upper = tag.toUpperCase();
    const out = [];
    const walk = (n) => {
      for (const c of n.children) {
        if (c.tagName === upper) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
}

function createFakePopupDom() {
  const byId = new Map();
  const root = new FakePopupNode('body');

  const ids = [
    'collection-toggle',
    'btn-enable-cta',
    'initial-activation-banner',
    'account-select',
    'viewer-status-badge',
    'status-banners',
    'overview-title',
    'overview-coverage',
    'latest-reply-time',
    'stat-total-replies',
    'stat-active-targets',
    'stat-active-label',
    'stat-deep-targets',
    'stat-deep-label',
    'top20-list',
    'top20-empty',
    'btn-cleanup',
    'btn-history-sync',
    'history-sync-status',
    'debug-logs-toggle',
    'btn-export',
    'btn-import',
    'file-import',
    'btn-clear-account',
    'btn-clear-all',
    'action-feedback',
    'modal-overlay',
    'modal-title',
    'modal-body',
    'btn-modal-confirm',
    'btn-modal-cancel'
  ];

  for (const id of ids) {
    const tag =
      id === 'account-select'
        ? 'select'
        : id === 'collection-toggle' || id === 'file-import'
        ? 'input'
        : 'div';
    const el = new FakePopupNode(tag);
    el.setAttribute('id', id);
    if (id === 'modal-overlay') el.hidden = true;
    byId.set(id, el);
    root.appendChild(el);
  }

  const createdDownloads = [];
  const revokedUrls = [];

  const doc = {
    body: root,
    getElementById(id) {
      return byId.get(id) || null;
    },
    createElement(tag) {
      const n = new FakePopupNode(tag);
      if (String(tag).toLowerCase() === 'a') {
        createdDownloads.push(n);
      }
      return n;
    },
    createElementNS(ns, tag) {
      return new FakePopupNode(tag, ns);
    }
  };

  const urlApi = {
    createObjectURL(_blob) {
      return 'blob:chrome-extension://sparklink/backup-1';
    },
    revokeObjectURL(u) {
      revokedUrls.push(u);
    }
  };

  return { doc, byId, createdDownloads, revokedUrls, urlApi };
}

function createArea() {
  let store = {};
  return {
    async setAccessLevel() {},
    async get(k) {
      if (typeof k === 'string') {
        return Object.prototype.hasOwnProperty.call(store, k)
          ? { [k]: structuredClone(store[k]) }
          : {};
      }
      return structuredClone(store);
    },
    async set(items) {
      store = { ...store, ...structuredClone(items) };
    },
    async clear() {
      store = {};
    },
    async getBytesInUse() {
      return Buffer.byteLength(JSON.stringify(store), 'utf8');
    }
  };
}

test('Popup HTML/CSS assets have zero remote resources and Popup UI covers activation, viewing Account B without altering Tab A binding, safe links, export notice, stale import re-confirm, and clears', async () => {
  const htmlSource = fs.readFileSync(
    path.resolve('src/popup/popup.html'),
    'utf8'
  );
  const cssSource = fs.readFileSync(
    path.resolve('src/popup/popup.css'),
    'utf8'
  );
  assert.ok(htmlSource.includes('SparkLink'));
  assert.ok(htmlSource.includes('我不会错过你的每一次发声'));
  assert.equal(/https?:\/\//i.test(htmlSource), false);
  assert.equal(/https?:\/\//i.test(cssSource), false);
  assert.ok(cssSource.includes('prefers-color-scheme: dark'));

  const localArea = createArea();
  const sessionArea = createArea();
  const bg = createBackgroundService(
    {
      storage: { local: localArea, session: sessionArea },
      runtime: {
        id: EXT_ID,
        getURL: (p) => `chrome-extension://${EXT_ID}/${p.replace(/^\//, '')}`,
        onMessage: { addListener() {} }
      },
      tabs: { sendMessage: async () => {}, onRemoved: { addListener() {} } }
    },
    { nowFn: () => NOW_MS }
  );

  const runtimeBridge = {
    sendMessage: (msg) => bg.handleMessage(msg, POPUP_SENDER)
  };

  const { doc, byId, createdDownloads, revokedUrls, urlApi } = createFakePopupDom();
  const popup = createPopupController({
    document: doc,
    runtime: runtimeBridge,
    urlApi
  });
  await popup.init();

  // 1. Initial paused state shows activation banner & exact Section 2.3 copy
  assert.equal(byId.get('initial-activation-banner').hidden, false);
  assert.equal(
    byId.get('overview-title').textContent,
    '近 30 天已记录的主动回复（含导入）'
  );
  assert.equal(
    byId.get('overview-coverage').textContent,
    '来源包括本机网页活动和导入的备份，历史记录可能不完整。'
  );
  assert.equal(byId.get('latest-reply-time').textContent, '尚无已记录回复');

  // 2. Click CTA to enable collection -> binds Tab A (1001001) and also imports Account B (9009009)
  await byId.get('btn-enable-cta').trigger('click');
  assert.equal(byId.get('collection-toggle').checked, true);

  const tabASender = {
    id: EXT_ID,
    tab: { id: 11, active: true },
    frameId: 0,
    documentId: 'doc_tab_a',
    origin: 'https://x.com',
    url: 'https://x.com/home'
  };
  const helloA = await bg.handleMessage({ type: 'HELLO' }, tabASender);
  const bindA = await bg.handleMessage(
    {
      type: 'BIND_VIEWER',
      captureSessionId: helloA.captureSessionId,
      viewer: { actorUserId: '1001001', handle: 'alice_x', displayName: 'Alice' }
    },
    tabASender
  );

  // Submit 1 reply with valid handle & 1 reply with missing handle (ID-only fallback)
  await bg.handleMessage(
    {
      type: 'SUBMIT_OBSERVED_BATCH',
      bindingContext: bindA.bindingContext,
      events: [
        {
          actorUserId: '1001001',
          replyTweetId: '2122147641553846272',
          parentTweetId: '2121785253688246272',
          targetUserId: '2002002',
          targetHandle: 'valid_friend',
          targetDisplayName: 'Valid Friend',
          createdAt: NOW_MS - 2000,
          observedAt: NOW_MS - 1000,
          source: 'live'
        },
        {
          actorUserId: '1001001',
          replyTweetId: '2122147641553846273',
          parentTweetId: '2121785253688246273',
          targetUserId: '3003003',
          targetHandle: null,
          targetDisplayName: null,
          createdAt: NOW_MS - 1000,
          observedAt: NOW_MS - 500,
          source: 'history'
        }
      ]
    },
    tabASender
  );

  // Import a backup containing Account B (9009009) + mixed validity (1 valid ID-only, 1 invalid missing targetUserId)
  const mixedBackup = JSON.stringify({
    format: 'sparklink-backup',
    formatVersion: 1,
    exportedAt: '2026-11-16T02:00:01.000Z',
    data: {
      schemaVersion: 1,
      accounts: {
        '9009009': {
          handle: 'bob_x',
          displayName: 'Bob',
          users: {},
          replies: {
            '2122147641553849001': {
              replyTweetId: '2122147641553849001',
              parentTweetId: '2121785253688249001',
              targetUserId: '7777777',
              createdAt: NOW_MS - 5000,
              observedAt: NOW_MS - 4000,
              source: 'live'
            },
            '2122147641553849002': {
              replyTweetId: '2122147641553849002',
              parentTweetId: '2121785253688249002',
              targetUserId: '', // invalid!
              createdAt: NOW_MS - 5000,
              observedAt: NOW_MS - 4000,
              source: 'live'
            }
          }
        }
      }
    }
  });

  byId.get('file-import').files = [
    {
      name: 'backup.json',
      size: mixedBackup.length,
      text: async () => mixedBackup
    }
  ];
  await byId.get('file-import').trigger('change');

  // Preview modal opens showing 新增 1, 无效 1
  assert.equal(byId.get('modal-overlay').hidden, false);
  assert.ok(byId.get('modal-body').textContent.includes('1'));

  // Simulate background change BEFORE user confirms import -> triggers PREVIEW_STALE!
  await bg.handleMessage(
    {
      type: 'SUBMIT_OBSERVED_BATCH',
      bindingContext: bindA.bindingContext,
      events: [
        {
          actorUserId: '1001001',
          replyTweetId: '2122147641553846299',
          parentTweetId: '2121785253688246299',
          targetUserId: '2002002',
          targetHandle: 'valid_friend',
          createdAt: NOW_MS - 500,
          observedAt: NOW_MS - 100,
          source: 'live'
        }
      ]
    },
    tabASender
  );
  // Also advance global generation by Clear All? Wait: let's test PREVIEW_STALE by clearing Account B or mutating Account B!
  // Let's confirm first import (Account B was null before and still null, so this succeeds!)
  await byId.get('btn-modal-confirm').trigger('click');
  assert.equal(byId.get('modal-overlay').hidden, true);

  // Refresh Popup: active tab is Account A (1001001, 3 replies)
  await popup.refresh();
  assert.equal(byId.get('stat-total-replies').textContent, '3');

  // Verify Top 20 safe links: valid_friend has https://x.com/valid_friend, 3003003 has NO link and displays ID
  const linksInTop20 = byId.get('top20-list').findAllByTag('a');
  assert.equal(linksInTop20.length, 1);
  assert.equal(linksInTop20[0].getAttribute('href'), 'https://x.com/valid_friend');
  assert.equal(linksInTop20[0].getAttribute('rel'), 'noopener noreferrer');
  assert.ok(byId.get('top20-list').textContent.includes('3003003'));

  // 3. Switch viewed account in Popup to Account B (9009009) -> does NOT change Tab A's capture binding!
  byId.get('account-select').value = '9009009';
  await byId.get('account-select').trigger('change');
  assert.equal(byId.get('stat-total-replies').textContent, '1');
  assert.ok(byId.get('top20-list').textContent.includes('7777777'));

  // Tab A submits another reply while Popup is viewing Account B -> still attributed to Account A!
  const tabAWriteWhileViewingB = await bg.handleMessage(
    {
      type: 'SUBMIT_OBSERVED_BATCH',
      bindingContext: bindA.bindingContext,
      events: [
        {
          actorUserId: '1001001',
          replyTweetId: '2122147641553846300',
          parentTweetId: '2121785253688246300',
          targetUserId: '2002002',
          createdAt: NOW_MS - 200,
          observedAt: NOW_MS - 50,
          source: 'live'
        }
      ]
    },
    tabASender
  );
  assert.equal(tabAWriteWhileViewingB.ok, true);
  assert.equal(tabAWriteWhileViewingB.added, 1);

  // 4. Export backup shows plaintext notice modal first, then downloads and revokes Blob URL
  await byId.get('btn-export').trigger('click');
  assert.equal(byId.get('modal-overlay').hidden, false);
  assert.ok(byId.get('modal-body').textContent.includes('明文'));
  await byId.get('btn-modal-confirm').trigger('click');
  assert.equal(byId.get('modal-overlay').hidden, true);
  assert.ok(createdDownloads.some((a) => (a.getAttribute('download') || '').startsWith('sparklink-backup-')));
  assert.equal(revokedUrls.length, 1);

  // 5. Open import preview, then Clear All before confirming -> PREVIEW_STALE requires second confirm!
  byId.get('file-import').files = [
    {
      name: 'backup.json',
      size: mixedBackup.length,
      text: async () => mixedBackup
    }
  ];
  await byId.get('file-import').trigger('change');
  assert.equal(byId.get('modal-overlay').hidden, false);

  // Mutate underlying state via CLEAR_ALL directly in background while preview modal is open
  await bg.handleMessage({ type: 'CLEAR_ALL' }, POPUP_SENDER);

  // First click on confirm gets PREVIEW_STALE and keeps modal open with fresh preview!
  await byId.get('btn-modal-confirm').trigger('click');
  assert.equal(byId.get('modal-overlay').hidden, false);
  assert.ok(byId.get('action-feedback').textContent.includes('变化'));

  // Second click confirms fresh preview and succeeds!
  await byId.get('btn-modal-confirm').trigger('click');
  assert.equal(byId.get('modal-overlay').hidden, true);
  assert.equal(byId.get('stat-total-replies').textContent, '1');
  assert.equal(byId.get('collection-toggle').checked, false);

  // 6. Cleanup expired, Clear single account, and Clear all via confirmation modals
  await byId.get('btn-cleanup').trigger('click');

  await byId.get('btn-clear-account').trigger('click');
  assert.equal(byId.get('modal-overlay').hidden, false);
  await byId.get('btn-modal-confirm').trigger('click');
  assert.equal(byId.get('stat-total-replies').textContent, '0');

  await byId.get('btn-clear-all').trigger('click');
  assert.equal(byId.get('modal-overlay').hidden, false);
  await byId.get('btn-modal-confirm').trigger('click');
  assert.equal(byId.get('collection-toggle').checked, false);
});

test('An older Popup refresh cannot overwrite a newer binding snapshot', async () => {
  const { doc, byId } = createFakePopupDom();
  const requests = [];
  const popup = createPopupController({
    document: doc,
    runtime: { sendMessage: () => new Promise((resolve) => requests.push(resolve)) }
  });
  const earlier = popup.refresh();
  const later = popup.refresh();
  const snapshot = { ok: true, settings: { collectionEnabled: true }, savedAccounts: [], selectedAccount: null };
  requests[1]({ ...snapshot, viewerStatus: 'bound', activeTabActorUserId: '9009009' });
  await later;
  requests[0]({ ...snapshot, viewerStatus: 'unconfirmed' });
  await earlier;
  assert.equal(byId.get('viewer-status-badge').textContent, '采集中');
});

test('Popup handles >9 MiB file rejection, modal cancel, toggle switch, and anomaly/corrupted banners cleanly', async () => {
  assert.equal(createPopupController({ document: null, runtime: null }), null);

  const { doc, byId, urlApi } = createFakePopupDom();
  let nextSnapshot = {
    ok: true,
    revision: 5,
    collectionGeneration: 1,
    settings: { collectionEnabled: true, captureSessionId: 5 },
    savedAccounts: [{ actorUserId: '1001001', accountGeneration: 2, handle: null, displayName: 'NoHandleUser' }],
    selectedAccount: {
      actorUserId: '1001001',
      accountGeneration: 2,
      handle: null,
      displayName: 'NoHandleUser',
      summary: {
        totalReplies: 55,
        activeTargetsCount: 1,
        deepTargetsCount: 1,
        latestReplyAt: NOW_MS - 1000,
        clockSkewDetected: true,
        top20: [
          {
            targetUserId: '8888888',
            handle: null,
            displayName: null,
            count: 55,
            lastReplyAt: NOW_MS - 1000,
            tierInfo: { tier: 'deep', label: '深度互动', tooltip: '近30天已记录你回复TA 55 次（含导入）' }
          }
        ]
      }
    },
    activeTabActorUserId: null,
    viewerStatus: 'unconfirmed',
    nearQuotaWarning: true,
    lastStorageError: '存储空间不足，部分新记录未保存',
    diagnostics: { partialUnrecognized: true, incompleteObservation: false, observationDropped: false }
  };

  const mockRuntime = {
    async sendMessage(msg) {
      if (msg.type === 'GET_POPUP_SNAPSHOT') return nextSnapshot;
      if (msg.type === 'SET_COLLECTION_ENABLED') {
        nextSnapshot.settings.collectionEnabled = msg.enabled;
        return { ok: true, settings: nextSnapshot.settings };
      }
      if (msg.type === 'PREVIEW_IMPORT') {
        return { ok: false, message: '不支持的备份格式' };
      }
      return { ok: true };
    }
  };

  const popup = createPopupController({ document: doc, runtime: mockRuntime, urlApi });
  await popup.init();

  const deepPill = byId.get('top20-list').findAllByTag('span').find(node => node.className.includes('tier-pill'));
  assert.equal(deepPill.textContent, '深度互动');
  assert.ok(deepPill.parentNode.children.some(node => node !== deepPill && node.textContent === '55 次'));

  // Verify all 5 warning/error banners rendered simultaneously
  const bannerText = byId.get('status-banners').textContent;
  assert.ok(bannerText.includes('存储空间不足'));
  assert.ok(bannerText.includes('7 MiB'));
  assert.ok(bannerText.includes('尚未确认'));
  assert.ok(bannerText.includes('无法识别'));
  assert.ok(bannerText.includes('系统时钟'));
  assert.equal(byId.get('viewer-status-badge').textContent, '账号待确认');

  // Oversized > 9 MiB file rejected immediately before reading
  await byId.get('btn-import').trigger('click');
  byId.get('file-import').files = [
    {
      name: 'huge.json',
      size: 10 * 1024 * 1024,
      text: async () => {
        throw new Error('Should not read oversized file');
      }
    }
  ];
  await byId.get('file-import').trigger('change');
  assert.ok(byId.get('action-feedback').textContent.includes('9 MiB'));

  // Invalid format preview displays error message
  byId.get('file-import').files = [
    { name: 'bad.json', size: 10, text: async () => '{}' }
  ];
  await byId.get('file-import').trigger('change');
  assert.ok(byId.get('action-feedback').textContent.includes('不支持'));

  // Modal cancel closes modal cleanly
  await byId.get('btn-clear-all').trigger('click');
  assert.equal(byId.get('modal-overlay').hidden, false);
  await byId.get('btn-modal-cancel').trigger('click');
  assert.equal(byId.get('modal-overlay').hidden, true);

  // Toggle collection checkbox directly
  byId.get('collection-toggle').checked = false;
  await byId.get('collection-toggle').trigger('change');
  assert.equal(byId.get('viewer-status-badge').textContent, '已暂停');

  // Corrupted snapshot state
  nextSnapshot = { ok: false, code: 'STATE_CORRUPTED', message: '本地状态版本不受支持，已保留旧快照' };
  await popup.refresh();
  assert.equal(byId.get('viewer-status-badge').textContent, '存储异常');
  assert.ok(byId.get('status-banners').textContent.includes('保留旧快照'));
});


test('Manual history button starts with foreground stay-on-tab guidance, toggles debug logs default-off, cancels, and shows cooldown', async () => {
  const popupHtml = fs.readFileSync(path.join(process.cwd(), 'src', 'popup', 'popup.html'), 'utf8');
  assert.ok(popupHtml.includes('id="debug-logs-toggle"'), 'popup.html must contain #debug-logs-toggle');

  const { doc, byId } = createFakePopupDom();
  const selectedAccount = { actorUserId: '42', handle: 'alice', summary: { top20: [] } };
  const snap = { ok: true, debugLogsEnabled: false, viewerStatus: 'bound', activeTabActorUserId: '42', settings: { collectionEnabled: true },
    selectedAccount, savedAccounts: [selectedAccount], historyNextStart: 0 };
  const calls = [];
  const runtime = { async sendMessage(msg) {
    if (msg.type === 'GET_POPUP_SNAPSHOT') return snap;
    calls.push(msg);
    if (msg.type === 'SET_DEBUG_LOGS') {
      snap.debugLogsEnabled = Boolean(msg.enabled);
      return { ok: true, debugLogsEnabled: snap.debugLogsEnabled };
    }
    if (msg.type === 'START_HISTORY_SYNC') {
      snap.historySync = { id: 'test', handle: 'alice', status: 'running', mode: 'timeline', pages: 0, added: 0, duplicates: 0, deadline: Date.now() + 300000 };
    } else {
      Object.assign(snap.historySync, { status: 'cancelled', reason: 'cancelled' });
      snap.historyNextStart = Date.now() + 900000;
    }
    return { ok: true };
  } };
  const ui = createPopupController({ document: doc, runtime });
  await ui.init();
  const debugToggle = byId.get('debug-logs-toggle');
  assert.equal(debugToggle.checked, false);
  debugToggle.checked = true;
  await debugToggle.trigger('change');
  assert.equal(snap.debugLogsEnabled, true);
  assert.equal(debugToggle.checked, true);

  const button = byId.get('btn-history-sync');
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, '同步最近数据');
  assert.match(byId.get('history-sync-status').textContent, /最多 1000 条或近 7 天.*同步期间请停留在该标签页/);
  await button.trigger('click');
  assert.equal(button.textContent, '停止同步');
  assert.match(byId.get('history-sync-status').textContent, /同步期间请停留在该标签页/);
  await button.trigger('click');
  assert.deepEqual(calls, [
    { type: 'SET_DEBUG_LOGS', enabled: true },
    { type: 'START_HISTORY_SYNC', actorUserId: '42' },
    { type: 'CANCEL_HISTORY_SYNC', jobId: 'test' }
  ]);
  await ui.refresh();
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, '同步最近数据');
  assert.match(byId.get('history-sync-status').textContent, /已停止.*后再次手动同步/);

  Object.assign(snap.historySync, { status: 'done', reason: 'item_limit', pages: 50, added: 1000, duplicates: 0 });
  await ui.refresh();
  assert.match(byId.get('history-sync-status').textContent, /已读满最近 1000 条回复/);
});

test('Audit regressions: unreadable import file handling, preserved account selection on failed CLEAR_ALL, Top-20 core bounds, and multi-page search copy', async () => {
  const { doc, byId } = createFakePopupDom();
  const accA = {
    actorUserId: '1001',
    accountGeneration: 1,
    handle: 'alice',
    summary: {
      totalReplies: 12,
      activeTargetsCount: 1,
      deepTargetsCount: 0,
      latestReplyAt: NOW_MS - 1000,
      top20: [
        {
          targetUserId: '9001',
          handle: 'friend_one',
          displayName: 'Friend One',
          count: 12,
          lastReplyAt: NOW_MS - 1000,
          tierInfo: { tier: 'active', label: '高频互动', tooltip: '近30天已记录你回复TA 12 次（含导入）' }
        }
      ]
    }
  };
  const accB = {
    actorUserId: '2002',
    accountGeneration: 1,
    handle: 'bob',
    summary: { totalReplies: 3, activeTargetsCount: 0, deepTargetsCount: 0, latestReplyAt: NOW_MS - 2000, top20: [] }
  };

  let clearAllShouldSucceed = false;
  let historySync = {
    id: 'job_s',
    handle: 'alice',
    status: 'running',
    mode: 'search',
    searchQuery: 'from:alice filter:replies since:2026-11-15 until:2026-11-16',
    pages: 3,
    added: 5,
    duplicates: 1,
    deadline: Date.now() + 240000
  };
  let previewCalled = false;
  const snapshotCalls = [];

  const runtime = {
    async sendMessage(msg) {
      if (msg.type === 'GET_POPUP_SNAPSHOT') {
        snapshotCalls.push(msg);
        const sel = msg.preferredActorUserId === '2002' ? accB : accA;
        return {
          ok: true,
          debugLogsEnabled: false,
          viewerStatus: 'bound',
          activeTabActorUserId: '1001',
          confirmedTabActorUserId: '1001',
          settings: { collectionEnabled: true },
          selectedAccount: sel,
          savedAccounts: [accA, accB],
          historySync,
          historyNextStart: 0
        };
      }
      if (msg.type === 'SET_POPUP_ACCOUNT') {
        return { ok: true, saved: true, manualTabActorUserId: msg.actorUserId };
      }
      if (msg.type === 'PREVIEW_IMPORT') {
        previewCalled = true;
        return { ok: true };
      }
      if (msg.type === 'CLEAR_ALL') {
        return clearAllShouldSucceed ? { ok: true } : { ok: false, message: '存储繁忙，清空失败' };
      }
      return { ok: true };
    }
  };

  const ui = createPopupController({ document: doc, runtime });
  await ui.init();

  // 1. Top-20 tier pill flame core radius stays bounded inside outer flame valleys (< 8.5)
  const pillCore = byId.get('top20-list').findAllByTag('circle').find((c) => c.getAttribute('class') === 'sparklink-fire-core');
  assert.ok(pillCore);
  assert.ok(Number(pillCore.getAttribute('r')) <= 8.5, 'Popup flame core radius must not bleed past outer valleys');

  // 2. Running and completed search status strings reflect multi-page daily search (no stale "首批")
  const runningSearchText = byId.get('history-sync-status').textContent;
  assert.equal(runningSearchText.includes('2026-11-15'), true);
  assert.equal(runningSearchText.includes('首批'), false);
  historySync = { ...historySync, status: 'done', reason: 'searched' };
  await ui.refresh();
  const doneSearchText = byId.get('history-sync-status').textContent;
  assert.equal(doneSearchText.includes('首批'), false);

  // 3. Unreadable file in #file-import change handler catches rejection and shows deterministic feedback
  byId.get('file-import').files = [
    {
      name: 'unreadable.json',
      size: 128,
      async text() {
        throw new Error('NotReadableError: The requested file could not be read');
      }
    }
  ];
  await byId.get('file-import').trigger('change');
  assert.equal(previewCalled, false);
  assert.match(byId.get('action-feedback').textContent, /读取备份文件失败/);

  // 4. Failed CLEAR_ALL preserves explicit account selection ('2002'), while successful CLEAR_ALL resets it
  byId.get('account-select').value = '2002';
  await byId.get('account-select').trigger('change');
  assert.equal(snapshotCalls.at(-1).preferredActorUserId, '2002');

  await byId.get('btn-clear-all').trigger('click');
  await byId.get('btn-modal-confirm').trigger('click');
  assert.match(byId.get('action-feedback').textContent, /存储繁忙/);
  assert.equal(snapshotCalls.at(-1).preferredActorUserId, '2002', 'Failed CLEAR_ALL must not wipe userSelectedActorId');

  clearAllShouldSucceed = true;
  await byId.get('btn-clear-all').trigger('click');
  await byId.get('btn-modal-confirm').trigger('click');
  assert.equal(snapshotCalls.at(-1).preferredActorUserId ?? null, null, 'Successful CLEAR_ALL resets userSelectedActorId');
});

test('Popup refresh timer honors 5-minute idleDeadline / nextTimeoutAt instead of waiting 20-minute hard deadline', async (t) => {
  const { doc } = createFakePopupDom();
  const baseNow = Date.now();
  const snap = {
    ok: true,
    debugLogsEnabled: false,
    viewerStatus: 'bound',
    activeTabActorUserId: '42',
    settings: { collectionEnabled: true },
    selectedAccount: { actorUserId: '42', handle: 'alice', summary: { top20: [] } },
    savedAccounts: [{ actorUserId: '42', handle: 'alice', summary: { top20: [] } }],
    historyNextStart: 0,
    historySync: {
      id: 'job_idle_timer',
      handle: 'alice',
      status: 'running',
      mode: 'timeline',
      pages: 1,
      added: 1,
      duplicates: 0,
      deadline: baseNow + 20 * 60000,
      idleDeadline: baseNow + 5 * 60000,
      nextTimeoutAt: baseNow + 5 * 60000
    }
  };
  const scheduledDelays = [];
  const origSetTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, delay, ...rest) => {
    scheduledDelays.push(delay);
    return origSetTimeout(fn, delay, ...rest);
  });

  const runtime = {
    async sendMessage(msg) {
      if (msg.type === 'GET_POPUP_SNAPSHOT') return snap;
      return { ok: true };
    }
  };

  const ui = createPopupController({ document: doc, runtime });
  await ui.init();

  assert.equal(scheduledDelays.length > 0, true);
  const timerDelay = scheduledDelays.at(-1);
  assert.ok(timerDelay <= 5 * 60000 + 500, `Expected delay <= 300500ms, got ${timerDelay}`);
  assert.ok(timerDelay >= 4 * 60000, `Expected delay around 5 minutes, got ${timerDelay}`);

  snap.historySync = { ...snap.historySync, status: 'done', reason: 'end' };
  await ui.refresh();
});

test('Popup stat threshold labels render from metrics TIER_THRESHOLDS and exist in popup.html', async () => {
  const popupHtml = fs.readFileSync(path.join(process.cwd(), 'src', 'popup', 'popup.html'), 'utf8');
  assert.ok(popupHtml.includes('id="stat-active-label"'), 'popup.html must define #stat-active-label');
  assert.ok(popupHtml.includes('id="stat-deep-label"'), 'popup.html must define #stat-deep-label');

  const { TIER_THRESHOLDS } = await import('../src/metrics.js');
  const { doc, byId } = createFakePopupDom();
  const runtime = {
    async sendMessage(msg) {
      if (msg.type === 'GET_POPUP_SNAPSHOT') {
        return {
          ok: true,
          debugLogsEnabled: false,
          viewerStatus: 'unbound',
          settings: { collectionEnabled: false },
          selectedAccount: null,
          savedAccounts: [],
          historyNextStart: 0
        };
      }
      return { ok: true };
    }
  };
  const ui = createPopupController({ document: doc, runtime });
  await ui.init();
  assert.equal(byId.get('stat-active-label').textContent, `活跃对象 (≥${TIER_THRESHOLDS.activeMin})`);
  assert.equal(byId.get('stat-deep-label').textContent, `深度对象 (≥${TIER_THRESHOLDS.deepMin})`);
});



