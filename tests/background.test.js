import test from 'node:test';
import assert from 'node:assert/strict';

import { createBackgroundService } from '../src/background.js';

const NOW_MS = 1794794402000;
const EXT_ID = 'sparklink_ext_id';
const POPUP_URL = `chrome-extension://${EXT_ID}/src/popup/popup.html`;

function createMockArea(initial = {}) {
  let data = structuredClone(initial);
  const accessLevels = [];
  return {
    accessLevels,
    async setAccessLevel(opts) {
      accessLevels.push(opts.accessLevel);
    },
    async get(key) {
      if (typeof key === 'string') {
        return Object.prototype.hasOwnProperty.call(data, key)
          ? { [key]: structuredClone(data[key]) }
          : {};
      }
      return structuredClone(data);
    },
    async set(items) {
      data = { ...data, ...structuredClone(items) };
    },
    async clear() {
      data = {};
    },
    peek() {
      return structuredClone(data);
    }
  };
}

function createMockChrome(localArea, sessionArea) {
  const onMessageListeners = new Set();
  const onRemovedListeners = new Set();
  const tabMessages = [];

  const chromeMock = {
    storage: {
      local: localArea,
      session: sessionArea
    },
    runtime: {
      id: EXT_ID,
      getURL(relPath) {
        const clean = relPath.replace(/^\//, '');
        return `chrome-extension://${EXT_ID}/${clean}`;
      },
      onMessage: {
        addListener(fn) {
          onMessageListeners.add(fn);
        }
      }
    },
    tabs: {
      async sendMessage(tabId, msg) {
        tabMessages.push({ tabId, msg });
      },
      onRemoved: {
        addListener(fn) {
          onRemovedListeners.add(fn);
        }
      }
    },
    tabMessages,
    async dispatchMessage(msg, sender) {
      for (const fn of onMessageListeners) {
        let replyVal;
        let asyncHandled = false;
        const ret = fn(msg, sender, (res) => {
          replyVal = res;
        });
        if (ret === true) {
          asyncHandled = true;
        }
        if (asyncHandled) {
          return new Promise((resolve) => {
            fn(msg, sender, (res) => resolve(res));
          });
        }
        if (replyVal !== undefined) {
          return replyVal;
        }
      }
      return undefined;
    },
    closeTab(tabId) {
      for (const fn of onRemovedListeners) {
        fn(tabId);
      }
    }
  };

  return chromeMock;
}

const POPUP_SENDER = Object.freeze({
  id: EXT_ID,
  url: POPUP_URL
});

function makeXSender(tabId = 101, docId = 'doc_1', frameId = 0, origin = 'https://x.com') {
  return {
    id: EXT_ID,
    tab: { id: tabId, active: true },
    frameId,
    documentId: docId,
    origin,
    url: `${origin}/home`
  };
}

test('Background enforces TRUSTED_CONTEXTS on boot and blocks Content Scripts, iframes, or foreign origins from privileged operations', async () => {
  const localArea = createMockArea();
  const sessionArea = createMockArea();
  const chromeMock = createMockChrome(localArea, sessionArea);

  const bg = createBackgroundService(chromeMock, { nowFn: () => NOW_MS });
  const snap = await bg.handleMessage({ type: 'GET_POPUP_SNAPSHOT' }, POPUP_SENDER);

  assert.equal(snap.ok, true);
  assert.deepEqual(localArea.accessLevels, ['TRUSTED_CONTEXTS']);
  assert.deepEqual(sessionArea.accessLevels, ['TRUSTED_CONTEXTS']);

  // Content script attempting Popup-only operations MUST be rejected
  const xSender = makeXSender(101, 'doc_1');
  for (const forbiddenType of [
    'SET_COLLECTION_ENABLED',
    'CLEAR_ALL',
    'CLEAR_ACCOUNT',
    'EXPORT_BACKUP',
    'PREVIEW_IMPORT',
    'COMMIT_IMPORT',
    'GET_POPUP_SNAPSHOT'
  ]) {
    const res = await bg.handleMessage({ type: forbiddenType, enabled: true }, xSender);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'FORBIDDEN_SENDER');
  }

  // Non-top-level iframe (frameId = 1) or non-X origin rejected even for HELLO
  assert.equal(
    (await bg.handleMessage({ type: 'HELLO' }, makeXSender(101, 'doc_sub', 1))).code,
    'FORBIDDEN_SENDER'
  );
  assert.equal(
    (await bg.handleMessage({ type: 'HELLO' }, makeXSender(101, 'doc_evil', 0, 'https://evil.com'))).code,
    'FORBIDDEN_SENDER'
  );
});

