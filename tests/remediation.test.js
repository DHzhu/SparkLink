import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

import { createBackgroundService } from '../src/background.js';
import { createPopupController } from '../src/popup/popup.js';
import { MAX_IMPORT_FILE_BYTES, STATE_STORAGE_KEY } from '../src/schema.js';

const require = createRequire(import.meta.url);
const adapterApi = require('../src/x-adapter.js');
const { installMainInterceptor } = require('../src/interceptor.js');
const { installIsolatedBridge } = require('../src/bridge.js');
const { installContentBadges } = require('../src/content.js');
const viewerFixtures = require('./fixtures/viewer-states.json');
const createTweetFixtures = require('./fixtures/create-tweet.json');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i];
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function verifyPngBuffer(buf, expectedSize) {
  assert.ok(buf.length > 33, 'PNG buffer must contain header and chunks');
  assert.equal(buf.subarray(0, 8).equals(PNG_SIGNATURE), true, 'Valid PNG magic signature');

  let offset = 8;
  let sawIhdr = false;
  let sawIdat = false;
  let sawIend = false;
  const idatParts = [];

  while (offset < buf.length) {
    assert.ok(offset + 8 <= buf.length, 'Chunk header within bounds');
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    assert.ok(dataEnd + 4 <= buf.length, `Chunk ${type} payload within bounds`);

    const chunkData = buf.subarray(dataStart, dataEnd);
    const expectedCrc = buf.readUInt32BE(dataEnd);
    const actualCrc = crc32(buf.subarray(offset + 4, dataEnd));
    assert.equal(actualCrc, expectedCrc, `Valid CRC32 for PNG chunk ${type}`);

    if (type === 'IHDR') {
      sawIhdr = true;
      assert.equal(length, 13);
      const width = chunkData.readUInt32BE(0);
      const height = chunkData.readUInt32BE(4);
      const bitDepth = chunkData[8];
      const colorType = chunkData[9];
      assert.equal(width, expectedSize);
      assert.equal(height, expectedSize);
      assert.equal(bitDepth, 8);
      assert.equal(colorType, 6); // RGBA
    } else if (type === 'IDAT') {
      sawIdat = true;
      idatParts.push(chunkData);
    } else if (type === 'IEND') {
      sawIend = true;
      assert.equal(length, 0);
    }

    offset = dataEnd + 4;
  }

  assert.equal(sawIhdr && sawIdat && sawIend, true, 'PNG must contain IHDR, IDAT, and IEND');
  const rawScanlines = zlib.inflateSync(Buffer.concat(idatParts));
  // Each row has 1 filter byte + width * 4 RGBA bytes
  assert.equal(rawScanlines.length, expectedSize * (1 + expectedSize * 4));
}

test('[P0] Unpacked extension package integrity: every manifest.json file exists on disk and all 4 brand PNG icons decode cleanly with exact dimensions', () => {
  const rootDir = path.resolve('.');
  const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'manifest.json'), 'utf8'));

  // 1. Background service worker & Popup HTML + linked CSS/JS
  const requiredFiles = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    'src/popup/popup.css',
    'src/popup/popup.js'
  ];

  // 2. Content scripts JS & CSS
  for (const cs of manifest.content_scripts) {
    for (const jsFile of cs.js || []) {
      requiredFiles.push(jsFile);
    }
    for (const cssFile of cs.css || []) {
      requiredFiles.push(cssFile);
    }
  }

  for (const relPath of requiredFiles) {
    const abs = path.join(rootDir, relPath);
    assert.equal(fs.existsSync(abs), true, `Referenced manifest asset must exist: ${relPath}`);
    assert.ok(fs.statSync(abs).size > 0, `Referenced manifest asset must be non-empty: ${relPath}`);
  }

  // 3. Icons & action.default_icon (16, 32, 48, 128)
  for (const sizeKey of ['16', '32', '48', '128']) {
    const iconRel = manifest.icons[sizeKey];
    const actionIconRel = manifest.action.default_icon[sizeKey];
    assert.equal(iconRel, `icons/icon${sizeKey}.png`);
    assert.equal(actionIconRel, iconRel);

    const iconAbs = path.join(rootDir, iconRel);
    assert.equal(fs.existsSync(iconAbs), true, `Missing required brand icon: ${iconRel}`);
    const pngBuf = fs.readFileSync(iconAbs);
    verifyPngBuffer(pngBuf, Number(sizeKey));
  }
});

test(
  '[P0] Real Chromium unpacked extension loading: registers MV3 Service Worker and boots Popup without load errors',
  { skip: !(fs.existsSync('/usr/bin/chromium') && fs.existsSync('/usr/bin/xvfb-run')) },
  async () => {
    const rootDir = path.resolve('.');
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparklink-chromium-load-'));
    let stderrLog = '';

    const child = spawn(
      '/usr/bin/xvfb-run',
      [
        '-a',
        '/usr/bin/chromium',
        '--enable-logging=stderr',
        '--v=0',
        '--remote-debugging-port=0',
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${profileDir}`,
        `--load-extension=${rootDir}`,
        'about:blank'
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], detached: true }
    );

    child.stderr.on('data', (chunk) => {
      stderrLog += chunk.toString('utf8');
    });

    try {
      const portFile = path.join(profileDir, 'DevToolsActivePort');
      let port = null;
      const deadline = Date.now() + 12000;

      while (Date.now() < deadline) {
        if (fs.existsSync(portFile)) {
          const lines = fs.readFileSync(portFile, 'utf8').trim().split('\n');
          if (lines[0] && /^\d+$/.test(lines[0].trim())) {
            port = Number(lines[0].trim());
            break;
          }
        }
        await new Promise((r) => setTimeout(r, 150));
      }

      assert.ok(port, `Chromium DevToolsActivePort must initialize (stderr: ${stderrLog.slice(0, 400)})`);

      // Poll /json until SparkLink MV3 Service Worker target appears
      let swTarget = null;
      const swDeadline = Date.now() + 8000;
      while (Date.now() < swDeadline) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/json`);
          if (res.ok) {
            const targets = await res.json();
            swTarget = targets.find(
              (t) =>
                t.type === 'service_worker' &&
                typeof t.url === 'string' &&
                t.url.endsWith('/src/background.js')
            );
            if (swTarget) {
              break;
            }
          }
        } catch (_ignore) {
          // Wait for HTTP listener
        }
        await new Promise((r) => setTimeout(r, 150));
      }

      assert.equal(
        /Failed to load extension|Could not load icon/i.test(stderrLog),
        false,
        `Chromium reported extension load error: ${stderrLog}`
      );
      assert.ok(swTarget, 'SparkLink MV3 background Service Worker must register in real Chromium');
    } finally {
      child.stderr.destroy();
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch (_ignore) {
        // Group already gone
      }
      await new Promise((r) => setTimeout(r, 150));
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (_ignore) {
        // Group already gone
      }
      fs.rmSync(profileDir, { recursive: true, force: true });
    }
  }
);

function createMockArea(initial = {}) {
  let store = structuredClone(initial);
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
    },
    peek() {
      return structuredClone(store);
    }
  };
}

