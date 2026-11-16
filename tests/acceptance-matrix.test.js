import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import { createBackgroundService } from '../src/background.js';
import { STATE_STORAGE_KEY } from '../src/schema.js';

const require = createRequire(import.meta.url);
const adapterApi = require('../src/x-adapter.js');
const { installMainInterceptor } = require('../src/interceptor.js');
const { installIsolatedBridge } = require('../src/bridge.js');
const { installContentBadges } = require('../src/content.js');
const viewerFixtures = require('./fixtures/viewer-states.json');
const createTweetFixtures = require('./fixtures/create-tweet.json');
const timelineFixtures = require('./fixtures/timelines.json');

const EXT_ID = 'sparklink_ext_acceptance';
const POPUP_SENDER = Object.freeze({
  id: EXT_ID,
  url: `chrome-extension://${EXT_ID}/src/popup/popup.html`
});

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
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
    },
    peekRaw() {
      return structuredClone(store);
    }
  };
}

test('Section 13 — Manifest, Brand & Global Privacy/Security Static Audit across all source files', () => {
  const manifest = JSON.parse(fs.readFileSync(path.resolve('manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, 'SparkLink - 星火链');
  assert.equal(manifest.short_name, 'SparkLink');
  assert.ok(manifest.description.includes('我不会错过你的每一次发声'));
  assert.deepEqual(manifest.permissions, ['storage']);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(JSON.stringify(manifest).includes(']('), false, 'No Markdown URLs in manifest.json');

  const allCodeFiles = [
    'src/x-adapter.js',
    'src/interceptor.js',
    'src/bridge.js',
    'src/content.js',
    'src/schema.js',
    'src/metrics.js',
    'src/storage.js',
    'src/background.js',
    'src/popup/popup.js'
  ];

  for (const rel of allCodeFiles) {
    const code = stripComments(fs.readFileSync(path.resolve(rel), 'utf8'));
    assert.equal(/\binnerHTML\b|\bouterHTML\b|\binsertAdjacentHTML\b/.test(code), false, `${rel} must not use innerHTML`);
    assert.equal(/\bdocument\.cookie\b/.test(code), false, `${rel} must not access document.cookie`);
    assert.equal(/\beval\s*\(|new\s+Function\s*\(/.test(code), false, `${rel} must not use eval`);
    assert.equal(/Function\.prototype\.toString/.test(code), false, `${rel} must not tamper with Function.prototype.toString`);
    assert.equal(/chrome\.storage\.sync/.test(code), false, `${rel} must not use storage.sync`);
  }
});

test('Section 13 — Full E2E Pause/Resume In-Flight Isolation + Replies Timeline Backfill + Account Switch A->B->A', async () => {
  // Align clock with fixtures: standardReply created_at is Wed Nov 11 2026 (~1794391200000)
  const NOW_MS = 1794794402000;
  const localArea = createArea();
  const sessionArea = createArea();
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
        async sendMessage(_tabId, msg) {
          for (const fn of tabListeners) {
            fn(msg, { id: EXT_ID });
          }
        },
        onRemoved: { addListener() {} }
      }
    },
    { nowFn: () => NOW_MS }
  );

  const tabSender = {
    id: EXT_ID,
    tab: { id: 77, active: true },
    frameId: 0,
    documentId: 'doc_e2e_77',
    origin: 'https://x.com',
    url: 'https://x.com/home'
  };

  let pendingNetworkResolver = null;
  let pendingFirstAResolver = null;
  let viewerCallSeq = 0;
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
      if (String(url).includes('PendingPauseTest')) {
        return new Promise((resolve) => {
          pendingNetworkResolver = resolve;
        });
      }
      if (String(url).includes('PendingSwitchATest')) {
        return new Promise((resolve) => {
          pendingFirstAResolver = resolve;
        });
      }
      if (String(url).includes('UserTweetsAndReplies')) {
        return Promise.resolve(
          new Response(JSON.stringify(timelineFixtures.ownRepliesTimelineMixed.response), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
        );
      }
      if (String(url).includes('Viewer')) {
        viewerCallSeq += 1;
        const viewerPayload =
          viewerCallSeq === 1
            ? viewerFixtures.viewerGraphqlLegacy
            : viewerFixtures.viewerGraphqlModern;
        return Promise.resolve(
          new Response(JSON.stringify(viewerPayload), {
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
          for (const fn of set) {
            fn({ data, origin, source: fakeWin });
          }
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

  // 1. Enable collection and bind Account A (1001001)
  await bg.handleMessage({ type: 'SET_COLLECTION_ENABLED', enabled: true }, POPUP_SENDER);
  installMainInterceptor(fakeWin, adapterApi, { nowFn: () => NOW_MS });
  const bridge = installIsolatedBridge(fakeWin, pageChrome, { nowFn: () => NOW_MS, retryDelayMs: 5 });

  await new Promise((r) => setTimeout(r, 40));
  assert.equal(bridge.getBindingContext().actorUserId, '1001001');

  // 2. Initiate a CreateTweet request BEFORE pause, then pause, then re-enable BEFORE response arrives!
  const inFlightPromise = fakeWin.fetch(
    'https://x.com/i/api/graphql/PendingPauseTest/CreateTweet',
    {
      method: 'POST',
      body: JSON.stringify(createTweetFixtures.standardReply.requestBody)
    }
  );

  // Pause collection, then re-enable collection (allocates a brand-new captureSessionId!)
  await bg.handleMessage({ type: 'SET_COLLECTION_ENABLED', enabled: false }, POPUP_SENDER);
  await new Promise((r) => setTimeout(r, 25));
  await bg.handleMessage({ type: 'SET_COLLECTION_ENABLED', enabled: true }, POPUP_SENDER);
  await new Promise((r) => setTimeout(r, 40));

  // Now the old in-flight response arrives! Must add 0 records!
  pendingNetworkResolver(
    new Response(JSON.stringify(createTweetFixtures.standardReply.response), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  );
  await inFlightPromise;
  await new Promise((r) => setTimeout(r, 40));

  const snapAfterOldArrived = await bg.handleMessage({ type: 'GET_POPUP_SNAPSHOT' }, POPUP_SENDER);
  assert.equal(snapAfterOldArrived.selectedAccount.summary.totalReplies, 0);

  // 3. User actively browses own replies timeline in the new session -> backfills valid replies!
  await fakeWin.fetch(
    'https://x.com/i/api/graphql/TimelineQid/UserTweetsAndReplies?variables=%7B%22userId%22%3A%221001001%22%7D'
  );
  await new Promise((r) => setTimeout(r, 50));

  const snapAfterBackfill = await bg.handleMessage({ type: 'GET_POPUP_SNAPSHOT' }, POPUP_SENDER);
  assert.ok(snapAfterBackfill.selectedAccount.summary.totalReplies > 0);
  // Ensure no tweet text or avatar URL was persisted anywhere in chrome.storage.local
  const serializedStorage = JSON.stringify(localArea.peekRaw());
  assert.equal(serializedStorage.includes('full_text'), false);
  assert.equal(serializedStorage.includes('profile_image_url'), false);

  // 4. Multi-account A -> B -> A: start an in-flight CreateTweet under A1, switch A -> B -> A2,
  // then let old A1 response arrive -> must add 0 records!
  const countBeforeSwitch = snapAfterBackfill.selectedAccount.summary.totalReplies;
  const oldA1BindingId = bridge.getBindingContext().bindingId;

  const lateSwitchAPromise = fakeWin.fetch(
    'https://x.com/i/api/graphql/PendingSwitchATest/CreateTweet',
    {
      method: 'POST',
      body: JSON.stringify(createTweetFixtures.standardReply.requestBody)
    }
  );

  // Switch A -> B (9009009)
  await fakeWin.fetch('https://x.com/i/api/graphql/ViewerQid/Viewer');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(bridge.getBindingContext().actorUserId, '9009009');

  // Switch B -> A (1001001, receives brand-new bindingId!)
  await fakeWin.fetch('https://x.com/i/api/graphql/ViewerQid/Viewer');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(bridge.getBindingContext().actorUserId, '1001001');
  assert.notEqual(bridge.getBindingContext().bindingId, oldA1BindingId);

  // Now resolve the late response from original A1 binding (with a distinct new reply ID)
  const distinctReplyResp = structuredClone(createTweetFixtures.standardReply.response);
  distinctReplyResp.data.create_tweet.tweet_results.result.rest_id = '2122147641553899999';
  distinctReplyResp.data.create_tweet.tweet_results.result.legacy.id_str = '2122147641553899999';
  pendingFirstAResolver(
    new Response(JSON.stringify(distinctReplyResp), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  );
  await lateSwitchAPromise;
  await new Promise((r) => setTimeout(r, 40));

  const snapAfterSwitchBack = await bg.handleMessage({ type: 'GET_POPUP_SNAPSHOT' }, POPUP_SENDER);
  assert.equal(snapAfterSwitchBack.selectedAccount.summary.totalReplies, countBeforeSwitch);

  bridge.destroy();
});

test('Section 13 — Spec Section 9.1 Exact v1 Backup Cross-Device Restore & Re-Import Preservation', async () => {
  // Exact JSON from spec.md Section 9.1
  const specSection91Backup = JSON.stringify({
    format: 'sparklink-backup',
    formatVersion: 1,
    exportedAt: '2026-11-16T02:00:01.000Z',
    data: {
      schemaVersion: 1,
      accounts: {
        '1001001': {
          handle: 'sample_me',
          displayName: '示例账号',
          users: {
            '2002002': {
              handle: 'sample_friend',
              displayName: '示例好友',
              updatedAt: 1794794401000
            }
          },
          replies: {
            '2122147641553846272': {
              replyTweetId: '2122147641553846272',
              parentTweetId: '2121785253688246272',
              targetUserId: '2002002',
              createdAt: 1794794400000,
              observedAt: 1794794401000,
              source: 'live'
            }
          }
        }
      }
    }
  });

  const NOW_MS = 1794794405000;
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

  // Empty device initially has collectionEnabled === false
  const prev1 = await bg.handleMessage({ type: 'PREVIEW_IMPORT', rawText: specSection91Backup }, POPUP_SENDER);
  assert.equal(prev1.ok, true);
  assert.equal(prev1.preview.added, 1);

  const com1 = await bg.handleMessage(
    { type: 'COMMIT_IMPORT', rawText: specSection91Backup, baseline: prev1.baseline },
    POPUP_SENDER
  );
  assert.equal(com1.ok, true);

  const snap1 = await bg.handleMessage({ type: 'GET_POPUP_SNAPSHOT' }, POPUP_SENDER);
  assert.equal(snap1.settings.collectionEnabled, false); // Preserved original disabled state!
  assert.equal(snap1.selectedAccount.summary.totalReplies, 1);
  assert.equal(snap1.selectedAccount.summary.latestReplyAt, 1794794400000); // Exact original createdAt!

  // Re-import the exact same backup -> count stays 1, original source ('live') & observedAt preserved!
  const prev2 = await bg.handleMessage({ type: 'PREVIEW_IMPORT', rawText: specSection91Backup }, POPUP_SENDER);
  const com2 = await bg.handleMessage(
    { type: 'COMMIT_IMPORT', rawText: specSection91Backup, baseline: prev2.baseline },
    POPUP_SENDER
  );
  assert.equal(com2.ok, true);
  assert.equal(com2.added, 0);
  assert.equal(com2.duplicates, 1);

  const storedReply =
    localArea.peekRaw()[STATE_STORAGE_KEY].accounts['1001001'].replies['2122147641553846272'];
  assert.equal(storedReply.source, 'live');
  assert.equal(storedReply.observedAt, 1794794401000);
});