test('Viewer binding persists across Worker restarts via storage.session, requires rebind if session cleared, and isolates multi-account clear', async () => {
  const localArea = createMockArea();
  const sessionArea = createMockArea();
  const chrome1 = createMockChrome(localArea, sessionArea);
  const bg1 = createBackgroundService(chrome1, { nowFn: () => NOW_MS });

  const tabASender = makeXSender(10, 'doc_a1');
  const tabBSender = makeXSender(20, 'doc_b1');

  // Unbound X tab cannot query counts or submit replies before BIND_VIEWER
  await bg1.handleMessage({ type: 'SET_COLLECTION_ENABLED', enabled: true }, POPUP_SENDER);
  const helloUnbound = await bg1.handleMessage({ type: 'HELLO' }, tabASender);
  assert.equal(helloUnbound.ok, true);
  assert.equal(helloUnbound.bindRequired, true);

  // Popup sees unconfirmed active X tab hint before viewer binding
  const popupBeforeBind = await bg1.handleMessage({ type: 'GET_POPUP_SNAPSHOT' }, POPUP_SENDER);
  assert.equal(popupBeforeBind.viewerStatus, 'unconfirmed');

  assert.equal(
    (await bg1.handleMessage({ type: 'QUERY_TARGET_COUNTS', targetUserIds: ['2002'] }, tabASender)).code,
    'BIND_REQUIRED'
  );

  // Bind Tab A to Account 1001001; duplicate handshake returns identical bindingId
  const bindA1 = await bg1.handleMessage(
    {
      type: 'BIND_VIEWER',
      captureSessionId: helloUnbound.captureSessionId,
      viewer: { actorUserId: '1001001', handle: 'user_a', displayName: 'User A' }
    },
    tabASender
  );
  assert.equal(bindA1.ok, true);

  const bindA1Dup = await bg1.handleMessage(
    {
      type: 'BIND_VIEWER',
      captureSessionId: helloUnbound.captureSessionId,
      viewer: { actorUserId: '1001001', handle: 'user_a', displayName: 'User A' }
    },
    tabASender
  );
  assert.equal(bindA1Dup.bindingContext.bindingId, bindA1.bindingContext.bindingId);

  // Bind Tab B to Account 9009009
  const bindB1 = await bg1.handleMessage(
    {
      type: 'BIND_VIEWER',
      captureSessionId: helloUnbound.captureSessionId,
      viewer: { actorUserId: '9009009', handle: 'user_b', displayName: 'User B' }
    },
    tabBSender
  );
  assert.equal(bindB1.ok, true);

  // Simulate Service Worker termination & fresh restart (localArea + sessionArea survive!)
  const chrome2 = createMockChrome(localArea, sessionArea);
  const bg2 = createBackgroundService(chrome2, { nowFn: () => NOW_MS });

  // First valid reply from Tab A after Worker restart restores session binding and adds +1!
  const submitAfterRestart = await bg2.handleMessage(
    {
      type: 'SUBMIT_OBSERVED_BATCH',
      bindingContext: bindA1.bindingContext,
      events: [
        {
          actorUserId: '1001001',
          replyTweetId: '2122147641553846272',
          parentTweetId: '2121785253688246272',
          targetUserId: '2002002',
          targetHandle: 'friend',
          createdAt: NOW_MS - 1000,
          observedAt: NOW_MS,
          source: 'live'
        }
      ]
    },
    tabASender
  );
  assert.equal(submitAfterRestart.ok, true);
  assert.equal(submitAfterRestart.added, 1);

  // Clear Account A from Popup -> revokes Tab A binding & notifies Tab A, while Tab B stays valid!
  const clearA = await bg2.handleMessage(
    {
      type: 'CLEAR_ACCOUNT',
      actorUserId: '1001001',
      accountGeneration: bindA1.bindingContext.accountGeneration
    },
    POPUP_SENDER
  );
  assert.equal(clearA.ok, true);
  assert.ok(
    chrome2.tabMessages.some(
      (m) => m.tabId === 10 && m.msg.type === 'BINDING_INVALIDATED'
    )
  );

  // Tab B can still submit with its original binding!
  const submitB = await bg2.handleMessage(
    {
      type: 'SUBMIT_OBSERVED_BATCH',
      bindingContext: bindB1.bindingContext,
      events: [
        {
          actorUserId: '9009009',
          replyTweetId: '2122147641553849999',
          parentTweetId: '2121785253688249999',
          targetUserId: '3003003',
          createdAt: NOW_MS - 500,
          observedAt: NOW_MS,
          source: 'live'
        }
      ]
    },
    tabBSender
  );
  assert.equal(submitB.ok, true);
  assert.equal(submitB.added, 1);

  // Now clear session storage (simulating browser restart) -> Tab B gets BIND_REQUIRED
  await sessionArea.clear();
  const chrome3 = createMockChrome(localArea, sessionArea);
  const bg3 = createBackgroundService(chrome3, { nowFn: () => NOW_MS });

  const afterSessionClear = await bg3.handleMessage(
    {
      type: 'QUERY_TARGET_COUNTS',
      bindingContext: bindB1.bindingContext,
      targetUserIds: ['3003003']
    },
    tabBSender
  );
  assert.equal(afterSessionClear.ok, false);
  assert.equal(afterSessionClear.code, 'BIND_REQUIRED');
});

