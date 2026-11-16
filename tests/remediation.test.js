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


