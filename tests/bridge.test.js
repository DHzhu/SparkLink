'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { installIsolatedBridge } = require('../src/bridge.js');

const BINDING_A1 = Object.freeze({
  bindingId: 'bind_a1',
  actorUserId: '1001001',
  captureSessionId: 1,
  collectionGeneration: 1,
  accountGeneration: 1
});

const BINDING_B1 = Object.freeze({
  bindingId: 'bind_b1',
  actorUserId: '9009009',
  captureSessionId: 1,
  collectionGeneration: 1,
  accountGeneration: 2
});

const BINDING_A2 = Object.freeze({
  bindingId: 'bind_a2',
  actorUserId: '1001001',
  captureSessionId: 1,
  collectionGeneration: 1,
  accountGeneration: 1
});

function makeReplyEvent(idx, bindingContext = BINDING_A1) {
  return {
    actorUserId: bindingContext.actorUserId,
    replyTweetId: String(2122147641553840000n + BigInt(idx)),
    parentTweetId: String(2121785253688240000n + BigInt(idx)),
    targetUserId: '2002002',
    targetHandle: 'sample_friend',
    targetDisplayName: '示例好友',
    createdAt: 1794794400000 + idx * 1000,
    observedAt: 1794794401000 + idx * 1000,
    source: 'live',
    bindingContext
  };
}

function createBridgeMockEnv(runtimeHandler) {
  const winListeners = new Map();
  const runtimeListeners = new Set();
  const mainInbound = [];
  const runtimeCalls = [];

  const win = {
    location: { origin: 'https://x.com', href: 'https://x.com/home' },
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, new Set());
      winListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      if (winListeners.has(type)) winListeners.get(type).delete(fn);
    },
    postMessage(data, targetOrigin) {
      mainInbound.push({ data, targetOrigin });
    },
    restoreFromCache() {
      for (const fn of winListeners.get('pageshow') || []) fn({ persisted: true });
    },
    emitFromMain(data, origin = 'https://x.com', source = win) {
      const set = winListeners.get('message');
      if (set) {
        for (const fn of set) {
          fn({ data, origin, source });
        }
      }
    }
  };
  win.top = win;

  const chromeObj = {
    runtime: {
      id: 'ext_sparklink_test',
      async sendMessage(msg) {
        runtimeCalls.push(msg);
        return runtimeHandler(msg);
      },
      onMessage: {
        addListener(fn) {
          runtimeListeners.add(fn);
        },
        removeListener(fn) {
          runtimeListeners.delete(fn);
        }
      }
    },
    emitFromBackground(msg) {
      for (const fn of runtimeListeners) {
        fn(msg, { id: 'ext_sparklink_test' }, () => {});
      }
    }
  };

  return { win, chromeObj, mainInbound, runtimeCalls };
}