test('[P1] Pause -> switch A to B on same page -> resume invalidates previous session viewer cache, binds B, shows B in Popup, and records B reply (+1)', async () => {
  const NOW_MS = 1794794402000;
  const EXT_ID = 'sparklink_remed_p1';
  const POPUP_SENDER = { id: EXT_ID, url: `chrome-extension://${EXT_ID}/src/popup/popup.html` };
  const tabSender = {
    id: EXT_ID,
    tab: { id: 42, active: true },
    frameId: 0,
    documentId: 'doc_42',
    origin: 'https://x.com',
    url: 'https://x.com/home'
  };

  const localArea = createMockArea();
  const sessionArea = createMockArea();
  const tabListeners = new Set();

  const bg = createBackgroundService(
    {
      storage: { local: localArea, session: sessionArea },
      runtime: {
        id: EXT_ID,
        getURL: (p) => `chrome-extension://${EXT_ID}/${p.replace(/^\//, '')}`,
        onMessage: { addListener() {} }
      },
      tabs: {
        async query() {
          return [{ id: 42, active: true }];
        },
        async sendMessage(_tabId, msg) {
          for (const fn of tabListeners) fn(msg, { id: EXT_ID });
        },
        onRemoved: { addListener() {} }
      }
    },
    { nowFn: () => NOW_MS }
  );

  const winListeners = new Map();
  let currentViewerGraphqlPayload = viewerFixtures.viewerGraphqlModern; // Account A (1001001)

  const replyByB = structuredClone(createTweetFixtures.standardReply.response);
  replyByB.data.create_tweet.tweet_results.result.rest_id = '2122147641553888888';
  replyByB.data.create_tweet.tweet_results.result.legacy.id_str = '2122147641553888888';
  replyByB.data.create_tweet.tweet_results.result.core.user_results.result.rest_id = '9009009';
  replyByB.data.create_tweet.tweet_results.result.core.user_results.result.core.screen_name = 'second_account';
  replyByB.data.create_tweet.tweet_results.result.legacy.user_id_str = '9009009';

  let currentSwitcherEl = null;
  const fakeWin = {
    location: { origin: 'https://x.com', href: 'https://x.com/home' },
    document: {
      visibilityState: 'visible',
      addEventListener() {},
      removeEventListener() {},
      querySelector: (sel) =>
        sel === '[data-testid="SideNav_AccountSwitcher_Button"]' ? currentSwitcherEl : null,
      querySelectorAll: () => []
    },
    __INITIAL_STATE__: viewerFixtures.loggedOutInitialState,
    fetch(url) {
      if (String(url).includes('Viewer')) {
        return Promise.resolve(
          new Response(JSON.stringify(currentViewerGraphqlPayload), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
        );
      }
      if (String(url).includes('CreateTweet')) {
        return Promise.resolve(
          new Response(JSON.stringify(replyByB), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
        );
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    },
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, new Set());
      winListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      if (winListeners.has(type)) winListeners.get(type).delete(fn);
    },
    postMessage(data, origin) {
      queueMicrotask(() => {
        const set = winListeners.get('message');
        if (set) {
          for (const fn of set) fn({ data, origin, source: fakeWin });
        }
      });
    }
  };
  fakeWin.top = fakeWin;

  const pageChrome = {
    runtime: {
      id: EXT_ID,
      sendMessage: (msg) => bg.handleMessage(msg, tabSender),
      onMessage: {
        addListener(fn) {
          tabListeners.add(fn);
        },
        removeListener(fn) {
          tabListeners.delete(fn);
        }
      }
    }
  };

  // 1. Session 1: Enable collection & recognize Account A (1001001) via Viewer GraphQL (caches latestGraphqlViewer = A)
  await bg.handleMessage({ type: 'SET_COLLECTION_ENABLED', enabled: true }, POPUP_SENDER);
  installMainInterceptor(fakeWin, adapterApi, { nowFn: () => NOW_MS });
  const bridge = installIsolatedBridge(fakeWin, pageChrome, { nowFn: () => NOW_MS, retryDelayMs: 5 });
  await new Promise((r) => setTimeout(r, 30));

  await fakeWin.fetch('https://x.com/i/api/graphql/ViewerQid/Viewer');
  await new Promise((r) => setTimeout(r, 35));
  assert.equal(bridge.getBindingContext().actorUserId, '1001001');

  // 2. Pause collection, switch page state to Account B (9009009) while paused, then resume!
  await bg.handleMessage({ type: 'SET_COLLECTION_ENABLED', enabled: false }, POPUP_SENDER);
  await new Promise((r) => setTimeout(r, 25));

  fakeWin.__INITIAL_STATE__ = {
    session: { user_id: '9009009' },
    entities: {
      users: {
        entities: {
          '9009009': { id_str: '9009009', screen_name: 'second_account', name: '第二账号' }
        }
      }
    }
  };
  currentSwitcherEl = {
    tagName: 'BUTTON',
    textContent: '@second_account',
    childNodes: [{ nodeType: 3, nodeValue: '@second_account' }]
  };

  await bg.handleMessage({ type: 'SET_COLLECTION_ENABLED', enabled: true }, POPUP_SENDER);
  await new Promise((r) => setTimeout(r, 40));

  // Popup MUST show Account B (9009009), NOT cached Account A (1001001)!
  const popupSnap = await bg.handleMessage({ type: 'GET_POPUP_SNAPSHOT' }, POPUP_SENDER);
  assert.equal(popupSnap.activeTabActorUserId, '9009009');
  assert.equal(popupSnap.selectedAccount.actorUserId, '9009009');

  // Account B sends 1 reply -> MUST record +1 for Account B!
  await fakeWin.fetch('https://x.com/i/api/graphql/ReplyQid/CreateTweet', {
    method: 'POST',
    body: JSON.stringify(createTweetFixtures.standardReply.requestBody)
  });
  await new Promise((r) => setTimeout(r, 40));

  const snapAfterReply = await bg.handleMessage({ type: 'GET_POPUP_SNAPSHOT' }, POPUP_SENDER);
  assert.equal(snapAfterReply.selectedAccount.actorUserId, '9009009');
  assert.equal(snapAfterReply.selectedAccount.summary.totalReplies, 1);

  bridge.destroy();
});

test('[P1] 20,000-reply state (~5.92 MiB) exported via Popup stays under 9 MiB and roundtrips cleanly through PREVIEW_IMPORT + COMMIT_IMPORT', async () => {
  const NOW_MS = 1794794402000;
  const EXT_ID = 'sparklink_remed_20k';
  const POPUP_SENDER = { id: EXT_ID, url: `chrome-extension://${EXT_ID}/src/popup/popup.html` };

  const replies = {};
  const users = {};
  for (let i = 0; i < 20000; i += 1) {
    const rid = String(2122147641550000000n + BigInt(i));
    const pid = String(2121785253680000000n + BigInt(i));
    const tid = String(2002000000n + BigInt(i));
    replies[rid] = {
      replyTweetId: rid,
      parentTweetId: pid,
      targetUserId: tid,
      createdAt: NOW_MS - 100000 + i,
      observedAt: NOW_MS - 50000 + i,
      source: 'live'
    };
    users[tid] = {
      handle: `friend_handle_${i}`,
      displayName: `示例互动好友_${i}`,
      updatedAt: NOW_MS
    };
  }

  const initialState = {
    [STATE_STORAGE_KEY]: {
      schemaVersion: 2,
      revision: 10,
      collectionGeneration: 1,
      settings: { collectionEnabled: false, captureSessionId: null },
      accounts: {
        '1001001': {
          accountGeneration: 2,
          handle: 'sample_me',
          displayName: '示例账号',
          lastCleanupAt: NOW_MS,
          users,
          replies
        }
      }
    }
  };

  const localBytes = Buffer.byteLength(JSON.stringify(initialState), 'utf8');
  assert.ok(localBytes > 5 * 1024 * 1024 && localBytes < 8 * 1024 * 1024);

  const localArea = createMockArea(initialState);
  const sessionArea = createMockArea();
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

  // Minimal Popup DOM harness to capture exact Blob generated by Popup export
  const nodes = new Map();
  const makeNode = (id) => {
    const listeners = new Map();
    const n = {
      id,
      hidden: false,
      disabled: false,
      checked: false,
      value: '',
      textContent: '',
      children: [],
      setAttribute() {},
      appendChild(c) { this.children.push(c); return c; },
      replaceChildren(...cs) { this.children = cs; },
      click() {},
      remove() {},
      addEventListener(t, fn) {
        if (!listeners.has(t)) listeners.set(t, []);
        listeners.get(t).push(fn);
      },
      async trigger(t) {
        for (const fn of listeners.get(t) || []) await fn({ target: n });
      }
    };
    nodes.set(id, n);
    return n;
  };
  for (const id of [
    'collection-toggle', 'btn-enable-cta', 'initial-activation-banner', 'account-select',
    'viewer-status-badge', 'status-banners', 'overview-title', 'overview-coverage',
    'latest-reply-time', 'stat-total-replies', 'stat-active-targets', 'stat-deep-targets',
    'top20-list', 'top20-empty', 'btn-cleanup', 'btn-export', 'btn-import', 'file-import',
    'btn-clear-account', 'btn-clear-all', 'action-feedback', 'modal-overlay', 'modal-title',
    'modal-body', 'btn-modal-confirm', 'btn-modal-cancel'
  ]) {
    makeNode(id);
  }

  let capturedBlob = null;
  const doc = {
    body: makeNode('body'),
    getElementById: (id) => nodes.get(id) || null,
    createElement: (tag) => makeNode(tag),
    createElementNS: (_ns, tag) => makeNode(tag)
  };
  const popup = createPopupController({
    document: doc,
    runtime: { sendMessage: (m) => bg.handleMessage(m, POPUP_SENDER) },
    urlApi: {
      createObjectURL(blob) {
        capturedBlob = blob;
        return 'blob:ext/20k';
      },
      revokeObjectURL() {}
    }
  });
  await popup.init();

  await nodes.get('btn-export').trigger('click');
  await nodes.get('btn-modal-confirm').trigger('click');
  assert.ok(capturedBlob, 'Popup must produce a backup Blob');

  const exportedJsonText = await capturedBlob.text();
  const exportedBytes = Buffer.byteLength(exportedJsonText, 'utf8');
  assert.ok(
    exportedBytes <= MAX_IMPORT_FILE_BYTES,
    `Exported backup (${exportedBytes} bytes) must not exceed MAX_IMPORT_FILE_BYTES (${MAX_IMPORT_FILE_BYTES})`
  );

  // Clear All and re-import the exact exported JSON text -> must restore all 20,000 replies!
  await bg.handleMessage({ type: 'CLEAR_ALL' }, POPUP_SENDER);
  const previewRes = await bg.handleMessage(
    { type: 'PREVIEW_IMPORT', rawText: exportedJsonText },
    POPUP_SENDER
  );
  assert.equal(previewRes.ok, true, `Import preview failed: ${previewRes.code || previewRes.message}`);
  assert.equal(previewRes.preview.added, 20000);

  const commitRes = await bg.handleMessage(
    { type: 'COMMIT_IMPORT', rawText: exportedJsonText, baseline: previewRes.baseline },
    POPUP_SENDER
  );
  assert.equal(commitRes.ok, true);
  assert.equal(commitRes.added, 20000);
});

function createPopupDomHarness() {
  const nodes = new Map();
  const makeNode = (id) => {
    const listeners = new Map();
    const n = {
      id,
      className: '',
      hidden: false,
      disabled: false,
      checked: false,
      value: '',
      _text: '',
      children: [],
      get textContent() {
        if (this.children.length === 0) return this._text;
        return this.children.map((c) => c.textContent).join('');
      },
      set textContent(val) {
        this.children = [];
        this._text = String(val);
      },
      setAttribute() {},
      appendChild(c) {
        this.children.push(c);
        return c;
      },
      replaceChildren(...cs) {
        this.children = cs;
      },
      click() {},
      remove() {},
      addEventListener(t, fn) {
        if (!listeners.has(t)) listeners.set(t, []);
        listeners.get(t).push(fn);
      },
      async trigger(t) {
        for (const fn of listeners.get(t) || []) await fn({ target: n });
      }
    };
    nodes.set(id, n);
    return n;
  };
  for (const id of [
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
    'stat-deep-targets',
    'top20-list',
    'top20-empty',
    'btn-cleanup',
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
  ]) {
    makeNode(id);
  }
  const doc = {
    body: makeNode('body'),
    getElementById: (id) => nodes.get(id) || null,
    createElement: (tag) => makeNode(tag),
    createElementNS: (_ns, tag) => makeNode(tag)
  };
  return { doc, nodes };
}

test('[P2] Popup foreground tab resolution: background bound Tab A never masks unbound foreground X Tab B or non-X foreground Tab C', async () => {
  const NOW_MS = 1794794402000;
  const EXT_ID = 'sparklink_remed_fg_tab';
  const POPUP_SENDER = { id: EXT_ID, url: `chrome-extension://${EXT_ID}/src/popup/popup.html` };

  const localArea = createMockArea();
  const sessionArea = createMockArea();
  let currentForegroundTab = { id: 10, active: true };
  const unloadedTabIds = new Set();

  const bg = createBackgroundService(
    {
      storage: { local: localArea, session: sessionArea },
      runtime: {
        id: EXT_ID,
        getURL: (p) => `chrome-extension://${EXT_ID}/${p.replace(/^\//, '')}`,
        onMessage: { addListener() {} }
      },
      tabs: {
        async query() {
          return currentForegroundTab ? [currentForegroundTab] : [];
        },
        async sendMessage(tabId, msg) {
          if (msg && msg.type === 'PING_X_TAB' && unloadedTabIds.has(tabId)) {
            throw new Error('Could not establish connection. Receiving end does not exist.');
          }
          return { ok: true, alive: true };
        },
        onRemoved: { addListener() {} }
      }
    },
    { nowFn: () => NOW_MS }
  );

  await bg.handleMessage({ type: 'SET_COLLECTION_ENABLED', enabled: true }, POPUP_SENDER);

  // 1. Tab 10 was active when bound to Account A (1001001) and recorded a diagnostic anomaly
  const tab10Sender = {
    id: EXT_ID,
    tab: { id: 10, active: true },
    frameId: 0,
    documentId: 'doc_10',
    origin: 'https://x.com',
    url: 'https://x.com/home'
  };
  const hello10 = await bg.handleMessage({ type: 'HELLO' }, tab10Sender);
  const bind10 = await bg.handleMessage(
    {
      type: 'BIND_VIEWER',
      captureSessionId: hello10.captureSessionId,
      viewer: { actorUserId: '1001001', handle: 'bg_alice', displayName: 'Background Alice' }
    },
    tab10Sender
  );
  await bg.handleMessage(
    {
      type: 'SUBMIT_OBSERVED_BATCH',
      bindingContext: bind10.bindingContext,
      incompleteObservation: true,
      events: []
    },
    tab10Sender
  );

  // 2. User opens Tab 20 in foreground on X (HELLO sent, NOT bound yet) while Tab 10 stays in background
  currentForegroundTab = { id: 20, active: true };
  const tab20Sender = {
    id: EXT_ID,
    tab: { id: 20, active: true },
    frameId: 0,
    documentId: 'doc_20',
    origin: 'https://x.com',
    url: 'https://x.com/i/flow/login'
  };
  await bg.handleMessage({ type: 'HELLO' }, tab20Sender);

  const { doc, nodes } = createPopupDomHarness();
  const popup = createPopupController({
    document: doc,
    runtime: { sendMessage: (m) => bg.handleMessage(m, POPUP_SENDER) }
  });
  const snapUnboundFg = await popup.init();

  assert.equal(snapUnboundFg.viewerStatus, 'unconfirmed');
  assert.equal(snapUnboundFg.activeTabActorUserId, null);
  // Background Tab 10 diagnostics must NOT leak into Tab 20
  assert.equal(snapUnboundFg.diagnostics.incompleteObservation, false);
  assert.equal(nodes.get('viewer-status-badge').textContent, '账号待确认');
  assert.equal(
    nodes.get('account-select').children[0].textContent.includes('(当前页)'),
    false,
    'Background Account A must NOT be marked (当前页)'
  );

  // 3. User switches foreground to Tab 30 (non-X page, never sent HELLO)
  currentForegroundTab = { id: 30, active: true };
  const snapNonXFg = await popup.refresh();
  assert.equal(snapNonXFg.viewerStatus, 'no_x_tab');
  assert.equal(snapNonXFg.activeTabActorUserId, null);
  assert.equal(nodes.get('viewer-status-badge').textContent, '无活动 X 页');

  // 4. User switches foreground back to Tab 10 -> Account A is active and bound again
  currentForegroundTab = { id: 10, active: true };
  const snapBoundFg = await popup.refresh();
  assert.equal(snapBoundFg.viewerStatus, 'bound');
  assert.equal(snapBoundFg.activeTabActorUserId, '1001001');
  assert.equal(snapBoundFg.diagnostics.incompleteObservation, true);
  assert.equal(nodes.get('viewer-status-badge').textContent, '采集中');
  assert.equal(nodes.get('account-select').children[0].textContent, '@bg_alice (当前页)');

  // 5. Same Tab 10 navigates away from X to a non-X site (no "tabs" permission so fgTab.url is omitted, Content Script unreachable)
  unloadedTabIds.add(10);
  const snapNavigatedAway = await popup.refresh();
  assert.equal(snapNavigatedAway.viewerStatus, 'no_x_tab');
  assert.equal(snapNavigatedAway.activeTabActorUserId, null);
  assert.equal(nodes.get('viewer-status-badge').textContent, '无活动 X 页');
});

test('[P2] Storage setAccessLevel(TRUSTED_CONTEXTS) failure blocks collection and Content Script access with retryable ACCESS_LEVEL_INIT_FAILED', async () => {
  const NOW_MS = 1794794402000;
  const EXT_ID = 'sparklink_remed_acl';
  const POPUP_SENDER = { id: EXT_ID, url: `chrome-extension://${EXT_ID}/src/popup/popup.html` };
  const xSender = {
    id: EXT_ID,
    tab: { id: 77, active: true },
    frameId: 0,
    documentId: 'doc_77',
    origin: 'https://x.com',
    url: 'https://x.com/home'
  };

  let failLocal = true;
  let failSession = false;

  const localArea = createMockArea();
  localArea.setAccessLevel = async () => {
    if (failLocal) {
      throw new Error('Simulated storage.local.setAccessLevel failure');
    }
  };

  const sessionArea = createMockArea();
  sessionArea.setAccessLevel = async () => {
    if (failSession) {
      throw new Error('Simulated storage.session.setAccessLevel failure');
    }
  };

  const bg = createBackgroundService(
    {
      storage: { local: localArea, session: sessionArea },
      runtime: {
        id: EXT_ID,
        getURL: (p) => `chrome-extension://${EXT_ID}/${p.replace(/^\//, '')}`,
        onMessage: { addListener() {} }
      },
      tabs: {
        async query() {
          return [{ id: 77, active: true }];
        },
        async sendMessage() {},
        onRemoved: { addListener() {} }
      }
    },
    { nowFn: () => NOW_MS }
  );

  const { doc, nodes } = createPopupDomHarness();
  const popup = createPopupController({
    document: doc,
    runtime: { sendMessage: (m) => bg.handleMessage(m, POPUP_SENDER) }
  });

  // Attempt 1: storage.local.setAccessLevel fails -> snapshot & toggle & Content Script HELLO all blocked
  const snapFail1 = await popup.init();
  assert.equal(snapFail1.ok, false);
  assert.equal(snapFail1.code, 'ACCESS_LEVEL_INIT_FAILED');
  assert.equal(nodes.get('collection-toggle').checked, false);

  const enableFail1 = await bg.handleMessage(
    { type: 'SET_COLLECTION_ENABLED', enabled: true },
    POPUP_SENDER
  );
  assert.equal(enableFail1.ok, false);
  assert.equal(enableFail1.code, 'ACCESS_LEVEL_INIT_FAILED');
  assert.deepEqual(localArea.peek(), {}, 'Must not write collectionEnabled=true before TRUSTED_CONTEXTS succeeds');

  const helloFail1 = await bg.handleMessage({ type: 'HELLO' }, xSender);
  assert.equal(helloFail1.ok, false);
  assert.equal(helloFail1.code, 'ACCESS_LEVEL_INIT_FAILED');

  // Attempt 2: storage.local succeeds, storage.session.setAccessLevel fails -> still blocked
  failLocal = false;
  failSession = true;
  await nodes.get('btn-enable-cta').trigger('click');
  assert.equal(nodes.get('collection-toggle').checked, false);
  assert.ok(nodes.get('action-feedback').textContent.includes('TRUSTED_CONTEXTS'));

  // Attempt 3: transient failure resolved -> retry succeeds without reloading extension!
  failSession = false;
  await nodes.get('btn-enable-cta').trigger('click');
  assert.equal(nodes.get('collection-toggle').checked, true);

  const snapRecovered = await bg.handleMessage({ type: 'GET_POPUP_SNAPSHOT' }, POPUP_SENDER);
  assert.equal(snapRecovered.ok, true);
  assert.equal(snapRecovered.settings.collectionEnabled, true);
});

function makeHtmlCollection(items) {
  const col = { length: items.length, item: (i) => items[i] || null };
  for (let i = 0; i < items.length; i += 1) {
    col[i] = items[i];
  }
  return Object.freeze(col);
}

class BrowserLikeElement {
  constructor(tagName) {
    this.nodeType = 1;
    this.tagName = String(tagName).toUpperCase();
    this.attributes = new Map();
    this._childElements = [];
    this._childNodes = null;
    this.parentNode = null;
    this._text = '';
    this.dataset = new Proxy(
      {},
      {
        get: (_t, prop) => {
          const k = 'data-' + String(prop).replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
          return this.attributes.get(k);
        },
        set: (_t, prop, val) => {
          const k = 'data-' + String(prop).replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
          this.attributes.set(k, String(val));
          return true;
        }
      }
    );
    this.classList = {
      contains: (tok) =>
        (this.attributes.get('class') || '')
          .split(/\s+/)
          .filter(Boolean)
          .includes(tok)
    };
  }

  get children() {
    // Non-Array HTMLCollection just like real Chromium DOM!
    return makeHtmlCollection(this._childElements);
  }

  get childNodes() {
    return this._childNodes ? makeHtmlCollection(this._childNodes) : undefined;
  }

  get className() {
    return this.attributes.get('class') || '';
  }

  set className(val) {
    this.attributes.set('class', String(val));
  }

  get isConnected() {
    let cur = this;
    while (cur.parentNode) cur = cur.parentNode;
    return cur.isRoot === true;
  }

  get textContent() {
    if (this._childElements.length === 0) return this._text;
    return this._childElements.map((c) => c.textContent).join('');
  }

  set textContent(val) {
    this._childElements = [];
    this._text = String(val);
  }

  setAttribute(k, v) {
    this.attributes.set(k, String(v));
  }

  getAttribute(k) {
    return this.attributes.has(k) ? this.attributes.get(k) : null;
  }

  appendChild(child) {
    child.parentNode = this;
    this._childElements.push(child);
    return child;
  }

  remove() {
    if (!this.parentNode) return;
    const idx = this.parentNode._childElements.indexOf(this);
    if (idx !== -1) this.parentNode._childElements.splice(idx, 1);
    this.parentNode = null;
  }

  matches(sel) {
    if (sel === '[data-testid="User-Name"]' || sel === '[data-testid="User-Name"], [data-testid="UserName"]') {
      const tid = this.getAttribute('data-testid');
      return tid === 'User-Name' || tid === 'UserName';
    }
    if (sel === '.sparklink-badge') return this.classList.contains('sparklink-badge');
    if (sel === 'a[href^="/"]') {
      return this.tagName === 'A' && (this.getAttribute('href') || '').startsWith('/');
    }
    if (sel === 'a[href*="/status/"]') {
      return this.tagName === 'A' && (this.getAttribute('href') || '').includes('/status/');
    }
    return false;
  }

  closest(sel) {
    let cur = this;
    while (cur && cur.nodeType === 1) {
      if (cur.matches(sel)) return cur;
      cur = cur.parentNode;
    }
    return null;
  }

  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => {
      for (const c of n._childElements) {
        if (c.matches(sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }

  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
}

test('[P2] Non-Array HTMLCollection DOM @handle validation: rejects <a href="/Alice"> + @Bob conflict and renders badge for linkless @Bob', async () => {
  const root = new BrowserLikeElement('body');
  root.isRoot = true;
  assert.equal(Array.isArray(root.children), false, 'children must be non-Array HTMLCollection');

  // Author block 1: Stale recycled link /alice_user with visible @bob_user text -> MUST reject conflict!
  const conflictHeader = new BrowserLikeElement('div');
  conflictHeader.setAttribute('data-testid', 'User-Name');
  const staleLink = new BrowserLikeElement('a');
  staleLink.setAttribute('href', '/alice_user');
  staleLink.textContent = 'Alice';
  const nestedWrap = new BrowserLikeElement('div');
  const handleSpan = new BrowserLikeElement('span');
  handleSpan.textContent = '@bob_user';
  nestedWrap.appendChild(handleSpan);
  conflictHeader.appendChild(staleLink);
  conflictHeader.appendChild(nestedWrap);
  root.appendChild(conflictHeader);

  // Author block 2: Linkless header with visible @bob_user text -> MUST resolve Bob (2002002) and render badge!
  const linklessHeader = new BrowserLikeElement('div');
  linklessHeader.setAttribute('data-testid', 'User-Name');
  const nameSpan = new BrowserLikeElement('span');
  nameSpan.textContent = 'Bob';
  const linklessHandleWrap = new BrowserLikeElement('div');
  const linklessHandleSpan = new BrowserLikeElement('span');
  const iconChild = new BrowserLikeElement('svg');
  // Exercise mixed element + text childNodes just like X inline icon + @handle spans
  linklessHandleSpan._childElements = [iconChild];
  linklessHandleSpan._childNodes = [iconChild, { nodeType: 3, nodeValue: '@bob_user' }];
  linklessHandleWrap.appendChild(linklessHandleSpan);
  linklessHeader.appendChild(nameSpan);
  linklessHeader.appendChild(linklessHandleWrap);
  root.appendChild(linklessHeader);

  const doc = {
    body: root,
    documentElement: root,
    createElement: (t) => new BrowserLikeElement(t),
    createElementNS: (_ns, t) => new BrowserLikeElement(t),
    querySelectorAll: (s) => root.querySelectorAll(s)
  };
  const win = {
    location: { origin: 'https://x.com' },
    document: doc,
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    requestAnimationFrame(cb) {
      cb();
      return 1;
    },
    cancelAnimationFrame() {}
  };
  win.top = win;

  const binding = {
    bindingId: 'bind_dom_1',
    actorUserId: '1001001',
    captureSessionId: 1,
    collectionGeneration: 1,
    accountGeneration: 1
  };
  const fakeBridge = {
    subscribe() {
      return () => {};
    },
    getBindingContext: () => binding,
    getRevision: () => 3,
    resolveUserIdByHandle(h) {
      const lower = String(h).toLowerCase();
      if (lower === 'alice_user') return '1111111';
      if (lower === 'bob_user') return '2002002';
      return null;
    },
    resolveAuthorByTweetId: () => null,
    async queryCounts(ids) {
      const counts = {};
      for (const id of ids) {
        if (id === '1111111') counts[id] = 9;
        if (id === '2002002') counts[id] = 5;
      }
      return { ok: true, counts, revision: 3 };
    }
  };

  const controller = installContentBadges(win, fakeBridge, {
    debounceMs: 5,
    windowRefreshMs: 60000
  });
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(
    conflictHeader.querySelectorAll('.sparklink-badge').length,
    0,
    'Mismatched <a href="/alice_user"> + @bob_user must NOT render Alice badge'
  );
  const bobBadges = linklessHeader.querySelectorAll('.sparklink-badge');
  assert.equal(bobBadges.length, 1, 'Linkless @bob_user with verified mapping MUST render Bob badge');
  assert.equal(bobBadges[0].dataset.sparklinkUserId, '2002002');
  assert.equal(bobBadges[0].dataset.sparklinkCount, '5');

  controller.destroy();
});

test(
  '[P2] Real Chromium DOM HTMLCollection verification: evaluates src/content.js against genuine Chromium HTMLCollection elements via CDP',
  {
    skip: !(
      fs.existsSync('/usr/bin/chromium') &&
      fs.existsSync('/usr/bin/xvfb-run') &&
      typeof WebSocket === 'function'
    )
  },
  async () => {
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparklink-chromium-dom-'));
    const contentSource = fs.readFileSync(path.resolve('src/content.js'), 'utf8');

    const child = spawn(
      '/usr/bin/xvfb-run',
      [
        '-a',
        '/usr/bin/chromium',
        '--remote-debugging-port=0',
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${profileDir}`,
        'about:blank'
      ],
      { stdio: ['ignore', 'ignore', 'ignore'], detached: true }
    );

    try {
      const portFile = path.join(profileDir, 'DevToolsActivePort');
      let port = null;
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        if (fs.existsSync(portFile)) {
          const lines = fs.readFileSync(portFile, 'utf8').trim().split('\n');
          if (lines[0] && /^\d+$/.test(lines[0].trim())) {
            port = Number(lines[0].trim());
            break;
          }
          }
        await new Promise((r) => setTimeout(r, 150));
      }
      assert.ok(port, 'Chromium DevToolsActivePort must initialize');

      let pageTarget = null;
      const pageDeadline = Date.now() + 6000;
      while (Date.now() < pageDeadline) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/json`);
          if (res.ok) {
            const targets = await res.json();
            pageTarget = targets.find(
              (t) => t.type === 'page' && t.url === 'about:blank' && t.webSocketDebuggerUrl
            );
            if (pageTarget) break;
          }
        } catch (_ignore) {
          // Wait
        }
        await new Promise((r) => setTimeout(r, 120));
      }
      assert.ok(pageTarget, 'Chromium page target must be available');

      const evalExpr = `(async () => {
        const exportsObj = {};
        const module = { exports: exportsObj };
        const fn = new Function('module', 'exports', ${JSON.stringify(contentSource)});
        fn(module, exportsObj);
        const { installContentBadges } = module.exports;

        document.body.replaceChildren();
        const conflictEl = document.createElement('div');
        conflictEl.setAttribute('data-testid', 'User-Name');
        const linkA = document.createElement('a');
        linkA.setAttribute('href', '/alice_real');
        linkA.textContent = 'Alice Real';
        const spanWrap = document.createElement('div');
        const spanB = document.createElement('span');
        spanB.textContent = '@bob_real';
        spanWrap.appendChild(spanB);
        conflictEl.appendChild(linkA);
        conflictEl.appendChild(spanWrap);
        document.body.appendChild(conflictEl);

        const linklessEl = document.createElement('div');
        linklessEl.setAttribute('data-testid', 'User-Name');
        const spanOnly = document.createElement('span');
        spanOnly.textContent = '@bob_real';
        linklessEl.appendChild(spanOnly);
        document.body.appendChild(linklessEl);

        const fakeWin = {
          location: { origin: 'https://x.com' },
          document,
          MutationObserver: class { observe() {} disconnect() {} },
          requestAnimationFrame: (cb) => setTimeout(() => cb(performance.now()), 0),
          cancelAnimationFrame: (id) => clearTimeout(id)
        };
        fakeWin.top = fakeWin;

        const ctrl = installContentBadges(fakeWin, {
          subscribe: () => () => {},
          getBindingContext: () => ({
            bindingId: 'b_real',
            actorUserId: '1001',
            captureSessionId: 1,
            collectionGeneration: 1,
            accountGeneration: 1
          }),
          getRevision: () => 1,
          resolveUserIdByHandle: (h) => {
            if (h === 'alice_real') return '111';
            if (h === 'bob_real') return '222';
            return null;
          },
          resolveAuthorByTweetId: () => null,
          queryCounts: async () => ({
            ok: true,
            revision: 1,
            counts: { '111': 12, '222': 7 }
          })
        }, { debounceMs: 5 });
        await new Promise((r) => setTimeout(r, 40));
        const out = {
          isHtmlCollection: conflictEl.children.constructor.name === 'HTMLCollection' && !Array.isArray(conflictEl.children),
          conflictBadgeCount: conflictEl.querySelectorAll('.sparklink-badge').length,
          linklessBadgeCount: linklessEl.querySelectorAll('.sparklink-badge').length,
          linklessUserId: linklessEl.querySelector('.sparklink-badge')?.dataset.sparklinkUserId || null
        };
        ctrl.destroy();
        return out;
      })()`;

      const cdpResult = await new Promise((resolve, reject) => {
        const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
        const timer = setTimeout(() => {
          ws.close();
          reject(new Error('CDP Runtime.evaluate timed out'));
        }, 8000);
        ws.addEventListener('open', () => {
          ws.send(
            JSON.stringify({
              id: 1,
              method: 'Runtime.evaluate',
              params: { expression: evalExpr, awaitPromise: true, returnByValue: true }
            })
          );
        });
        ws.addEventListener('message', (ev) => {
          const msg = JSON.parse(String(ev.data));
          if (msg.id === 1) {
            clearTimeout(timer);
            ws.close();
            resolve(msg);
          }
        });
        ws.addEventListener('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      const val = cdpResult.result && cdpResult.result.result && cdpResult.result.result.value;
      assert.deepEqual(val, {
        isHtmlCollection: true,
        conflictBadgeCount: 0,
        linklessBadgeCount: 1,
        linklessUserId: '222'
      });
    } finally {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch (_ignore) {}
      await new Promise((r) => setTimeout(r, 150));
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (_ignore) {}
      fs.rmSync(profileDir, { recursive: true, force: true });
    }
  }
);

test('[P2] Schema drift diagnostics: broken CreateTweet reply schema surfaces live-capture anomaly instead of normal collection, distinct from UserTweetsAndReplies history-backfill anomaly', async () => {
  const NOW_MS = 1794794402000;
  const EXT_ID = 'sparklink_remed_schema_drift';
  const POPUP_SENDER = { id: EXT_ID, url: `chrome-extension://${EXT_ID}/src/popup/popup.html` };
  const tabSender = {
    id: EXT_ID,
    tab: { id: 88, active: true },
    frameId: 0,
    documentId: 'doc_88',
    origin: 'https://x.com',
    url: 'https://x.com/home'
  };

  const localArea = createMockArea();
  const sessionArea = createMockArea();
  const tabListeners = new Set();

  const bg = createBackgroundService(
    {
      storage: { local: localArea, session: sessionArea },
      runtime: {
        id: EXT_ID,
        getURL: (p) => `chrome-extension://${EXT_ID}/${p.replace(/^\//, '')}`,
        onMessage: { addListener() {} }
      },
      tabs: {
        async query() {
          return [{ id: 88, active: true }];
        },
        async sendMessage(_tabId, msg) {
          if (msg && msg.type === 'PING_X_TAB') return { ok: true, alive: true };
          for (const fn of tabListeners) fn(msg, { id: EXT_ID });
          return undefined;
        },
        onRemoved: { addListener() {} }
      }
    },
    { nowFn: () => NOW_MS }
  );

  let nextTimelinePayload = {
    data: {
      user: {
        result: {
          __typename: 'User',
          rest_id: '1001001',
          // Renamed timeline_v2 -> timeline_v3_drifted so instructions cannot be recognized!
          timeline_v3_drifted: { steps: [] }
        }
      }
    }
  };
  let nextCreateTweetPayload = {
    data: {
      // Renamed create_tweet -> create_post_v2 so reply entity cannot be recognized!
      create_post_v2: {
        post_results: { id: '2122147641553899999' }
      }
    }
  };

  const winListeners = new Map();
  const fakeWin = {
    location: { origin: 'https://x.com', href: 'https://x.com/home' },
    document: {
      visibilityState: 'visible',
      addEventListener() {},
      removeEventListener() {},
      querySelectorAll: () => []
    },
    __INITIAL_STATE__: viewerFixtures.ownProfileInitialState,
    fetch(url) {
      if (String(url).includes('UserTweetsAndReplies')) {
        return Promise.resolve(
          new Response(JSON.stringify(nextTimelinePayload), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
        );
      }
      if (String(url).includes('CreateTweet')) {
        return Promise.resolve(
          new Response(JSON.stringify(nextCreateTweetPayload), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
        );
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    },
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, new Set());
      winListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      if (winListeners.has(type)) winListeners.get(type).delete(fn);
    },
    postMessage(data, origin) {
      queueMicrotask(() => {
        const set = winListeners.get('message');
        if (set) {
          for (const fn of set) fn({ data, origin, source: fakeWin });
        }
      });
    }
  };
  fakeWin.top = fakeWin;

  const pageChrome = {
    runtime: {
      id: EXT_ID,
      sendMessage: (msg) => bg.handleMessage(msg, tabSender),
      onMessage: {
        addListener(fn) {
          tabListeners.add(fn);
        },
        removeListener(fn) {
          tabListeners.delete(fn);
        }
      }
    }
  };

  await bg.handleMessage({ type: 'SET_COLLECTION_ENABLED', enabled: true }, POPUP_SENDER);
  installMainInterceptor(fakeWin, adapterApi, { nowFn: () => NOW_MS });
  const bridge = installIsolatedBridge(fakeWin, pageChrome, { nowFn: () => NOW_MS, retryDelayMs: 5 });
  await new Promise((r) => setTimeout(r, 40));

  const { doc, nodes } = createPopupDomHarness();
  const popup = createPopupController({
    document: doc,
    runtime: { sendMessage: (m) => bg.handleMessage(m, POPUP_SENDER) }
  });
  await popup.init();
  assert.equal(nodes.get('viewer-status-badge').textContent, '采集中');

  // 1. UserTweetsAndReplies returns drifted 200 JSON -> surfaces history-backfill anomaly only!
  await fakeWin.fetch('https://x.com/i/api/graphql/HistQid/UserTweetsAndReplies');
  await new Promise((r) => setTimeout(r, 40));
  const snapHistoryDrift = await popup.refresh();
  assert.equal(snapHistoryDrift.diagnostics.historyBackfillAnomaly, true);
  assert.equal(snapHistoryDrift.diagnostics.liveCaptureAnomaly, false);
  assert.equal(nodes.get('viewer-status-badge').textContent, '历史补录受限');
  assert.ok(
    nodes.get('status-banners').textContent.includes('历史补录暂不可用，仍可记录新回复和导入备份')
  );

  // 2. HTTP 200 GraphQL business error on CreateTweet (e.g. duplicate 187) must NOT trigger live schema-drift anomaly
  nextCreateTweetPayload = createTweetFixtures.graphqlBusinessError.response;
  await fakeWin.fetch('https://x.com/i/api/graphql/ReplyQid/CreateTweet', {
    method: 'POST',
    body: JSON.stringify(createTweetFixtures.standardReply.requestBody)
  });
  await new Promise((r) => setTimeout(r, 35));
  const snapAfterBizErr = await popup.refresh();
  assert.equal(snapAfterBizErr.diagnostics.liveCaptureAnomaly, false);

  // 3. Real schema drift on CreateTweet reply (HTTP 200 without errors, renamed create_tweet / missing reply fields)
  nextCreateTweetPayload = {
    data: {
      create_post_v2: {
        post_results: { id: '2122147641553899999' }
      }
    }
  };
  await fakeWin.fetch('https://x.com/i/api/graphql/ReplyQid/CreateTweet', {
    method: 'POST',
    body: JSON.stringify(createTweetFixtures.standardReply.requestBody)
  });
  await new Promise((r) => setTimeout(r, 40));

  const snapLiveDrift = await popup.refresh();
  assert.equal(snapLiveDrift.diagnostics.liveCaptureAnomaly, true);
  assert.equal(snapLiveDrift.diagnostics.historyBackfillAnomaly, true);
  assert.notEqual(
    nodes.get('viewer-status-badge').textContent,
    '采集中',
    'Popup must NOT display normal 采集中 when live CreateTweet reply schema fails'
  );
  assert.equal(nodes.get('viewer-status-badge').textContent, '实时采集异常');
  assert.ok(nodes.get('status-banners').textContent.includes('实时回复响应结构无法识别'));

  // 4. Direct unit checks on additional CreateTweet & UserTweetsAndReplies field-level drift branches
  const directEngine = adapterApi.createAdapterEngine();
  const sampleBind = bridge.getBindingContext();
  const replyMeta = { expectedParentTweetId: '2121785253688246272', isReplyCandidate: true };

  // Missing rest_id inside tweet_results
  const driftNoId = directEngine.processCreateTweetResponse({
    payload: { data: { create_tweet: { tweet_results: { result: { __typename: 'Tweet' } } } } },
    requestMeta: replyMeta,
    bindingContext: sampleBind,
    observedAt: NOW_MS
  });
  assert.deepEqual(driftNoId.anomalies, ['unrecognized_reply_schema']);
  assert.equal(driftNoId.incompleteObservation, true);

  // Reply candidate missing parentTweetId in response
  const driftNoParent = directEngine.processCreateTweetResponse({
    payload: createTweetFixtures.plainPost.response,
    requestMeta: replyMeta,
    bindingContext: sampleBind,
    observedAt: NOW_MS
  });
  assert.deepEqual(driftNoParent.anomalies, ['unrecognized_reply_schema']);
  assert.equal(driftNoParent.incompleteObservation, true);

  // Reply candidate missing authorUserId in response
  const noAuthorPayload = structuredClone(createTweetFixtures.standardReply.response);
  delete noAuthorPayload.data.create_tweet.tweet_results.result.core;
  delete noAuthorPayload.data.create_tweet.tweet_results.result.legacy.user_id_str;
  const driftNoAuthor = directEngine.processCreateTweetResponse({
    payload: noAuthorPayload,
    requestMeta: replyMeta,
    bindingContext: sampleBind,
    observedAt: NOW_MS
  });
  assert.deepEqual(driftNoAuthor.anomalies, ['unrecognized_reply_schema']);
  assert.equal(driftNoAuthor.incompleteObservation, true);

  // Timeline entry with unrecognized tweet item structure vs normal TweetTombstone
  const timelineItemDrift = directEngine.processTimelineResponse({
    operationName: 'UserTweetsAndReplies',
    payload: {
      data: {
        user: {
          result: {
            __typename: 'User',
            rest_id: sampleBind.actorUserId,
            timeline_v2: {
              timeline: {
                instructions: [
                  {
                    type: 'TimelineAddEntries',
                    entries: [
                      {
                        entryId: 'tomb-1',
                        content: {
                          itemContent: {
                            tweet_results: { result: { __typename: 'TweetTombstone' } }
                          }
                        }
                      },
                      {
                        entryId: 'drifted-tweet-1',
                        content: {
                          itemContent: {
                            tweet_results: { result: { __typename: 'Tweet', id_renamed: '999' } }
                          }
                        }
                      }
                    ]
                  }
                ]
              }
            }
          }
        }
      }
    },
    bindingContext: sampleBind,
    observedAt: NOW_MS
  });
  assert.equal(timelineItemDrift.partialUnrecognized, true);
  assert.ok(timelineItemDrift.anomalies.includes('unrecognized_timeline_tweet_schema'));

  bridge.destroy();
});

test('[P1] Pause -> SPA switch A to B while initial A window.__INITIAL_STATE__ snapshot stays unchanged -> resume stays unconfirmed (never rebinding stale A) until fresh B viewer evidence arrives', async () => {
  const NOW_MS = 1794794402000;
  const EXT_ID = 'sparklink_remed_stale_snap';
  const POPUP_SENDER = { id: EXT_ID, url: `chrome-extension://${EXT_ID}/src/popup/popup.html` };
  const tabSender = {
    id: EXT_ID,
    tab: { id: 91, active: true },
    frameId: 0,
    documentId: 'doc_91',
    origin: 'https://x.com',
    url: 'https://x.com/home'
  };

  const localArea = createMockArea();
  const sessionArea = createMockArea();
  const tabListeners = new Set();

  const bg = createBackgroundService(
    {
      storage: { local: localArea, session: sessionArea },
      runtime: {
        id: EXT_ID,
        getURL: (p) => `chrome-extension://${EXT_ID}/${p.replace(/^\//, '')}`,
        onMessage: { addListener() {} }
      },
      tabs: {
        async query() {
          return [{ id: 91, active: true }];
        },
        async sendMessage(_tabId, msg) {
          if (msg && msg.type === 'PING_X_TAB') return { ok: true, alive: true };
          for (const fn of tabListeners) fn(msg, { id: EXT_ID });
          return undefined;
        },
        onRemoved: { addListener() {} }
      }
    },
    { nowFn: () => NOW_MS }
  );

  let currentViewerGraphqlPayload = viewerFixtures.viewerGraphqlModern; // Account A (1001001)
  const replyByB = structuredClone(createTweetFixtures.standardReply.response);
  replyByB.data.create_tweet.tweet_results.result.rest_id = '2122147641553888901';
  replyByB.data.create_tweet.tweet_results.result.legacy.id_str = '2122147641553888901';
  replyByB.data.create_tweet.tweet_results.result.core.user_results.result.rest_id = '9009009';
  replyByB.data.create_tweet.tweet_results.result.core.user_results.result.core.screen_name = 'second_account';
  replyByB.data.create_tweet.tweet_results.result.legacy.user_id_str = '9009009';

  const winListeners = new Map();
  // Page initially loaded as Account A -> static SSR __INITIAL_STATE__ holds Account A (1001001)
  const fakeWin = {
    location: { origin: 'https://x.com', href: 'https://x.com/home' },
    document: {
      visibilityState: 'visible',
      addEventListener() {},
      removeEventListener() {},
      querySelector: () => null,
      querySelectorAll: () => []
    },
    __INITIAL_STATE__: structuredClone(viewerFixtures.ownProfileInitialState),
    fetch(url) {
      if (String(url).includes('Viewer')) {
        return Promise.resolve(
          new Response(JSON.stringify(currentViewerGraphqlPayload), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
        );
      }
      if (String(url).includes('CreateTweet')) {
        return Promise.resolve(
          new Response(JSON.stringify(replyByB), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
        );
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    },
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, new Set());
      winListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      if (winListeners.has(type)) winListeners.get(type).delete(fn);
    },
    postMessage(data, origin) {
      queueMicrotask(() => {
        const set = winListeners.get('message');
        if (set) {
          for (const fn of set) fn({ data, origin, source: fakeWin });
        }
      });
    }
  };
  fakeWin.top = fakeWin;

  const pageChrome = {
    runtime: {
      id: EXT_ID,
      sendMessage: (msg) => bg.handleMessage(msg, tabSender),
      onMessage: {
        addListener(fn) {
          tabListeners.add(fn);
        },
        removeListener(fn) {
          tabListeners.delete(fn);
        }
      }
    }
  };

  // 1. Enable collection -> binds Account A (1001001) from initial page load
  await bg.handleMessage({ type: 'SET_COLLECTION_ENABLED', enabled: true }, POPUP_SENDER);
  installMainInterceptor(fakeWin, adapterApi, { nowFn: () => NOW_MS });
  const bridge = installIsolatedBridge(fakeWin, pageChrome, { nowFn: () => NOW_MS, retryDelayMs: 5 });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(bridge.getBindingContext().actorUserId, '1001001');

  // 2. Pause collection; user switches A -> B in SPA, while static SSR fakeWin.__INITIAL_STATE__ remains Account A!
  await bg.handleMessage({ type: 'SET_COLLECTION_ENABLED', enabled: false }, POPUP_SENDER);
  await new Promise((r) => setTimeout(r, 25));
  currentViewerGraphqlPayload = viewerFixtures.viewerGraphqlLegacy; // Account B (9009009)
  assert.equal(fakeWin.__INITIAL_STATE__.session.user_id, '1001001');

  // 3. Resume collection -> old snapshot has NOT updated, so tab MUST stay unconfirmed (NOT bound to stale A)!
  await bg.handleMessage({ type: 'SET_COLLECTION_ENABLED', enabled: true }, POPUP_SENDER);
  await new Promise((r) => setTimeout(r, 40));

  assert.equal(
    bridge.getBindingContext(),
    null,
    'Un-updated initial window snapshot must NOT rebind stale Account A after pause'
  );
  const { doc: popupDoc, nodes: popupNodes } = createPopupDomHarness();
  const popup = createPopupController({
    document: popupDoc,
    runtime: { sendMessage: (m) => bg.handleMessage(m, POPUP_SENDER) }
  });
  await popup.init();
  assert.equal(popupNodes.get('viewer-status-badge').textContent, '账号待确认');

  const snapOnResume = await bg.handleMessage({ type: 'GET_POPUP_SNAPSHOT' }, POPUP_SENDER);
  assert.equal(snapOnResume.viewerStatus, 'unconfirmed');
  assert.equal(snapOnResume.activeTabActorUserId, null);

  // 4. Fresh B Viewer response arrives -> confirms Account B and records B's first reply (+1)!
  await fakeWin.fetch('https://x.com/i/api/graphql/ViewerQid/Viewer');
  await new Promise((r) => setTimeout(r, 35));
  assert.equal(bridge.getBindingContext().actorUserId, '9009009');

  await fakeWin.fetch('https://x.com/i/api/graphql/ReplyQid/CreateTweet', {
    method: 'POST',
    body: JSON.stringify(createTweetFixtures.standardReply.requestBody)
  });
  await new Promise((r) => setTimeout(r, 40));

  const snapAfterBReply = await popup.refresh();
  assert.equal(popupNodes.get('viewer-status-badge').textContent, '采集中');
  assert.equal(snapAfterBReply.viewerStatus, 'bound');
  assert.equal(snapAfterBReply.activeTabActorUserId, '9009009');
  assert.equal(snapAfterBReply.selectedAccount.actorUserId, '9009009');
  assert.equal(snapAfterBReply.selectedAccount.summary.totalReplies, 1);

  bridge.destroy();
});

test('[P2] Native fetch(new Request(...)) reply schema drift surfaces liveCaptureAnomaly in Popup while enforcing 64 KiB / timeout / bodyUsed limits', async () => {
  const NOW_MS = 1794794402000;
  const EXT_ID = 'sparklink_remed_request_clone';
  const POPUP_SENDER = { id: EXT_ID, url: `chrome-extension://${EXT_ID}/src/popup/popup.html` };
  const tabSender = {
    id: EXT_ID,
    tab: { id: 92, active: true },
    frameId: 0,
    documentId: 'doc_92',
    origin: 'https://x.com',
    url: 'https://x.com/home'
  };

  const localArea = createMockArea();
  const sessionArea = createMockArea();
  const tabListeners = new Set();

  const bg = createBackgroundService(
    {
      storage: { local: localArea, session: sessionArea },
      runtime: {
        id: EXT_ID,
        getURL: (p) => `chrome-extension://${EXT_ID}/${p.replace(/^\//, '')}`,
        onMessage: { addListener() {} }
      },
      tabs: {
        async query() {
          return [{ id: 92, active: true }];
        },
        async sendMessage(_tabId, msg) {
          if (msg && msg.type === 'PING_X_TAB') return { ok: true, alive: true };
          for (const fn of tabListeners) fn(msg, { id: EXT_ID });
          return undefined;
        },
        onRemoved: { addListener() {} }
      }
    },
    { nowFn: () => NOW_MS }
  );

  let nextCreateTweetPayload = {
    data: {
      create_post_v2: {
        post_results: { id: '2122147641553899888' }
      }
    }
  };
  const callerConsumedBodies = [];
  const winListeners = new Map();

  const fakeWin = {
    location: { origin: 'https://x.com', href: 'https://x.com/home' },
    document: {
      visibilityState: 'visible',
      addEventListener() {},
      removeEventListener() {},
      querySelector: () => null,
      querySelectorAll: () => []
    },
    __INITIAL_STATE__: structuredClone(viewerFixtures.ownProfileInitialState),
    async fetch(input, init) {
      const urlStr = typeof input === 'string' ? input : input.url;
      if (input && typeof input === 'object' && typeof input.text === 'function' && !input.bodyUsed) {
        callerConsumedBodies.push(await input.text());
      } else if (init && typeof init.body === 'string') {
        callerConsumedBodies.push(init.body);
      }
      if (String(urlStr).includes('CreateTweet')) {
        return new Response(JSON.stringify(nextCreateTweetPayload), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      return new Response('{}', { status: 200 });
    },
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, new Set());
      winListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      if (winListeners.has(type)) winListeners.get(type).delete(fn);
    },
    postMessage(data, origin) {
      queueMicrotask(() => {
        const set = winListeners.get('message');
        if (set) {
          for (const fn of set) fn({ data, origin, source: fakeWin });
        }
      });
    }
  };
  fakeWin.top = fakeWin;

  const pageChrome = {
    runtime: {
      id: EXT_ID,
      sendMessage: (msg) => bg.handleMessage(msg, tabSender),
      onMessage: {
        addListener(fn) {
          tabListeners.add(fn);
        },
        removeListener(fn) {
          tabListeners.delete(fn);
        }
      }
    }
  };

  await bg.handleMessage({ type: 'SET_COLLECTION_ENABLED', enabled: true }, POPUP_SENDER);
  installMainInterceptor(fakeWin, adapterApi, {
    nowFn: () => NOW_MS,
    maxRequestBytes: 64 * 1024,
    cloneTimeoutMs: 60
  });
  const bridge = installIsolatedBridge(fakeWin, pageChrome, { nowFn: () => NOW_MS, retryDelayMs: 5 });
  await new Promise((r) => setTimeout(r, 40));

  const { doc, nodes } = createPopupDomHarness();
  const popup = createPopupController({
    document: doc,
    runtime: { sendMessage: (m) => bg.handleMessage(m, POPUP_SENDER) }
  });
  await popup.init();
  assert.equal(nodes.get('viewer-status-badge').textContent, '采集中');

  const replyJson = JSON.stringify(createTweetFixtures.standardReply.requestBody);

  // 1. Oversized Request (> 64 KiB), pre-consumed Request (bodyUsed === true), and timed-out streaming Request must NOT trigger false anomaly
  const oversizedReq = new Request('https://x.com/i/api/graphql/ReplyQid/CreateTweet', {
    method: 'POST',
    body: JSON.stringify({
      variables: {
        reply: { in_reply_to_tweet_id: '2121785253688246272' },
        padding: 'x'.repeat(70 * 1024)
      }
    })
  });
  await (await fakeWin.fetch(oversizedReq)).json();

  const usedReq = new Request('https://x.com/i/api/graphql/ReplyQid/CreateTweet', {
    method: 'POST',
    body: replyJson
  });
  await usedReq.text();
  assert.equal(usedReq.bodyUsed, true);
  await fakeWin.fetch(usedReq);

  const slowBody = new ReadableStream({
    start(ctrl) {
      const timer = setTimeout(() => {
        try {
          ctrl.enqueue(new TextEncoder().encode(replyJson));
          ctrl.close();
        } catch (_ignore) {}
      }, 160);
      if (timer && typeof timer.unref === 'function') timer.unref();
    }
  });
  const slowReq = new Request('https://x.com/i/api/graphql/ReplyQid/CreateTweet', {
    method: 'POST',
    body: slowBody,
    duplex: 'half'
  });
  await fakeWin.fetch(slowReq);
  await new Promise((r) => setTimeout(r, 100));

  const snapBeforeValidReq = await popup.refresh();
  assert.equal(snapBeforeValidReq.diagnostics.liveCaptureAnomaly, false);
  assert.equal(nodes.get('viewer-status-badge').textContent, '采集中');

  // 2. Valid native Request reply with drifted 200 response -> caller receives intact body AND Popup surfaces 实时采集异常!
  const nativeReplyReq = new Request('https://x.com/i/api/graphql/ReplyQid/CreateTweet', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: replyJson
  });
  const callerRes = await fakeWin.fetch(nativeReplyReq);
  const callerParsed = await callerRes.json();
  assert.equal(callerParsed.data.create_post_v2.post_results.id, '2122147641553899888');
  assert.ok(callerConsumedBodies.includes(replyJson), 'Original Request body must remain intact for caller');

  await new Promise((r) => setTimeout(r, 50));
  const snapAfterNativeReq = await popup.refresh();
  assert.equal(snapAfterNativeReq.diagnostics.liveCaptureAnomaly, true);
  assert.equal(nodes.get('viewer-status-badge').textContent, '实时采集异常');
  assert.ok(nodes.get('status-banners').textContent.includes('实时回复响应结构无法识别'));

  // 3. Valid native Request reply with valid CreateTweet 200 response -> records +1 reply!
  nextCreateTweetPayload = createTweetFixtures.standardReply.response;
  const validReplyReq = new Request('https://x.com/i/api/graphql/ReplyQid/CreateTweet', {
    method: 'POST',
    body: replyJson
  });
  await (await fakeWin.fetch(validReplyReq)).json();
  await new Promise((r) => setTimeout(r, 50));
  const snapAfterValidReply = await popup.refresh();
  assert.equal(snapAfterValidReply.selectedAccount.summary.totalReplies, 1);

  bridge.destroy();
});

test(
  '[P2] Real Chromium native fetch(new Request(...)) verification via CDP',
  { skip: !fs.existsSync('/usr/bin/chromium') || !fs.existsSync('/usr/bin/xvfb-run') },
  async () => {
    const adapterSource = fs.readFileSync(path.resolve('src/x-adapter.js'), 'utf8');
    const interceptorSource = fs.readFileSync(path.resolve('src/interceptor.js'), 'utf8');
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparklink-chromium-req-'));
    const child = spawn(
      '/usr/bin/xvfb-run',
      [
        '-a',
        '/usr/bin/chromium',
        '--remote-debugging-port=0',
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${profileDir}`,
        'about:blank'
      ],
      { stdio: ['ignore', 'ignore', 'ignore'], detached: true }
    );

    try {
      const portFile = path.join(profileDir, 'DevToolsActivePort');
      let port = null;
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        if (fs.existsSync(portFile)) {
          const lines = fs.readFileSync(portFile, 'utf8').trim().split('\n');
          if (lines[0] && /^\d+$/.test(lines[0].trim())) {
            port = Number(lines[0].trim());
            break;
          }
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      assert.ok(port, 'Chromium DevToolsActivePort must initialize');

      let pageTarget = null;
      const pageDeadline = Date.now() + 6000;
      while (Date.now() < pageDeadline) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/json`);
          if (res.ok) {
            const targets = await res.json();
            pageTarget = targets.find(
              (t) => t.type === 'page' && t.url === 'about:blank' && t.webSocketDebuggerUrl
            );
            if (pageTarget) break;
          }
        } catch (_ignore) {}
        await new Promise((r) => setTimeout(r, 120));
      }
      assert.ok(pageTarget, 'Chromium page target must be available');

      const evalExpr = `(async () => {
        const loadCjs = (src) => {
          const exportsObj = {};
          const mod = { exports: exportsObj };
          new Function('module', 'exports', src)(mod, exportsObj);
          return mod.exports;
        };
        const adapter = loadCjs(${JSON.stringify(adapterSource)});
        const { installMainInterceptor } = loadCjs(${JSON.stringify(interceptorSource)});

        const posted = [];
        const listeners = new Set();
        let consumedReqText = null;

        const fakeWin = {
          location: { origin: 'https://x.com', href: 'https://x.com/home' },
          document: { visibilityState: 'visible', querySelector: () => null, querySelectorAll: () => [] },
          fetch: async (input) => {
            consumedReqText = await input.text();
            return new Response(
              JSON.stringify({ data: { create_post_v2: { id: '999' } } }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            );
          },
          addEventListener: (_t, fn) => listeners.add(fn),
          removeEventListener: (_t, fn) => listeners.delete(fn),
          postMessage: (data, origin) => posted.push({ data, origin })
        };
        fakeWin.top = fakeWin;

        installMainInterceptor(fakeWin, adapter);
        const dispatch = (msg) => {
          for (const fn of listeners) fn({ data: msg, origin: 'https://x.com', source: fakeWin });
        };

        dispatch({
          protocol: 'SPARKLINK_BRIDGE_V1',
          type: 'BRIDGE_INIT',
          nonce: 'chromium_nonce_req',
          collectionEnabled: true,
          captureSessionId: 1,
          bindingContext: {
            bindingId: 'b_req_1',
            actorUserId: '1001001',
            captureSessionId: 1,
            collectionGeneration: 1,
            accountGeneration: 1
          }
        });

        const reqBody = ${JSON.stringify(JSON.stringify(createTweetFixtures.standardReply.requestBody))};
        const nativeReq = new Request('https://x.com/i/api/graphql/ReplyQid/CreateTweet', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: reqBody
        });
        const res = await fakeWin.fetch(nativeReq);
        const resJson = await res.json();
        await new Promise((r) => setTimeout(r, 40));

        const obs = posted.find((m) => m.data && m.data.type === 'OBSERVED_EVENTS');
        return {
          consumedMatches: consumedReqText === reqBody,
          callerGotResponse: Boolean(resJson && resJson.data && resJson.data.create_post_v2),
          liveCaptureAnomaly: Boolean(obs && obs.data.liveCaptureAnomaly),
          anomalies: obs ? obs.data.anomalies : []
        };
      })()`;

      const cdpResult = await new Promise((resolve, reject) => {
        const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
        const timer = setTimeout(() => {
          ws.close();
          reject(new Error('CDP Runtime.evaluate timed out'));
        }, 8000);
        ws.addEventListener('open', () => {
          ws.send(
            JSON.stringify({
              id: 1,
              method: 'Runtime.evaluate',
              params: { expression: evalExpr, awaitPromise: true, returnByValue: true }
            })
          );
        });
        ws.addEventListener('message', (ev) => {
          const msg = JSON.parse(String(ev.data));
          if (msg.id === 1) {
            clearTimeout(timer);
            ws.close();
            resolve(msg);
          }
        });
        ws.addEventListener('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      const val = cdpResult.result && cdpResult.result.result && cdpResult.result.result.value;
      assert.deepEqual(val, {
        consumedMatches: true,
        callerGotResponse: true,
        liveCaptureAnomaly: true,
        anomalies: ['unrecognized_reply_schema']
      });
    } finally {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch (_ignore) {}
      await new Promise((r) => setTimeout(r, 150));
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (_ignore) {}
      fs.rmSync(profileDir, { recursive: true, force: true });
    }
  }
);

test('[P2] Explicit TimelineTweet with renamed tweet_results sets historyBackfillAnomaly in Popup while merging valid sibling replies', async () => {
  const NOW_MS = 1794794402000;
  const EXT_ID = 'sparklink_remed_timeline_field_drift';
  const POPUP_SENDER = { id: EXT_ID, url: `chrome-extension://${EXT_ID}/src/popup/popup.html` };
  const tabSender = {
    id: EXT_ID,
    tab: { id: 93, active: true },
    frameId: 0,
    documentId: 'doc_93',
    origin: 'https://x.com',
    url: 'https://x.com/sample_me/with_replies'
  };

  const localArea = createMockArea();
  const sessionArea = createMockArea();
  const tabListeners = new Set();

  const bg = createBackgroundService(
    {
      storage: { local: localArea, session: sessionArea },
      runtime: {
        id: EXT_ID,
        getURL: (p) => `chrome-extension://${EXT_ID}/${p.replace(/^\//, '')}`,
        onMessage: { addListener() {} }
      },
      tabs: {
        async query() {
          return [{ id: 93, active: true }];
        },
        async sendMessage(_tabId, msg) {
          if (msg && msg.type === 'PING_X_TAB') return { ok: true, alive: true };
          for (const fn of tabListeners) fn(msg, { id: EXT_ID });
          return undefined;
        },
        onRemoved: { addListener() {} }
      }
    },
    { nowFn: () => NOW_MS }
  );

  const timelineFixtures = require('./fixtures/timelines.json');
  const mixedDriftedTimeline = structuredClone(timelineFixtures.ownRepliesTimelineMixed.response);
  const entries = mixedDriftedTimeline.data.user.result.timeline_v2.timeline.instructions[0].entries;
  // Keep entry[0] (valid conversation module with reply 2122147641553846272 -> 2002002),
  // add a non-tweet cursor + promoted TimelineTweet (must be ignored), and rename tweet_results on explicit TimelineTweet!
  entries.splice(
    1,
    entries.length - 1,
    {
      entryId: 'cursor-bottom-1',
      content: {
        entryType: 'TimelineTimelineItem',
        itemContent: {
          itemType: 'TimelineTimelineCursor',
          value: 'cursor_val_1',
          cursorType: 'Bottom'
        }
      }
    },
    {
      entryId: 'promoted-tweet-1',
      content: {
        entryType: 'TimelineTimelineItem',
        itemContent: {
          itemType: 'TimelineTweet',
          promotedMetadata: { impressionId: 'ad_1' },
          tweet_results_renamed: { result: { rest_id: '888' } }
        }
      }
    },
    {
      entryId: 'tweet-2122147641553849999',
      content: {
        entryType: 'TimelineTimelineItem',
        itemContent: {
          itemType: 'TimelineTweet',
          // Renamed tweet_results -> tweet_results_v2!
          tweet_results_v2: {
            result: {
              __typename: 'Tweet',
              rest_id: '2122147641553849999'
            }
          }
        }
      }
    }
  );

  const winListeners = new Map();
  const fakeWin = {
    location: { origin: 'https://x.com', href: 'https://x.com/sample_me/with_replies' },
    document: {
      visibilityState: 'visible',
      addEventListener() {},
      removeEventListener() {},
      querySelector: () => null,
      querySelectorAll: () => []
    },
    __INITIAL_STATE__: structuredClone(viewerFixtures.ownProfileInitialState),
    async fetch(url) {
      if (String(url).includes('UserTweetsAndReplies')) {
        return new Response(JSON.stringify(mixedDriftedTimeline), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      return new Response('{}', { status: 200 });
    },
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, new Set());
      winListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      if (winListeners.has(type)) winListeners.get(type).delete(fn);
    },
    postMessage(data, origin) {
      queueMicrotask(() => {
        const set = winListeners.get('message');
        if (set) {
          for (const fn of set) fn({ data, origin, source: fakeWin });
        }
      });
    }
  };
  fakeWin.top = fakeWin;

  const pageChrome = {
    runtime: {
      id: EXT_ID,
      sendMessage: (msg) => bg.handleMessage(msg, tabSender),
      onMessage: {
        addListener(fn) {
          tabListeners.add(fn);
        },
        removeListener(fn) {
          tabListeners.delete(fn);
        }
      }
    }
  };

  await bg.handleMessage({ type: 'SET_COLLECTION_ENABLED', enabled: true }, POPUP_SENDER);
  installMainInterceptor(fakeWin, adapterApi, { nowFn: () => NOW_MS });
  const bridge = installIsolatedBridge(fakeWin, pageChrome, { nowFn: () => NOW_MS, retryDelayMs: 5 });
  await new Promise((r) => setTimeout(r, 40));

  const { doc, nodes } = createPopupDomHarness();
  const popup = createPopupController({
    document: doc,
    runtime: { sendMessage: (m) => bg.handleMessage(m, POPUP_SENDER) }
  });
  await popup.init();
  assert.equal(nodes.get('viewer-status-badge').textContent, '采集中');

  await fakeWin.fetch(
    'https://x.com/i/api/graphql/TimelineQid/UserTweetsAndReplies?variables=%7B%22userId%22%3A%221001001%22%7D'
  );
  await new Promise((r) => setTimeout(r, 50));

  const snap = await popup.refresh();
  assert.equal(snap.selectedAccount.summary.totalReplies, 1, 'Valid sibling reply must still merge');
  assert.equal(snap.diagnostics.historyBackfillAnomaly, true);
  assert.equal(snap.diagnostics.liveCaptureAnomaly, false);
  assert.equal(nodes.get('viewer-status-badge').textContent, '历史补录受限');
  assert.ok(nodes.get('status-banners').textContent.includes('历史补录暂不可用，仍可记录新回复和导入备份'));

  bridge.destroy();
});

test(
  '[P2] Real Chromium DOM direct Text node traversal on root author container via CDP',
  { skip: !fs.existsSync('/usr/bin/chromium') || !fs.existsSync('/usr/bin/xvfb-run') },
  async () => {
    const contentSource = fs.readFileSync(path.resolve('src/content.js'), 'utf8');
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparklink-chromium-direct-text-'));
    const child = spawn(
      '/usr/bin/xvfb-run',
      [
        '-a',
        '/usr/bin/chromium',
        '--remote-debugging-port=0',
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${profileDir}`,
        'about:blank'
      ],
      { stdio: ['ignore', 'ignore', 'ignore'], detached: true }
    );

    try {
      const portFile = path.join(profileDir, 'DevToolsActivePort');
      let port = null;
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        if (fs.existsSync(portFile)) {
          const lines = fs.readFileSync(portFile, 'utf8').trim().split('\n');
          if (lines[0] && /^\d+$/.test(lines[0].trim())) {
            port = Number(lines[0].trim());
            break;
          }
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      assert.ok(port, 'Chromium DevToolsActivePort must initialize');

      let pageTarget = null;
      const pageDeadline = Date.now() + 6000;
      while (Date.now() < pageDeadline) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/json`);
          if (res.ok) {
            const targets = await res.json();
            pageTarget = targets.find(
              (t) => t.type === 'page' && t.url === 'about:blank' && t.webSocketDebuggerUrl
            );
            if (pageTarget) break;
          }
        } catch (_ignore) {}
        await new Promise((r) => setTimeout(r, 120));
      }
      assert.ok(pageTarget, 'Chromium page target must be available');

      const evalExpr = `(async () => {
        const exportsObj = {};
        const mod = { exports: exportsObj };
        new Function('module', 'exports', ${JSON.stringify(contentSource)})(mod, exportsObj);
        const { installContentBadges } = mod.exports;

        document.body.replaceChildren();

        // Case 1: <div data-testid="User-Name"><a href="/alice_real">Alice Real</a>@bob_real</div> (direct Text child)
        const directConflictEl = document.createElement('div');
        directConflictEl.setAttribute('data-testid', 'User-Name');
        const linkA = document.createElement('a');
        linkA.setAttribute('href', '/alice_real');
        linkA.textContent = 'Alice Real';
        directConflictEl.appendChild(linkA);
        directConflictEl.appendChild(document.createTextNode('@bob_real'));
        document.body.appendChild(directConflictEl);

        // Case 2: <div data-testid="User-Name">@bob_real</div> (ONLY direct Text child, zero Element children!)
        const directOnlyEl = document.createElement('div');
        directOnlyEl.setAttribute('data-testid', 'User-Name');
        directOnlyEl.appendChild(document.createTextNode('@bob_real'));
        document.body.appendChild(directOnlyEl);

        const fakeWin = {
          location: { origin: 'https://x.com' },
          document,
          MutationObserver: class { observe() {} disconnect() {} },
          requestAnimationFrame: (cb) => setTimeout(() => cb(performance.now()), 0),
          cancelAnimationFrame: (id) => clearTimeout(id)
        };
        fakeWin.top = fakeWin;

        const ctrl = installContentBadges(fakeWin, {
          subscribe: () => () => {},
          getBindingContext: () => ({
            bindingId: 'b_direct_text',
            actorUserId: '1001',
            captureSessionId: 1,
            collectionGeneration: 1,
            accountGeneration: 1
          }),
          getRevision: () => 1,
          resolveUserIdByHandle: (h) => {
            if (h === 'alice_real') return '111';
            if (h === 'bob_real') return '222';
            return null;
          },
          resolveAuthorByTweetId: () => null,
          queryCounts: async () => ({
            ok: true,
            revision: 1,
            counts: { '111': 12, '222': 7 }
          })
        }, { debounceMs: 5 });

        await new Promise((r) => setTimeout(r, 40));
        const out = {
          directConflictBadgeCount: directConflictEl.querySelectorAll('.sparklink-badge').length,
          directOnlyBadgeCount: directOnlyEl.querySelectorAll('.sparklink-badge').length,
          directOnlyUserId: directOnlyEl.querySelector('.sparklink-badge')?.dataset.sparklinkUserId || null
        };
        ctrl.destroy();
        return out;
      })()`;

      const cdpResult = await new Promise((resolve, reject) => {
        const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
        const timer = setTimeout(() => {
          ws.close();
          reject(new Error('CDP Runtime.evaluate timed out'));
        }, 8000);
        ws.addEventListener('open', () => {
          ws.send(
            JSON.stringify({
              id: 1,
              method: 'Runtime.evaluate',
              params: { expression: evalExpr, awaitPromise: true, returnByValue: true }
            })
          );
        });
        ws.addEventListener('message', (ev) => {
          const msg = JSON.parse(String(ev.data));
          if (msg.id === 1) {
            clearTimeout(timer);
            ws.close();
            resolve(msg);
          }
        });
        ws.addEventListener('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      const val = cdpResult.result && cdpResult.result.result && cdpResult.result.result.value;
      assert.deepEqual(val, {
        directConflictBadgeCount: 0,
        directOnlyBadgeCount: 1,
        directOnlyUserId: '222'
      });
    } finally {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch (_ignore) {}
      await new Promise((r) => setTimeout(r, 150));
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (_ignore) {}
      fs.rmSync(profileDir, { recursive: true, force: true });
    }
  }
);

test('[P1] & [P2] Same-tab A -> B -> A updated snapshot rebinds A and records first reply (+1) while clicking Pause performs 0 window.__INITIAL_STATE__ reads', async () => {
  const NOW_MS = 1794794402000;
  const EXT_ID = 'sparklink_remed_aba_snapshot';
  const POPUP_SENDER = { id: EXT_ID, url: `chrome-extension://${EXT_ID}/src/popup/popup.html` };
  const tabSender = {
    id: EXT_ID,
    tab: { id: 95, active: true },
    frameId: 0,
    documentId: 'doc_95',
    origin: 'https://x.com',
    url: 'https://x.com/home'
  };

  const localArea = createMockArea();
  const sessionArea = createMockArea();
  const tabListeners = new Set();

  const bg = createBackgroundService(
    {
      storage: { local: localArea, session: sessionArea },
      runtime: {
        id: EXT_ID,
        getURL: (p) => `chrome-extension://${EXT_ID}/${p.replace(/^\//, '')}`,
        onMessage: { addListener() {} }
      },
      tabs: {
        async query() {
          return [{ id: 95, active: true }];
        },
        async sendMessage(_tabId, msg) {
          if (msg && msg.type === 'PING_X_TAB') return { ok: true, alive: true };
          for (const fn of tabListeners) fn(msg, { id: EXT_ID });
          return undefined;
        },
        onRemoved: { addListener() {} }
      }
    },
    { nowFn: () => NOW_MS }
  );

  const initialStateA = () => structuredClone(viewerFixtures.ownProfileInitialState);
  const initialStateB = () => ({
    session: { user_id: '9009009' },
    entities: {
      users: {
        entities: {
          '9009009': { id_str: '9009009', screen_name: 'second_account', name: '第二账号' }
        }
      }
    }
  });

  const replyForA = structuredClone(createTweetFixtures.standardReply.response);
  replyForA.data.create_tweet.tweet_results.result.rest_id = '2122147641553890101';
  replyForA.data.create_tweet.tweet_results.result.legacy.id_str = '2122147641553890101';

  const replyForB = structuredClone(createTweetFixtures.standardReply.response);
  replyForB.data.create_tweet.tweet_results.result.rest_id = '2122147641553890202';
  replyForB.data.create_tweet.tweet_results.result.legacy.id_str = '2122147641553890202';
  replyForB.data.create_tweet.tweet_results.result.core.user_results.result.rest_id = '9009009';
  replyForB.data.create_tweet.tweet_results.result.core.user_results.result.core.screen_name =
    'second_account';
  replyForB.data.create_tweet.tweet_results.result.legacy.user_id_str = '9009009';

  let currentReplyPayload = replyForA;
  let currentInitialState = initialStateA();
  let initialStateReads = 0;
  let domQueryReads = 0;
  let currentSwitcherHandle = 'sample_me';
  const winListeners = new Map();

  const fakeWin = {
    location: { origin: 'https://x.com', href: 'https://x.com/home' },
    document: {
      visibilityState: 'visible',
      addEventListener() {},
      removeEventListener() {},
      querySelector(sel) {
        domQueryReads += 1;
        if (sel === '[data-testid="SideNav_AccountSwitcher_Button"]' && currentSwitcherHandle) {
          return {
            tagName: 'BUTTON',
            textContent: `@${currentSwitcherHandle}`,
            childNodes: [{ nodeType: 3, nodeValue: `@${currentSwitcherHandle}` }]
          };
        }
        return null;
      },
      querySelectorAll() {
        domQueryReads += 1;
        return [];
      }
    },
    fetch(url) {
      if (String(url).includes('CreateTweet')) {
        return Promise.resolve(
          new Response(JSON.stringify(currentReplyPayload), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
        );
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    },
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, new Set());
      winListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      if (winListeners.has(type)) winListeners.get(type).delete(fn);
    },
    postMessage(data, origin) {
      queueMicrotask(() => {
        const set = winListeners.get('message');
        if (set) {
          for (const fn of set) fn({ data, origin, source: fakeWin });
        }
      });
    }
  };
  Object.defineProperty(fakeWin, '__INITIAL_STATE__', {
    configurable: true,
    enumerable: true,
    get() {
      initialStateReads += 1;
      return currentInitialState;
    }
  });
  fakeWin.top = fakeWin;

  const pageChrome = {
    runtime: {
      id: EXT_ID,
      sendMessage: (msg) => bg.handleMessage(msg, tabSender),
      onMessage: {
        addListener(fn) {
          tabListeners.add(fn);
        },
        removeListener(fn) {
          tabListeners.delete(fn);
        }
      }
    }
  };

  // 1. Enable collection -> binds Account A (1001001)
  await bg.handleMessage({ type: 'SET_COLLECTION_ENABLED', enabled: true }, POPUP_SENDER);
  installMainInterceptor(fakeWin, adapterApi, { nowFn: () => NOW_MS });
  const bridge = installIsolatedBridge(fakeWin, pageChrome, { nowFn: () => NOW_MS, retryDelayMs: 5 });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(bridge.getBindingContext().actorUserId, '1001001');

  const { doc: popupDoc, nodes: popupNodes } = createPopupDomHarness();
  const popup = createPopupController({
    document: popupDoc,
    runtime: { sendMessage: (m) => bg.handleMessage(m, POPUP_SENDER) }
  });
  await popup.init();
  assert.equal(popupNodes.get('viewer-status-badge').textContent, '采集中');

  // 2. Reset read counters, then click Pause #1 -> MUST perform 0 reads of window.__INITIAL_STATE__ & DOM!
  initialStateReads = 0;
  domQueryReads = 0;
  await bg.handleMessage({ type: 'SET_COLLECTION_ENABLED', enabled: false }, POPUP_SENDER);
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(initialStateReads, 0, 'Clicking Pause must perform 0 reads on window.__INITIAL_STATE__');
  assert.equal(domQueryReads, 0, 'Clicking Pause must perform 0 DOM viewer queries');

  // 3. During Pause #1, update page snapshot + live switcher to Account B (9009009) and Resume #1 -> binds B and records B reply (+1)
  currentInitialState = initialStateB();
  currentSwitcherHandle = 'second_account';
  currentReplyPayload = replyForB;
  await bg.handleMessage({ type: 'SET_COLLECTION_ENABLED', enabled: true }, POPUP_SENDER);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(bridge.getBindingContext().actorUserId, '9009009');

  await fakeWin.fetch('https://x.com/i/api/graphql/ReplyQid/CreateTweet', {
    method: 'POST',
    body: JSON.stringify(createTweetFixtures.standardReply.requestBody)
  });
  await new Promise((r) => setTimeout(r, 40));
  const snapB = await popup.refresh();
  assert.equal(snapB.selectedAccount.actorUserId, '9009009');
  assert.equal(snapB.selectedAccount.summary.totalReplies, 1);

  // 4. Reset read counters, click Pause #2 -> MUST perform 0 reads of window.__INITIAL_STATE__!
  initialStateReads = 0;
  domQueryReads = 0;
  await bg.handleMessage({ type: 'SET_COLLECTION_ENABLED', enabled: false }, POPUP_SENDER);
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(initialStateReads, 0, 'Second Pause must also perform 0 reads on window.__INITIAL_STATE__');
  assert.equal(domQueryReads, 0);

  // 5. During Pause #2, update page snapshot + live switcher BACK to Account A (1001001) and Resume #2 -> MUST bind A immediately and record A's first reply (+1)!
  currentInitialState = initialStateA();
  currentSwitcherHandle = 'sample_me';
  currentReplyPayload = replyForA;
  await bg.handleMessage({ type: 'SET_COLLECTION_ENABLED', enabled: true }, POPUP_SENDER);
  await new Promise((r) => setTimeout(r, 40));

  const snapResumeA = await popup.refresh();
  assert.equal(
    popupNodes.get('viewer-status-badge').textContent,
    '采集中',
    'Popup must bind switcher-corroborated Account A snapshot rather than staying at 账号待确认'
  );
  assert.equal(snapResumeA.viewerStatus, 'bound');
  assert.equal(snapResumeA.activeTabActorUserId, '1001001');
  assert.ok(bridge.getBindingContext());
  assert.equal(bridge.getBindingContext().actorUserId, '1001001');

  await fakeWin.fetch('https://x.com/i/api/graphql/ReplyQid/CreateTweet', {
    method: 'POST',
    body: JSON.stringify(createTweetFixtures.standardReply.requestBody)
  });
  await new Promise((r) => setTimeout(r, 40));

  const snapAfterAReply = await popup.refresh();
  assert.equal(snapAfterAReply.selectedAccount.actorUserId, '1001001');
  assert.equal(snapAfterAReply.selectedAccount.summary.totalReplies, 1);

  // 6. Pause #3 WITHOUT switcher @handle -> Resume #3 stays unconfirmed!
  initialStateReads = 0;
  currentSwitcherHandle = null;
  await bg.handleMessage({ type: 'SET_COLLECTION_ENABLED', enabled: false }, POPUP_SENDER);
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(initialStateReads, 0);

  await bg.handleMessage({ type: 'SET_COLLECTION_ENABLED', enabled: true }, POPUP_SENDER);
  await new Promise((r) => setTimeout(r, 40));
  const snapUnchanged = await popup.refresh();
  assert.equal(snapUnchanged.viewerStatus, 'unconfirmed');
  assert.equal(popupNodes.get('viewer-status-badge').textContent, '账号待确认');

  bridge.destroy();
});

test('[P2] fetch(request, { body: null }) preserves Request parent-tweet validation (0 misattributed replies + anomaly) and default 256 KiB parses ~80 KiB Request body', async () => {
  const NOW_MS = 1794794402000;
  const EXT_ID = 'sparklink_remed_null_body';
  const POPUP_SENDER = { id: EXT_ID, url: `chrome-extension://${EXT_ID}/src/popup/popup.html` };
  const tabSender = {
    id: EXT_ID,
    tab: { id: 96, active: true },
    frameId: 0,
    documentId: 'doc_96',
    origin: 'https://x.com',
    url: 'https://x.com/home'
  };

  const localArea = createMockArea();
  const sessionArea = createMockArea();
  const tabListeners = new Set();

  const bg = createBackgroundService(
    {
      storage: { local: localArea, session: sessionArea },
      runtime: {
        id: EXT_ID,
        getURL: (p) => `chrome-extension://${EXT_ID}/${p.replace(/^\//, '')}`,
        onMessage: { addListener() {} }
      },
      tabs: {
        async query() {
          return [{ id: 96, active: true }];
        },
        async sendMessage(_tabId, msg) {
          if (msg && msg.type === 'PING_X_TAB') return { ok: true, alive: true };
          for (const fn of tabListeners) fn(msg, { id: EXT_ID });
          return undefined;
        },
        onRemoved: { addListener() {} }
      }
    },
    { nowFn: () => NOW_MS }
  );

  // Response claims parentTweetId = 9999999999999999999 (user 8888888), conflicting with Request's 2121785253688246272!
  const parentConflictResp = structuredClone(createTweetFixtures.standardReply.response);
  parentConflictResp.data.create_tweet.tweet_results.result.rest_id = '2122147641553890999';
  parentConflictResp.data.create_tweet.tweet_results.result.legacy.id_str = '2122147641553890999';
  parentConflictResp.data.create_tweet.tweet_results.result.legacy.in_reply_to_status_id_str =
    '9999999999999999999';
  parentConflictResp.data.create_tweet.tweet_results.result.legacy.in_reply_to_user_id_str =
    '8888888';
  parentConflictResp.data.create_tweet.tweet_results.result.legacy.in_reply_to_screen_name =
    'wrong_target';

  let nextCreateResp = parentConflictResp;
  const transmittedBodies = [];
  const winListeners = new Map();

  const fakeWin = {
    location: { origin: 'https://x.com', href: 'https://x.com/home' },
    document: {
      visibilityState: 'visible',
      addEventListener() {},
      removeEventListener() {},
      querySelector: () => null,
      querySelectorAll: () => []
    },
    __INITIAL_STATE__: structuredClone(viewerFixtures.ownProfileInitialState),
    async fetch(input, init) {
      // Follow WHATWG Fetch spec via native new Request(input, init)
      const effectiveReq = new Request(input, init);
      if (effectiveReq.method === 'POST') {
        transmittedBodies.push(await effectiveReq.text());
      }
      return new Response(JSON.stringify(nextCreateResp), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    },
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, new Set());
      winListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      if (winListeners.has(type)) winListeners.get(type).delete(fn);
    },
    postMessage(data, origin) {
      queueMicrotask(() => {
        const set = winListeners.get('message');
        if (set) {
          for (const fn of set) fn({ data, origin, source: fakeWin });
        }
      });
    }
  };
  fakeWin.top = fakeWin;

  const pageChrome = {
    runtime: {
      id: EXT_ID,
      sendMessage: (msg) => bg.handleMessage(msg, tabSender),
      onMessage: {
        addListener(fn) {
          tabListeners.add(fn);
        },
        removeListener(fn) {
          tabListeners.delete(fn);
        }
      }
    }
  };

  await bg.handleMessage({ type: 'SET_COLLECTION_ENABLED', enabled: true }, POPUP_SENDER);
  // Use default maxRequestBytes (256 KiB)!
  installMainInterceptor(fakeWin, adapterApi, { nowFn: () => NOW_MS });
  const bridge = installIsolatedBridge(fakeWin, pageChrome, { nowFn: () => NOW_MS, retryDelayMs: 5 });
  await new Promise((r) => setTimeout(r, 40));

  const { doc, nodes } = createPopupDomHarness();
  const popup = createPopupController({
    document: doc,
    runtime: { sendMessage: (m) => bg.handleMessage(m, POPUP_SENDER) }
  });
  await popup.init();

  // 1. Call fetch(request, { body: null }) with conflicting parent-tweet response ->
  // native Fetch transmits original body, and SparkLink MUST reject parent conflict (0 replies added + liveCaptureAnomaly)!
  const reqBodyStr = JSON.stringify(createTweetFixtures.standardReply.requestBody);
  const req1 = new Request('https://x.com/i/api/graphql/ReplyQid/CreateTweet', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: reqBodyStr
  });
  await (await fakeWin.fetch(req1, { body: null })).json();
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(transmittedBodies[0], reqBodyStr, 'WHATWG Fetch transmits original Request body when init.body is null');
  const snapConflict = await popup.refresh();
  assert.equal(
    snapConflict.selectedAccount.summary.totalReplies,
    0,
    'Conflicting parent tweet must add 0 replies even when init.body is explicitly null'
  );
  assert.equal(snapConflict.diagnostics.liveCaptureAnomaly, true);
  assert.equal(nodes.get('viewer-status-badge').textContent, '实时采集异常');

  // 2. Verify ~80 KiB (> 64 KiB, <= 256 KiB default) Request body is parsed cleanly under default 256 KiB limit!
  const eightyKibReqBody = JSON.stringify({
    ...createTweetFixtures.standardReply.requestBody,
    client_context_padding: 'p'.repeat(80 * 1024)
  });
  const req80k = new Request('https://x.com/i/api/graphql/ReplyQid/CreateTweet', {
    method: 'POST',
    body: eightyKibReqBody
  });
  nextCreateResp = { data: { drifted_80k: true } };
  await (await fakeWin.fetch(req80k)).json();
  nextCreateResp = createTweetFixtures.standardReply.response;
  const req80kValid = new Request('https://x.com/i/api/graphql/ReplyQid/CreateTweet', {
    method: 'POST',
    body: eightyKibReqBody
  });
  await (await fakeWin.fetch(req80kValid, { body: null })).json();
  await new Promise((r) => setTimeout(r, 50));

  const snapAfter80k = await popup.refresh();
  assert.equal(snapAfter80k.selectedAccount.summary.totalReplies, 1);

  bridge.destroy();
});

test(
  '[P2] Real Chromium fetch(request, { body: null }) parent-conflict verification via CDP',
  { skip: !fs.existsSync('/usr/bin/chromium') || !fs.existsSync('/usr/bin/xvfb-run') },
  async () => {
    const adapterSource = fs.readFileSync(path.resolve('src/x-adapter.js'), 'utf8');
    const interceptorSource = fs.readFileSync(path.resolve('src/interceptor.js'), 'utf8');
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparklink-chromium-null-body-'));
    const child = spawn(
      '/usr/bin/xvfb-run',
      [
        '-a',
        '/usr/bin/chromium',
        '--remote-debugging-port=0',
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${profileDir}`,
        'about:blank'
      ],
      { stdio: ['ignore', 'ignore', 'ignore'], detached: true }
    );

    try {
      const portFile = path.join(profileDir, 'DevToolsActivePort');
      let port = null;
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        if (fs.existsSync(portFile)) {
          const lines = fs.readFileSync(portFile, 'utf8').trim().split('\n');
          if (lines[0] && /^\d+$/.test(lines[0].trim())) {
            port = Number(lines[0].trim());
            break;
          }
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      assert.ok(port, 'Chromium DevToolsActivePort must initialize');

      let pageTarget = null;
      const pageDeadline = Date.now() + 6000;
      while (Date.now() < pageDeadline) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/json`);
          if (res.ok) {
            const targets = await res.json();
            pageTarget = targets.find(
              (t) => t.type === 'page' && t.url === 'about:blank' && t.webSocketDebuggerUrl
            );
            if (pageTarget) break;
          }
        } catch (_ignore) {}
        await new Promise((r) => setTimeout(r, 120));
      }
      assert.ok(pageTarget, 'Chromium page target must be available');

      const conflictResp = structuredClone(createTweetFixtures.standardReply.response);
      conflictResp.data.create_tweet.tweet_results.result.rest_id = '2122147641553890998';
      conflictResp.data.create_tweet.tweet_results.result.legacy.id_str = '2122147641553890998';
      conflictResp.data.create_tweet.tweet_results.result.legacy.in_reply_to_status_id_str =
        '9999999999999999999';
      conflictResp.data.create_tweet.tweet_results.result.legacy.in_reply_to_user_id_str =
        '8888888';

      const evalExpr = `(async () => {
        const loadCjs = (src) => {
          const exportsObj = {};
          const mod = { exports: exportsObj };
          new Function('module', 'exports', src)(mod, exportsObj);
          return mod.exports;
        };
        const adapter = loadCjs(${JSON.stringify(adapterSource)});
        const { installMainInterceptor } = loadCjs(${JSON.stringify(interceptorSource)});

        const posted = [];
        const listeners = new Set();
        let chromiumForwardedBody = null;

        const fakeWin = {
          location: { origin: 'https://x.com', href: 'https://x.com/home' },
          document: { visibilityState: 'visible', querySelector: () => null, querySelectorAll: () => [] },
          fetch: async (input, init) => {
            const effective = new Request(input, init);
            chromiumForwardedBody = await effective.text();
            return new Response(
              JSON.stringify(${JSON.stringify(conflictResp)}),
              { status: 200, headers: { 'content-type': 'application/json' } }
            );
          },
          addEventListener: (_t, fn) => listeners.add(fn),
          removeEventListener: (_t, fn) => listeners.delete(fn),
          postMessage: (data, origin) => posted.push({ data, origin })
        };
        fakeWin.top = fakeWin;

        installMainInterceptor(fakeWin, adapter);
        for (const fn of listeners) {
          fn({
            data: {
              protocol: 'SPARKLINK_BRIDGE_V1',
              type: 'BRIDGE_INIT',
              nonce: 'chromium_null_body',
              collectionEnabled: true,
              captureSessionId: 1,
              bindingContext: {
                bindingId: 'b_null_body_1',
                actorUserId: '1001001',
                captureSessionId: 1,
                collectionGeneration: 1,
                accountGeneration: 1
              }
            },
            origin: 'https://x.com',
            source: fakeWin
          });
        }

        const reqBody = ${JSON.stringify(JSON.stringify(createTweetFixtures.standardReply.requestBody))};
        const req = new Request('https://x.com/i/api/graphql/ReplyQid/CreateTweet', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: reqBody
        });
        await (await fakeWin.fetch(req, { body: null })).json();
        await new Promise((r) => setTimeout(r, 40));

        const obs = posted.find((m) => m.data && m.data.type === 'OBSERVED_EVENTS');
        return {
          chromiumPreservedBody: chromiumForwardedBody === reqBody,
          recordedEventsCount: obs ? obs.data.events.length : 0,
          liveCaptureAnomaly: Boolean(obs && obs.data.liveCaptureAnomaly),
          anomalies: obs ? obs.data.anomalies : []
        };
      })()`;

      const cdpResult = await new Promise((resolve, reject) => {
        const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
        const timer = setTimeout(() => {
          ws.close();
          reject(new Error('CDP Runtime.evaluate timed out'));
        }, 8000);
        ws.addEventListener('open', () => {
          ws.send(
            JSON.stringify({
              id: 1,
              method: 'Runtime.evaluate',
              params: { expression: evalExpr, awaitPromise: true, returnByValue: true }
            })
          );
        });
        ws.addEventListener('message', (ev) => {
          const msg = JSON.parse(String(ev.data));
          if (msg.id === 1) {
            clearTimeout(timer);
            ws.close();
            resolve(msg);
          }
        });
        ws.addEventListener('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      const val = cdpResult.result && cdpResult.result.result && cdpResult.result.result.value;
      assert.deepEqual(val, {
        chromiumPreservedBody: true,
        recordedEventsCount: 0,
        liveCaptureAnomaly: true,
        anomalies: ['parent_mismatch']
      });
    } finally {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch (_ignore) {}
      await new Promise((r) => setTimeout(r, 150));
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (_ignore) {}
      fs.rmSync(profileDir, { recursive: true, force: true });
    }
  }
);

test('[P1] Shallow-copying window.__INITIAL_STATE__ without changing account field after Viewer confirmed B keeps Popup at 账号待确认 on resume instead of reviving A', async () => {
  const NOW_MS = 1794794402000;
  const EXT_ID = 'sparklink_remed_shallow_copy_state';
  const POPUP_SENDER = { id: EXT_ID, url: `chrome-extension://${EXT_ID}/src/popup/popup.html` };
  const tabSender = {
    id: EXT_ID,
    tab: { id: 97, active: true },
    frameId: 0,
    documentId: 'doc_97',
    origin: 'https://x.com',
    url: 'https://x.com/home'
  };

  const localArea = createMockArea();
  const sessionArea = createMockArea();
  const tabListeners = new Set();

  const bg = createBackgroundService(
    {
      storage: { local: localArea, session: sessionArea },
      runtime: {
        id: EXT_ID,
        getURL: (p) => `chrome-extension://${EXT_ID}/${p.replace(/^\//, '')}`,
        onMessage: { addListener() {} }
      },
      tabs: {
        async query() {
          return [{ id: 97, active: true }];
        },
        async sendMessage(_tabId, msg) {
          if (msg && msg.type === 'PING_X_TAB') return { ok: true, alive: true };
          for (const fn of tabListeners) fn(msg, { id: EXT_ID });
          return undefined;
        },
        onRemoved: { addListener() {} }
      }
    },
    { nowFn: () => NOW_MS }
  );

  const replyForA = structuredClone(createTweetFixtures.standardReply.response);
  replyForA.data.create_tweet.tweet_results.result.rest_id = '2122147641553891001';
  replyForA.data.create_tweet.tweet_results.result.legacy.id_str = '2122147641553891001';

  const replyForB = structuredClone(createTweetFixtures.standardReply.response);
  replyForB.data.create_tweet.tweet_results.result.rest_id = '2122147641553891002';
  replyForB.data.create_tweet.tweet_results.result.legacy.id_str = '2122147641553891002';
  replyForB.data.create_tweet.tweet_results.result.core.user_results.result.rest_id = '9009009';
  replyForB.data.create_tweet.tweet_results.result.core.user_results.result.core.screen_name =
    'second_account';
  replyForB.data.create_tweet.tweet_results.result.legacy.user_id_str = '9009009';

  let currentReplyPayload = replyForA;
  let shallowSwitcherEl = null;
  const winListeners = new Map();

  const fakeWin = {
    location: { origin: 'https://x.com', href: 'https://x.com/home' },
    document: {
      visibilityState: 'visible',
      addEventListener() {},
      removeEventListener() {},
      querySelector: (sel) =>
        sel === '[data-testid="SideNav_AccountSwitcher_Button"]' ? shallowSwitcherEl : null,
      querySelectorAll: () => []
    },
    // Page initially loads as Account A (1001001)
    __INITIAL_STATE__: structuredClone(viewerFixtures.ownProfileInitialState),
    fetch(url) {
      if (String(url).includes('Viewer')) {
        // Viewer confirms Account B (9009009)
        return Promise.resolve(
          new Response(JSON.stringify(viewerFixtures.viewerGraphqlLegacy), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
        );
      }
      if (String(url).includes('CreateTweet')) {
        return Promise.resolve(
          new Response(JSON.stringify(currentReplyPayload), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
        );
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    },
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, new Set());
      winListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      if (winListeners.has(type)) winListeners.get(type).delete(fn);
    },
    postMessage(data, origin) {
      queueMicrotask(() => {
        const set = winListeners.get('message');
        if (set) {
          for (const fn of set) fn({ data, origin, source: fakeWin });
        }
      });
    }
  };
  fakeWin.top = fakeWin;

  const pageChrome = {
    runtime: {
      id: EXT_ID,
      sendMessage: (msg) => bg.handleMessage(msg, tabSender),
      onMessage: {
        addListener(fn) {
          tabListeners.add(fn);
        },
        removeListener(fn) {
          tabListeners.delete(fn);
        }
      }
    }
  };

  // 1. Enable collection -> binds A (1001001), A sends 1 reply (totalReplies = 1)
  await bg.handleMessage({ type: 'SET_COLLECTION_ENABLED', enabled: true }, POPUP_SENDER);
  installMainInterceptor(fakeWin, adapterApi, { nowFn: () => NOW_MS });
  const bridge = installIsolatedBridge(fakeWin, pageChrome, { nowFn: () => NOW_MS, retryDelayMs: 5 });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(bridge.getBindingContext().actorUserId, '1001001');

  await fakeWin.fetch('https://x.com/i/api/graphql/ReplyQid/CreateTweet', {
    method: 'POST',
    body: JSON.stringify(createTweetFixtures.standardReply.requestBody)
  });
  await new Promise((r) => setTimeout(r, 40));

  // 2. Viewer confirms Account B (9009009) while fakeWin.__INITIAL_STATE__ remains Account A (1001001)
  await fakeWin.fetch('https://x.com/i/api/graphql/ViewerQid/Viewer');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(bridge.getBindingContext().actorUserId, '9009009');

  const { doc: popupDoc, nodes: popupNodes } = createPopupDomHarness();
  const popup = createPopupController({
    document: popupDoc,
    runtime: { sendMessage: (m) => bg.handleMessage(m, POPUP_SENDER) }
  });
  const snapBeforePause = await popup.init();
  assert.equal(snapBeforePause.activeTabActorUserId, '9009009');
  assert.equal(snapBeforePause.selectedAccount.actorUserId, '9009009');
  assert.equal(snapBeforePause.selectedAccount.summary.totalReplies, 0);
  assert.equal(popupNodes.get('viewer-status-badge').textContent, '采集中');

  // 3. Pause collection; page shallow-copies outer __INITIAL_STATE__ object WITHOUT changing account field (still 1001001)!
  await bg.handleMessage({ type: 'SET_COLLECTION_ENABLED', enabled: false }, POPUP_SENDER);
  await new Promise((r) => setTimeout(r, 25));
  fakeWin.__INITIAL_STATE__ = { ...fakeWin.__INITIAL_STATE__, uiThemeUpdated: true };
  assert.equal(fakeWin.__INITIAL_STATE__.session.user_id, '1001001');

  // 4. Resume collection -> MUST stay unconfirmed (账号待确认), NEVER reviving Account A or showing A's 1 reply as actively collecting!
  await bg.handleMessage({ type: 'SET_COLLECTION_ENABLED', enabled: true }, POPUP_SENDER);
  await new Promise((r) => setTimeout(r, 40));

  const snapAfterResume = await popup.refresh();
  assert.equal(
    bridge.getBindingContext(),
    null,
    'Shallow-copying outer __INITIAL_STATE__ without changing user_id must NOT rebind superseded Account A'
  );
  assert.equal(snapAfterResume.viewerStatus, 'unconfirmed');
  assert.equal(snapAfterResume.activeTabActorUserId, null);
  assert.equal(popupNodes.get('viewer-status-badge').textContent, '账号待确认');
  assert.equal(
    snapAfterResume.selectedAccount && snapAfterResume.selectedAccount.actorUserId,
    '9009009',
    'Open Popup viewing Account B (0 replies) must NOT auto-switch to Account A (1 reply) during 账号待确认'
  );
  assert.equal(popupNodes.get('account-select').value, '9009009');
  assert.equal(popupNodes.get('stat-total-replies').textContent, '0');

  // 5. Fresh Viewer for B confirms B and records B's reply (+1)
  currentReplyPayload = replyForB;
  await fakeWin.fetch('https://x.com/i/api/graphql/ViewerQid/Viewer');
  await new Promise((r) => setTimeout(r, 35));
  await fakeWin.fetch('https://x.com/i/api/graphql/ReplyQid/CreateTweet', {
    method: 'POST',
    body: JSON.stringify(createTweetFixtures.standardReply.requestBody)
  });
  await new Promise((r) => setTimeout(r, 40));

  const snapAfterBReply = await popup.refresh();
  assert.equal(snapAfterBReply.viewerStatus, 'bound');
  assert.equal(snapAfterBReply.activeTabActorUserId, '9009009');
  assert.equal(snapAfterBReply.selectedAccount.actorUserId, '9009009');
  assert.equal(snapAfterBReply.selectedAccount.summary.totalReplies, 1);

  // 6. Pause -> __INITIAL_STATE__ catches up to B (clears supersededDynamicActorId, still equals staleActiveActorId B -> stays unconfirmed),
  //    then Viewer confirms B, Pause -> __INITIAL_STATE__ genuinely switches B -> A -> Resume rebinds A!
  await bg.handleMessage({ type: 'SET_COLLECTION_ENABLED', enabled: false }, POPUP_SENDER);
  await new Promise((r) => setTimeout(r, 25));
  fakeWin.__INITIAL_STATE__ = {
    session: { user_id: '9009009', user: { screen_name: 'second_account', name: '第二账号' } }
  };
  await bg.handleMessage({ type: 'SET_COLLECTION_ENABLED', enabled: true }, POPUP_SENDER);
  await new Promise((r) => setTimeout(r, 35));
  assert.equal(bridge.getBindingContext(), null);

  await fakeWin.fetch('https://x.com/i/api/graphql/ViewerQid/Viewer');
  await new Promise((r) => setTimeout(r, 35));
  assert.equal(bridge.getBindingContext().actorUserId, '9009009');

  await bg.handleMessage({ type: 'SET_COLLECTION_ENABLED', enabled: false }, POPUP_SENDER);
  await new Promise((r) => setTimeout(r, 25));
  fakeWin.__INITIAL_STATE__ = structuredClone(viewerFixtures.ownProfileInitialState);
  shallowSwitcherEl = {
    tagName: 'BUTTON',
    textContent: '@sample_me',
    childNodes: [{ nodeType: 3, nodeValue: '@sample_me' }]
  };
  await bg.handleMessage({ type: 'SET_COLLECTION_ENABLED', enabled: true }, POPUP_SENDER);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(bridge.getBindingContext().actorUserId, '1001001');

  bridge.destroy();
});

test('[P1] Releasing window.__INITIAL_STATE__ during pause never falls back to initial HTML inline <script> containing Account A', async () => {
  const NOW_MS = 1794794402000;
  const EXT_ID = 'sparklink_remed_inline_script_fallback';
  const POPUP_SENDER = { id: EXT_ID, url: `chrome-extension://${EXT_ID}/src/popup/popup.html` };
  const tabSender = {
    id: EXT_ID,
    tab: { id: 98, active: true },
    frameId: 0,
    documentId: 'doc_98',
    origin: 'https://x.com',
    url: 'https://x.com/home'
  };

  const localArea = createMockArea();
  const sessionArea = createMockArea();
  const tabListeners = new Set();

  const bg = createBackgroundService(
    {
      storage: { local: localArea, session: sessionArea },
      runtime: {
        id: EXT_ID,
        getURL: (p) => `chrome-extension://${EXT_ID}/${p.replace(/^\//, '')}`,
        onMessage: { addListener() {} }
      },
      tabs: {
        async query() {
          return [{ id: 98, active: true }];
        },
        async sendMessage(_tabId, msg) {
          if (msg && msg.type === 'PING_X_TAB') return { ok: true, alive: true };
          for (const fn of tabListeners) fn(msg, { id: EXT_ID });
          return undefined;
        },
        onRemoved: { addListener() {} }
      }
    },
    { nowFn: () => NOW_MS }
  );

  // Initial HTML contains static inline script for Account A (1001001)
  const initialInlineScriptNode = {
    textContent:
      'window.__INITIAL_STATE__ = {"session":{"user_id":"1001001","user":{"screen_name":"sample_me","name":"示例账号"}}};'
  };
  const winListeners = new Map();

  const fakeWin = {
    location: { origin: 'https://x.com', href: 'https://x.com/home' },
    document: {
      visibilityState: 'visible',
      addEventListener() {},
      removeEventListener() {},
      querySelector: () => null,
      querySelectorAll(sel) {
        if (sel === 'script:not([src])') {
          return [initialInlineScriptNode];
        }
        return [];
      }
    },
    // Dynamic window.__INITIAL_STATE__ and Viewer GraphQL both confirm Account B (9009009)!
    __INITIAL_STATE__: {
      session: { user_id: '9009009' },
      entities: {
        users: {
          entities: {
            '9009009': { id_str: '9009009', screen_name: 'second_account', name: '第二账号' }
          }
        }
      }
    },
    fetch(url) {
      if (String(url).includes('Viewer')) {
        return Promise.resolve(
          new Response(JSON.stringify(viewerFixtures.viewerGraphqlLegacy), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
        );
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    },
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, new Set());
      winListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      if (winListeners.has(type)) winListeners.get(type).delete(fn);
    },
    postMessage(data, origin) {
      queueMicrotask(() => {
        const set = winListeners.get('message');
        if (set) {
          for (const fn of set) fn({ data, origin, source: fakeWin });
        }
      });
    }
  };
  fakeWin.top = fakeWin;

  const pageChrome = {
    runtime: {
      id: EXT_ID,
      sendMessage: (msg) => bg.handleMessage(msg, tabSender),
      onMessage: {
        addListener(fn) {
          tabListeners.add(fn);
        },
        removeListener(fn) {
          tabListeners.delete(fn);
        }
      }
    }
  };

  await bg.handleMessage({ type: 'SET_COLLECTION_ENABLED', enabled: true }, POPUP_SENDER);
  installMainInterceptor(fakeWin, adapterApi, { nowFn: () => NOW_MS });
  const bridge = installIsolatedBridge(fakeWin, pageChrome, { nowFn: () => NOW_MS, retryDelayMs: 5 });
  await new Promise((r) => setTimeout(r, 40));

  await fakeWin.fetch('https://x.com/i/api/graphql/ViewerQid/Viewer');
  await new Promise((r) => setTimeout(r, 35));
  assert.equal(bridge.getBindingContext().actorUserId, '9009009');

  const { doc: popupDoc, nodes: popupNodes } = createPopupDomHarness();
  const popup = createPopupController({
    document: popupDoc,
    runtime: { sendMessage: (m) => bg.handleMessage(m, POPUP_SENDER) }
  });
  await popup.init();
  assert.equal(popupNodes.get('viewer-status-badge').textContent, '采集中');

  // Pause collection, then release dynamic window.__INITIAL_STATE__ (leaving static inline <script> for A in DOM!)
  await bg.handleMessage({ type: 'SET_COLLECTION_ENABLED', enabled: false }, POPUP_SENDER);
  await new Promise((r) => setTimeout(r, 25));
  delete fakeWin.__INITIAL_STATE__;

  // Resume collection -> MUST stay unconfirmed (账号待确认), NEVER reading static inline <script> for Account A!
  await bg.handleMessage({ type: 'SET_COLLECTION_ENABLED', enabled: true }, POPUP_SENDER);
  await new Promise((r) => setTimeout(r, 40));

  const snapAfterResume = await popup.refresh();
  assert.equal(
    bridge.getBindingContext(),
    null,
    'Releasing window.__INITIAL_STATE__ must NOT fall back to initial HTML inline <script> for Account A'
  );
  assert.equal(snapAfterResume.viewerStatus, 'unconfirmed');
  assert.equal(snapAfterResume.activeTabActorUserId, null);
  assert.equal(popupNodes.get('viewer-status-badge').textContent, '账号待确认');

  bridge.destroy();
});

test(
  '[P1] Real Chromium CDP verification: shallow-copied __INITIAL_STATE__ and initial HTML inline <script> never revive Account A after Viewer confirmed B',
  { skip: !fs.existsSync('/usr/bin/chromium') || !fs.existsSync('/usr/bin/xvfb-run') },
  async () => {
    const adapterSource = fs.readFileSync(path.resolve('src/x-adapter.js'), 'utf8');
    const interceptorSource = fs.readFileSync(path.resolve('src/interceptor.js'), 'utf8');
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparklink-chromium-viewer-sm-'));
    const child = spawn(
      '/usr/bin/xvfb-run',
      [
        '-a',
        '/usr/bin/chromium',
        '--remote-debugging-port=0',
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${profileDir}`,
        'about:blank'
      ],
      { stdio: ['ignore', 'ignore', 'ignore'], detached: true }
    );

    try {
      const portFile = path.join(profileDir, 'DevToolsActivePort');
      let port = null;
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        if (fs.existsSync(portFile)) {
          const lines = fs.readFileSync(portFile, 'utf8').trim().split('\n');
          if (lines[0] && /^\d+$/.test(lines[0].trim())) {
            port = Number(lines[0].trim());
            break;
          }
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      assert.ok(port, 'Chromium DevToolsActivePort must initialize');

      let pageTarget = null;
      const pageDeadline = Date.now() + 6000;
      while (Date.now() < pageDeadline) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/json`);
          if (res.ok) {
            const targets = await res.json();
            pageTarget = targets.find(
              (t) => t.type === 'page' && t.url === 'about:blank' && t.webSocketDebuggerUrl
            );
            if (pageTarget) break;
          }
        } catch (_ignore) {}
        await new Promise((r) => setTimeout(r, 120));
      }
      assert.ok(pageTarget, 'Chromium page target must be available');

      const evalExpr = `(async () => {
        const loadCjs = (src) => {
          const exportsObj = {};
          const mod = { exports: exportsObj };
          new Function('module', 'exports', src)(mod, exportsObj);
          return mod.exports;
        };
        const adapter = loadCjs(${JSON.stringify(adapterSource)});
        const { installMainInterceptor } = loadCjs(${JSON.stringify(interceptorSource)});

        // Mount real <script type="application/json-ssr"> (inline script without src) containing Account A (1001001)
        document.head.replaceChildren();
        document.body.replaceChildren();
        const ssrScript = document.createElement('script');
        ssrScript.type = 'text/plain';
        ssrScript.textContent = 'window.__INITIAL_STATE__ = {"session":{"user_id":"1001001","user":{"screen_name":"sample_me","name":"A"}}};';
        document.head.appendChild(ssrScript);

        const posted = [];
        const listeners = new Set();
        const fakeWin = {
          location: { origin: 'https://x.com', href: 'https://x.com/home' },
          document,
          __INITIAL_STATE__: {
            session: { user_id: '1001001', user: { screen_name: 'sample_me', name: 'A' } }
          },
          fetch: async () => new Response(
            JSON.stringify(${JSON.stringify(viewerFixtures.viewerGraphqlLegacy)}),
            { status: 200, headers: { 'content-type': 'application/json' } }
          ),
          addEventListener: (_t, fn) => listeners.add(fn),
          removeEventListener: (_t, fn) => listeners.delete(fn),
          postMessage: (data, origin) => posted.push({ data, origin })
        };
        fakeWin.top = fakeWin;

        installMainInterceptor(fakeWin, adapter);
        const dispatch = (msg) => {
          for (const fn of listeners) fn({ data: msg, origin: 'https://x.com', source: fakeWin });
        };

        // 1. Init session 1 -> binds A, then Viewer GraphQL confirms B (9009009) while __INITIAL_STATE__ stays A
        dispatch({
          protocol: 'SPARKLINK_BRIDGE_V1',
          type: 'BRIDGE_INIT',
          nonce: 'chromium_sm_nonce',
          collectionEnabled: true,
          captureSessionId: 1,
          bindingContext: null
        });
        await fakeWin.fetch('https://x.com/i/api/graphql/ViewerQid/Viewer');
        await new Promise((r) => setTimeout(r, 30));
        dispatch({
          protocol: 'SPARKLINK_BRIDGE_V1',
          type: 'SYNC_STATE',
          nonce: 'chromium_sm_nonce',
          collectionEnabled: true,
          captureSessionId: 1,
          bindingContext: {
            bindingId: 'b_9009009_1',
            actorUserId: '9009009',
            captureSessionId: 1,
            collectionGeneration: 1,
            accountGeneration: 1
          }
        });

        // 2. Pause -> shallow copy __INITIAL_STATE__ (still A) -> Resume session 2
        dispatch({
          protocol: 'SPARKLINK_BRIDGE_V1',
          type: 'SYNC_STATE',
          nonce: 'chromium_sm_nonce',
          collectionEnabled: false,
          captureSessionId: null,
          bindingContext: null
        });
        fakeWin.__INITIAL_STATE__ = { ...fakeWin.__INITIAL_STATE__, copied: true };
        posted.length = 0;
        dispatch({
          protocol: 'SPARKLINK_BRIDGE_V1',
          type: 'SYNC_STATE',
          nonce: 'chromium_sm_nonce',
          collectionEnabled: true,
          captureSessionId: 2,
          bindingContext: null
        });
        dispatch({ protocol: 'SPARKLINK_BRIDGE_V1', type: 'PROBE_VIEWER', nonce: 'chromium_sm_nonce' });
        const shallowCopyEmitted = posted.filter((m) => m.data.type === 'VIEWER_EVIDENCE').length;

        // 3. Confirm B in both __INITIAL_STATE__ and Viewer, then Pause -> delete __INITIAL_STATE__ (leaving real DOM <script> with A!) -> Resume session 3
        fakeWin.__INITIAL_STATE__ = {
          session: { user_id: '9009009', user: { screen_name: 'second_account', name: 'B' } }
        };
        await fakeWin.fetch('https://x.com/i/api/graphql/ViewerQid/Viewer');
        await new Promise((r) => setTimeout(r, 25));
        dispatch({
          protocol: 'SPARKLINK_BRIDGE_V1',
          type: 'SYNC_STATE',
          nonce: 'chromium_sm_nonce',
          collectionEnabled: true,
          captureSessionId: 2,
          bindingContext: {
            bindingId: 'b_9009009_2',
            actorUserId: '9009009',
            captureSessionId: 2,
            collectionGeneration: 1,
            accountGeneration: 2
          }
        });
        dispatch({
          protocol: 'SPARKLINK_BRIDGE_V1',
          type: 'SYNC_STATE',
          nonce: 'chromium_sm_nonce',
          collectionEnabled: false,
          captureSessionId: null,
          bindingContext: null
        });
        delete fakeWin.__INITIAL_STATE__;
        posted.length = 0;
        dispatch({
          protocol: 'SPARKLINK_BRIDGE_V1',
          type: 'SYNC_STATE',
          nonce: 'chromium_sm_nonce',
          collectionEnabled: true,
          captureSessionId: 3,
          bindingContext: null
        });
        dispatch({ protocol: 'SPARKLINK_BRIDGE_V1', type: 'PROBE_VIEWER', nonce: 'chromium_sm_nonce' });
        const inlineFallbackEmitted = posted.filter((m) => m.data.type === 'VIEWER_EVIDENCE').length;

        // 4. Genuine user_id change in __INITIAL_STATE__ to 3003003 -> Pause & Resume session 4 -> emits 3003003!
        dispatch({
          protocol: 'SPARKLINK_BRIDGE_V1',
          type: 'SYNC_STATE',
          nonce: 'chromium_sm_nonce',
          collectionEnabled: false,
          captureSessionId: null,
          bindingContext: null
        });
        fakeWin.__INITIAL_STATE__ = {
          session: { user_id: '3003003', user: { screen_name: 'third_acc', name: 'C' } }
        };
        const switcherC = document.createElement('button');
        switcherC.setAttribute('data-testid', 'SideNav_AccountSwitcher_Button');
        switcherC.textContent = '@third_acc';
        document.body.appendChild(switcherC);
        posted.length = 0;
        dispatch({
          protocol: 'SPARKLINK_BRIDGE_V1',
          type: 'SYNC_STATE',
          nonce: 'chromium_sm_nonce',
          collectionEnabled: true,
          captureSessionId: 4,
          bindingContext: null
        });
        const genuineChangeActor = posted.find((m) => m.data.type === 'VIEWER_EVIDENCE')?.data?.viewer?.actorUserId || null;

        return {
          shallowCopyEmitted,
          inlineFallbackEmitted,
          genuineChangeActor
        };
      })()`;

      const cdpResult = await new Promise((resolve, reject) => {
        const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
        const timer = setTimeout(() => {
          ws.close();
          reject(new Error('CDP Runtime.evaluate timed out'));
        }, 8000);
        ws.addEventListener('open', () => {
          ws.send(
            JSON.stringify({
              id: 1,
              method: 'Runtime.evaluate',
              params: { expression: evalExpr, awaitPromise: true, returnByValue: true }
            })
          );
        });
        ws.addEventListener('message', (ev) => {
          const msg = JSON.parse(String(ev.data));
          if (msg.id === 1) {
            clearTimeout(timer);
            ws.close();
            resolve(msg);
          }
        });
        ws.addEventListener('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      const val = cdpResult.result && cdpResult.result.result && cdpResult.result.result.value;
      assert.deepEqual(val, {
        shallowCopyEmitted: 0,
        inlineFallbackEmitted: 0,
        genuineChangeActor: '3003003'
      });
    } finally {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch (_ignore) {}
      await new Promise((r) => setTimeout(r, 150));
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (_ignore) {}
      fs.rmSync(profileDir, { recursive: true, force: true });
    }
  }
);

test('[P1] Tab opened as A while collection is paused -> switches to B and releases window.__INITIAL_STATE__ -> first enable stays 账号待确认 and counts B reply (+1) after B Viewer, while enabled-at-load tab still bootstraps inline <script>', async () => {
  const NOW_MS = 1794794402000;
  const EXT_ID = 'sparklink_remed_paused_open_inline';
  const POPUP_SENDER = { id: EXT_ID, url: `chrome-extension://${EXT_ID}/src/popup/popup.html` };
  const tabPausedSender = {
    id: EXT_ID,
    tab: { id: 101, active: true },
    frameId: 0,
    documentId: 'doc_101',
    origin: 'https://x.com',
    url: 'https://x.com/home'
  };
  const tabEnabledSender = {
    id: EXT_ID,
    tab: { id: 102, active: true },
    frameId: 0,
    documentId: 'doc_102',
    origin: 'https://x.com',
    url: 'https://x.com/home'
  };

  const localArea = createMockArea();
  const sessionArea = createMockArea();
  const tab101Listeners = new Set();
  const tab102Listeners = new Set();
  let activeTabId = 101;

  const bg = createBackgroundService(
    {
      storage: { local: localArea, session: sessionArea },
      runtime: {
        id: EXT_ID,
        getURL: (p) => `chrome-extension://${EXT_ID}/${p.replace(/^\//, '')}`,
        onMessage: { addListener() {} }
      },
      tabs: {
        async query() {
          return [{ id: activeTabId, active: true }];
        },
        async sendMessage(tabId, msg) {
          if (msg && msg.type === 'PING_X_TAB') return { ok: true, alive: true };
          const set = tabId === 101 ? tab101Listeners : tab102Listeners;
          for (const fn of set) fn(msg, { id: EXT_ID });
          return undefined;
        },
        onRemoved: { addListener() {} }
      }
    },
    { nowFn: () => NOW_MS }
  );

  const inlineScriptNodeA = {
    textContent:
      'window.__INITIAL_STATE__ = {"session":{"user_id":"1001001","user":{"screen_name":"sample_me","name":"示例账号"}}};'
  };

  const replyForB = structuredClone(createTweetFixtures.standardReply.response);
  replyForB.data.create_tweet.tweet_results.result.rest_id = '2122147641553892001';
  replyForB.data.create_tweet.tweet_results.result.legacy.id_str = '2122147641553892001';
  replyForB.data.create_tweet.tweet_results.result.core.user_results.result.rest_id = '9009009';
  replyForB.data.create_tweet.tweet_results.result.core.user_results.result.core.screen_name =
    'second_account';
  replyForB.data.create_tweet.tweet_results.result.legacy.user_id_str = '9009009';

  let pausedInitialStateReads = 0;
  let currentPausedWinState = structuredClone(viewerFixtures.ownProfileInitialState);
  const win101Listeners = new Map();

  // Tab 101 opens as Account A while collection is PAUSED (default disabled state)
  const fakeWin101 = {
    location: { origin: 'https://x.com', href: 'https://x.com/home' },
    document: {
      visibilityState: 'visible',
      addEventListener() {},
      removeEventListener() {},
      querySelector: () => null,
      querySelectorAll(sel) {
        if (sel === 'script:not([src])') return [inlineScriptNodeA];
        return [];
      }
    },
    fetch(url) {
      if (String(url).includes('Viewer')) {
        return Promise.resolve(
          new Response(JSON.stringify(viewerFixtures.viewerGraphqlLegacy), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
        );
      }
      if (String(url).includes('CreateTweet')) {
        return Promise.resolve(
          new Response(JSON.stringify(replyForB), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
        );
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    },
    addEventListener(type, fn) {
      if (!win101Listeners.has(type)) win101Listeners.set(type, new Set());
      win101Listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      if (win101Listeners.has(type)) win101Listeners.get(type).delete(fn);
    },
    postMessage(data, origin) {
      queueMicrotask(() => {
        const set = win101Listeners.get('message');
        if (set) {
          for (const fn of set) fn({ data, origin, source: fakeWin101 });
        }
      });
    }
  };
  Object.defineProperty(fakeWin101, '__INITIAL_STATE__', {
    configurable: true,
    enumerable: true,
    get() {
      pausedInitialStateReads += 1;
      return currentPausedWinState;
    }
  });
  fakeWin101.top = fakeWin101;

  const pageChrome101 = {
    runtime: {
      id: EXT_ID,
      sendMessage: (msg) => bg.handleMessage(msg, tabPausedSender),
      onMessage: {
        addListener: (fn) => tab101Listeners.add(fn),
        removeListener: (fn) => tab101Listeners.delete(fn)
      }
    }
  };

  installMainInterceptor(fakeWin101, adapterApi, { nowFn: () => NOW_MS });
  const bridge101 = installIsolatedBridge(fakeWin101, pageChrome101, {
    nowFn: () => NOW_MS,
    retryDelayMs: 5
  });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(
    pausedInitialStateReads,
    0,
    'Tab opened while paused must perform 0 window.__INITIAL_STATE__ reads while paused'
  );

  // User switches to Account B in-page while STILL paused: page receives B's Viewer response and releases window.__INITIAL_STATE__
  await fakeWin101.fetch('https://x.com/i/api/graphql/ViewerQid/Viewer');
  await new Promise((r) => setTimeout(r, 25));
  delete fakeWin101.__INITIAL_STATE__;

  // User enables collection for the FIRST time!
  await bg.handleMessage({ type: 'SET_COLLECTION_ENABLED', enabled: true }, POPUP_SENDER);
  await new Promise((r) => setTimeout(r, 45));

  const { doc: popupDoc, nodes: popupNodes } = createPopupDomHarness();
  const popup = createPopupController({
    document: popupDoc,
    runtime: { sendMessage: (m) => bg.handleMessage(m, POPUP_SENDER) }
  });
  const snapAfterFirstEnable = await popup.init();

  assert.equal(
    bridge101.getBindingContext(),
    null,
    'Tab opened while paused must NOT bind stale Account A from initial HTML inline <script> on first enable'
  );
  assert.equal(snapAfterFirstEnable.viewerStatus, 'unconfirmed');
  assert.equal(popupNodes.get('viewer-status-badge').textContent, '账号待确认');

  // Fresh B Viewer arrives -> binds B and records B's first reply (+1)
  await fakeWin101.fetch('https://x.com/i/api/graphql/ViewerQid/Viewer');
  await new Promise((r) => setTimeout(r, 35));
  assert.equal(bridge101.getBindingContext().actorUserId, '9009009');

  await fakeWin101.fetch('https://x.com/i/api/graphql/ReplyQid/CreateTweet', {
    method: 'POST',
    body: JSON.stringify(createTweetFixtures.standardReply.requestBody)
  });
  await new Promise((r) => setTimeout(r, 40));
  const snapAfterBReply = await popup.refresh();
  assert.equal(snapAfterBReply.selectedAccount.actorUserId, '9009009');
  assert.equal(snapAfterBReply.selectedAccount.summary.totalReplies, 1);

  // Verify a brand-new Tab 102 loaded while collection is ALREADY enabled still bootstraps from inline <script> when __INITIAL_STATE__ is absent
  activeTabId = 102;
  const win102Listeners = new Map();
  const fakeWin102 = {
    location: { origin: 'https://x.com', href: 'https://x.com/home' },
    document: {
      visibilityState: 'visible',
      addEventListener() {},
      removeEventListener() {},
      querySelector: () => null,
      querySelectorAll(sel) {
        if (sel === 'script:not([src])') return [inlineScriptNodeA];
        return [];
      }
    },
    fetch: () => Promise.resolve(new Response('{}', { status: 200 })),
    addEventListener(type, fn) {
      if (!win102Listeners.has(type)) win102Listeners.set(type, new Set());
      win102Listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      if (win102Listeners.has(type)) win102Listeners.get(type).delete(fn);
    },
    postMessage(data, origin) {
      queueMicrotask(() => {
        const set = win102Listeners.get('message');
        if (set) {
          for (const fn of set) fn({ data, origin, source: fakeWin102 });
        }
      });
    }
  };
  fakeWin102.top = fakeWin102;
  const pageChrome102 = {
    runtime: {
      id: EXT_ID,
      sendMessage: (msg) => bg.handleMessage(msg, tabEnabledSender),
      onMessage: {
        addListener: (fn) => tab102Listeners.add(fn),
        removeListener: (fn) => tab102Listeners.delete(fn)
      }
    }
  };
  installMainInterceptor(fakeWin102, adapterApi, { nowFn: () => NOW_MS });
  const bridge102 = installIsolatedBridge(fakeWin102, pageChrome102, {
    nowFn: () => NOW_MS,
    retryDelayMs: 5
  });
  await new Promise((r) => setTimeout(r, 45));
  assert.ok(bridge102.getBindingContext());
  assert.equal(bridge102.getBindingContext().actorUserId, '1001001');

  bridge101.destroy();
  bridge102.destroy();
});

test('[P2] Transient SideNav_AccountSwitcher_Button stale @handle blocks premature bind without poisoning dynamic viewer A, allowing visibilitychange recheck to bind A and record first reply (+1)', async () => {
  const NOW_MS = 1794794402000;
  const EXT_ID = 'sparklink_remed_transient_switcher';
  const POPUP_SENDER = { id: EXT_ID, url: `chrome-extension://${EXT_ID}/src/popup/popup.html` };
  const tabSender = {
    id: EXT_ID,
    tab: { id: 103, active: true },
    frameId: 0,
    documentId: 'doc_103',
    origin: 'https://x.com',
    url: 'https://x.com/home'
  };

  const localArea = createMockArea();
  const sessionArea = createMockArea();
  const tabListeners = new Set();
  const docVisibilityListeners = new Set();

  const bg = createBackgroundService(
    {
      storage: { local: localArea, session: sessionArea },
      runtime: {
        id: EXT_ID,
        getURL: (p) => `chrome-extension://${EXT_ID}/${p.replace(/^\//, '')}`,
        onMessage: { addListener() {} }
      },
      tabs: {
        async query() {
          return [{ id: 103, active: true }];
        },
        async sendMessage(_tabId, msg) {
          if (msg && msg.type === 'PING_X_TAB') return { ok: true, alive: true };
          for (const fn of tabListeners) fn(msg, { id: EXT_ID });
          return undefined;
        },
        onRemoved: { addListener() {} }
      }
    },
    { nowFn: () => NOW_MS }
  );

  // Dynamic state is already Account A (@sample_me, 1001001), while switcher button briefly shows @second_account (B)
  let switcherText = 'Second Account @second_account';
  let visibilityState = 'visible';
  const winListeners = new Map();

  const replyForA = structuredClone(createTweetFixtures.standardReply.response);
  replyForA.data.create_tweet.tweet_results.result.rest_id = '2122147641553893001';
  replyForA.data.create_tweet.tweet_results.result.legacy.id_str = '2122147641553893001';

  const fakeWin = {
    location: { origin: 'https://x.com', href: 'https://x.com/home' },
    document: {
      get visibilityState() {
        return visibilityState;
      },
      addEventListener(type, fn) {
        if (type === 'visibilitychange') docVisibilityListeners.add(fn);
      },
      removeEventListener(type, fn) {
        if (type === 'visibilitychange') docVisibilityListeners.delete(fn);
      },
      querySelector(sel) {
        if (sel === '[data-testid="SideNav_AccountSwitcher_Button"]') {
          return { textContent: switcherText };
        }
        return null;
      },
      querySelectorAll: () => []
    },
    __INITIAL_STATE__: structuredClone(viewerFixtures.ownProfileInitialState),
    fetch(url) {
      if (String(url).includes('CreateTweet')) {
        return Promise.resolve(
          new Response(JSON.stringify(replyForA), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
        );
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    },
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, new Set());
      winListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      if (winListeners.has(type)) winListeners.get(type).delete(fn);
    },
    postMessage(data, origin) {
      queueMicrotask(() => {
        const set = winListeners.get('message');
        if (set) {
          for (const fn of set) fn({ data, origin, source: fakeWin });
        }
      });
    }
  };
  fakeWin.top = fakeWin;

  const pageChrome = {
    runtime: {
      id: EXT_ID,
      sendMessage: (msg) => bg.handleMessage(msg, tabSender),
      onMessage: {
        addListener: (fn) => tabListeners.add(fn),
        removeListener: (fn) => tabListeners.delete(fn)
      }
    }
  };

  await bg.handleMessage({ type: 'SET_COLLECTION_ENABLED', enabled: true }, POPUP_SENDER);
  installMainInterceptor(fakeWin, adapterApi, { nowFn: () => NOW_MS });
  const bridge = installIsolatedBridge(fakeWin, pageChrome, { nowFn: () => NOW_MS, retryDelayMs: 5 });
  await new Promise((r) => setTimeout(r, 40));

  // 1. Initial probe blocked because switcher button briefly displays @second_account
  assert.equal(bridge.getBindingContext(), null);

  // 2. Switcher button updates to @sample_me; user switches away and returns to tab -> triggers visibilitychange recheck
  switcherText = '示例账号 @sample_me';
  visibilityState = 'hidden';
  for (const fn of docVisibilityListeners) fn();
  visibilityState = 'visible';
  for (const fn of docVisibilityListeners) fn();
  await new Promise((r) => setTimeout(r, 45));

  assert.ok(
    bridge.getBindingContext(),
    'Subsequent visibilitychange recheck after switcher button updates to @sample_me must bind Account A'
  );
  assert.equal(bridge.getBindingContext().actorUserId, '1001001');

  // 3. Account A sends first reply -> MUST be counted (+1)!
  await fakeWin.fetch('https://x.com/i/api/graphql/ReplyQid/CreateTweet', {
    method: 'POST',
    body: JSON.stringify(createTweetFixtures.standardReply.requestBody)
  });
  await new Promise((r) => setTimeout(r, 40));

  const snap = await bg.handleMessage({ type: 'GET_POPUP_SNAPSHOT' }, POPUP_SENDER);
  assert.equal(snap.selectedAccount.actorUserId, '1001001');
  assert.equal(snap.selectedAccount.summary.totalReplies, 1);

  bridge.destroy();
});

test(
  '[P1] & [P2] Real Chromium CDP verification: paused-at-load tab inline <script> guard and transient SideNav_AccountSwitcher_Button recheck',
  { skip: !fs.existsSync('/usr/bin/chromium') || !fs.existsSync('/usr/bin/xvfb-run') },
  async () => {
    const adapterSource = fs.readFileSync(path.resolve('src/x-adapter.js'), 'utf8');
    const interceptorSource = fs.readFileSync(path.resolve('src/interceptor.js'), 'utf8');
    const bridgeSource = fs.readFileSync(path.resolve('src/bridge.js'), 'utf8');
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparklink-chromium-paused-recheck-'));
    const child = spawn(
      '/usr/bin/xvfb-run',
      [
        '-a',
        '/usr/bin/chromium',
        '--remote-debugging-port=0',
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${profileDir}`,
        'about:blank'
      ],
      { stdio: ['ignore', 'ignore', 'ignore'], detached: true }
    );

    try {
      const portFile = path.join(profileDir, 'DevToolsActivePort');
      let port = null;
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        if (fs.existsSync(portFile)) {
          const lines = fs.readFileSync(portFile, 'utf8').trim().split('\n');
          if (lines[0] && /^\d+$/.test(lines[0].trim())) {
            port = Number(lines[0].trim());
            break;
          }
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      assert.ok(port, 'Chromium DevToolsActivePort must initialize');

      let pageTarget = null;
      const pageDeadline = Date.now() + 6000;
      while (Date.now() < pageDeadline) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/json`);
          if (res.ok) {
            const targets = await res.json();
            pageTarget = targets.find(
              (t) => t.type === 'page' && t.url === 'about:blank' && t.webSocketDebuggerUrl
            );
            if (pageTarget) break;
          }
        } catch (_ignore) {}
        await new Promise((r) => setTimeout(r, 120));
      }
      assert.ok(pageTarget, 'Chromium page target must be available');

      const setupExpr = `(() => {
        const loadCjs = (src) => {
          const exportsObj = {};
          const mod = { exports: exportsObj };
          new Function('module', 'exports', src)(mod, exportsObj);
          return mod.exports;
        };
        window.__sparkTestLoad = loadCjs;
        window.__sparkTestAdapter = loadCjs(${JSON.stringify(adapterSource)});
        window.__sparkTestInterceptor = loadCjs(${JSON.stringify(interceptorSource)});
        return true;
      })()`;

      const evalExpr = `(async () => {
        const adapter = window.__sparkTestAdapter;
        const { installMainInterceptor } = window.__sparkTestInterceptor;
        const { installIsolatedBridge } = window.__sparkTestLoad(${JSON.stringify(bridgeSource)});

        // Scenario 1: Paused-at-load real DOM with inline <script> A -> switch to B & delete __INITIAL_STATE__ -> first enable
        document.head.replaceChildren();
        document.body.replaceChildren();
        const ssrScript = document.createElement('script');
        ssrScript.type = 'text/plain';
        ssrScript.textContent = 'window.__INITIAL_STATE__ = {"session":{"user_id":"1001001","user":{"screen_name":"sample_me","name":"A"}}};';
        document.head.appendChild(ssrScript);

        let bgEnabled = false;
        let bgSessionId = null;
        let bgBinding = null;
        const runtimeListeners = new Set();
        const win1Listeners = new Set();
        const fakeWin1 = {
          location: { origin: 'https://x.com', href: 'https://x.com/home' },
          document,
          __INITIAL_STATE__: { session: { user_id: '1001001', user: { screen_name: 'sample_me', name: 'A' } } },
          fetch: async () => new Response('{}', { status: 200 }),
          addEventListener: (t, fn) => { if (t === 'message') win1Listeners.add(fn); },
          removeEventListener: (t, fn) => { if (t === 'message') win1Listeners.delete(fn); },
          postMessage: (data, origin) => queueMicrotask(() => {
            for (const fn of win1Listeners) fn({ data, origin, source: fakeWin1 });
          })
        };
        fakeWin1.top = fakeWin1;

        const fakeChrome1 = {
          runtime: {
            id: 'ext_cdp',
            async sendMessage(msg) {
              if (msg.type === 'HELLO') {
                return { ok: true, collectionEnabled: bgEnabled, captureSessionId: bgSessionId, bindingContext: bgBinding, revision: 1 };
              }
              if (msg.type === 'BIND_VIEWER') {
                bgBinding = { bindingId: 'b_' + msg.viewer.actorUserId, actorUserId: msg.viewer.actorUserId, captureSessionId: bgSessionId, collectionGeneration: 1, accountGeneration: 1 };
                return { ok: true, bindingContext: bgBinding, revision: 2 };
              }
              return { ok: true };
            },
            onMessage: { addListener: (fn) => runtimeListeners.add(fn), removeListener: (fn) => runtimeListeners.delete(fn) }
          }
        };

        installMainInterceptor(fakeWin1, adapter);
        const bridge1 = installIsolatedBridge(fakeWin1, fakeChrome1, { retryDelayMs: 5 });
        await new Promise((r) => setTimeout(r, 35));

        // While paused, release __INITIAL_STATE__ (leaving real DOM <script> A) and enable collection for the first time
        delete fakeWin1.__INITIAL_STATE__;
        bgEnabled = true;
        bgSessionId = 1;
        for (const fn of runtimeListeners) fn({ type: 'STATE_CHANGED', collectionEnabled: true, captureSessionId: 1 }, { id: 'ext_cdp' });
        await new Promise((r) => setTimeout(r, 40));
        const pausedOpenFirstEnableActor = bridge1.getBindingContext() ? bridge1.getBindingContext().actorUserId : null;
        bridge1.destroy();

        // Scenario 2: Real DOM SideNav_AccountSwitcher_Button briefly shows @second_account while __INITIAL_STATE__ is @sample_me, then updates to @sample_me
        const switcherBtn = document.createElement('button');
        switcherBtn.setAttribute('data-testid', 'SideNav_AccountSwitcher_Button');
        switcherBtn.textContent = 'B @second_account';
        document.body.appendChild(switcherBtn);

        let bg2Binding = null;
        const win2Listeners = new Set();
        const fakeWin2 = {
          location: { origin: 'https://x.com', href: 'https://x.com/home' },
          document,
          __INITIAL_STATE__: { session: { user_id: '1001001', user: { screen_name: 'sample_me', name: 'A' } } },
          fetch: async () => new Response('{}', { status: 200 }),
          addEventListener: (t, fn) => { if (t === 'message') win2Listeners.add(fn); },
          removeEventListener: (t, fn) => { if (t === 'message') win2Listeners.delete(fn); },
          postMessage: (data, origin) => queueMicrotask(() => {
            for (const fn of win2Listeners) fn({ data, origin, source: fakeWin2 });
          })
        };
        fakeWin2.top = fakeWin2;
        const fakeChrome2 = {
          runtime: {
            id: 'ext_cdp',
            async sendMessage(msg) {
              if (msg.type === 'HELLO') {
                return { ok: true, collectionEnabled: true, captureSessionId: 2, bindingContext: bg2Binding, revision: 1 };
              }
              if (msg.type === 'BIND_VIEWER') {
                bg2Binding = { bindingId: 'b2_' + msg.viewer.actorUserId, actorUserId: msg.viewer.actorUserId, captureSessionId: 2, collectionGeneration: 1, accountGeneration: 1 };
                return { ok: true, bindingContext: bg2Binding, revision: 2 };
              }
              return { ok: true };
            },
            onMessage: { addListener() {}, removeListener() {} }
          }
        };
        installMainInterceptor(fakeWin2, adapter);
        const bridge2 = installIsolatedBridge(fakeWin2, fakeChrome2, { retryDelayMs: 5 });
        await new Promise((r) => setTimeout(r, 35));
        const beforeSwitcherCatchup = bridge2.getBindingContext() ? bridge2.getBindingContext().actorUserId : null;

        switcherBtn.textContent = 'A @sample_me';
        document.dispatchEvent(new Event('visibilitychange'));
        await new Promise((r) => setTimeout(r, 40));
        const afterSwitcherCatchup = bridge2.getBindingContext() ? bridge2.getBindingContext().actorUserId : null;
        bridge2.destroy();

        return {
          pausedOpenFirstEnableActor,
          beforeSwitcherCatchup,
          afterSwitcherCatchup
        };
      })()`;

      const cdpResult = await new Promise((resolve, reject) => {
        const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
        const timer = setTimeout(() => {
          ws.close();
          reject(new Error('CDP Runtime.evaluate timed out'));
        }, 8000);
        ws.addEventListener('open', () => {
          ws.send(
            JSON.stringify({
              id: 1,
              method: 'Runtime.evaluate',
              params: { expression: setupExpr, returnByValue: true }
            })
          );
        });
        ws.addEventListener('message', (ev) => {
          const msg = JSON.parse(String(ev.data));
          if (msg.id === 1) {
            ws.send(
              JSON.stringify({
                id: 2,
                method: 'Runtime.evaluate',
                params: { expression: evalExpr, awaitPromise: true, returnByValue: true }
              })
            );
          } else if (msg.id === 2) {
            clearTimeout(timer);
            ws.close();
            resolve(msg);
          }
        });
        ws.addEventListener('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      const val = cdpResult.result && cdpResult.result.result && cdpResult.result.result.value;
      assert.deepEqual(val, {
        pausedOpenFirstEnableActor: null,
        beforeSwitcherCatchup: null,
        afterSwitcherCatchup: '1001001'
      });
    } finally {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch (_ignore) {}
      await new Promise((r) => setTimeout(r, 150));
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (_ignore) {}
      fs.rmSync(profileDir, { recursive: true, force: true });
    }
  }
);

test('[P2] Unconfirmed state retains previously viewed Account B in open/reopened Popup and awaits explicit user choice on brand-new unconfirmed tabs instead of auto-switching to savedAccounts[0] (Account A)', async () => {
  const NOW_MS = 1794794402000;
  const EXT_ID = 'sparklink_remed_popup_unconfirmed_retain';
  const POPUP_SENDER = { id: EXT_ID, url: `chrome-extension://${EXT_ID}/src/popup/popup.html` };
  const tabBSender = {
    id: EXT_ID,
    tab: { id: 105, active: true },
    frameId: 0,
    documentId: 'doc_105_b',
    origin: 'https://x.com',
    url: 'https://x.com/home'
  };
  const freshTabSender = {
    id: EXT_ID,
    tab: { id: 106, active: true },
    frameId: 0,
    documentId: 'doc_106_fresh',
    origin: 'https://x.com',
    url: 'https://x.com/home'
  };

  let fgTabId = 105;
  const localArea = createMockArea();
  const sessionArea = createMockArea();

  const bg = createBackgroundService(
    {
      storage: { local: localArea, session: sessionArea },
      runtime: {
        id: EXT_ID,
        getURL: (p) => `chrome-extension://${EXT_ID}/${p.replace(/^\//, '')}`,
        onMessage: { addListener() {} }
      },
      tabs: {
        async query() {
          return [{ id: fgTabId, active: true }];
        },
        async sendMessage(_tabId, msg) {
          if (msg && msg.type === 'PING_X_TAB') return { ok: true, alive: true };
          return undefined;
        },
        onRemoved: { addListener() {} }
      }
    },
    { nowFn: () => NOW_MS }
  );

  // 1. Seed Account A ('1001001', 1 reply) and bind Tab 105 to Account B ('9009009', 0 replies)
  const enable1 = await bg.handleMessage({ type: 'SET_COLLECTION_ENABLED', enabled: true }, POPUP_SENDER);
  await bg.handleMessage({ type: 'HELLO' }, tabBSender);
  const bindA = await bg.handleMessage(
    {
      type: 'BIND_VIEWER',
      captureSessionId: enable1.settings.captureSessionId,
      viewer: { actorUserId: '1001001', handle: 'alice_first', displayName: 'Alice' }
    },
    tabBSender
  );
  await bg.handleMessage(
    {
      type: 'SUBMIT_OBSERVED_BATCH',
      bindingContext: bindA.bindingContext,
      events: [
        {
          actorUserId: '1001001',
          replyTweetId: '2122147641553894001',
          parentTweetId: '2121785253688246272',
          targetUserId: '2002002',
          targetHandle: 'friend_1',
          targetDisplayName: 'Friend 1',
          createdAt: NOW_MS - 2000,
          observedAt: NOW_MS - 1000,
          source: 'live'
        }
      ]
    },
    tabBSender
  );
  await bg.handleMessage(
    {
      type: 'BIND_VIEWER',
      captureSessionId: enable1.settings.captureSessionId,
      viewer: { actorUserId: '9009009', handle: 'bob_second', displayName: 'Bob' }
    },
    tabBSender
  );

  // 2. Open Popup -> displays Account B (0 replies), user never touches account-select
  const { doc: popupDoc, nodes: popupNodes } = createPopupDomHarness();
  const popup = createPopupController({
    document: popupDoc,
    runtime: { sendMessage: (m) => bg.handleMessage(m, POPUP_SENDER) }
  });
  const snapInitial = await popup.init();
  assert.equal(snapInitial.viewerStatus, 'bound');
  assert.equal(snapInitial.selectedAccount.actorUserId, '9009009');
  assert.equal(popupNodes.get('account-select').value, '9009009');
  assert.equal(popupNodes.get('stat-total-replies').textContent, '0');

  // 3. Click Pause then Resume inside the SAME open Popup -> viewerStatus is 账号待确认, MUST retain Account B (0 replies)!
  popupNodes.get('collection-toggle').checked = false;
  await popupNodes.get('collection-toggle').trigger('change');
  assert.equal(popupNodes.get('viewer-status-badge').textContent, '已暂停');
  assert.equal(popupNodes.get('account-select').value, '9009009');
  assert.equal(popupNodes.get('stat-total-replies').textContent, '0');

  popupNodes.get('collection-toggle').checked = true;
  await popupNodes.get('collection-toggle').trigger('change');
  assert.equal(popupNodes.get('viewer-status-badge').textContent, '账号待确认');
  assert.equal(popupNodes.get('account-select').value, '9009009');
  assert.equal(popupNodes.get('stat-total-replies').textContent, '0');

  // 4. Reopen a brand-new Popup panel on the SAME Tab 105 while still unconfirmed -> still retains Tab 105's last confirmed Account B!
  const { doc: reopenedDoc, nodes: reopenedNodes } = createPopupDomHarness();
  const reopenedPopup = createPopupController({
    document: reopenedDoc,
    runtime: { sendMessage: (m) => bg.handleMessage(m, POPUP_SENDER) }
  });
  const snapReopened = await reopenedPopup.init();
  assert.equal(snapReopened.viewerStatus, 'unconfirmed');
  assert.equal(snapReopened.selectedAccount.actorUserId, '9009009');
  assert.equal(reopenedNodes.get('account-select').value, '9009009');
  assert.equal(reopenedNodes.get('stat-total-replies').textContent, '0');

  // 5. Switch foreground to a brand-new unconfirmed X Tab 106 (never bound any account) and open a fresh Popup ->
  //    MUST NOT auto-select savedAccounts[0] (Account A), instead awaits confirmation or explicit user selection!
  fgTabId = 106;
  await bg.handleMessage({ type: 'HELLO' }, freshTabSender);
  const { doc: freshPopupDoc, nodes: freshPopupNodes } = createPopupDomHarness();
  const freshPopup = createPopupController({
    document: freshPopupDoc,
    runtime: { sendMessage: (m) => bg.handleMessage(m, POPUP_SENDER) }
  });
  const snapFreshUnconfirmed = await freshPopup.init();
  assert.equal(snapFreshUnconfirmed.viewerStatus, 'unconfirmed');
  assert.equal(snapFreshUnconfirmed.selectedAccount, null);
  assert.equal(freshPopupNodes.get('account-select').value, '');
  assert.equal(freshPopupNodes.get('stat-total-replies').textContent, '0');
  assert.equal(freshPopupNodes.get('btn-clear-account').disabled, true);

  // User explicitly chooses Account A in dropdown -> now displays Account A's 1 reply!
  freshPopupNodes.get('account-select').value = '1001001';
  await freshPopupNodes.get('account-select').trigger('change');
  assert.equal(freshPopupNodes.get('account-select').value, '1001001');
  assert.equal(freshPopupNodes.get('stat-total-replies').textContent, '1');
});

test('[P1] & [P2] Paused-at-load snapshot freshness & segmented DOM matrix: historical snapshots without switcher handle stay unconfirmed, nested spans corroborate, segmented text runs veto prefix match, and same-session binding loss resets GraphQL cache', async () => {
  const NOW_MS = 1794794402000;
  const EXT_ID = 'sparklink_remed_paused_freshness_matrix';
  const POPUP_SENDER = { id: EXT_ID, url: `chrome-extension://${EXT_ID}/src/popup/popup.html` };

  const localArea = createMockArea();
  const sessionArea = createMockArea();
  let fgTabId = 201;
  const tabListenersByTab = new Map();

  const bg = createBackgroundService(
    {
      storage: { local: localArea, session: sessionArea },
      runtime: {
        id: EXT_ID,
        getURL: (p) => `chrome-extension://${EXT_ID}/${p.replace(/^\//, '')}`,
        onMessage: { addListener() {} }
      },
      tabs: {
        query: async () => [{ id: fgTabId, active: true }],
        sendMessage: async (tid, msg) => {
          const set = tabListenersByTab.get(tid);
          if (!set || set.size === 0) {
            throw new Error('No content script');
          }
          let responseVal = { ok: true };
          for (const fn of set) {
            fn(msg, { id: EXT_ID }, (r) => {
              responseVal = r;
            });
          }
          return responseVal;
        },
        onRemoved: { addListener() {} }
      }
    },
    { nowFn: () => NOW_MS }
  );

  const viewerBGraphql = {
    data: {
      viewer: {
        user_results: {
          result: {
            __typename: 'User',
            rest_id: '9009009',
            core: { screen_name: 'second_account', name: '第二账号' },
            legacy: {}
          }
        }
      }
    }
  };
  const replyByB1 = structuredClone(createTweetFixtures.standardReply.response);
  replyByB1.data.create_tweet.tweet_results.result.rest_id = '2122147641553971001';
  replyByB1.data.create_tweet.tweet_results.result.legacy.id_str = '2122147641553971001';
  replyByB1.data.create_tweet.tweet_results.result.core.user_results.result.rest_id = '9009009';
  replyByB1.data.create_tweet.tweet_results.result.core.user_results.result.core.screen_name = 'second_account';
  replyByB1.data.create_tweet.tweet_results.result.legacy.user_id_str = '9009009';

  const replyByB2 = structuredClone(replyByB1);
  replyByB2.data.create_tweet.tweet_results.result.rest_id = '2122147641553971002';
  replyByB2.data.create_tweet.tweet_results.result.legacy.id_str = '2122147641553971002';

  function makeTabHarness(tabId, docId, { inlineJson = null, initialState = undefined, switcherEl = null }) {
    const sender = {
      id: EXT_ID,
      tab: { id: tabId, active: true },
      frameId: 0,
      documentId: docId,
      origin: 'https://x.com',
      url: 'https://x.com/home'
    };
    const winListeners = new Map();
    const tabSet = new Set();
    tabListenersByTab.set(tabId, tabSet);

    let stateObj = initialState;
    let stateReads = 0;
    const inlineScripts = inlineJson
      ? [{ textContent: `window.__INITIAL_STATE__ = ${inlineJson};` }]
      : [];

    const fakeWin = {
      location: { origin: 'https://x.com', href: 'https://x.com/home' },
      document: {
        visibilityState: 'visible',
        addEventListener(type, fn) {
          if (!winListeners.has(`doc:${type}`)) winListeners.set(`doc:${type}`, new Set());
          winListeners.get(`doc:${type}`).add(fn);
        },
        removeEventListener(type, fn) {
          if (winListeners.has(`doc:${type}`)) winListeners.get(`doc:${type}`).delete(fn);
        },
        querySelector: (sel) =>
          sel === '[data-testid="SideNav_AccountSwitcher_Button"]' ? switcherEl : null,
        querySelectorAll: (sel) => (sel === 'script:not([src])' ? inlineScripts : [])
      },
      fetch(url) {
        if (String(url).includes('ViewerA')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                data: {
                  viewer: {
                    user_results: {
                      result: {
                        __typename: 'User',
                        rest_id: '1001001',
                        core: { screen_name: 'sample_me', name: 'A' },
                        legacy: {}
                      }
                    }
                  }
                }
              }),
              {
                status: 200,
                headers: { 'content-type': 'application/json' }
              }
            )
          );
        }
        if (String(url).includes('Viewer')) {
          return Promise.resolve(
            new Response(JSON.stringify(viewerBGraphql), {
              status: 200,
              headers: { 'content-type': 'application/json' }
            })
          );
        }
        if (String(url).includes('ReplyA1')) {
          const replyByA1 = structuredClone(createTweetFixtures.standardReply.response);
          replyByA1.data.create_tweet.tweet_results.result.rest_id = '2122147641553971009';
          replyByA1.data.create_tweet.tweet_results.result.legacy.id_str = '2122147641553971009';
          return Promise.resolve(
            new Response(JSON.stringify(replyByA1), {
              status: 200,
              headers: { 'content-type': 'application/json' }
            })
          );
        }
        if (String(url).includes('ReplyB1')) {
          return Promise.resolve(
            new Response(JSON.stringify(replyByB1), {
              status: 200,
              headers: { 'content-type': 'application/json' }
            })
          );
        }
        if (String(url).includes('ReplyB2')) {
          return Promise.resolve(
            new Response(JSON.stringify(replyByB2), {
              status: 200,
              headers: { 'content-type': 'application/json' }
            })
          );
        }
        return Promise.resolve(new Response('{}', { status: 200 }));
      },
      addEventListener(type, fn) {
        if (!winListeners.has(type)) winListeners.set(type, new Set());
        winListeners.get(type).add(fn);
      },
      removeEventListener(type, fn) {
        if (winListeners.has(type)) winListeners.get(type).delete(fn);
      },
      postMessage(data, origin) {
        queueMicrotask(() => {
          const set = winListeners.get('message');
          if (set) {
            for (const fn of set) fn({ data, origin, source: fakeWin });
          }
        });
      }
    };
    fakeWin.top = fakeWin;
    Object.defineProperty(fakeWin, '__INITIAL_STATE__', {
      configurable: true,
      enumerable: true,
      get() {
        stateReads += 1;
        return stateObj;
      },
      set(v) {
        stateObj = v;
      }
    });

    const pageChrome = {
      runtime: {
        id: EXT_ID,
        sendMessage: (msg) => bg.handleMessage(msg, sender),
        onMessage: {
          addListener: (fn) => tabSet.add(fn),
          removeListener: (fn) => tabSet.delete(fn)
        }
      }
    };

    const interceptor = installMainInterceptor(fakeWin, adapterApi, { nowFn: () => NOW_MS });
    const bridge = installIsolatedBridge(fakeWin, pageChrome, { nowFn: () => NOW_MS, retryDelayMs: 5 });
    return {
      fakeWin,
      interceptor,
      bridge,
      getStateReads: () => stateReads,
      triggerVisibility() {
        const set = winListeners.get('doc:visibilitychange');
        if (set) {
          for (const fn of set) fn();
        }
      }
    };
  }

  // Case 1 (Finding #1): Tab 201 opens as A while paused, switches A -> B while paused,
  // window.__INITIAL_STATE__ STILL holds A, and icon-only switcher button has NO @handle!
  const ssrAJson = JSON.stringify({
    session: { user_id: '1001001', user: { screen_name: 'sample_me', name: 'A' } }
  });
  const tab201 = makeTabHarness(201, 'doc_paused_stale_a', {
    inlineJson: ssrAJson,
    initialState: structuredClone(viewerFixtures.ownProfileInitialState),
    switcherEl: { textContent: 'AvatarOnly', childNodes: [{ nodeType: 3, nodeValue: 'AvatarOnly' }] }
  });
  await new Promise((r) => setTimeout(r, 35));
  assert.equal(tab201.getStateReads(), 0, '0 reads while paused');

  // User switches A -> B while paused (Viewer B response ignored while paused, __INITIAL_STATE__ remains A!)
  await tab201.fakeWin.fetch('https://x.com/i/api/graphql/PausedSwitch/Viewer');
  assert.equal(tab201.getStateReads(), 0);

  // First-time collection enable -> MUST stay 账号待确认 (unconfirmed), NEVER binding stale A!
  await bg.handleMessage({ type: 'SET_COLLECTION_ENABLED', enabled: true }, POPUP_SENDER);
  await new Promise((r) => setTimeout(r, 45));
  assert.equal(tab201.bridge.getBindingContext(), null);
  const snap201Enable = await bg.handleMessage({ type: 'GET_POPUP_SNAPSHOT' }, POPUP_SENDER);
  assert.equal(snap201Enable.viewerStatus, 'unconfirmed');
  assert.equal(snap201Enable.activeTabActorUserId, null);

  // Once fresh B Viewer arrives, Tab 201 binds B and records B's reply (+1)
  await tab201.fakeWin.fetch('https://x.com/i/api/graphql/ActiveConfirmB/Viewer');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(tab201.bridge.getBindingContext().actorUserId, '9009009');
  await tab201.fakeWin.fetch('https://x.com/i/api/graphql/ReplyB1/CreateTweet', {
    method: 'POST',
    body: JSON.stringify(createTweetFixtures.standardReply.requestBody)
  });
  await new Promise((r) => setTimeout(r, 45));
  const snap201Bound = await bg.handleMessage({ type: 'GET_POPUP_SNAPSHOT' }, POPUP_SENDER);
  assert.equal(snap201Bound.selectedAccount.actorUserId, '9009009');
  assert.equal(snap201Bound.selectedAccount.summary.totalReplies, 1);
  tab201.bridge.destroy();

  // Case 2 ([P1] A -> B -> A paused-load ambiguity): Pause again, open Tab 202 as A (inline <script> A),
  // switch A -> B while paused (updating __INITIAL_STATE__ to B), then switch B -> A while still paused
  // WITHOUT rewriting __INITIAL_STATE__ (so inline <script> = A, __INITIAL_STATE__ = B, switcher has NO @handle) ->
  // first-time enable MUST stay 账号待确认 (unconfirmed), NEVER misbinding B, until fresh ViewerA confirms A (+1 reply)!
  await bg.handleMessage({ type: 'SET_COLLECTION_ENABLED', enabled: false }, POPUP_SENDER);
  fgTabId = 202;
  const tab202 = makeTabHarness(202, 'doc_paused_updated_b', {
    inlineJson: ssrAJson,
    initialState: structuredClone(viewerFixtures.ownProfileInitialState),
    switcherEl: null
  });
  await new Promise((r) => setTimeout(r, 35));
  // __INITIAL_STATE__ became B during A -> B, then user switched back B -> A without updating __INITIAL_STATE__
  tab202.fakeWin.__INITIAL_STATE__ = {
    session: { user_id: '9009009', user: { screen_name: 'second_account', name: '第二账号' } }
  };
  await bg.handleMessage({ type: 'SET_COLLECTION_ENABLED', enabled: true }, POPUP_SENDER);
  await new Promise((r) => setTimeout(r, 45));
  assert.equal(
    tab202.bridge.getBindingContext(),
    null,
    'Two differing pre-enable snapshots (inline A vs __INITIAL_STATE__ B) without switcher @handle must stay unconfirmed'
  );
  const snap202Pending = await bg.handleMessage({ type: 'GET_POPUP_SNAPSHOT' }, POPUP_SENDER);
  assert.equal(snap202Pending.viewerStatus, 'unconfirmed');
  assert.equal(snap202Pending.activeTabActorUserId, null);

  // Fresh ViewerA arrives -> binds A (1001001) and counts A's reply (+1)
  await tab202.fakeWin.fetch('https://x.com/i/api/graphql/ViewerA/Viewer');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(tab202.bridge.getBindingContext().actorUserId, '1001001');
  await tab202.fakeWin.fetch('https://x.com/i/api/graphql/ReplyA1/CreateTweet', {
    method: 'POST',
    body: JSON.stringify(createTweetFixtures.standardReply.requestBody)
  });
  await new Promise((r) => setTimeout(r, 45));
  const snap202 = await bg.handleMessage({ type: 'GET_POPUP_SNAPSHOT' }, POPUP_SENDER);
  assert.equal(snap202.selectedAccount.actorUserId, '1001001');
  assert.equal(snap202.selectedAccount.summary.totalReplies, 1);
  tab202.bridge.destroy();

  // Case 3 (Audit Cousin A1): Paused-at-load Tab 203 with NO inline <script>, __INITIAL_STATE__ = A (@sample_me),
  // and nested SideNav_AccountSwitcher_Button `<div><span>Alice</span></div><div><span>@sample_me</span></div>`
  // whose concatenated textContent is "Alice@sample_me" (no whitespace before @)!
  await bg.handleMessage({ type: 'SET_COLLECTION_ENABLED', enabled: false }, POPUP_SENDER);
  fgTabId = 203;
  const nestedSwitcher = {
    textContent: 'Alice@sample_me',
    childNodes: [
      {
        nodeType: 1,
        textContent: 'Alice',
        childNodes: [{ nodeType: 3, nodeValue: 'Alice' }]
      },
      {
        nodeType: 1,
        textContent: '@sample_me',
        childNodes: [{ nodeType: 3, nodeValue: '@sample_me' }]
      }
    ]
  };
  const tab203 = makeTabHarness(203, 'doc_paused_nested_switcher', {
    inlineJson: null,
    initialState: structuredClone(viewerFixtures.ownProfileInitialState),
    switcherEl: nestedSwitcher
  });
  await new Promise((r) => setTimeout(r, 35));
  await bg.handleMessage({ type: 'SET_COLLECTION_ENABLED', enabled: true }, POPUP_SENDER);
  await new Promise((r) => setTimeout(r, 45));
  assert.equal(
    tab203.bridge.getBindingContext() && tab203.bridge.getBindingContext().actorUserId,
    '1001001',
    'Nested DOM spans inside SideNav_AccountSwitcher_Button must corroborate @sample_me even without whitespace in textContent'
  );
  tab203.bridge.destroy();

  // Case 4 ([P2] Segmented switcher text nodes + unconfirmed re-pause before live switcher corroboration):
  // Tab 204 has __INITIAL_STATE__ = A (@sample_me), while SideNav_AccountSwitcher_Button renders @sample_me_alt
  // split across adjacent Text("@sample_me") + Text("_alt")! MUST stay unconfirmed (never prefix-matching @sample_me)!
  // Even across a second Pause -> Resume while still unconfirmed, once switcher renders @sample_me it corroborates A cleanly!
  await bg.handleMessage({ type: 'SET_COLLECTION_ENABLED', enabled: false }, POPUP_SENDER);
  fgTabId = 204;
  let dynamicSwitcher204 = {
    tagName: 'BUTTON',
    textContent: '@sample_me_alt',
    childNodes: [
      {
        nodeType: 1,
        tagName: 'SPAN',
        textContent: '@sample_me_alt',
        childNodes: [
          { nodeType: 3, nodeValue: '@sample_me' },
          { nodeType: 3, nodeValue: '_alt' }
        ]
      }
    ]
  };
  const tab204 = makeTabHarness(204, 'doc_paused_segmented_switcher', {
    inlineJson: null,
    initialState: structuredClone(viewerFixtures.ownProfileInitialState),
    switcherEl: null
  });
  tab204.fakeWin.document.querySelector = (sel) =>
    sel === '[data-testid="SideNav_AccountSwitcher_Button"]' ? dynamicSwitcher204 : null;
  await new Promise((r) => setTimeout(r, 35));
  await bg.handleMessage({ type: 'SET_COLLECTION_ENABLED', enabled: true }, POPUP_SENDER);
  await new Promise((r) => setTimeout(r, 45));
  assert.equal(
    tab204.bridge.getBindingContext(),
    null,
    'Adjacent Text("@sample_me") + Text("_alt") must be coalesced as @sample_me_alt and NEVER prefix-match @sample_me'
  );

  // Pause again before any viewer was ever confirmed, then switcher renders segmented Text("@") + Comment + Text("sample_me") -> Resume binds A!
  await bg.handleMessage({ type: 'SET_COLLECTION_ENABLED', enabled: false }, POPUP_SENDER);
  await new Promise((r) => setTimeout(r, 25));
  dynamicSwitcher204 = {
    tagName: 'BUTTON',
    textContent: '@sample_me',
    childNodes: [
      {
        nodeType: 1,
        tagName: 'SPAN',
        textContent: '@sample_me',
        childNodes: [
          { nodeType: 3, nodeValue: '@' },
          { nodeType: 8, nodeValue: '' },
          { nodeType: 3, nodeValue: 'sample_me' }
        ]
      }
    ]
  };
  await bg.handleMessage({ type: 'SET_COLLECTION_ENABLED', enabled: true }, POPUP_SENDER);
  await new Promise((r) => setTimeout(r, 45));
  assert.equal(
    tab204.bridge.getBindingContext() && tab204.bridge.getBindingContext().actorUserId,
    '1001001',
    'Unconfirmed pause must not poison windowSnapshotStale, and segmented "@" + "sample_me" must corroborate 1001001'
  );
  tab204.bridge.destroy();

  // Case 5: Conflicting @handles inside SideNav_AccountSwitcher_Button veto probe, and same-session SYNC_STATE(bindingContext: null) clears latestGraphqlViewer!
  const directOutbound = [];
  const directListeners = new Map();
  let directSwitcher = {
    textContent: '@sample_me@second_account',
    childNodes: [
      { nodeType: 3, nodeValue: '@sample_me' },
      { nodeType: 3, nodeValue: '@second_account' }
    ]
  };
  const directWin = {
    location: { origin: 'https://x.com', href: 'https://x.com/home' },
    document: {
      querySelector: () => directSwitcher,
      querySelectorAll: () => []
    },
    __INITIAL_STATE__: structuredClone(viewerFixtures.ownProfileInitialState),
    fetch: async () =>
      new Response(JSON.stringify(viewerBGraphql), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      }),
    addEventListener(type, fn) {
      if (!directListeners.has(type)) directListeners.set(type, new Set());
      directListeners.get(type).add(fn);
    },
    postMessage(data) {
      directOutbound.push(data);
    }
  };
  installMainInterceptor(directWin, adapterApi);
  const sendDirect = (data) => {
    for (const fn of directListeners.get('message') || []) {
      fn({ data, origin: 'https://x.com', source: directWin });
    }
  };
  sendDirect({
    protocol: 'SPARKLINK_BRIDGE_V1',
    type: 'BRIDGE_INIT',
    nonce: 'nonce_direct_conflict',
    collectionEnabled: true,
    captureSessionId: 50,
    bindingContext: null
  });
  // Conflicting @sample_me + @second_account inside switcher button must veto initial probe!
  assert.equal(
    directOutbound.filter((d) => d.type === 'VIEWER_EVIDENCE').length,
    0,
    'Conflicting switcher handles must veto probe'
  );
  // Viewer GraphQL confirms B (9009009) and binds B, while __INITIAL_STATE__ is deleted
  await directWin.fetch('https://x.com/i/api/graphql/V50/Viewer');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(directOutbound.filter((d) => d.type === 'VIEWER_EVIDENCE').length, 1);
  delete directWin.__INITIAL_STATE__;
  sendDirect({
    protocol: 'SPARKLINK_BRIDGE_V1',
    type: 'SYNC_STATE',
    nonce: 'nonce_direct_conflict',
    collectionEnabled: true,
    captureSessionId: 50,
    bindingContext: {
      bindingId: 'bind_b_50',
      actorUserId: '9009009',
      captureSessionId: 50,
      collectionGeneration: 1,
      accountGeneration: 1
    }
  });
  // Same-session binding loss (bindingContext -> null) MUST clear latestGraphqlViewer so stale B is not re-emitted!
  sendDirect({
    protocol: 'SPARKLINK_BRIDGE_V1',
    type: 'SYNC_STATE',
    nonce: 'nonce_direct_conflict',
    collectionEnabled: true,
    captureSessionId: 50,
    bindingContext: null
  });
  assert.equal(
    directOutbound.filter((d) => d.type === 'VIEWER_EVIDENCE').length,
    1,
    'Same-session binding clearance must reset latestGraphqlViewer'
  );
});

test(
  '[P1] & [P2] Real Chromium CDP verification: paused-at-load historical snapshots without switcher @handle stay unconfirmed, nested DOM spans corroborate, and segmented text/span runs coalesce',
  { skip: !fs.existsSync('/usr/bin/chromium') || !fs.existsSync('/usr/bin/xvfb-run') },
  async () => {
    const adapterSource = fs.readFileSync(path.resolve('src/x-adapter.js'), 'utf8');
    const interceptorSource = fs.readFileSync(path.resolve('src/interceptor.js'), 'utf8');
    const bridgeSource = fs.readFileSync(path.resolve('src/bridge.js'), 'utf8');
    const contentSource = fs.readFileSync(path.resolve('src/content.js'), 'utf8');
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparklink-chromium-freshness-'));
    const child = spawn(
      '/usr/bin/xvfb-run',
      [
        '-a',
        '/usr/bin/chromium',
        '--remote-debugging-port=0',
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${profileDir}`,
        'about:blank'
      ],
      { stdio: ['ignore', 'ignore', 'ignore'], detached: true }
    );

    try {
      const portFile = path.join(profileDir, 'DevToolsActivePort');
      let port = null;
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        if (fs.existsSync(portFile)) {
          const lines = fs.readFileSync(portFile, 'utf8').trim().split('\n');
          if (lines[0] && /^\d+$/.test(lines[0].trim())) {
            port = Number(lines[0].trim());
            break;
          }
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      assert.ok(port, 'Chromium DevToolsActivePort must initialize');

      let pageTarget = null;
      const pageDeadline = Date.now() + 6000;
      while (Date.now() < pageDeadline) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/json`);
          if (res.ok) {
            const targets = await res.json();
            pageTarget = targets.find(
              (t) => t.type === 'page' && t.url === 'about:blank' && t.webSocketDebuggerUrl
            );
            if (pageTarget) break;
          }
        } catch (_ignore) {}
        await new Promise((r) => setTimeout(r, 120));
      }
      assert.ok(pageTarget, 'Chromium page target must be available');

      const setupExpr = `(() => {
        const loadCjs = (src) => {
          const exportsObj = {};
          const mod = { exports: exportsObj };
          new Function('module', 'exports', src)(mod, exportsObj);
          return mod.exports;
        };
        window.__sparkTestLoad = loadCjs;
        window.__sparkTestAdapter = loadCjs(${JSON.stringify(adapterSource)});
        window.__sparkTestInterceptor = loadCjs(${JSON.stringify(interceptorSource)});
        return true;
      })()`;

      const evalExpr = `(async () => {
        const adapter = window.__sparkTestAdapter;
        const { installMainInterceptor } = window.__sparkTestInterceptor;
        const { installIsolatedBridge } = window.__sparkTestLoad(${JSON.stringify(bridgeSource)});

        async function runPausedOpenCase(mutateDuringPauseFn, setupDomFn) {
          document.head.replaceChildren();
          document.body.replaceChildren();
          const ssrScript = document.createElement('script');
          ssrScript.type = 'text/plain';
          ssrScript.textContent = 'window.__INITIAL_STATE__ = {"session":{"user_id":"1001001","user":{"screen_name":"sample_me","name":"A"}}};';
          document.head.appendChild(ssrScript);
          setupDomFn();

          let bgEnabled = false;
          let bgSessionId = null;
          let bgBinding = null;
          const runtimeListeners = new Set();
          const winListeners = new Set();
          const fakeWin = {
            location: { origin: 'https://x.com', href: 'https://x.com/home' },
            document,
            __INITIAL_STATE__: { session: { user_id: '1001001', user: { screen_name: 'sample_me', name: 'A' } } },
            fetch: async () => new Response('{}', { status: 200 }),
            addEventListener: (t, fn) => { if (t === 'message') winListeners.add(fn); },
            removeEventListener: (t, fn) => { if (t === 'message') winListeners.delete(fn); },
            postMessage: (data, origin) => queueMicrotask(() => {
              for (const fn of winListeners) fn({ data, origin, source: fakeWin });
            })
          };
          fakeWin.top = fakeWin;
          const fakeChrome = {
            runtime: {
              id: 'ext_cdp_freshness',
              async sendMessage(msg) {
                if (msg.type === 'HELLO') {
                  return { ok: true, collectionEnabled: bgEnabled, captureSessionId: bgSessionId, bindingContext: bgBinding, revision: 1 };
                }
                if (msg.type === 'BIND_VIEWER') {
                  bgBinding = { bindingId: 'b_' + msg.viewer.actorUserId, actorUserId: msg.viewer.actorUserId, captureSessionId: bgSessionId, collectionGeneration: 1, accountGeneration: 1 };
                  return { ok: true, bindingContext: bgBinding, revision: 2 };
                }
                return { ok: true };
              },
              onMessage: { addListener: (fn) => runtimeListeners.add(fn), removeListener: (fn) => runtimeListeners.delete(fn) }
            }
          };

          installMainInterceptor(fakeWin, adapter);
          const bridge = installIsolatedBridge(fakeWin, fakeChrome, { retryDelayMs: 5 });
          await new Promise((r) => setTimeout(r, 35));

          mutateDuringPauseFn(fakeWin);

          bgEnabled = true;
          bgSessionId = 1;
          for (const fn of runtimeListeners) {
            fn({ type: 'STATE_CHANGED', collectionEnabled: true, captureSessionId: 1 }, { id: 'ext_cdp_freshness' });
          }
          await new Promise((r) => setTimeout(r, 40));
          const actor = bridge.getBindingContext() ? bridge.getBindingContext().actorUserId : null;
          bridge.destroy();
          return actor;
        }

        // 1. Stale __INITIAL_STATE__ = A + collapsed icon-only switcher button (no @handle) -> MUST be null (unconfirmed)!
        const staleANoHandleActor = await runPausedOpenCase(
          () => {},
          () => {
            const btn = document.createElement('button');
            btn.setAttribute('data-testid', 'SideNav_AccountSwitcher_Button');
            const icon = document.createElement('div');
            icon.textContent = 'Avatar';
            btn.appendChild(icon);
            document.body.appendChild(btn);
          }
        );

        // 2. [P1] Updated __INITIAL_STATE__ = B (9009009) vs inline <script> A (1001001) + no switcher @handle (indistinguishable from A -> B -> A) -> MUST stay null (unconfirmed)!
        const updatedBNoHandleActor = await runPausedOpenCase(
          (w) => {
            w.__INITIAL_STATE__ = { session: { user_id: '9009009', user: { screen_name: 'second_account', name: 'B' } } };
          },
          () => {}
        );

        // 3. __INITIAL_STATE__ = A + real nested spans <div><span>Alice</span></div><div><span>@sample_me</span></div> (textContent === "Alice@sample_me") -> MUST corroborate 1001001!
        const nestedDomCorroboratedActor = await runPausedOpenCase(
          () => {},
          () => {
            const btn = document.createElement('button');
            btn.setAttribute('data-testid', 'SideNav_AccountSwitcher_Button');
            const d1 = document.createElement('div');
            const s1 = document.createElement('span');
            s1.textContent = 'Alice';
            d1.appendChild(s1);
            const d2 = document.createElement('div');
            const s2 = document.createElement('span');
            s2.textContent = '@sample_me';
            d2.appendChild(s2);
            btn.appendChild(d1);
            btn.appendChild(d2);
            document.body.appendChild(btn);
          }
        );

        // 4. __INITIAL_STATE__ = A + real nested spans <div><span>Bob</span></div><div><span>@second_account</span></div> (textContent === "Bob@second_account" without space) -> MUST veto A (null)!
        const nestedDomMismatchActor = await runPausedOpenCase(
          () => {},
          () => {
            const btn = document.createElement('button');
            btn.setAttribute('data-testid', 'SideNav_AccountSwitcher_Button');
            const d1 = document.createElement('div');
            const s1 = document.createElement('span');
            s1.textContent = 'Bob';
            d1.appendChild(s1);
            const d2 = document.createElement('div');
            const s2 = document.createElement('span');
            s2.textContent = '@second_account';
            d2.appendChild(s2);
            btn.appendChild(d1);
            btn.appendChild(d2);
            document.body.appendChild(btn);
          }
        );

        // 5. [P2] Real DOM adjacent Text("@sample_me") + Text("_alt") inside SideNav_AccountSwitcher_Button while __INITIAL_STATE__ = @sample_me -> MUST veto prefix match and stay null (unconfirmed)!
        const segmentedTextPrefixMismatchActor = await runPausedOpenCase(
          () => {},
          () => {
            const btn = document.createElement('button');
            btn.setAttribute('data-testid', 'SideNav_AccountSwitcher_Button');
            const d = document.createElement('div');
            const sp = document.createElement('span');
            sp.appendChild(document.createTextNode('@sample_me'));
            sp.appendChild(document.createTextNode('_alt'));
            d.appendChild(sp);
            btn.appendChild(d);
            document.body.appendChild(btn);
          }
        );

        // 6. [P2] Real DOM inline <span>@sample_me</span><span>_alt</span> inside SideNav_AccountSwitcher_Button while __INITIAL_STATE__ = @sample_me -> MUST also stay null!
        const segmentedSpanPrefixMismatchActor = await runPausedOpenCase(
          () => {},
          () => {
            const btn = document.createElement('button');
            btn.setAttribute('data-testid', 'SideNav_AccountSwitcher_Button');
            const d = document.createElement('div');
            const sp1 = document.createElement('span');
            sp1.textContent = '@sample_me';
            const sp2 = document.createElement('span');
            sp2.textContent = '_alt';
            d.appendChild(sp1);
            d.appendChild(sp2);
            btn.appendChild(d);
            document.body.appendChild(btn);
          }
        );

        // 7. Block boundary preservation: <div><span>@sample_me</span></div><div><span>Protected</span></div> -> MUST corroborate @sample_me (1001001), never merging across block <div>s!
        const blockSeparatedCorroboratedActor = await runPausedOpenCase(
          () => {},
          () => {
            const btn = document.createElement('button');
            btn.setAttribute('data-testid', 'SideNav_AccountSwitcher_Button');
            const outer = document.createElement('div');
            const d1 = document.createElement('div');
            const s1 = document.createElement('span');
            s1.textContent = '@sample_me';
            d1.appendChild(s1);
            const d2 = document.createElement('div');
            const s2 = document.createElement('span');
            s2.textContent = 'Protected';
            d2.appendChild(s2);
            outer.appendChild(d1);
            outer.appendChild(d2);
            btn.appendChild(outer);
            document.body.appendChild(btn);
          }
        );

        // 8. [Cousin] src/content.js segmented Text("@sample_me") + Text("_alt") inside [data-testid="User-Name"]
        const { installContentBadges } = window.__sparkTestLoad(${JSON.stringify(contentSource)});
        document.body.replaceChildren();
        const conflictHeader = document.createElement('div');
        conflictHeader.setAttribute('data-testid', 'User-Name');
        const linkA = document.createElement('a');
        linkA.setAttribute('href', '/sample_me');
        linkA.textContent = 'Sample Me';
        const handleSpan = document.createElement('span');
        handleSpan.appendChild(document.createTextNode('@sample_me'));
        handleSpan.appendChild(document.createTextNode('_alt'));
        conflictHeader.appendChild(linkA);
        conflictHeader.appendChild(handleSpan);
        document.body.appendChild(conflictHeader);

        const validSegmentedHeader = document.createElement('div');
        validSegmentedHeader.setAttribute('data-testid', 'User-Name');
        const validSpan = document.createElement('span');
        validSpan.appendChild(document.createTextNode('@'));
        validSpan.appendChild(document.createComment('react'));
        validSpan.appendChild(document.createTextNode('friend_two'));
        validSegmentedHeader.appendChild(validSpan);
        document.body.appendChild(validSegmentedHeader);

        const contentCtrl = installContentBadges(
          window,
          {
            getBindingContext: () => ({ bindingId: 'b_content_seg', actorUserId: '1001001' }),
            getRevision: () => 1,
            subscribe: () => () => {},
            resolveUserIdByHandle: (h) => {
              const lower = String(h).toLowerCase();
              if (lower === 'sample_me') return '222';
              if (lower === 'friend_two') return '333';
              return null;
            },
            resolveAuthorByTweetId: () => null,
            queryCounts: async (ids) => {
              const counts = {};
              for (const id of ids) counts[id] = 15;
              return { ok: true, bindingId: 'b_content_seg', revision: 1, counts };
            }
          },
          { debounceMs: 0 }
        );
        await new Promise((r) => setTimeout(r, 60));
        const conflictBadgeCount = conflictHeader.querySelectorAll('.sparklink-badge').length;
        const validSegmentedBadgeCount = validSegmentedHeader.querySelectorAll('.sparklink-badge').length;
        contentCtrl.destroy();

        return {
          staleANoHandleActor,
          updatedBNoHandleActor,
          nestedDomCorroboratedActor,
          nestedDomMismatchActor,
          segmentedTextPrefixMismatchActor,
          segmentedSpanPrefixMismatchActor,
          blockSeparatedCorroboratedActor,
          conflictBadgeCount,
          validSegmentedBadgeCount
        };
      })()`;

      const cdpResult = await new Promise((resolve, reject) => {
        const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
        const timer = setTimeout(() => {
          ws.close();
          reject(new Error('CDP Runtime.evaluate timed out'));
        }, 8000);
        ws.addEventListener('open', () => {
          ws.send(
            JSON.stringify({
              id: 1,
              method: 'Runtime.evaluate',
              params: { expression: setupExpr, returnByValue: true }
            })
          );
        });
        ws.addEventListener('message', (ev) => {
          const msg = JSON.parse(String(ev.data));
          if (msg.id === 1) {
            ws.send(
              JSON.stringify({
                id: 2,
                method: 'Runtime.evaluate',
                params: { expression: evalExpr, awaitPromise: true, returnByValue: true }
              })
            );
          } else if (msg.id === 2) {
            clearTimeout(timer);
            ws.close();
            resolve(msg);
          }
        });
        ws.addEventListener('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      const val = cdpResult.result && cdpResult.result.result && cdpResult.result.result.value;
      assert.deepEqual(val, {
        staleANoHandleActor: null,
        updatedBNoHandleActor: null,
        nestedDomCorroboratedActor: '1001001',
        nestedDomMismatchActor: null,
        segmentedTextPrefixMismatchActor: null,
        segmentedSpanPrefixMismatchActor: null,
        blockSeparatedCorroboratedActor: '1001001',
        conflictBadgeCount: 0,
        validSegmentedBadgeCount: 1
      });
    } finally {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch (_ignore) {}
      await new Promise((r) => setTimeout(r, 150));
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (_ignore) {}
      fs.rmSync(profileDir, { recursive: true, force: true });
    }
  }
);

test('[P2] Popup provenance isolation: Pause -> Resume and Paused -> Enable on a never-bound tab never leak default savedAccounts[0] into unconfirmed state, while manual choice and confirmed tabs stay retained', async () => {
  const NOW_MS = 1794794402000;
  const EXT_ID = 'sparklink_remed_popup_provenance';
  const POPUP_SENDER = { id: EXT_ID, url: `chrome-extension://${EXT_ID}/src/popup/popup.html` };
  const seedTabSender = {
    id: EXT_ID,
    tab: { id: 301, active: true },
    frameId: 0,
    documentId: 'doc_301_seed',
    origin: 'https://x.com',
    url: 'https://x.com/home'
  };
  const neverBoundTabSender = {
    id: EXT_ID,
    tab: { id: 302, active: true },
    frameId: 0,
    documentId: 'doc_302_never_bound',
    origin: 'https://x.com',
    url: 'https://x.com/home'
  };

  let fgTabId = 301;
  const localArea = createMockArea();
  const sessionArea = createMockArea();

  const bg = createBackgroundService(
    {
      storage: { local: localArea, session: sessionArea },
      runtime: {
        id: EXT_ID,
        getURL: (p) => `chrome-extension://${EXT_ID}/${p.replace(/^\//, '')}`,
        onMessage: { addListener() {} }
      },
      tabs: {
        async query() {
          return [{ id: fgTabId, active: true }];
        },
        async sendMessage(_tabId, msg) {
          if (msg && msg.type === 'PING_X_TAB') return { ok: true, alive: true };
          return undefined;
        },
        onRemoved: { addListener() {} }
      }
    },
    { nowFn: () => NOW_MS }
  );

  // Seed Account A ('1001001', 1 reply) and Account B ('9009009', 0 replies)
  const enableRes = await bg.handleMessage(
    { type: 'SET_COLLECTION_ENABLED', enabled: true },
    POPUP_SENDER
  );
  await bg.handleMessage({ type: 'HELLO' }, seedTabSender);
  const bindA = await bg.handleMessage(
    {
      type: 'BIND_VIEWER',
      captureSessionId: enableRes.settings.captureSessionId,
      viewer: { actorUserId: '1001001', handle: 'alice_first', displayName: 'Alice' }
    },
    seedTabSender
  );
  await bg.handleMessage(
    {
      type: 'SUBMIT_OBSERVED_BATCH',
      bindingContext: bindA.bindingContext,
      events: [
        {
          actorUserId: '1001001',
          replyTweetId: '2122147641553981001',
          parentTweetId: '2121785253688246272',
          targetUserId: '2002002',
          targetHandle: 'friend_1',
          targetDisplayName: 'Friend 1',
          createdAt: NOW_MS - 2000,
          observedAt: NOW_MS - 1000,
          source: 'live'
        }
      ]
    },
    seedTabSender
  );
  await bg.handleMessage(
    {
      type: 'BIND_VIEWER',
      captureSessionId: enableRes.settings.captureSessionId,
      viewer: { actorUserId: '9009009', handle: 'bob_second', displayName: 'Bob' }
    },
    seedTabSender
  );

  // 1. Switch foreground to brand-new Tab 302 (never bound any account) while collection is enabled
  fgTabId = 302;
  await bg.handleMessage({ type: 'HELLO' }, neverBoundTabSender);

  const { doc: p1Doc, nodes: p1Nodes } = createPopupDomHarness();
  const popup1 = createPopupController({
    document: p1Doc,
    runtime: { sendMessage: (m) => bg.handleMessage(m, POPUP_SENDER) }
  });
  const s1Init = await popup1.init();
  assert.equal(s1Init.viewerStatus, 'unconfirmed');
  assert.equal(p1Nodes.get('account-select').value, '');
  assert.equal(p1Nodes.get('stat-total-replies').textContent, '0');
  assert.equal(p1Nodes.get('btn-clear-account').disabled, true);

  // 2. Finding #2: User clicks Pause (while paused, Popup displays savedAccounts[0] = A for offline viewing),
  //    then clicks Resume -> MUST return to unselected placeholder ('', 0 replies, Clear Account disabled)!
  p1Nodes.get('collection-toggle').checked = false;
  await p1Nodes.get('collection-toggle').trigger('change');
  assert.equal(p1Nodes.get('viewer-status-badge').textContent, '已暂停');
  assert.equal(p1Nodes.get('account-select').value, '1001001');
  assert.equal(p1Nodes.get('stat-total-replies').textContent, '1');

  p1Nodes.get('collection-toggle').checked = true;
  await p1Nodes.get('collection-toggle').trigger('change');
  assert.equal(p1Nodes.get('viewer-status-badge').textContent, '账号待确认');
  assert.equal(
    p1Nodes.get('account-select').value,
    '',
    'Pause -> Resume on a never-bound tab must NOT leak paused default Account A into unconfirmed state'
  );
  assert.equal(p1Nodes.get('stat-total-replies').textContent, '0');
  assert.equal(p1Nodes.get('btn-clear-account').disabled, true);

  // 3. Audit Cousin B1: Pause collection, close Popup, open a brand-new Popup WHILE PAUSED on Tab 302 (shows default A),
  //    then click Enable -> MUST also show unselected placeholder ('', 0 replies, Clear Account disabled)!
  await bg.handleMessage({ type: 'SET_COLLECTION_ENABLED', enabled: false }, POPUP_SENDER);
  const { doc: p2Doc, nodes: p2Nodes } = createPopupDomHarness();
  const popup2 = createPopupController({
    document: p2Doc,
    runtime: { sendMessage: (m) => bg.handleMessage(m, POPUP_SENDER) }
  });
  const s2PausedInit = await popup2.init();
  assert.equal(s2PausedInit.viewerStatus, 'paused');
  assert.equal(p2Nodes.get('account-select').value, '1001001');

  p2Nodes.get('collection-toggle').checked = true;
  await p2Nodes.get('collection-toggle').trigger('change');
  assert.equal(p2Nodes.get('viewer-status-badge').textContent, '账号待确认');
  assert.equal(
    p2Nodes.get('account-select').value,
    '',
    'Opening Popup while paused on a never-bound tab and clicking Enable must NOT leak default Account A'
  );
  assert.equal(p2Nodes.get('stat-total-replies').textContent, '0');
  assert.equal(p2Nodes.get('btn-clear-account').disabled, true);

  // 4. Explicit user dropdown selection IS preserved across Pause -> Resume even on a never-bound tab!
  p2Nodes.get('account-select').value = '1001001';
  await p2Nodes.get('account-select').trigger('change');
  assert.equal(p2Nodes.get('account-select').value, '1001001');
  assert.equal(p2Nodes.get('stat-total-replies').textContent, '1');
  assert.equal(p2Nodes.get('btn-clear-account').disabled, false);

  p2Nodes.get('collection-toggle').checked = false;
  await p2Nodes.get('collection-toggle').trigger('change');
  p2Nodes.get('collection-toggle').checked = true;
  await p2Nodes.get('collection-toggle').trigger('change');
  // Simulate bridge.js STATE_CHANGED -> same-document HELLO re-handshake
  await bg.handleMessage({ type: 'HELLO' }, neverBoundTabSender);
  assert.equal(p2Nodes.get('account-select').value, '1001001');
  assert.equal(p2Nodes.get('stat-total-replies').textContent, '1');

  // 5. [P2] Close Popup #2 and reopen a brand-new Popup #3 on the SAME unconfirmed webpage (doc_302_never_bound) ->
  //    MUST restore manual selection Account A ('1001001', 1 reply, Clear Account enabled), NOT revert to placeholder!
  const { doc: p3Doc, nodes: p3Nodes } = createPopupDomHarness();
  const popup3 = createPopupController({
    document: p3Doc,
    runtime: { sendMessage: (m) => bg.handleMessage(m, POPUP_SENDER) }
  });
  const s3Reopen = await popup3.init();
  assert.equal(s3Reopen.viewerStatus, 'unconfirmed');
  assert.equal(
    p3Nodes.get('account-select').value,
    '1001001',
    'Closing and reopening Popup on the same unconfirmed webpage must retain manual Account A selection'
  );
  assert.equal(p3Nodes.get('stat-total-replies').textContent, '1');
  assert.equal(p3Nodes.get('btn-clear-account').disabled, false);

  // 6. Simulate MV3 Service Worker restart (fresh background instance reading storage.session) + reopen Popup #4 -> still retains A!
  const bgRestarted = createBackgroundService(
    {
      storage: { local: localArea, session: sessionArea },
      runtime: {
        id: EXT_ID,
        getURL: (p) => `chrome-extension://${EXT_ID}/${p.replace(/^\//, '')}`,
        onMessage: { addListener() {} }
      },
      tabs: {
        async query() {
          return [{ id: fgTabId, active: true }];
        },
        async sendMessage(_tabId, msg) {
          if (msg && msg.type === 'PING_X_TAB') return { ok: true, alive: true };
          return undefined;
        },
        onRemoved: { addListener() {} }
      }
    },
    { nowFn: () => NOW_MS }
  );
  const { doc: p4Doc, nodes: p4Nodes } = createPopupDomHarness();
  const popup4 = createPopupController({
    document: p4Doc,
    runtime: { sendMessage: (m) => bgRestarted.handleMessage(m, POPUP_SENDER) }
  });
  await popup4.init();
  assert.equal(p4Nodes.get('account-select').value, '1001001');
  assert.equal(p4Nodes.get('stat-total-replies').textContent, '1');

  // 7. Cross-tab isolation: switch foreground to another unconfirmed X Tab 303 -> shows placeholder ('', 0 replies)
  fgTabId = 303;
  await bgRestarted.handleMessage(
    { type: 'HELLO' },
    {
      id: EXT_ID,
      tab: { id: 303, active: true },
      frameId: 0,
      documentId: 'doc_303_other',
      origin: 'https://x.com',
      url: 'https://x.com/explore'
    }
  );
  const { doc: p5Doc, nodes: p5Nodes } = createPopupDomHarness();
  const popup5 = createPopupController({
    document: p5Doc,
    runtime: { sendMessage: (m) => bgRestarted.handleMessage(m, POPUP_SENDER) }
  });
  await popup5.init();
  assert.equal(p5Nodes.get('account-select').value, '');
  assert.equal(p5Nodes.get('stat-total-replies').textContent, '0');

  // Switch back to Tab 302 -> still retains Account A ('1001001', 1 reply)
  fgTabId = 302;
  const { doc: p6Doc, nodes: p6Nodes } = createPopupDomHarness();
  const popup6 = createPopupController({
    document: p6Doc,
    runtime: { sendMessage: (m) => bgRestarted.handleMessage(m, POPUP_SENDER) }
  });
  const s6Snap = await popup6.init();
  assert.equal(p6Nodes.get('account-select').value, '1001001');
  assert.equal(p6Nodes.get('stat-total-replies').textContent, '1');

  // 8. When Tab 302 newly confirms Account B ('9009009') via BIND_VIEWER, fresh Popup prioritizes confirmed B and clears pre-bind manual pick
  await bgRestarted.handleMessage(
    {
      type: 'BIND_VIEWER',
      captureSessionId: s6Snap.settings.captureSessionId,
      viewer: { actorUserId: '9009009', handle: 'bob_second', displayName: 'Bob' }
    },
    neverBoundTabSender
  );
  const { doc: p7Doc, nodes: p7Nodes } = createPopupDomHarness();
  const popup7 = createPopupController({
    document: p7Doc,
    runtime: { sendMessage: (m) => bgRestarted.handleMessage(m, POPUP_SENDER) }
  });
  await popup7.init();
  assert.equal(p7Nodes.get('viewer-status-badge').textContent, '采集中');
  assert.equal(p7Nodes.get('account-select').value, '9009009');
  assert.equal(p7Nodes.get('stat-total-replies').textContent, '0');

  // 9. Document navigation (new documentId) resets manual selection to placeholder, and CLEAR_ACCOUNT cleans up manualSelectedActorUserId
  p7Nodes.get('collection-toggle').checked = false;
  await p7Nodes.get('collection-toggle').trigger('change');
  p7Nodes.get('collection-toggle').checked = true;
  await p7Nodes.get('collection-toggle').trigger('change');
  p7Nodes.get('account-select').value = '1001001';
  await p7Nodes.get('account-select').trigger('change');

  const nav2Sender = {
    ...neverBoundTabSender,
    documentId: 'doc_302_navigated_2'
  };
  await bgRestarted.handleMessage({ type: 'HELLO' }, nav2Sender);
  const { doc: p8Doc, nodes: p8Nodes } = createPopupDomHarness();
  const popup8 = createPopupController({
    document: p8Doc,
    runtime: { sendMessage: (m) => bgRestarted.handleMessage(m, POPUP_SENDER) }
  });
  await popup8.init();
  assert.equal(
    p8Nodes.get('account-select').value,
    '',
    'Navigating tab to a new documentId must reset per-document manual selection'
  );

  // Manual select A on new document, then delete A via Clear Account -> cleans up manual selection cleanly
  p8Nodes.get('account-select').value = '1001001';
  await p8Nodes.get('account-select').trigger('change');
  assert.equal(p8Nodes.get('stat-total-replies').textContent, '1');
  await p8Nodes.get('btn-clear-account').trigger('click');
  await p8Nodes.get('btn-modal-confirm').trigger('click');
  assert.equal(p8Nodes.get('account-select').value, '');
  assert.equal(p8Nodes.get('stat-total-replies').textContent, '0');
});

test('[P1] Post-pause resume never trusts window.__INITIAL_STATE__ ID delta alone (after confirmed A, after unconfirmed snapshot read, and on BFCache persisted restore) unless corroborated by live switcher @handle or fresh Viewer', async () => {
  const NOW_MS = 1794794408000;
  const EXT_ID = 'sparklink_remed_post_pause_unified';
  const POPUP_SENDER = { id: EXT_ID, url: `chrome-extension://${EXT_ID}/src/popup/popup.html` };

  const localArea = createMockArea();
  const sessionArea = createMockArea();
  const tabListenersByTab = new Map();
  let fgTabId = 401;

  const bg = createBackgroundService(
    {
      storage: { local: localArea, session: sessionArea },
      runtime: {
        id: EXT_ID,
        getURL: (p) => `chrome-extension://${EXT_ID}/${p.replace(/^\//, '')}`,
        onMessage: { addListener() {} }
      },
      tabs: {
        async query() {
          return [{ id: fgTabId, active: true }];
        },
        async sendMessage(tabId, msg) {
          if (msg && msg.type === 'PING_X_TAB') return { ok: true, alive: true };
          const set = tabListenersByTab.get(tabId);
          if (set) {
            for (const fn of set) fn(msg, { id: EXT_ID });
          }
          return undefined;
        },
        onRemoved: { addListener() {} }
      }
    },
    { nowFn: () => NOW_MS }
  );

  const viewerAGraphql = {
    data: {
      viewer: {
        user_results: {
          result: {
            __typename: 'User',
            rest_id: '1001001',
            core: { screen_name: 'sample_me', name: 'A' },
            legacy: {}
          }
        }
      }
    }
  };
  const viewerBGraphql = structuredClone(viewerFixtures.viewerGraphqlLegacy);
  const replyByA = structuredClone(createTweetFixtures.standardReply.response);
  replyByA.data.create_tweet.tweet_results.result.rest_id = '2122147641553990401';
  replyByA.data.create_tweet.tweet_results.result.legacy.id_str = '2122147641553990401';

  function createPageHarness(tabId, docId, initialStateVal, initialSwitcherEl) {
    const winListeners = new Map();
    const docListeners = new Map();
    const runtimeListeners = new Set();
    tabListenersByTab.set(tabId, runtimeListeners);
    let currentState = initialStateVal;
    let currentSwitcher = initialSwitcherEl;
    let currentViewerPayload = viewerAGraphql;
    let stateReads = 0;

    const fakeWin = {
      location: { origin: 'https://x.com', href: 'https://x.com/home' },
      document: {
        visibilityState: 'visible',
        addEventListener(type, fn) {
          if (!docListeners.has(type)) docListeners.set(type, new Set());
          docListeners.get(type).add(fn);
        },
        removeEventListener(type, fn) {
          if (docListeners.has(type)) docListeners.get(type).delete(fn);
        },
        querySelector: (sel) =>
          sel === '[data-testid="SideNav_AccountSwitcher_Button"]' ? currentSwitcher : null,
        querySelectorAll: () => []
      },
      fetch(url) {
        const u = String(url);
        if (u.includes('/Viewer')) {
          return Promise.resolve(
            new Response(JSON.stringify(currentViewerPayload), {
              status: 200,
              headers: { 'content-type': 'application/json' }
            })
          );
        }
        if (u.includes('/CreateTweet')) {
          return Promise.resolve(
            new Response(JSON.stringify(replyByA), {
              status: 200,
              headers: { 'content-type': 'application/json' }
            })
          );
        }
        return Promise.resolve(new Response('{}', { status: 200 }));
      },
      addEventListener(type, fn) {
        if (!winListeners.has(type)) winListeners.set(type, new Set());
        winListeners.get(type).add(fn);
      },
      removeEventListener(type, fn) {
        if (winListeners.has(type)) winListeners.get(type).delete(fn);
      },
      postMessage(data, origin) {
        queueMicrotask(() => {
          for (const fn of winListeners.get('message') || []) {
            fn({ data, origin, source: fakeWin });
          }
        });
      }
    };
    Object.defineProperty(fakeWin, '__INITIAL_STATE__', {
      configurable: true,
      enumerable: true,
      get() {
        stateReads += 1;
        return currentState;
      },
      set(v) {
        currentState = v;
      }
    });
    fakeWin.top = fakeWin;

    const sender = {
      id: EXT_ID,
      tab: { id: tabId, active: true },
      frameId: 0,
      documentId: docId,
      origin: 'https://x.com',
      url: 'https://x.com/home'
    };
    const pageChrome = {
      runtime: {
        id: EXT_ID,
        sendMessage: (msg) => bg.handleMessage(msg, sender),
        onMessage: {
          addListener: (fn) => runtimeListeners.add(fn),
          removeListener: (fn) => runtimeListeners.delete(fn)
        }
      }
    };

    installMainInterceptor(fakeWin, adapterApi, { nowFn: () => NOW_MS });
    const bridge = installIsolatedBridge(fakeWin, pageChrome, {
      nowFn: () => NOW_MS,
      retryDelayMs: 5
    });

    return {
      fakeWin,
      bridge,
      sender,
      setSwitcher: (el) => {
        currentSwitcher = el;
      },
      setViewerPayload: (p) => {
        currentViewerPayload = p;
      },
      getStateReads: () => stateReads,
      resetStateReads: () => {
        stateReads = 0;
      },
      firePageShow: (persisted) => {
        for (const fn of winListeners.get('pageshow') || []) {
          fn({ persisted });
        }
      },
      fireVisibilityVisible: () => {
        for (const fn of docListeners.get('visibilitychange') || []) {
          fn({});
        }
      }
    };
  }

  // Case A ([P1] Confirmed A -> Pause -> A -> B -> A while __INITIAL_STATE__ stays at B and switcher has NO @handle):
  await bg.handleMessage({ type: 'SET_COLLECTION_ENABLED', enabled: true }, POPUP_SENDER);
  const tab401 = createPageHarness(
    401,
    'doc_401_confirmed_aba',
    structuredClone(viewerFixtures.ownProfileInitialState),
    null
  );
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(tab401.bridge.getBindingContext().actorUserId, '1001001');

  tab401.resetStateReads();
  await bg.handleMessage({ type: 'SET_COLLECTION_ENABLED', enabled: false }, POPUP_SENDER);
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(tab401.getStateReads(), 0, 'Pause must perform 0 __INITIAL_STATE__ reads');

  // User switched A -> B (setting __INITIAL_STATE__ = B), then B -> A without updating __INITIAL_STATE__; switcher has no @handle!
  tab401.fakeWin.__INITIAL_STATE__ = {
    session: { user_id: '9009009', user: { screen_name: 'second_account', name: '第二账号' } }
  };
  await bg.handleMessage({ type: 'SET_COLLECTION_ENABLED', enabled: true }, POPUP_SENDER);
  await new Promise((r) => setTimeout(r, 45));

  assert.equal(
    tab401.bridge.getBindingContext(),
    null,
    'Post-pause resume MUST NOT bind B from __INITIAL_STATE__ ID delta alone without switcher @handle or Viewer'
  );
  const snap401Resume = await bg.handleMessage({ type: 'GET_POPUP_SNAPSHOT' }, POPUP_SENDER);
  assert.equal(snap401Resume.viewerStatus, 'unconfirmed');
  assert.equal(snap401Resume.activeTabActorUserId, null);

  // Fresh Viewer(A) arrives -> binds A (1001001) and counts A's reply (+1 for A, 0 for B)!
  await tab401.fakeWin.fetch('https://x.com/i/api/graphql/ConfirmReturnA/Viewer');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(tab401.bridge.getBindingContext().actorUserId, '1001001');
  await tab401.fakeWin.fetch('https://x.com/i/api/graphql/ReplyAfterViewerA/CreateTweet', {
    method: 'POST',
    body: JSON.stringify(createTweetFixtures.standardReply.requestBody)
  });
  await new Promise((r) => setTimeout(r, 45));
  const snap401AfterA = await bg.handleMessage({ type: 'GET_POPUP_SNAPSHOT' }, POPUP_SENDER);
  assert.equal(snap401AfterA.selectedAccount.actorUserId, '1001001');
  assert.equal(snap401AfterA.selectedAccount.summary.totalReplies, 1);
  tab401.bridge.destroy();

  // Case B ([P1] Unconfirmed snapshot read before pause -> Pause -> A -> B -> A without switcher @handle):
  fgTabId = 402;
  // Open Tab 402 while enabled, with __INITIAL_STATE__ = A (@sample_me) and switcher showing @second_account -> reads A dynamically but stays unconfirmed!
  const tab402 = createPageHarness(
    402,
    'doc_402_unconfirmed_aba',
    structuredClone(viewerFixtures.ownProfileInitialState),
    {
      tagName: 'BUTTON',
      textContent: '@second_account',
      childNodes: [{ nodeType: 3, nodeValue: '@second_account' }]
    }
  );
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(tab402.bridge.getBindingContext(), null);

  await bg.handleMessage({ type: 'SET_COLLECTION_ENABLED', enabled: false }, POPUP_SENDER);
  await new Promise((r) => setTimeout(r, 25));
  // During pause, switch A -> B -> A leaving __INITIAL_STATE__ = B and switcher icon-only (null)
  tab402.fakeWin.__INITIAL_STATE__ = {
    session: { user_id: '9009009', user: { screen_name: 'second_account', name: '第二账号' } }
  };
  tab402.setSwitcher(null);

  await bg.handleMessage({ type: 'SET_COLLECTION_ENABLED', enabled: true }, POPUP_SENDER);
  await new Promise((r) => setTimeout(r, 45));
  assert.equal(
    tab402.bridge.getBindingContext(),
    null,
    'Tab that read unconfirmed snapshot A before pause must NOT bind B from __INITIAL_STATE__ delta alone on resume'
  );
  const snap402Resume = await bg.handleMessage({ type: 'GET_POPUP_SNAPSHOT' }, POPUP_SENDER);
  assert.equal(snap402Resume.viewerStatus, 'unconfirmed');

  // Now __INITIAL_STATE__ reflects A AND live switcher renders bidi/middle-dot `@sample_me·私密` -> visibility re-probe binds A!
  tab402.fakeWin.__INITIAL_STATE__ = structuredClone(viewerFixtures.ownProfileInitialState);
  tab402.setSwitcher({
    tagName: 'BUTTON',
    textContent: '⁦@sample_me⁩·私密',
    childNodes: [{ nodeType: 3, nodeValue: '⁦@sample_me⁩·私密' }]
  });
  tab402.fireVisibilityVisible();
  await new Promise((r) => setTimeout(r, 45));
  assert.equal(
    tab402.bridge.getBindingContext() && tab402.bridge.getBindingContext().actorUserId,
    '1001001',
    'Live switcher handle with tight middle-dot and bidi isolates must corroborate @sample_me'
  );

  // Case C (Superseded __INITIAL_STATE__ = A after Viewer(B), then Pause -> switch B -> A with live switcher @sample_me -> binds A!):
  tab402.setViewerPayload(viewerBGraphql);
  await tab402.fakeWin.fetch('https://x.com/i/api/graphql/ConfirmB402/Viewer');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(tab402.bridge.getBindingContext().actorUserId, '9009009');
  // __INITIAL_STATE__ was still A (supersededDynamicActorId = '1001001'). Pause, user switches B -> A, live switcher says @sample_me!
  await bg.handleMessage({ type: 'SET_COLLECTION_ENABLED', enabled: false }, POPUP_SENDER);
  await new Promise((r) => setTimeout(r, 25));
  tab402.setSwitcher({
    tagName: 'BUTTON',
    textContent: '@sample_me',
    childNodes: [{ nodeType: 3, nodeValue: '@sample_me' }]
  });
  await bg.handleMessage({ type: 'SET_COLLECTION_ENABLED', enabled: true }, POPUP_SENDER);
  await new Promise((r) => setTimeout(r, 45));
  assert.equal(
    tab402.bridge.getBindingContext() && tab402.bridge.getBindingContext().actorUserId,
    '1001001',
    'Live switcher @sample_me after pause must confirm return to A even if A was superseded before pause'
  );

  // Case D (BFCache pageshow persisted restore when tab binding was replaced while frozen):
  tab402.setSwitcher(null);
  // Simulate intermediate document replacing tab 402's session entry while doc_402 was frozen in BFCache
  await bg.handleMessage(
    { type: 'HELLO' },
    {
      ...tab402.sender,
      documentId: 'doc_402_other_page'
    }
  );
  tab402.firePageShow(true);
  await new Promise((r) => setTimeout(r, 45));
  assert.equal(
    tab402.bridge.getBindingContext(),
    null,
    'BFCache persisted restore without switcher @handle must require fresh verification rather than trusting frozen __INITIAL_STATE__'
  );
  tab402.bridge.destroy();
});

test(
  '[P1] & [P2] Real Chromium CDP verification: post-pause A -> B -> A holds unconfirmed without switcher @handle, and real DOM author rows with middle-dot timestamps never misbadge or drop badges',
  { skip: !fs.existsSync('/usr/bin/chromium') || !fs.existsSync('/usr/bin/xvfb-run') },
  async () => {
    const adapterSource = fs.readFileSync(path.resolve('src/x-adapter.js'), 'utf8');
    const interceptorSource = fs.readFileSync(path.resolve('src/interceptor.js'), 'utf8');
    const contentSource = fs.readFileSync(path.resolve('src/content.js'), 'utf8');

    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparklink-chromium-post-pause-sep-'));
    const child = spawn(
      '/usr/bin/xvfb-run',
      [
        '-a',
        '/usr/bin/chromium',
        '--remote-debugging-port=0',
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${profileDir}`,
        'about:blank'
      ],
      { stdio: ['ignore', 'ignore', 'ignore'], detached: true }
    );
    try {
      const portFile = path.join(profileDir, 'DevToolsActivePort');
      let port = null;
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        if (fs.existsSync(portFile)) {
          const lines = fs.readFileSync(portFile, 'utf8').trim().split('\n');
          if (lines[0] && /^\d+$/.test(lines[0].trim())) {
            port = Number(lines[0].trim());
            break;
          }
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      assert.ok(port, 'Chromium DevToolsActivePort must initialize');

      let pageTarget = null;
      const pageDeadline = Date.now() + 6000;
      while (Date.now() < pageDeadline) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/json`);
          if (res.ok) {
            const targets = await res.json();
            pageTarget = targets.find(
              (t) => t.type === 'page' && t.url === 'about:blank' && t.webSocketDebuggerUrl
            );
            if (pageTarget) break;
          }
        } catch (_ignore) {}
        await new Promise((r) => setTimeout(r, 120));
      }
      assert.ok(pageTarget && pageTarget.webSocketDebuggerUrl);

      const evalExpr = `
        (async () => {
          const loadCjs = (src) => {
            const mod = { exports: {} };
            new Function('module', 'exports', src)(mod, mod.exports);
            return mod.exports;
          };
          const adapter = loadCjs(${JSON.stringify(adapterSource)});
          const { installMainInterceptor } = loadCjs(${JSON.stringify(interceptorSource)});
          const { installContentBadges } = loadCjs(${JSON.stringify(contentSource)});

          // Part 1: Real Chromium MAIN-world post-pause A -> B -> A verification
          const doc = document.implementation.createHTMLDocument('x');
          const msgHandlers = new Set();
          const outbound = [];
          const win = {
            location: { origin: 'https://x.com', href: 'https://x.com/home' },
            document: doc,
            addEventListener(type, fn) {
              if (type === 'message') msgHandlers.add(fn);
            },
            removeEventListener(type, fn) {
              if (type === 'message') msgHandlers.delete(fn);
            },
            postMessage(data, origin) {
              outbound.push({ data, origin });
            },
            fetch: async () => new Response('{}', { status: 200 }),
            __INITIAL_STATE__: {
              session: { user_id: '1001001', user: { screen_name: 'sample_me', name: 'A' } }
            }
          };
          win.top = win;

          installMainInterceptor(win, adapter);
          const send = (payload) => {
            for (const fn of msgHandlers) {
              fn({ data: payload, origin: 'https://x.com', source: win });
            }
          };

          // Session 1: active load binds A (1001001)
          send({
            protocol: 'SPARKLINK_BRIDGE_V1',
            type: 'BRIDGE_INIT',
            nonce: 'cdp_nonce_aba_1',
            collectionEnabled: true,
            captureSessionId: 1,
            bindingContext: null,
            stateConfirmed: true
          });
          const initialEvCount = outbound.filter((m) => m.data && m.data.type === 'VIEWER_EVIDENCE').length;
          send({
            protocol: 'SPARKLINK_BRIDGE_V1',
            type: 'SYNC_STATE',
            nonce: 'cdp_nonce_aba_1',
            collectionEnabled: true,
            captureSessionId: 1,
            bindingContext: {
              bindingId: 'b_a_1',
              actorUserId: '1001001',
              captureSessionId: 1,
              collectionGeneration: 1,
              accountGeneration: 1
            },
            stateConfirmed: true
          });

          // Pause -> switch A -> B -> A leaving __INITIAL_STATE__ = B (9009009) and icon-only switcher without @handle!
          send({
            protocol: 'SPARKLINK_BRIDGE_V1',
            type: 'SYNC_STATE',
            nonce: 'cdp_nonce_aba_1',
            collectionEnabled: false,
            captureSessionId: null,
            bindingContext: null,
            stateConfirmed: true,
            observedPaused: true
          });
          const iconOnlyBtn = doc.createElement('button');
          iconOnlyBtn.setAttribute('data-testid', 'SideNav_AccountSwitcher_Button');
          iconOnlyBtn.textContent = 'Account menu';
          doc.body.appendChild(iconOnlyBtn);
          win.__INITIAL_STATE__ = {
            session: { user_id: '9009009', user: { screen_name: 'second_account', name: 'B' } }
          };

          // Resume Session 2 -> MUST emit 0 VIEWER_EVIDENCE (never misbinding B!)
          send({
            protocol: 'SPARKLINK_BRIDGE_V1',
            type: 'SYNC_STATE',
            nonce: 'cdp_nonce_aba_1',
            collectionEnabled: true,
            captureSessionId: 2,
            bindingContext: null,
            stateConfirmed: true
          });
          const evCountWithoutHandle = outbound.filter(
            (m) => m.data && m.data.type === 'VIEWER_EVIDENCE' && m.data.captureSessionId === 2
          ).length;

          // Part 2: Real Chromium DOM content badges with middle-dot timestamps
          document.body.textContent = '';
          // Row 1: <a href="/sample_friend"> + <span>@somebody_else</span><span> · 2h</span> -> MUST have 0 badges!
          const art1 = document.createElement('article');
          art1.setAttribute('data-testid', 'tweet');
          const box1 = document.createElement('div');
          box1.setAttribute('data-testid', 'User-Name');
          const a1 = document.createElement('a');
          a1.setAttribute('href', '/sample_friend');
          a1.textContent = 'Friend';
          const row1 = document.createElement('div');
          const s1a = document.createElement('span');
          s1a.textContent = '@somebody_else';
          const s1b = document.createElement('span');
          s1b.textContent = ' · 2h';
          row1.appendChild(s1a);
          row1.appendChild(s1b);
          box1.appendChild(a1);
          box1.appendChild(row1);
          art1.appendChild(box1);
          document.body.appendChild(art1);

          // Row 2: Linkless author row with <span>@sample_friend</span><span> · 2h</span> -> MUST render 1 badge!
          const art2 = document.createElement('article');
          art2.setAttribute('data-testid', 'tweet');
          const box2 = document.createElement('div');
          box2.setAttribute('data-testid', 'User-Name');
          const row2 = document.createElement('div');
          const s2a = document.createElement('span');
          s2a.textContent = '@sample_friend';
          const s2b = document.createElement('span');
          s2b.textContent = ' · 2h';
          row2.appendChild(s2a);
          row2.appendChild(s2b);
          box2.appendChild(row2);
          art2.appendChild(box2);
          document.body.appendChild(art2);

          // Row 3: Segmented @sample_friend + _alt + " · 2h" -> MUST NOT prefix-match sample_friend (0 badges)!
          const art3 = document.createElement('article');
          art3.setAttribute('data-testid', 'tweet');
          const box3 = document.createElement('div');
          box3.setAttribute('data-testid', 'User-Name');
          const row3 = document.createElement('div');
          const s3a = document.createElement('span');
          s3a.textContent = '@sample_friend';
          const s3b = document.createElement('span');
          s3b.textContent = '_alt';
          const s3c = document.createElement('span');
          s3c.textContent = ' · 2h';
          row3.appendChild(s3a);
          row3.appendChild(s3b);
          row3.appendChild(s3c);
          box3.appendChild(row3);
          art3.appendChild(box3);
          document.body.appendChild(art3);

          const fakeBridge = {
            getBindingContext: () => ({
              bindingId: 'b_cdp',
              actorUserId: '1001001',
              captureSessionId: 2,
              collectionGeneration: 1,
              accountGeneration: 1
            }),
            getRevision: () => 1,
            subscribe: () => () => {},
            resolveUserIdByHandle: (h) =>
              String(h).toLowerCase() === 'sample_friend' ? '2002002' : null,
            resolveAuthorByTweetId: () => null,
            queryCounts: async () => ({
              ok: true,
              counts: { '2002002': 7 },
              revision: 1,
              bindingId: 'b_cdp'
            })
          };

          const contentWin = {
            location: { origin: 'https://x.com', href: 'https://x.com/home' },
            document,
            MutationObserver,
            requestAnimationFrame: (cb) => setTimeout(() => cb(performance.now()), 0),
            cancelAnimationFrame: (id) => clearTimeout(id),
            setInterval: window.setInterval.bind(window),
            clearInterval: window.clearInterval.bind(window),
            setTimeout: window.setTimeout.bind(window),
            clearTimeout: window.clearTimeout.bind(window)
          };
          contentWin.top = contentWin;

          const ctrl = installContentBadges(contentWin, fakeBridge, {
            debounceMs: 5,
            frameBudgetMs: 50
          });
          ctrl.refreshNow();
          await new Promise((r) => setTimeout(r, 60));
          const row1Badges = box1.querySelectorAll('.sparklink-badge').length;
          const row2Badges = box2.querySelectorAll('.sparklink-badge').length;
          const row3Badges = box3.querySelectorAll('.sparklink-badge').length;
          ctrl.destroy();

          return {
            initialEvCount,
            evCountWithoutHandle,
            row1Badges,
            row2Badges,
            row3Badges
          };
        })()
      `;

      const cdpResult = await new Promise((resolve, reject) => {
        const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
        const timer = setTimeout(() => {
          ws.close();
          reject(new Error('CDP Runtime.evaluate timed out'));
        }, 8000);
        ws.addEventListener('open', () => {
          ws.send(
            JSON.stringify({
              id: 1,
              method: 'Runtime.evaluate',
              params: { expression: evalExpr, awaitPromise: true, returnByValue: true }
            })
          );
        });
        ws.addEventListener('message', (ev) => {
          const msg = JSON.parse(String(ev.data));
          if (msg.id === 1) {
            clearTimeout(timer);
            ws.close();
            resolve(msg);
          }
        });
        ws.addEventListener('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      const val = cdpResult.result && cdpResult.result.result && cdpResult.result.result.value;
      assert.deepEqual(val, {
        initialEvCount: 1,
        evCountWithoutHandle: 0,
        row1Badges: 0,
        row2Badges: 1,
        row3Badges: 0
      });
    } finally {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch (_ignore) {}
      await new Promise((r) => setTimeout(r, 150));
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (_ignore) {}
      fs.rmSync(profileDir, { recursive: true, force: true });
    }
  }
);

test('[P2] Already-open Popup (both closed-and-reopened and never-closed) switches from manual unconfirmed Account A to newly bound Account B on refresh and targets B on Clear Account', async () => {
  const NOW_MS = 1794794412000;
  const EXT_ID = 'sparklink_remed_open_popup_sync';
  const POPUP_SENDER = { id: EXT_ID, url: `chrome-extension://${EXT_ID}/src/popup/popup.html` };

  const localArea = createMockArea();
  const sessionArea = createMockArea();
  let fgTabId = 501;

  const bg = createBackgroundService(
    {
      storage: { local: localArea, session: sessionArea },
      runtime: {
        id: EXT_ID,
        getURL: (p) => `chrome-extension://${EXT_ID}/${p.replace(/^\//, '')}`,
        onMessage: { addListener() {} }
      },
      tabs: {
        async query() {
          return [{ id: fgTabId, active: true }];
        },
        async sendMessage(_tabId, msg) {
          if (msg && msg.type === 'PING_X_TAB') return { ok: true, alive: true };
          return undefined;
        },
        onRemoved: { addListener() {} }
      }
    },
    { nowFn: () => NOW_MS }
  );

  // Seed Account A ('1001001', 1 reply) and Account B ('9009009', 0 replies)
  await bg.handleMessage({ type: 'SET_COLLECTION_ENABLED', enabled: true }, POPUP_SENDER);
  const seedSender = {
    id: EXT_ID,
    tab: { id: 500, active: false },
    frameId: 0,
    documentId: 'doc_seed_500',
    origin: 'https://x.com',
    url: 'https://x.com/home'
  };
  const bindSeedA = await bg.handleMessage(
    {
      type: 'BIND_VIEWER',
      captureSessionId: 1,
      viewer: { actorUserId: '1001001', handle: 'alice_first', displayName: 'Alice' }
    },
    seedSender
  );
  await bg.handleMessage(
    {
      type: 'SUBMIT_OBSERVED_BATCH',
      bindingContext: bindSeedA.bindingContext,
      events: [
        {
          actorUserId: '1001001',
          replyTweetId: '2122147641553995001',
          parentTweetId: '2121785253688295001',
          targetUserId: '2002002',
          targetHandle: 'friend_one',
          createdAt: NOW_MS - 1000,
          observedAt: NOW_MS - 500,
          source: 'live'
        }
      ]
    },
    seedSender
  );
  await bg.handleMessage(
    {
      type: 'BIND_VIEWER',
      captureSessionId: 1,
      viewer: { actorUserId: '9009009', handle: 'bob_second', displayName: 'Bob' }
    },
    seedSender
  );

  // 1. Exact reported repro: Foreground Tab 501 is unconfirmed. Open Popup #1, manually select Account A ('1001001', 1 reply), close Popup #1, reopen Popup #2!
  const tab501Sender = {
    id: EXT_ID,
    tab: { id: 501, active: true },
    frameId: 0,
    documentId: 'doc_501_unconfirmed',
    origin: 'https://x.com',
    url: 'https://x.com/home'
  };
  await bg.handleMessage({ type: 'HELLO' }, tab501Sender);

  const { doc: p1Doc, nodes: p1Nodes } = createPopupDomHarness();
  const popup1 = createPopupController({
    document: p1Doc,
    runtime: { sendMessage: (m) => bg.handleMessage(m, POPUP_SENDER) }
  });
  await popup1.init();
  assert.equal(p1Nodes.get('viewer-status-badge').textContent, '账号待确认');
  assert.equal(p1Nodes.get('account-select').value, '');

  p1Nodes.get('account-select').value = '1001001';
  await p1Nodes.get('account-select').trigger('change');
  assert.equal(p1Nodes.get('stat-total-replies').textContent, '1');

  // Close Popup #1 and reopen Popup #2 while Tab 501 is STILL unconfirmed -> restores A ('1001001', 1 reply)
  const { doc: p2Doc, nodes: p2Nodes } = createPopupDomHarness();
  const popup2 = createPopupController({
    document: p2Doc,
    runtime: { sendMessage: (m) => bg.handleMessage(m, POPUP_SENDER) }
  });
  const snapP2Init = await popup2.init();
  assert.equal(snapP2Init.viewerStatus, 'unconfirmed');
  assert.equal(p2Nodes.get('account-select').value, '1001001');
  assert.equal(p2Nodes.get('stat-total-replies').textContent, '1');

  // While Tab 501 is STILL unconfirmed, clicking "清理过期记录" in Popup #2 retains A ('1001001', 1 reply)
  await p2Nodes.get('btn-cleanup').trigger('click');
  assert.equal(p2Nodes.get('account-select').value, '1001001');
  assert.equal(p2Nodes.get('stat-total-replies').textContent, '1');

  // Now Tab 501 receives Viewer(B) ('9009009') while Popup #2 STAYS OPEN!
  await bg.handleMessage(
    {
      type: 'BIND_VIEWER',
      captureSessionId: snapP2Init.settings.captureSessionId,
      viewer: { actorUserId: '9009009', handle: 'bob_second', displayName: 'Bob' }
    },
    tab501Sender
  );

  // In the STILL-OPEN Popup #2, click "清理过期记录" -> MUST immediately switch to B ('9009009', 0 replies, 采集中)!
  await p2Nodes.get('btn-cleanup').trigger('click');
  assert.equal(p2Nodes.get('viewer-status-badge').textContent, '采集中');
  assert.equal(
    p2Nodes.get('account-select').value,
    '9009009',
    'Already-open reopened Popup must switch from manual Account A to newly bound Account B on Cleanup click'
  );
  assert.equal(
    p2Nodes.get('stat-total-replies').textContent,
    '0',
    'Already-open reopened Popup must show Account B (0 replies) rather than stale Account A (1 reply)'
  );

  // Clicking "清空当前账号" in Popup #2 MUST target Account B ('9009009'), leaving Account A's 1 reply intact!
  await p2Nodes.get('btn-clear-account').trigger('click');
  assert.equal(p2Nodes.get('modal-overlay').hidden, false);
  assert.ok(
    p2Nodes.get('modal-body').textContent.includes('9009009'),
    'Clear Current Account modal must target newly bound Account B (9009009), NOT Account A (1001001)'
  );
  await p2Nodes.get('btn-modal-confirm').trigger('click');

  // Re-seed Account B ('9009009') and verify Account A STILL has its 1 reply!
  const snapCheckA = await bg.handleMessage(
    { type: 'GET_POPUP_SNAPSHOT', preferredActorUserId: '1001001' },
    POPUP_SENDER
  );
  assert.equal(snapCheckA.selectedAccount.actorUserId, '1001001');
  assert.equal(snapCheckA.selectedAccount.summary.totalReplies, 1);

  await bg.handleMessage(
    {
      type: 'BIND_VIEWER',
      captureSessionId: snapCheckA.settings.captureSessionId,
      viewer: { actorUserId: '9009009', handle: 'bob_second', displayName: 'Bob' }
    },
    seedSender
  );

  // 2. Cousin scenario: Never-closed Popup on unconfirmed Tab 502 selects A, then Tab 502 receives Viewer(B) WITHOUT closing Popup -> switches to B!
  fgTabId = 502;
  const tab502Sender = {
    id: EXT_ID,
    tab: { id: 502, active: true },
    frameId: 0,
    documentId: 'doc_502_never_closed',
    origin: 'https://x.com',
    url: 'https://x.com/explore'
  };
  await bg.handleMessage({ type: 'HELLO' }, tab502Sender);

  const { doc: p3Doc, nodes: p3Nodes } = createPopupDomHarness();
  const popup3 = createPopupController({
    document: p3Doc,
    runtime: { sendMessage: (m) => bg.handleMessage(m, POPUP_SENDER) }
  });
  const snapP3Init = await popup3.init();
  assert.equal(snapP3Init.viewerStatus, 'unconfirmed');
  p3Nodes.get('account-select').value = '1001001';
  await p3Nodes.get('account-select').trigger('change');
  assert.equal(p3Nodes.get('stat-total-replies').textContent, '1');

  // Without ever closing Popup #3, Tab 502 binds Account B ('9009009') -> click Cleanup -> switches to B!
  await bg.handleMessage(
    {
      type: 'BIND_VIEWER',
      captureSessionId: snapP3Init.settings.captureSessionId,
      viewer: { actorUserId: '9009009', handle: 'bob_second', displayName: 'Bob' }
    },
    tab502Sender
  );
  await p3Nodes.get('btn-cleanup').trigger('click');
  assert.equal(
    p3Nodes.get('account-select').value,
    '9009009',
    'Never-closed Popup must also switch to newly bound Account B after manual pick on unconfirmed tab'
  );
  assert.equal(p3Nodes.get('stat-total-replies').textContent, '0');

  // 3. Explicit inspection on an ALREADY-bound tab: while Tab 502 is bound to B ('9009009'), manually picking A ('1001001') stays on A across Cleanup while Tab 502 remains bound to B, and switches if Tab 502 live-switches to C ('3003003')!
  p3Nodes.get('account-select').value = '1001001';
  await p3Nodes.get('account-select').trigger('change');
  assert.equal(p3Nodes.get('account-select').value, '1001001');
  assert.equal(p3Nodes.get('stat-total-replies').textContent, '1');
  await p3Nodes.get('btn-cleanup').trigger('click');
  assert.equal(
    p3Nodes.get('account-select').value,
    '1001001',
    'Manual inspection of A on already-bound Tab B must stay on A while Tab B remains bound to B'
  );

  await bg.handleMessage(
    {
      type: 'BIND_VIEWER',
      captureSessionId: snapP3Init.settings.captureSessionId,
      viewer: { actorUserId: '3003003', handle: 'carol_third', displayName: 'Carol' }
    },
    tab502Sender
  );
  await p3Nodes.get('btn-cleanup').trigger('click');
  assert.equal(
    p3Nodes.get('account-select').value,
    '3003003',
    'Live account switch on bound tab (B -> C) must switch open Popup to newly bound Account C'
  );
});