test('Background handles Popup export/preview/commit import, cleanup, Clear All, diagnostics, REVOKE_VIEWER_BINDING, and tab onRemoved', async () => {
  const localArea = createMockArea();
  const sessionArea = createMockArea();
  const chromeMock = createMockChrome(localArea, sessionArea);
  const bg = createBackgroundService(chromeMock, { nowFn: () => NOW_MS });

  await bg.handleMessage({ type: 'SET_COLLECTION_ENABLED', enabled: true }, POPUP_SENDER);
  const tabSender = makeXSender(55, 'doc_55');
  const hello = await bg.handleMessage({ type: 'HELLO' }, tabSender);
  const bound = await bg.handleMessage(
    {
      type: 'BIND_VIEWER',
      captureSessionId: hello.captureSessionId,
      viewer: { actorUserId: '1001001', handle: 'sample_me', displayName: '示例账号' }
    },
    tabSender
  );

  await bg.handleMessage(
    {
      type: 'SUBMIT_OBSERVED_BATCH',
      bindingContext: bound.bindingContext,
      partialUnrecognized: true,
      events: [
        {
          actorUserId: '1001001',
          replyTweetId: '2122147641553846272',
          parentTweetId: '2121785253688246272',
          targetUserId: '2002002',
          targetHandle: 'friend',
          createdAt: NOW_MS - 1000,
          observedAt: NOW_MS,
          source: 'live'
        }
      ]
    },
    tabSender
  );

  await bg.handleMessage(
    { type: 'REPORT_DIAGNOSTIC', category: 'observation_dropped' },
    tabSender
  );

  const snapWithDiag = await chromeMock.dispatchMessage(
    { type: 'GET_POPUP_SNAPSHOT' },
    POPUP_SENDER
  );
  assert.equal(snapWithDiag.viewerStatus, 'bound');
  assert.equal(snapWithDiag.activeTabActorUserId, '1001001');
  assert.equal(snapWithDiag.diagnostics.partialUnrecognized, true);
  assert.equal(snapWithDiag.diagnostics.observationDropped, true);

  // Export -> Clear All -> Preview -> Commit Import
  const exported = await bg.handleMessage({ type: 'EXPORT_BACKUP' }, POPUP_SENDER);
  assert.equal(exported.ok, true);
  const rawJson = JSON.stringify(exported.backup);

  const clearAll = await bg.handleMessage({ type: 'CLEAR_ALL' }, POPUP_SENDER);
  assert.equal(clearAll.ok, true);

  const preview = await bg.handleMessage({ type: 'PREVIEW_IMPORT', rawText: rawJson }, POPUP_SENDER);
  assert.equal(preview.ok, true);
  assert.equal(preview.preview.added, 1);

  const committed = await bg.handleMessage(
    { type: 'COMMIT_IMPORT', rawText: rawJson, baseline: preview.baseline },
    POPUP_SENDER
  );
  assert.equal(committed.ok, true);

  const cleanup = await bg.handleMessage({ type: 'CLEANUP_EXPIRED' }, POPUP_SENDER);
  assert.equal(cleanup.ok, true);

  // Re-hello, bind, revoke, and close tab
  await bg.handleMessage({ type: 'SET_COLLECTION_ENABLED', enabled: true }, POPUP_SENDER);
  const h2 = await bg.handleMessage({ type: 'HELLO' }, tabSender);
  const b2 = await bg.handleMessage(
    {
      type: 'BIND_VIEWER',
      captureSessionId: h2.captureSessionId,
      viewer: { actorUserId: '1001001', handle: 'sample_me' }
    },
    tabSender
  );
  await bg.handleMessage(
    { type: 'REVOKE_VIEWER_BINDING', bindingId: b2.bindingContext.bindingId },
    tabSender
  );
  chromeMock.closeTab(55);
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(sessionArea.peek().sparklink_doc_bindings['55'], undefined);
});