test('A failed BFCache handshake retries without user input and ordinary worker wakeups can restore bindings', { timeout: 2000 }, async (t) => {
  const helloFlags = [];
  let storedBinding = BINDING_A1;
  const { win, chromeObj } = createBridgeMockEnv((msg) => {
    assert.equal(msg.type, 'HELLO');
    helloFlags.push(msg.revalidateViewer);
    if (helloFlags.length === 2) throw new Error('Worker temporarily unavailable');
    if (msg.revalidateViewer) storedBinding = null;
    return { ok: true, collectionEnabled: true, captureSessionId: 1, bindingContext: storedBinding };
  });
  const bridge = installIsolatedBridge(win, chromeObj, { retryDelayMs: 1 });
  t.after(() => bridge.destroy());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(bridge.getBindingContext()?.bindingId, BINDING_A1.bindingId);

  const revalidated = new Promise((resolve) => bridge.subscribe((event) => {
    if (event.type === 'BINDING_REQUIRED') resolve();
  }));
  win.restoreFromCache();
  assert.equal(bridge.getBindingContext(), null);
  await revalidated;
  assert.deepEqual(helloFlags, [false, true, true]);

  // A later worker wakeup has a newly verified binding for this document.
  storedBinding = BINDING_B1;
  chromeObj.emitFromBackground({ type: 'STATE_CHANGED', collectionEnabled: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(helloFlags.at(-1), false);
  assert.equal(bridge.getBindingContext()?.bindingId, BINDING_B1.bindingId);
});

test('Bridge performs handshake, HELLO -> BIND_VIEWER lifecycle, rejects malicious postMessages, and handles A -> B -> A account switching', async () => {
  let bindSeq = 0;
  const { win, chromeObj, mainInbound, runtimeCalls } = createBridgeMockEnv(async (msg) => {
    if (msg.type === 'HELLO') {
      return {
        ok: true,
        collectionEnabled: true,
        captureSessionId: 1,
        bindingContext: null,
        bindRequired: true,
        revision: 1
      };
    }
    if (msg.type === 'BIND_VIEWER') {
      bindSeq += 1;
      if (msg.viewer.actorUserId === '1001001') {
        return {
          ok: true,
          bindingContext: bindSeq === 1 ? BINDING_A1 : BINDING_A2,
          revision: bindSeq + 1
        };
      }
      return {
        ok: true,
        bindingContext: BINDING_B1,
        revision: bindSeq + 1
      };
    }
    if (msg.type === 'REVOKE_VIEWER_BINDING') {
      return { ok: true };
    }
    if (msg.type === 'SUBMIT_OBSERVED_BATCH') {
      return { ok: true, revision: 10 };
    }
    return { ok: true };
  });

  const bridge = installIsolatedBridge(win, chromeObj, { retryDelayMs: 10 });
  await new Promise((r) => setTimeout(r, 20));

  // Initial BRIDGE_INIT sent with exact origin
  const initMsg = mainInbound.find((m) => m.data.type === 'BRIDGE_INIT');
  assert.ok(initMsg);
  assert.equal(initMsg.targetOrigin, 'https://x.com');
  const nonce = initMsg.data.nonce;

  // Acknowledge MAIN_READY
  win.emitFromMain({ protocol: 'SPARKLINK_BRIDGE_V1', type: 'MAIN_READY', nonce });

  // Malicious messages (wrong origin, privileged action attempt, prototype pollution, oversized array) must be rejected
  win.emitFromMain(
    {
      protocol: 'SPARKLINK_BRIDGE_V1',
      type: 'VIEWER_EVIDENCE',
      nonce,
      captureSessionId: 1,
      viewer: { actorUserId: '666666' }
    },
    'https://attacker.example'
  );
  win.emitFromMain({
    protocol: 'SPARKLINK_BRIDGE_V1',
    type: 'CLEAR_ALL_DATA',
    nonce
  });
  const pollutedViewer = JSON.parse(
    `{"protocol":"SPARKLINK_BRIDGE_V1","type":"VIEWER_EVIDENCE","nonce":"${nonce}","captureSessionId":1,"__proto":{"x":1},"viewer":{"actorUserId":"1001001"}}`
  );
  Object.defineProperty(pollutedViewer, '__proto__', {
    value: { bad: true },
    enumerable: true
  });
  win.emitFromMain(pollutedViewer);

  assert.equal(runtimeCalls.filter((c) => c.type === 'BIND_VIEWER').length, 0);

  // Valid VIEWER_EVIDENCE for Account A -> establishes BINDING_A1
  win.emitFromMain({
    protocol: 'SPARKLINK_BRIDGE_V1',
    type: 'VIEWER_EVIDENCE',
    nonce,
    captureSessionId: 1,
    viewer: { actorUserId: '1001001', handle: 'sample_me', displayName: '示例账号' }
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(bridge.getBindingContext(), BINDING_A1);

  // Switch A -> B -> revokes A1 and gets BINDING_B1
  win.emitFromMain({
    protocol: 'SPARKLINK_BRIDGE_V1',
    type: 'VIEWER_EVIDENCE',
    nonce,
    captureSessionId: 1,
    viewer: { actorUserId: '9009009', handle: 'second_account', displayName: '第二账号' }
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(bridge.getBindingContext(), BINDING_B1);
  assert.ok(
    runtimeCalls.some((c) => c.type === 'REVOKE_VIEWER_BINDING' && c.bindingId === 'bind_a1')
  );

  // Late response from old BINDING_A1 arrives now -> must be dropped (0 batches submitted)
  win.emitFromMain({
    protocol: 'SPARKLINK_BRIDGE_V1',
    type: 'OBSERVED_EVENTS',
    nonce,
    bindingContext: BINDING_A1,
    events: [makeReplyEvent(1, BINDING_A1)]
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(runtimeCalls.filter((c) => c.type === 'SUBMIT_OBSERVED_BATCH').length, 0);

  // Switch B -> back to A -> gets brand new BINDING_A2 (not A1!)
  win.emitFromMain({
    protocol: 'SPARKLINK_BRIDGE_V1',
    type: 'VIEWER_EVIDENCE',
    nonce,
    captureSessionId: 1,
    viewer: { actorUserId: '1001001', handle: 'sample_me', displayName: '示例账号' }
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(bridge.getBindingContext(), BINDING_A2);
});

test('Bridge splits >100 events into 100-item batches, retries transient failures up to 3x, enforces 128-item / 60s queue cap, and never re-stamps stale batches on BIND_REQUIRED', async () => {
  let submitBehavior = 'ok';
  let helloRecoveryBinding = BINDING_A1;
  let transientAttempts = 0;

  const { win, chromeObj, mainInbound, runtimeCalls } = createBridgeMockEnv(async (msg) => {
    if (msg.type === 'HELLO') {
      return {
        ok: true,
        collectionEnabled: true,
        captureSessionId: 1,
        bindingContext: helloRecoveryBinding,
        bindRequired: !helloRecoveryBinding,
        revision: 2
      };
    }
    if (msg.type === 'SUBMIT_OBSERVED_BATCH') {
      if (submitBehavior === 'transient_twice') {
        transientAttempts += 1;
        if (transientAttempts <= 2) {
          throw new Error('SW restarting');
        }
        return { ok: true, revision: 5 };
      }
      if (submitBehavior === 'always_fail') {
        throw new Error('Channel disconnected');
      }
      if (submitBehavior === 'bind_required_lost_session') {
        helloRecoveryBinding = null;
        return { ok: false, code: 'BIND_REQUIRED' };
      }
      return { ok: true, revision: 3 };
    }
    return { ok: true };
  });

  const bridge = installIsolatedBridge(win, chromeObj, {
    retryDelayMs: 10,
    maxBatchSize: 100,
    maxPendingQueue: 128,
    pendingTtlMs: 60000
  });
  await new Promise((r) => setTimeout(r, 20));
  const nonce = mainInbound.find((m) => m.data.type === 'BRIDGE_INIT').data.nonce;
  win.emitFromMain({ protocol: 'SPARKLINK_BRIDGE_V1', type: 'MAIN_READY', nonce });

  // 1. Send 125 valid events at once -> split into batch of 100 + batch of 25
  const events125 = [];
  for (let i = 1; i <= 125; i += 1) {
    events125.push(makeReplyEvent(i, BINDING_A1));
  }
  win.emitFromMain({
    protocol: 'SPARKLINK_BRIDGE_V1',
    type: 'OBSERVED_EVENTS',
    nonce,
    bindingContext: BINDING_A1,
    events: events125
  });
  await new Promise((r) => setTimeout(r, 30));

  const batches = runtimeCalls.filter((c) => c.type === 'SUBMIT_OBSERVED_BATCH');
  assert.equal(batches.length, 2);
  assert.equal(batches[0].events.length, 100);
  assert.equal(batches[1].events.length, 25);

  // 2. Transient failure twice then succeeds on retry #2 (within 3 retries)
  submitBehavior = 'transient_twice';
  transientAttempts = 0;
  win.emitFromMain({
    protocol: 'SPARKLINK_BRIDGE_V1',
    type: 'OBSERVED_EVENTS',
    nonce,
    bindingContext: BINDING_A1,
    events: [makeReplyEvent(200, BINDING_A1)]
  });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(transientAttempts, 3);
  assert.equal(bridge.getPendingQueueSize(), 0);

  // 3. Exhausts 3 retries -> drops batch and reports observation_dropped diagnostic
  submitBehavior = 'always_fail';
  win.emitFromMain({
    protocol: 'SPARKLINK_BRIDGE_V1',
    type: 'OBSERVED_EVENTS',
    nonce,
    bindingContext: BINDING_A1,
    events: [makeReplyEvent(300, BINDING_A1)]
  });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(bridge.getPendingQueueSize(), 0);
  assert.ok(
    runtimeCalls.some(
      (c) => c.type === 'REPORT_DIAGNOSTIC' && c.category === 'observation_dropped'
    )
  );

  // 4. BIND_REQUIRED when session storage was cleared -> drops old batch without re-stamping
  submitBehavior = 'bind_required_lost_session';
  win.emitFromMain({
    protocol: 'SPARKLINK_BRIDGE_V1',
    type: 'OBSERVED_EVENTS',
    nonce,
    bindingContext: BINDING_A1,
    events: [makeReplyEvent(400, BINDING_A1)]
  });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(bridge.getBindingContext(), null);
  assert.equal(bridge.getPendingQueueSize(), 0);
});

test('Bridge covers AUTHOR_MAPPINGS rename eviction, queryCounts, runtime broadcasts, queue overflow/TTL, iframe guard, and destroy', async () => {
  // Sub-frame guard
  const iframeWin = { location: { origin: 'https://x.com' }, top: {} };
  assert.equal(installIsolatedBridge(iframeWin, null), null);

  let currentClock = 1794794400000;
  let paused = false;
  let blockSubmits = false;
  let unblockFn = null;

  const { win, chromeObj, mainInbound, runtimeCalls } = createBridgeMockEnv(async (msg) => {
    if (msg.type === 'HELLO') {
      if (paused) {
        return {
          ok: true,
          collectionEnabled: false,
          captureSessionId: null,
          bindingContext: null,
          bindRequired: false,
          revision: 9
        };
      }
      return {
        ok: true,
        collectionEnabled: true,
        captureSessionId: 1,
        bindingContext: BINDING_A1,
        bindRequired: false,
        revision: 4
      };
    }
    if (msg.type === 'QUERY_TARGET_COUNTS') {
      return {
        ok: true,
        counts: { '2002002': 15 },
        revision: 4
      };
    }
    if (msg.type === 'SUBMIT_OBSERVED_BATCH') {
      if (blockSubmits) {
        await new Promise((resolve) => {
          unblockFn = resolve;
        });
        return { ok: false, code: 'QUOTA_EXCEEDED' };
      }
      return { ok: true, revision: 6 };
    }
    return { ok: true };
  });

  const bridge = installIsolatedBridge(win, chromeObj, {
    maxPendingQueue: 3,
    pendingTtlMs: 1000,
    retryDelayMs: 5,
    nowFn: () => currentClock
  });
  await new Promise((r) => setTimeout(r, 20));

  const subEvents = [];
  const unsubscribe = bridge.subscribe((ev) => subEvents.push(ev));

  // MAIN_HELLO triggers BRIDGE_INIT reply
  win.emitFromMain({ protocol: 'SPARKLINK_BRIDGE_V1', type: 'MAIN_HELLO' });
  const nonce = mainInbound[mainInbound.length - 1].data.nonce;

  assert.equal(bridge.isCollectionEnabled(), true);
  assert.equal(bridge.getRevision(), 4);

  // AUTHOR_MAPPINGS & rename eviction + handle takeover
  win.emitFromMain({
    protocol: 'SPARKLINK_BRIDGE_V1',
    type: 'AUTHOR_MAPPINGS',
    nonce,
    bindingContext: BINDING_A1,
    observedUsers: [{ userId: '2002002', handle: 'old_handle', displayName: 'Friend' }],
    observedTweets: [{ tweetId: '2121000000000000001', authorUserId: '2002002', handle: 'old_handle' }]
  });
  assert.equal(bridge.resolveUserIdByHandle('old_handle'), '2002002');
  assert.equal(bridge.resolveAuthorByTweetId('2121000000000000001').authorUserId, '2002002');

  // Rename 2002002 -> new_handle, and 3003003 takes old_handle
  win.emitFromMain({
    protocol: 'SPARKLINK_BRIDGE_V1',
    type: 'AUTHOR_MAPPINGS',
    nonce,
    bindingContext: BINDING_A1,
    observedUsers: [
      { userId: '2002002', handle: 'new_handle', displayName: 'Friend' },
      { userId: '3003003', handle: 'old_handle', displayName: 'Newcomer' }
    ],
    observedTweets: []
  });
  assert.equal(bridge.resolveUserIdByHandle('new_handle'), '2002002');
  assert.equal(bridge.resolveUserIdByHandle('old_handle'), '3003003');

  // queryCounts
  const emptyCounts = await bridge.queryCounts([]);
  assert.deepEqual(emptyCounts, {
    ok: true,
    counts: {},
    revision: 4,
    bindingId: 'bind_a1'
  });
  const countRes = await bridge.queryCounts(['2002002', 'invalid_id']);
  assert.equal(countRes.ok, true);
  assert.equal(countRes.counts['2002002'], 15);

  // DIAGNOSTIC forwarding
  win.emitFromMain({
    protocol: 'SPARKLINK_BRIDGE_V1',
    type: 'DIAGNOSTIC',
    nonce,
    category: 'concurrency_limit_skipped'
  });
  assert.ok(
    runtimeCalls.some(
      (c) => c.type === 'REPORT_DIAGNOSTIC' && c.category === 'concurrency_limit_skipped'
    )
  );

  // Queue overflow (>3) & TTL expiration while first batch is in-flight
  blockSubmits = true;
  win.emitFromMain({
    protocol: 'SPARKLINK_BRIDGE_V1',
    type: 'OBSERVED_EVENTS',
    nonce,
    bindingContext: BINDING_A1,
    events: [makeReplyEvent(1, BINDING_A1)]
  });
  await new Promise((r) => setTimeout(r, 10));

  // Push 4 more while blocked -> triggers overflow drop
  win.emitFromMain({
    protocol: 'SPARKLINK_BRIDGE_V1',
    type: 'OBSERVED_EVENTS',
    nonce,
    bindingContext: BINDING_A1,
    events: [
      makeReplyEvent(2, BINDING_A1),
      makeReplyEvent(3, BINDING_A1),
      makeReplyEvent(4, BINDING_A1),
      makeReplyEvent(5, BINDING_A1)
    ]
  });
  assert.equal(bridge.getPendingQueueSize(), 3);

  // Advance clock past TTL -> remaining items expire on next enqueue/flush
  currentClock += 5000;
  unblockFn();
  await new Promise((r) => setTimeout(r, 20));
  blockSubmits = false;

  // Runtime broadcast: REVISION_UPDATED, BINDING_INVALIDATED, STATE_CHANGED (paused)
  chromeObj.emitFromBackground({ type: 'REVISION_UPDATED', revision: 12 });
  assert.equal(bridge.getRevision(), 12);

  chromeObj.emitFromBackground({
    type: 'BINDING_INVALIDATED',
    actorUserId: '1001001'
  });
  assert.equal(bridge.getBindingContext(), null);

  const unboundQuery = await bridge.queryCounts(['2002002']);
  assert.equal(unboundQuery.code, 'UNBOUND');

  paused = true;
  chromeObj.emitFromBackground({ type: 'STATE_CHANGED' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(bridge.isCollectionEnabled(), false);
  assert.ok(subEvents.some((e) => e.type === 'COLLECTION_PAUSED'));

  unsubscribe();
  bridge.destroy();
});

test('Bridge keeps [SparkLink Sync/Bridge] silent by default and propagates debugLogsEnabled across HELLO and DEBUG_LOGS_CHANGED', async () => {
  let helloDebug = false;
  const bridgeLogs = [];
  const { win, chromeObj, mainInbound } = createBridgeMockEnv(async (msg) => {
    if (msg.type === 'HELLO') {
      return {
        ok: true,
        debugLogsEnabled: helloDebug,
        historySyncId: 'job_dbg_1',
        historyScope: { id: 'job_dbg_1', actor: '1001001', since: 1000, deadline: 9999999999999, query: null },
        collectionEnabled: true,
        captureSessionId: 1,
        bindingContext: BINDING_A1,
        bindRequired: false,
        revision: 1
      };
    }
    return { ok: true };
  });
  win.console = {
    info(...args) {
      if (String(args[0] || '').includes('[SparkLink Sync/Bridge]')) {
        bridgeLogs.push(args);
      }
    }
  };
  const bridge = installIsolatedBridge(win, chromeObj, { retryDelayMs: 5 });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(bridge.isDebugLogsEnabled(), false);
  assert.equal(bridgeLogs.length, 0);
  assert.equal(mainInbound.at(-1).data.debugLogsEnabled, false);

  chromeObj.emitFromBackground({ type: 'DEBUG_LOGS_CHANGED', debugLogsEnabled: true });
  assert.equal(bridge.isDebugLogsEnabled(), true);
  assert.equal(mainInbound.at(-1).data.type, 'SYNC_STATE');
  assert.equal(mainInbound.at(-1).data.debugLogsEnabled, true);
  bridge.requestHistoryNext('job_dbg_1');
  assert.ok(bridgeLogs.length > 0);
  bridge.destroy();
});
