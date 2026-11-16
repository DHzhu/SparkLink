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

  const fakeWin = {
    location: { origin: 'https://x.com', href: 'https://x.com/home' },
    document: {
      visibilityState: 'visible',
      addEventListener() {},
      removeEventListener() {},
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
            pageTarget = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
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
            pageTarget = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
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
            pageTarget = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
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
  const winListeners = new Map();

  const fakeWin = {
    location: { origin: 'https://x.com', href: 'https://x.com/home' },
    document: {
      visibilityState: 'visible',
      addEventListener() {},
      removeEventListener() {},
      querySelector() {
        domQueryReads += 1;
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

  // 3. During Pause #1, update page snapshot to Account B (9009009) and Resume #1 -> binds B and records B reply (+1)
  currentInitialState = initialStateB();
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

  // 5. During Pause #2, update page snapshot BACK to Account A (1001001) and Resume #2 -> MUST bind A immediately and record A's first reply (+1)!
  currentInitialState = initialStateA();
  currentReplyPayload = replyForA;
  await bg.handleMessage({ type: 'SET_COLLECTION_ENABLED', enabled: true }, POPUP_SENDER);
  await new Promise((r) => setTimeout(r, 40));

  const snapResumeA = await popup.refresh();
  assert.equal(
    popupNodes.get('viewer-status-badge').textContent,
    '采集中',
    'Popup must bind updated Account A snapshot rather than staying at 账号待确认'
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

  // 6. Pause #3 WITHOUT updating snapshot (snapshot stays at Account A) -> Resume #3 still stays unconfirmed!
  initialStateReads = 0;
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
            pageTarget = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
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





