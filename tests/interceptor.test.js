'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const adapterApi = require('../src/x-adapter.js');
const viewerFixtures = require('./fixtures/viewer-states.json');
const createTweetFixtures = require('./fixtures/create-tweet.json');
const timelineFixtures = require('./fixtures/timelines.json');

const { installMainInterceptor } = require('../src/interceptor.js');

const BINDING_A = Object.freeze({
  bindingId: 'bind_a',
  actorUserId: '1001001',
  captureSessionId: 10,
  collectionGeneration: 1,
  accountGeneration: 2
});

function createStreamingResponse(jsonString, options = {}) {
  const status = options.status || 200;
  const delayMs = options.delayMs || 0;
  const encoder = new TextEncoder();
  const bytes = encoder.encode(jsonString);
  let cloneCalled = 0;
  let readerCancelled = false;

  function makeStream() {
    return new ReadableStream({
      start(controller) {
        if (delayMs > 0) {
          const timer = setTimeout(() => {
            try {
              controller.enqueue(bytes);
              controller.close();
            } catch (_e) {
              // Closed/cancelled
            }
          }, delayMs);
          if (timer.unref) timer.unref();
        } else {
          controller.enqueue(bytes);
          controller.close();
        }
      },
      cancel() {
        readerCancelled = true;
      }
    });
  }

  const res = new Response(makeStream(), {
    status,
    headers: { 'content-type': 'application/json' }
  });
  const origClone = res.clone.bind(res);
  res.clone = function trackedClone() {
    cloneCalled += 1;
    const cloned = origClone();
    const origGetReader = cloned.body.getReader.bind(cloned.body);
    cloned.body.getReader = function trackedReader() {
      const r = origGetReader();
      const origCancel = r.cancel.bind(r);
      r.cancel = function trackedCancel(reason) {
        readerCancelled = true;
        return origCancel(reason);
      };
      return r;
    };
    return cloned;
  };

  return {
    res,
    getCloneCalled: () => cloneCalled,
    wasReaderCancelled: () => readerCancelled
  };
}

function createMockEnvironment(fetchImpl) {
  const listeners = new Map();
  const outboundMessages = [];

  class FakeXHR {
    constructor() {
      this._listeners = new Map();
      this.responseType = '';
      this.status = 200;
      this.responseText = '';
      this.response = null;
      this.onload = null;
    }
    open(method, url, asyncFlag = true) {
      if (!method) {
        throw new TypeError('Method required');
      }
      this._openedMethod = method;
      this._openedUrl = url;
      this._asyncFlag = asyncFlag;
    }
    send(body) {
      this._sentBody = body;
    }
    addEventListener(type, fn) {
      if (!this._listeners.has(type)) {
        this._listeners.set(type, new Set());
      }
      this._listeners.get(type).add(fn);
    }
    dispatchLoad(status, payload, responseType = '') {
      this.status = status;
      this.responseType = responseType;
      if (responseType === '' || responseType === 'text') {
        const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
        Object.defineProperty(this, 'responseText', {
          value: text,
          configurable: true
        });
        this.response = text;
      } else if (responseType === 'json') {
        Object.defineProperty(this, 'responseText', {
          get() {
            throw new Error('InvalidStateError: responseText not accessible for json');
          },
          configurable: true
        });
        this.response = payload;
      } else {
        Object.defineProperty(this, 'responseText', {
          get() {
            throw new Error('InvalidStateError: binary responseType');
          },
          configurable: true
        });
        this.response = payload;
      }
      if (typeof this.onload === 'function') {
        this.onload.call(this, { type: 'load' });
      }
      const set = this._listeners.get('load');
      if (set) {
        for (const fn of set) {
          fn.call(this, { type: 'load' });
        }
      }
    }
  }

  const win = {
    location: { origin: 'https://x.com', href: 'https://x.com/home' },
    __INITIAL_STATE__: viewerFixtures.ownProfileInitialState,
    fetch: fetchImpl,
    XMLHttpRequest: FakeXHR,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      if (listeners.has(type)) listeners.get(type).delete(fn);
    },
    postMessage(data, targetOrigin) {
      outboundMessages.push({ data, targetOrigin });
    },
    restoreFromCache() {
      for (const fn of listeners.get('pageshow') || []) fn({ persisted: true });
    },
    dispatchBridgeMessage(data, origin = 'https://x.com', source = win) {
      const set = listeners.get('message');
      if (set) {
        for (const fn of set) {
          fn({ data, origin, source });
        }
      }
    }
  };

  return { win, FakeXHR, outboundMessages };
}

test('Interceptor installs once, never tampers with Function.prototype.toString, and does not clone when paused or unbound', async () => {
  const originalFnToString = Function.prototype.toString;
  let tracked = null;
  const { win, outboundMessages } = createMockEnvironment(async () => {
    tracked = createStreamingResponse(JSON.stringify(createTweetFixtures.standardReply.response));
    return tracked.res;
  });

  const handle1 = installMainInterceptor(win, adapterApi);
  const handle2 = installMainInterceptor(win, adapterApi);
  assert.equal(handle1, handle2);
  assert.equal(Function.prototype.toString, originalFnToString);

  // Handshake with ISOLATED bridge (collection still disabled)
  win.dispatchBridgeMessage({
    protocol: 'SPARKLINK_BRIDGE_V1',
    type: 'BRIDGE_INIT',
    nonce: 'nonce_test_1',
    collectionEnabled: false,
    captureSessionId: null,
    bindingContext: null
  });

  // Fetch while paused -> original response works, zero clones!
  const pageRes = await win.fetch(createTweetFixtures.standardReply.requestUrl, {
    method: 'POST',
    body: JSON.stringify(createTweetFixtures.standardReply.requestBody)
  });
  const pageJson = await pageRes.json();
  assert.equal(pageJson.data.create_tweet.tweet_results.result.rest_id, '2122147641553846272');
  assert.equal(tracked.getCloneCalled(), 0);
  assert.equal(
    outboundMessages.filter((m) => m.data.type === 'OBSERVED_EVENTS').length,
    0
  );
});

test('Pause-then-resume during in-flight request discards late response from old session (0 replies added)', async () => {
  let resolveFetch;
  const { win, outboundMessages } = createMockEnvironment(() => {
    return new Promise((resolve) => {
      resolveFetch = resolve;
    });
  });

  installMainInterceptor(win, adapterApi);

  // Enable & bind session 10
  win.dispatchBridgeMessage({
    protocol: 'SPARKLINK_BRIDGE_V1',
    type: 'BRIDGE_INIT',
    nonce: 'nonce_2',
    collectionEnabled: true,
    captureSessionId: 10,
    bindingContext: BINDING_A
  });

  // Start request under session 10
  const pendingFetch = win.fetch(createTweetFixtures.standardReply.requestUrl, {
    method: 'POST',
    body: JSON.stringify(createTweetFixtures.standardReply.requestBody)
  });

  // User pauses collection, then re-enables with new session 11 BEFORE response arrives
  win.dispatchBridgeMessage({
    protocol: 'SPARKLINK_BRIDGE_V1',
    type: 'SYNC_STATE',
    nonce: 'nonce_2',
    collectionEnabled: false,
    captureSessionId: null,
    bindingContext: null
  });
  win.dispatchBridgeMessage({
    protocol: 'SPARKLINK_BRIDGE_V1',
    type: 'SYNC_STATE',
    nonce: 'nonce_2',
    collectionEnabled: true,
    captureSessionId: 11,
    bindingContext: { ...BINDING_A, bindingId: 'bind_a_new', captureSessionId: 11 }
  });

  // Old response now arrives -> must NOT be cloned or counted!
  const tracked = createStreamingResponse(
    JSON.stringify(createTweetFixtures.standardReply.response)
  );
  resolveFetch(tracked.res);
  await pendingFetch;
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(tracked.getCloneCalled(), 0);
  assert.equal(
    outboundMessages.filter((m) => m.data.type === 'OBSERVED_EVENTS').length,
    0
  );
});

test('Viewer requests started before BFCache restoration cannot confirm the restored document', async () => {
  let finishFetch;
  const { win, FakeXHR, outboundMessages } = createMockEnvironment(() =>
    new Promise((resolve) => { finishFetch = resolve; })
  );
  delete win.__INITIAL_STATE__;
  installMainInterceptor(win, adapterApi);
  win.dispatchBridgeMessage({
    protocol: 'SPARKLINK_BRIDGE_V1', type: 'BRIDGE_INIT', nonce: 'cache-restore',
    collectionEnabled: true, captureSessionId: 1, bindingContext: null
  });
  const url = 'https://x.com/i/api/graphql/viewerTest/Viewer';
  const pending = win.fetch(url);
  const xhr = new FakeXHR();
  xhr.open('GET', url);
  xhr.send();
  const payload = viewerFixtures.viewerGraphqlLegacy;
  const response = createStreamingResponse(JSON.stringify(payload));
  win.restoreFromCache();
  xhr.dispatchLoad(200, payload, 'json');
  finishFetch(response.res);
  await pending;
  await new Promise((resolve) => setImmediate(resolve));
  const viewerMessages = () => outboundMessages.filter(({ data }) => data.type === 'VIEWER_EVIDENCE');
  assert.equal(response.getCloneCalled(), 0);
  assert.equal(viewerMessages().length, 0);

  xhr.open('GET', url);
  xhr.send();
  xhr.dispatchLoad(200, payload, 'json');
  assert.equal(viewerMessages().at(-1)?.data.viewer.actorUserId, '9009009');
});

test('Active bound interceptor captures fetch & reused XHR across responseTypes, enforces 4-clone concurrency, 2 MiB size limit, and 2s timeout', async () => {
  let nextResponseFactory = null;
  const { win, FakeXHR, outboundMessages } = createMockEnvironment((input, init) => {
    return nextResponseFactory(input, init);
  });

  installMainInterceptor(win, adapterApi, {
    maxConcurrentClones: 4,
    maxRequestBytes: 256 * 1024,
    maxResponseBytes: 1024, // 1 KiB small budget for unit test verification (default 2 MiB tested separately)
    cloneTimeoutMs: 60
  });

  // Enable without binding first -> emits VIEWER_EVIDENCE from __INITIAL_STATE__ with exact origin
  win.dispatchBridgeMessage({
    protocol: 'SPARKLINK_BRIDGE_V1',
    type: 'BRIDGE_INIT',
    nonce: 'nonce_3',
    collectionEnabled: true,
    captureSessionId: 10,
    bindingContext: null
  });

  const viewerMsg = outboundMessages.find((m) => m.data.type === 'VIEWER_EVIDENCE');
  assert.ok(viewerMsg);
  assert.equal(viewerMsg.targetOrigin, 'https://x.com');
  assert.equal(viewerMsg.data.viewer.actorUserId, '1001001');

  // Now bind viewer
  win.dispatchBridgeMessage({
    protocol: 'SPARKLINK_BRIDGE_V1',
    type: 'SYNC_STATE',
    nonce: 'nonce_3',
    collectionEnabled: true,
    captureSessionId: 10,
    bindingContext: BINDING_A
  });

  // 1. Valid CreateTweet via fetch (within 1 KiB)
  nextResponseFactory = async () =>
    createStreamingResponse(JSON.stringify(createTweetFixtures.standardReply.response)).res;

  const r1 = await win.fetch(createTweetFixtures.standardReply.requestUrl, {
    method: 'POST',
    body: JSON.stringify(createTweetFixtures.standardReply.requestBody)
  });
  assert.equal(r1.status, 200);
  await new Promise((r) => setTimeout(r, 25));

  const eventMsgs = outboundMessages.filter((m) => m.data.type === 'OBSERVED_EVENTS');
  assert.equal(eventMsgs.length, 1);
  assert.equal(eventMsgs[0].data.events[0].replyTweetId, '2122147641553846272');

  // 2. Oversized response (>1 KiB test cap) cancels reader without breaking page response
  const bigJson = JSON.stringify({
    ...createTweetFixtures.standardReply.response,
    padding: 'x'.repeat(2048)
  });
  let bigTracked;
  nextResponseFactory = async () => {
    bigTracked = createStreamingResponse(bigJson);
    return bigTracked.res;
  };
  const pageBigRes = await win.fetch(createTweetFixtures.standardReply.requestUrl, {
    method: 'POST',
    body: JSON.stringify(createTweetFixtures.standardReply.requestBody)
  });
  const pageBigParsed = await pageBigRes.json();
  assert.equal(pageBigParsed.padding.length, 2048);
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(bigTracked.wasReaderCancelled(), true);

  // 3. Slow response (>60ms timeout) cancels clone reader without affecting page
  let slowTracked;
  nextResponseFactory = async () => {
    slowTracked = createStreamingResponse(
      JSON.stringify(createTweetFixtures.standardReply.response),
      { delayMs: 140 }
    );
    return slowTracked.res;
  };
  const slowPromise = win.fetch(createTweetFixtures.standardReply.requestUrl, {
    method: 'POST',
    body: JSON.stringify(createTweetFixtures.standardReply.requestBody)
  });
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(slowTracked.wasReaderCancelled(), true);
  await slowPromise;

  // 4. Concurrency cap (4 active clones -> 5th skipped cleanly)
  const concurrentTrackers = [];
  nextResponseFactory = async () => {
    const t = createStreamingResponse(
      JSON.stringify(createTweetFixtures.standardReply.response),
      { delayMs: 40 }
    );
    concurrentTrackers.push(t);
    return t.res;
  };
  await Promise.all([
    win.fetch(createTweetFixtures.standardReply.requestUrl, { method: 'POST', body: '{}' }),
    win.fetch(createTweetFixtures.standardReply.requestUrl, { method: 'POST', body: '{}' }),
    win.fetch(createTweetFixtures.standardReply.requestUrl, { method: 'POST', body: '{}' }),
    win.fetch(createTweetFixtures.standardReply.requestUrl, { method: 'POST', body: '{}' }),
    win.fetch(createTweetFixtures.standardReply.requestUrl, { method: 'POST', body: '{}' })
  ]);
  assert.equal(concurrentTrackers.filter((t) => t.getCloneCalled() === 1).length, 4);
  assert.equal(concurrentTrackers[4].getCloneCalled(), 0);
  await new Promise((r) => setTimeout(r, 60));

  // 5. XHR instance reuse, onload preservation, json & blob responseType handling
  const xhr = new FakeXHR();
  let pageOnloadCount = 0;
  xhr.onload = function onPageLoad() {
    pageOnloadCount += 1;
  };

  // First use: binary blob responseType -> safely skipped without throwing InvalidStateError
  xhr.open('POST', createTweetFixtures.standardReply.requestUrl);
  xhr.send(JSON.stringify(createTweetFixtures.standardReply.requestBody));
  xhr.dispatchLoad(200, new Uint8Array([1, 2, 3]), 'arraybuffer');
  assert.equal(pageOnloadCount, 1);

  // Reuse same XHR instance with responseType = 'json' -> captured cleanly!
  const smallHistoryPayload = {
    data: {
      user: {
        result: {
          __typename: 'User',
          rest_id: '1001001',
          timeline_v2: {
            timeline: {
              instructions: [
                {
                  type: 'TimelineAddEntries',
                  entries: [
                    timelineFixtures.ownRepliesTimelineMixed.response.data.user.result.timeline_v2.timeline.instructions[0].entries[1]
                  ]
                }
              ]
            }
          }
        }
      }
    }
  };
  xhr.open('GET', timelineFixtures.ownRepliesTimelineMixed.requestUrl);
  xhr.send(null);
  xhr.dispatchLoad(200, smallHistoryPayload, 'json');
  assert.equal(pageOnloadCount, 2);

  const afterXhrEvents = outboundMessages.filter((m) => m.data.type === 'OBSERVED_EVENTS');
  // 1 initial fetch + 4 permitted concurrent clones + 1 reused XHR = 6 observed batches
  assert.equal(afterXhrEvents.length, 6);
  assert.equal(afterXhrEvents[5].data.events[0].replyTweetId, '2122147641553847003');
  assert.equal(afterXhrEvents[5].data.events[0].source, 'history');

  // 6. Original synchronous & async errors propagate untouched
  assert.throws(() => xhr.open('', 'https://x.com'), TypeError);
  nextResponseFactory = () => Promise.reject(new TypeError('Failed to fetch'));
  await assert.rejects(
    () => win.fetch(createTweetFixtures.standardReply.requestUrl, { method: 'POST' }),
    TypeError
  );
});

test('Defensive & mapping branches: Request/URL inputs, Viewer GraphQL, AUTHOR_MAPPINGS, REVOKE_BINDING, PROBE_VIEWER, XHR text, and cross-origin rejection', async () => {
  let nextResponseFactory = null;
  const { win, FakeXHR, outboundMessages } = createMockEnvironment((input, init) =>
    nextResponseFactory(input, init)
  );
  delete win.__INITIAL_STATE__;

  const controller = installMainInterceptor(win, adapterApi, {
    maxRequestBytes: 128
  });

  // Cross-origin or wrong source or polluted messages are ignored
  win.dispatchBridgeMessage(
    { protocol: 'SPARKLINK_BRIDGE_V1', type: 'BRIDGE_INIT', nonce: 'bad_origin_nonce' },
    'https://evil.example'
  );
  win.dispatchBridgeMessage(
    { protocol: 'SPARKLINK_BRIDGE_V1', type: 'BRIDGE_INIT', nonce: 'bad_source_nonce' },
    'https://x.com',
    {}
  );
  assert.equal(controller.getStateSnapshot().collectionEnabled, false);

  // Valid init with collectionEnabled=true, unbound -> Viewer GraphQL request allowed
  win.dispatchBridgeMessage({
    protocol: 'SPARKLINK_BRIDGE_V1',
    type: 'BRIDGE_INIT',
    nonce: 'nonce_def_1',
    collectionEnabled: true,
    captureSessionId: 20,
    bindingContext: null
  });

  nextResponseFactory = async () =>
    createStreamingResponse(JSON.stringify(viewerFixtures.viewerGraphqlModern)).res;
  await win.fetch(new URL('https://x.com/i/api/graphql/vQuery1/Viewer'));
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(outboundMessages.some((m) => m.data.type === 'VIEWER_EVIDENCE'));

  // Bind viewer
  const binding20 = { ...BINDING_A, bindingId: 'bind_20', captureSessionId: 20 };
  win.dispatchBridgeMessage({
    protocol: 'SPARKLINK_BRIDGE_V1',
    type: 'SYNC_STATE',
    nonce: 'nonce_def_1',
    collectionEnabled: true,
    captureSessionId: 20,
    bindingContext: binding20
  });
  assert.equal(controller.getStateSnapshot().bindingContext.bindingId, 'bind_20');

  // Request object input + TweetDetail -> emits AUTHOR_MAPPINGS
  nextResponseFactory = async () =>
    createStreamingResponse(JSON.stringify(timelineFixtures.tweetDetailResolutionAndRename.response)).res;
  const reqObj = new Request(timelineFixtures.tweetDetailResolutionAndRename.requestUrl, {
    method: 'GET'
  });
  await win.fetch(reqObj);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(outboundMessages.some((m) => m.data.type === 'AUTHOR_MAPPINGS'));

  // Oversized request body (>128 bytes) and non-string body are skipped without cloning
  let skippedTrack;
  nextResponseFactory = async () => {
    skippedTrack = createStreamingResponse(JSON.stringify(createTweetFixtures.standardReply.response));
    return skippedTrack.res;
  };
  await win.fetch(createTweetFixtures.standardReply.requestUrl, {
    method: 'POST',
    body: 'x'.repeat(256)
  });
  assert.equal(skippedTrack.getCloneCalled(), 0);

  await win.fetch(createTweetFixtures.standardReply.requestUrl, {
    method: 'POST',
    body: new Uint8Array([1, 2, 3])
  });
  assert.equal(skippedTrack.getCloneCalled(), 0);

  // XHR text mode capture
  const xhrText = new FakeXHR();
  xhrText.open('POST', createTweetFixtures.standardReply.requestUrl);
  xhrText.send('{}');
  xhrText.dispatchLoad(200, createTweetFixtures.standardReply.response, 'text');
  assert.ok(outboundMessages.some((m) => m.data.type === 'OBSERVED_EVENTS'));

  // REVOKE_BINDING for unrelated ID keeps current binding; matching ID revokes it
  win.dispatchBridgeMessage({
    protocol: 'SPARKLINK_BRIDGE_V1',
    type: 'REVOKE_BINDING',
    nonce: 'nonce_def_1',
    bindingId: 'other_id'
  });
  assert.equal(controller.getStateSnapshot().bindingContext.bindingId, 'bind_20');

  win.__INITIAL_STATE__ = viewerFixtures.ownProfileInitialState;
  win.dispatchBridgeMessage({
    protocol: 'SPARKLINK_BRIDGE_V1',
    type: 'REVOKE_BINDING',
    nonce: 'nonce_def_1',
    bindingId: 'bind_20'
  });
  assert.equal(controller.getStateSnapshot().bindingContext, null);

  win.dispatchBridgeMessage({
    protocol: 'SPARKLINK_BRIDGE_V1',
    type: 'PROBE_VIEWER',
    nonce: 'nonce_def_1'
  });
  assert.ok(outboundMessages.filter((m) => m.data.type === 'VIEWER_EVIDENCE').length >= 2);
});

test('Manual stop signals preserve native responses for HTTP limits, authentication and GraphQL errors', async () => {
  const { win, outboundMessages } = createMockEnvironment(() => Promise.resolve(
    new Response('{}', { status: 429, headers: { 'Retry-After': '7200' } })
  ));
  installMainInterceptor(win, adapterApi);
  win.dispatchBridgeMessage({ protocol: 'SPARKLINK_BRIDGE_V1', type: 'BRIDGE_INIT', nonce: 'history_nonce',
    collectionEnabled: true, captureSessionId: 10, bindingContext: BINDING_A });
  const url = timelineFixtures.ownRepliesTimelineMixed.requestUrl;
  const before = Date.now();
  const response = await win.fetch(url);
  assert.equal(response.status, 429);
  assert.equal(await response.text(), '{}');
  const xhr = new win.XMLHttpRequest();
  const reset = Math.ceil(before / 1000) + 10800;
  xhr.getResponseHeader = (name) => name === 'x-rate-limit-reset' ? String(reset) : null;
  for (const [status, errors] of [[403, []], [200, [{ code: 88 }]], [200, [{ code: 326 }]], [503, []]]) {
    xhr.open('GET', url);
    xhr.send();
    xhr.dispatchLoad(status, { errors }, 'json');
  }
  const signals = outboundMessages.filter(m => m.data.type === 'HISTORY_STOP').map(m => m.data);
  assert.deepEqual(signals.map(m => m.reason), ['rate_limited', 'verification', 'rate_limited', 'verification', 'unavailable']);
  assert.ok(signals[0].retryAt >= before + 7200000);
  assert.equal(signals[2].retryAt, reset * 1000);
  assert.ok(signals.every(m => m.captureSessionId === 10));
});

test('Authorized HISTORY_NEXT paginates exclusively via native scrollScan, marks cursor used before scrolling, and drops duplicate or unpaced grants', async (t) => {
  let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  const requests = [];
  const page1Payload = structuredClone(timelineFixtures.ownRepliesTimelineMixed.response);
  const entries1 = page1Payload.data.user.result.timeline_v2.timeline.instructions.find(i => Array.isArray(i.entries)).entries;
  for (const entry of entries1) if (entry.content?.cursorType === 'Bottom') entry.content.value = 'scroll-p2';
  if (!entries1.some(e => e.content?.cursorType === 'Bottom')) {
    entries1.push({ entryId: 'cursor-bottom', content: { entryType: 'TimelineTimelineCursor', cursorType: 'Bottom', value: 'scroll-p2' } });
  }
  const page2Payload = structuredClone(timelineFixtures.ownRepliesTimelineMixed.response);
  const entries2 = page2Payload.data.user.result.timeline_v2.timeline.instructions.find(i => Array.isArray(i.entries)).entries;
  for (const entry of entries2) if (entry.content?.cursorType === 'Bottom') entry.content.value = 'scroll-p2';
  if (!entries2.some(e => e.content?.cursorType === 'Bottom')) {
    entries2.push({ entryId: 'cursor-bottom', content: { entryType: 'TimelineTimelineCursor', cursorType: 'Bottom', value: 'scroll-p2' } });
  }

  const { win, outboundMessages } = createMockEnvironment(async (input, init) => {
    const reqUrl = typeof input === 'string' ? input : input.url;
    requests.push({ url: reqUrl, init });
    const vars = JSON.parse(new URL(reqUrl).searchParams.get('variables'));
    return new Response(JSON.stringify(vars.cursor ? page2Payload : page1Payload));
  });

  const se = { scrollTop: 0, scrollHeight: 2800 };
  win.location.href = 'https://x.com/sample_me/with_replies';
  win.document = {
    documentElement: se,
    scrollingElement: se,
    querySelector: () => ({ scrollIntoView() {} }),
    querySelectorAll: () => [{ scrollIntoView() {} }]
  };
  let scrollStepCount = 0;
  const baseUrl = new URL(timelineFixtures.ownRepliesTimelineMixed.requestUrl);
  const baseVars = JSON.parse(baseUrl.searchParams.get('variables'));
  win.scrollTo = (_x, y) => {
    se.scrollTop = y;
    scrollStepCount += 1;
    if (scrollStepCount === 1) {
      const nextUrl = new URL(baseUrl.href);
      nextUrl.searchParams.set('variables', JSON.stringify({ ...baseVars, cursor: 'scroll-p2' }));
      queueMicrotask(() => {
        win.fetch(nextUrl.href);
      });
    }
  };

  const msg = (type, extra) => win.dispatchBridgeMessage({ type, protocol: 'SPARKLINK_BRIDGE_V1', nonce: 'history_cursor', ...extra });
  const state = { collectionEnabled: true, captureSessionId: BINDING_A.captureSessionId, bindingContext: BINDING_A,
    historyScope: { id: 'job', actor: BINDING_A.actorUserId, deadline: clock + 300000, query: null } };
  installMainInterceptor(win, adapterApi);
  msg('BRIDGE_INIT', state);
  const grant = { jobId: 'job', bindingId: BINDING_A.bindingId };
  const pages = () => outboundMessages.filter(m => m.data.historyPage);
  const waitPage = async (num) => {
    for (let i = 0; i < 100 && pages().length < num; ++i) await new Promise(r => setTimeout(r, 5));
    assert.equal(pages().length, num);
  };

  await win.fetch(baseUrl.href);
  await waitPage(1);
  assert.equal(pages()[0].data.historyPage.canPage, true);

  // Unpaced grant (< 12s since page 1) must be ignored
  msg('HISTORY_NEXT', grant);
  assert.equal(scrollStepCount, 0);
  assert.equal(requests.length, 1);

  clock += 12000;
  msg('HISTORY_NEXT', { ...grant, jobId: 'stale' });
  msg('HISTORY_NEXT', grant);
  msg('HISTORY_NEXT', grant);
  await waitPage(2);

  assert.equal(requests.length, 2);
  const secondVars = JSON.parse(new URL(requests[1].url).searchParams.get('variables'));
  assert.equal(secondVars.cursor, 'scroll-p2');
  // Page 2 echoed the same 'scroll-p2' cursor, which was marked used before scrolling -> ended & canPage: false
  assert.equal(pages()[1].data.historyPage.canPage, false);
  assert.equal(pages()[1].data.historyPage.ended, true);
  assert.ok(pages().every(m => !JSON.stringify(m).includes('scroll-p2')));

  msg('SYNC_STATE', { ...state, historyScope: null });
  clock += 12000;
  msg('HISTORY_NEXT', grant);
  assert.equal(requests.length, 2);
});

test('Daily search received before document binding waits for that viewer; ordinary searches are never cloned', async () => {
  const query = 'from:sample_me filter:replies since:2026-11-16 until:2026-11-17';
  const url = 'https://x.com/i/api/graphql/Fixture/SearchTimeline?variables=' + encodeURIComponent(JSON.stringify({rawQuery: query, product: 'Latest'}));
  const timeline = timelineFixtures.ownRepliesTimelineMixed.response.data.user.result.timeline_v2.timeline;
  const payload = JSON.stringify({ data: { search_by_raw_query: { search_timeline: { timeline } } } });
  const { win, outboundMessages } = createMockEnvironment(async () => new Response(payload));
  win.location.href = 'https://x.com/search?' + new URLSearchParams({q: query, f: 'live'});
  installMainInterceptor(win, adapterApi);
  const sync = (type, extra) => win.dispatchBridgeMessage({ protocol: 'SPARKLINK_BRIDGE_V1', nonce:'query_test',
    collectionEnabled: true, captureSessionId: 10, type, ...extra });
  sync('BRIDGE_INIT', {bindingContext: BINDING_A});
  const pages = () => outboundMessages.filter(m => m.data.historyPage);
  await win.fetch(url);
  await new Promise(r => setImmediate(r));
  assert.equal(pages().length, 0);
  const historyScope = { id: 'j', actor: BINDING_A.actorUserId, query, deadline: Date.now()+300000 };
  sync('SYNC_STATE', { bindingContext: null, historyScope });
  await win.fetch(url);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(pages().length, 0);
  sync('SYNC_STATE', { bindingContext: BINDING_A, historyScope });
  assert.equal(pages().length, 1);
  assert.equal(pages()[0].data.historyPage.searchQuery, query);
});

test('Pre-binding XHR buffers cleanly and both timeline and search XHR paginate via scrollScan with accurate empty-page ended detection', async (t) => {
  let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  const syntheticFetchCalls = [];
  const query = 'from:sample_me filter:replies since:2026-11-16 until:2026-11-17';

  const replyPage1 = structuredClone(timelineFixtures.ownRepliesTimelineMixed.response);
  replyPage1.data.user.result.timeline_v2.timeline.instructions[0].entries.push({
    entryId: 'cursor-bottom',
    content: { entryType: 'TimelineTimelineCursor', cursorType: 'Bottom', value: 'xhr-cursor-2' }
  });
  // Empty page 2 with only a new cursor: because 'xhr-cursor-2' was marked used BEFORE scrolling, usedCursors.size > 0 && !hasTweets must set ended = true!
  const emptyReplyPage2 = {
    data: {
      user: {
        result: {
          timeline_v2: {
            timeline: {
              instructions: [
                {
                  type: 'TimelineAddEntries',
                  entries: [
                    { entryId: 'cursor-bottom-2', content: { entryType: 'TimelineTimelineCursor', cursorType: 'Bottom', value: 'xhr-cursor-3' } }
                  ]
                }
              ]
            }
          }
        }
      }
    }
  };

  const searchPage1 = {
    data: {
      search_by_raw_query: {
        search_timeline: {
          timeline: {
            instructions: [
              {
                type: 'TimelineAddEntries',
                entries: [
                  timelineFixtures.ownRepliesTimelineMixed.response.data.user.result.timeline_v2.timeline.instructions[0].entries[1],
                  { entryId: 'cursor-bottom-s2', content: { entryType: 'TimelineTimelineCursor', cursorType: 'Bottom', value: 'search-p2' } }
                ]
              }
            ]
          }
        }
      }
    }
  };
  const searchPage2 = {
    data: {
      search_by_raw_query: {
        search_timeline: {
          timeline: {
            instructions: [
              {
                type: 'TimelineAddEntries',
                entries: []
              }
            ]
          }
        }
      }
    }
  };

  const { win, FakeXHR, outboundMessages } = createMockEnvironment(async (input) => {
    syntheticFetchCalls.push(input);
    return new Response('{}', { status: 404 });
  });
  const se = { scrollTop: 0, scrollHeight: 2400 };
  win.document = {
    documentElement: se,
    scrollingElement: se,
    querySelector: () => null,
    querySelectorAll: () => []
  };
  win.location.href = 'https://x.com/sample_me/with_replies';

  const xhrUrlsSeen = [];
  let scrollAction = null;
  win.scrollTo = (_x, y) => {
    se.scrollTop = y;
    if (typeof scrollAction === 'function') {
      const fn = scrollAction;
      scrollAction = null;
      queueMicrotask(fn);
    }
  };

  installMainInterceptor(win, adapterApi);
  const sync = (type, extra) => win.dispatchBridgeMessage({
    protocol: 'SPARKLINK_BRIDGE_V1', nonce: 'xhr_cursor', collectionEnabled: true, captureSessionId: 10, type, ...extra
  });
  const replyScope = { id: 'job1', actor: BINDING_A.actorUserId, deadline: clock + 300000, query: null };
  sync('BRIDGE_INIT', { bindingContext: null, historyScope: null });

  // Pre-binding XHR arrives before bindingContext/historyScope; note DOM tweet cells are not rendered yet
  const xhr = new FakeXHR();
  xhr.open('GET', timelineFixtures.ownRepliesTimelineMixed.requestUrl);
  xhr.send();
  xhr.dispatchLoad(200, replyPage1, 'json');

  sync('SYNC_STATE', { bindingContext: BINDING_A, historyScope: replyScope });
  const pages = () => outboundMessages.filter(m => m.data.historyPage);
  assert.equal(pages().length, 1);
  assert.equal(pages()[0].data.historyPage.canPage, true);

  // Scroll triggers X's native XHR for page 2 carrying cursor 'xhr-cursor-2'
  scrollAction = () => {
    const u = new URL(timelineFixtures.ownRepliesTimelineMixed.requestUrl);
    const v = JSON.parse(u.searchParams.get('variables'));
    u.searchParams.set('variables', JSON.stringify({ ...v, cursor: 'xhr-cursor-2' }));
    xhrUrlsSeen.push(u.href);
    const xhr2 = new win.XMLHttpRequest();
    xhr2.open('GET', u.href);
    xhr2.send();
    xhr2.dispatchLoad(200, emptyReplyPage2, 'json');
  };
  clock += 12000;
  sync('HISTORY_NEXT', { jobId: 'job1', bindingId: BINDING_A.bindingId });
  for (let i = 0; i < 100 && pages().length < 2; ++i) await new Promise(r => setTimeout(r, 5));
  assert.equal(pages().length, 2);
  assert.equal(JSON.parse(new URL(xhrUrlsSeen[0]).searchParams.get('variables')).cursor, 'xhr-cursor-2');
  assert.equal(pages()[1].data.historyPage.ended, true);
  assert.equal(pages()[1].data.historyPage.canPage, false);

  // Search mode XHR pagination via scrollScan
  win.location.href = 'https://x.com/search?' + new URLSearchParams({ q: query, f: 'live' });
  const searchScope = { id: 'job1', actor: BINDING_A.actorUserId, deadline: clock + 300000, query };
  sync('SYNC_STATE', { bindingContext: BINDING_A, historyScope: searchScope });
  const searchUrl = 'https://x.com/i/api/graphql/Fix/SearchTimeline?variables=' +
    encodeURIComponent(JSON.stringify({ rawQuery: query, product: 'Latest' }));
  const searchXhr1 = new win.XMLHttpRequest();
  searchXhr1.open('GET', searchUrl);
  searchXhr1.send();
  searchXhr1.dispatchLoad(200, searchPage1, 'json');
  assert.equal(pages().length, 3);
  assert.equal(pages()[2].data.historyPage.canPage, true);

  scrollAction = () => {
    const nextSearchUrl = 'https://x.com/i/api/graphql/Fix/SearchTimeline?variables=' +
      encodeURIComponent(JSON.stringify({ rawQuery: query, product: 'Latest', cursor: 'search-p2' }));
    xhrUrlsSeen.push(nextSearchUrl);
    const searchXhr2 = new win.XMLHttpRequest();
    searchXhr2.open('GET', nextSearchUrl);
    searchXhr2.send();
    searchXhr2.dispatchLoad(200, searchPage2, 'json');
  };
  clock += 12000;
  sync('HISTORY_NEXT', { jobId: 'job1', bindingId: BINDING_A.bindingId });
  for (let i = 0; i < 100 && pages().length < 4; ++i) await new Promise(r => setTimeout(r, 5));
  assert.equal(pages().length, 4);
  assert.equal(JSON.parse(new URL(xhrUrlsSeen[1]).searchParams.get('variables')).cursor, 'search-p2');
  assert.equal(pages()[3].data.historyPage.canPage, false);
  // Zero extension-originated synthetic fetch calls ever occurred
  assert.equal(syntheticFetchCalls.length, 0);
});

test('scrollScan never issues synthetic fetches on timeout and extends grace wait when a native request is in flight', async (t) => {
  let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  const page1Payload = structuredClone(timelineFixtures.ownRepliesTimelineMixed.response);
  page1Payload.data.user.result.timeline_v2.timeline.instructions[0].entries.push({
    entryId: 'cursor-bottom-1',
    content: { entryType: 'TimelineTimelineCursor', cursorType: 'Bottom', value: 'scroll-p2' }
  });
  const page2Payload = structuredClone(timelineFixtures.ownRepliesTimelineMixed.response);
  page2Payload.data.user.result.timeline_v2.timeline.instructions[0].entries.push({
    entryId: 'cursor-bottom-2',
    content: { entryType: 'TimelineTimelineCursor', cursorType: 'Bottom', value: 'scroll-p3' }
  });

  const networkCalls = [];
  let resolveSlowNative = null;
  const { win, outboundMessages } = createMockEnvironment((input) => {
    const reqUrl = typeof input === 'string' ? input : input.url;
    networkCalls.push(reqUrl);
    if (reqUrl.includes('scroll-p2')) {
      return new Promise((resolve) => {
        resolveSlowNative = () => resolve(new Response(JSON.stringify(page2Payload), { status: 200 }));
      });
    }
    return Promise.resolve(new Response(JSON.stringify(page1Payload), { status: 200 }));
  });

  const se = { scrollTop: 0, scrollHeight: 3000 };
  win.location.href = 'https://x.com/sample_me/with_replies';
  win.document = {
    documentElement: se,
    scrollingElement: se,
    scripts: [{ src: 'https://abs.twimg.com/responsive-web/client-web/main.abc.js' }],
    querySelector: () => ({ scrollIntoView() {} }),
    querySelectorAll: () => [{ scrollIntoView() {} }]
  };

  const scrollTargets = [];
  const baseUrl = new URL(timelineFixtures.ownRepliesTimelineMixed.requestUrl);
  const baseVars = JSON.parse(baseUrl.searchParams.get('variables'));
  let triggerSlowNativeOnScroll = true;
  win.scrollTo = (_x, y) => {
    scrollTargets.push(y);
    se.scrollTop = y;
    if (triggerSlowNativeOnScroll) {
      triggerSlowNativeOnScroll = false;
      const slowUrl = new URL(baseUrl.href);
      slowUrl.searchParams.set('variables', JSON.stringify({ ...baseVars, cursor: 'scroll-p2' }));
      queueMicrotask(() => {
        win.fetch(slowUrl.href);
      });
    }
  };

  installMainInterceptor(win, adapterApi);
  const sync = (type, extra) => win.dispatchBridgeMessage({
    protocol: 'SPARKLINK_BRIDGE_V1', nonce: 'scroll_scan_nonce', collectionEnabled: true, captureSessionId: 10, type, ...extra
  });
  const scope = { id: 'job_scroll', actor: BINDING_A.actorUserId, since: clock - 7 * 86400000, deadline: clock + 300000, query: null };
  sync('BRIDGE_INIT', { bindingContext: BINDING_A, historyScope: scope });

  // Ensure zero script-bundle or bootstrap fetches happen on BRIDGE_INIT
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(networkCalls.length, 0);

  // Page 1 arrives natively
  await win.fetch(baseUrl.href);
  const pages = () => outboundMessages.filter((m) => m.data.historyPage);
  for (let i = 0; i < 50 && pages().length < 1; ++i) await new Promise((r) => setTimeout(r, 5));
  assert.equal(pages().length, 1);
  assert.equal(pages()[0].data.historyPage.canPage, true);

  // Start scrollScan -> triggers slow native request with cursor 'scroll-p2'
  clock += 12000;
  sync('HISTORY_NEXT', { jobId: 'job_scroll', bindingId: BINDING_A.bindingId });
  for (let i = 0; i < 50 && !resolveSlowNative; ++i) await new Promise((r) => setTimeout(r, 5));
  assert.equal(typeof resolveSlowNative, 'function');
  assert.equal(JSON.parse(new URL(networkCalls[1]).searchParams.get('variables')).cursor, 'scroll-p2');

  // Advance clock past initial 3500ms scrollDeadline while nativeRequestsInFlight > 0 -> must keep waiting without firing any synthetic fallback
  clock += 4000;
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(networkCalls.length, 2);
  resolveSlowNative();
  for (let i = 0; i < 100 && pages().length < 2; ++i) await new Promise((r) => setTimeout(r, 5));
  assert.equal(pages().length, 2);
  assert.equal(pages()[1].data.historyPage.canPage, true);

  // Next scrollScan when X produces NO network request -> times out cleanly with 0 synthetic requests and 0 HISTORY_STOP
  clock += 12000;
  sync('HISTORY_NEXT', { jobId: 'job_scroll', bindingId: BINDING_A.bindingId });
  await new Promise((r) => setTimeout(r, 30));
  clock += 4000;
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(networkCalls.length, 2);
  assert.equal(outboundMessages.filter((m) => m.data.type === 'HISTORY_STOP').length, 0);

  // Even after another 12s, 'scroll-p3' was already consumed before scrolling, so duplicate HISTORY_NEXT will not re-scroll the same cursor
  const prevScrollCount = scrollTargets.length;
  clock += 12000;
  sync('HISTORY_NEXT', { jobId: 'job_scroll', bindingId: BINDING_A.bindingId });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(scrollTargets.length, prevScrollCount);
});

test('Audit regressions: triggerScrollStep targets primaryColumn cells instead of sidebarColumn and REVOKE_BINDING aborts active scroll waiter', async (t) => {
  let clock = 1_794_800_000_000;
  t.mock.method(Date, 'now', () => clock);

  let primaryLastScrolled = 0;
  let sidebarScrolled = 0;
  const scrollingElement = { scrollTop: 0, scrollHeight: 3600 };
  const primaryCell = {
    scrollIntoView() {
      primaryLastScrolled += 1;
    }
  };
  const sidebarCell = {
    scrollIntoView() {
      sidebarScrolled += 1;
      // Simulate sticky sidebar pulling scrollTop back to 0 if mistakenly targeted
      scrollingElement.scrollTop = 0;
      win.scrollY = 0;
    }
  };

  const listeners = new Map();
  const outbound = [];
  const baseUrl = new URL(timelineFixtures.ownRepliesTimelineMixed.requestUrl);
  const pagePayload = structuredClone(timelineFixtures.ownRepliesTimelineMixed.response);
  pagePayload.data.user.result.timeline_v2.timeline.instructions[0].entries.push({
    entryId: 'cursor-bottom-pcol',
    content: { entryType: 'TimelineTimelineCursor', cursorType: 'Bottom', value: 'cursor_primary_1' }
  });
  const win = {
    location: { origin: 'https://x.com', href: 'https://x.com/sample_me/with_replies', pathname: '/sample_me/with_replies', search: '' },
    scrollY: 0,
    document: {
      scrollingElement,
      documentElement: scrollingElement,
      querySelector(sel) {
        if (sel === '[data-testid="primaryColumn"]') {
          return {
            querySelectorAll(innerSel) {
              return innerSel === '[data-testid="cellInnerDiv"]' ? [primaryCell] : [];
            }
          };
        }
        return null;
      },
      querySelectorAll(sel) {
        return sel === '[data-testid="cellInnerDiv"]' ? [primaryCell, sidebarCell] : [];
      }
    },
    scrollTo(_x, y) {
      scrollingElement.scrollTop = y;
      win.scrollY = y;
    },
    dispatchEvent() {},
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    postMessage(data) {
      outbound.push(data);
    },
    async fetch() {
      return new Response(
        JSON.stringify(pagePayload),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
  };
  win.top = win;

  installMainInterceptor(win, adapterApi);
  const dispatch = (type, extra) => {
    for (const fn of listeners.get('message') || []) {
      fn({
        source: win,
        origin: 'https://x.com',
        data: { protocol: 'SPARKLINK_BRIDGE_V1', nonce: 'audit_nonce', collectionEnabled: true, captureSessionId: 10, type, ...extra }
      });
    }
  };

  dispatch('BRIDGE_INIT', {
    bindingContext: BINDING_A,
    historyScope: { id: 'job_pcol', actor: BINDING_A.actorUserId, since: clock - 86400000, deadline: clock + 300000, query: null }
  });

  await win.fetch(baseUrl.href);
  for (let i = 0; i < 40 && !outbound.some((m) => m.historyPage); i += 1) {
    await new Promise((r) => setTimeout(r, 5));
  }

  clock += 12000;
  dispatch('HISTORY_NEXT', { jobId: 'job_pcol', bindingId: BINDING_A.bindingId });
  await new Promise((r) => setTimeout(r, 25));

  assert.equal(primaryLastScrolled, 1);
  assert.equal(sidebarScrolled, 0);
  assert.ok(scrollingElement.scrollTop >= 3600);

  // Immediately revoking binding must wake and clear history transport without waiting 3.5s
  dispatch('REVOKE_BINDING', { bindingId: BINDING_A.bindingId });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(primaryLastScrolled, 1);
});

test('Pre-confirm buffering replays early UserTweetsAndReplies and SearchTimeline across split SYNC_STATE messages, rejects when confirmed paused, and separates up/down scroll nudge across frames', async (t) => {
  let clock = 1_795_000_000_000;
  t.mock.method(Date, 'now', () => clock);

  // 1. Tab loads before HELLO, fires pre-confirm timeline/search/create_tweet, then backend confirms PAUSED -> zero events & create_tweet never cloned
  const pausedCreateTracker = createStreamingResponse(JSON.stringify(createTweetFixtures.standardReply.response));
  const pausedEnv = createMockEnvironment(async (url) => {
    const u = String(url);
    if (u.includes('CreateTweet')) return pausedCreateTracker.res;
    if (u.includes('UserTweetsAndReplies')) {
      return new Response(JSON.stringify(timelineFixtures.ownRepliesTimelineMixed.response), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  });
  pausedEnv.win.location.href = 'https://x.com/sample_me/with_replies';
  installMainInterceptor(pausedEnv.win, adapterApi);
  pausedEnv.win.dispatchBridgeMessage({
    protocol: 'SPARKLINK_BRIDGE_V1',
    type: 'BRIDGE_INIT',
    nonce: 'pconf_pause',
    collectionEnabled: false,
    captureSessionId: null,
    bindingContext: null,
    historyScope: null,
    stateConfirmed: false,
    observedPaused: false
  });
  await pausedEnv.win.fetch(timelineFixtures.ownRepliesTimelineMixed.requestUrl);
  await pausedEnv.win.fetch(createTweetFixtures.standardReply.requestUrl, {
    method: 'POST',
    body: JSON.stringify(createTweetFixtures.standardReply.requestBody)
  });
  assert.equal(pausedCreateTracker.getCloneCalled(), 0);
  pausedEnv.win.dispatchBridgeMessage({
    protocol: 'SPARKLINK_BRIDGE_V1',
    type: 'SYNC_STATE',
    nonce: 'pconf_pause',
    collectionEnabled: false,
    captureSessionId: null,
    bindingContext: null,
    historyScope: null,
    stateConfirmed: true,
    observedPaused: true
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(pausedEnv.outboundMessages.filter((m) => m.data.type === 'OBSERVED_EVENTS').length, 0);

  // 2. Pre-confirm UserTweetsAndReplies survives split SYNC_STATE (collectionEnabled -> bindingContext -> historyScope) and replays page 1
  const page1Payload = structuredClone(timelineFixtures.ownRepliesTimelineMixed.response);
  page1Payload.data.user.result.timeline_v2.timeline.instructions[0].entries.push({
    entryId: 'cursor-bottom-pconf',
    content: { entryType: 'TimelineTimelineCursor', cursorType: 'Bottom', value: 'pconf-cursor-2' }
  });
  const scrollYs = [];
  const se = { scrollTop: 1000, scrollHeight: 3000 };
  const timelineEnv = createMockEnvironment(async () => new Response(JSON.stringify(page1Payload), { status: 200 }));
  timelineEnv.win.location.href = 'https://x.com/sample_me/with_replies';
  timelineEnv.win.scrollY = 1000;
  timelineEnv.win.document = {
    scrollingElement: se,
    documentElement: se,
    querySelector: () => null,
    querySelectorAll: () => []
  };
  timelineEnv.win.scrollTo = (_x, y) => {
    scrollYs.push(y);
    se.scrollTop = y;
    timelineEnv.win.scrollY = y;
  };
  installMainInterceptor(timelineEnv.win, adapterApi);
  timelineEnv.win.dispatchBridgeMessage({
    protocol: 'SPARKLINK_BRIDGE_V1',
    type: 'BRIDGE_INIT',
    nonce: 'pconf_tl',
    collectionEnabled: false,
    captureSessionId: null,
    bindingContext: null,
    historyScope: null,
    stateConfirmed: false,
    observedPaused: false
  });
  await timelineEnv.win.fetch(timelineFixtures.ownRepliesTimelineMixed.requestUrl);
  await new Promise((r) => setTimeout(r, 15));
  const replyScope = { id: 'job_pconf', actor: BINDING_A.actorUserId, since: clock - 86400000, deadline: clock + 300000, query: null };
  // Step A: HELLO enables collection before binding or scope arrives
  timelineEnv.win.dispatchBridgeMessage({
    protocol: 'SPARKLINK_BRIDGE_V1',
    type: 'SYNC_STATE',
    nonce: 'pconf_tl',
    collectionEnabled: true,
    captureSessionId: 10,
    bindingContext: null,
    historyScope: null,
    stateConfirmed: true,
    observedPaused: false
  });
  // Step B: BIND_VIEWER sets bindingContext while historyScope is still null (must NOT drop pendingTimeline)
  timelineEnv.win.dispatchBridgeMessage({
    protocol: 'SPARKLINK_BRIDGE_V1',
    type: 'SYNC_STATE',
    nonce: 'pconf_tl',
    collectionEnabled: true,
    captureSessionId: 10,
    bindingContext: BINDING_A,
    historyScope: null,
    stateConfirmed: true,
    observedPaused: false
  });
  // Step C: historyScope arrives -> pendingTimeline replays with cursor preserved
  timelineEnv.win.dispatchBridgeMessage({
    protocol: 'SPARKLINK_BRIDGE_V1',
    type: 'SYNC_STATE',
    nonce: 'pconf_tl',
    collectionEnabled: true,
    captureSessionId: 10,
    bindingContext: BINDING_A,
    historyScope: replyScope,
    stateConfirmed: true,
    observedPaused: false
  });
  const tlPages = timelineEnv.outboundMessages.filter((m) => m.data.historyPage);
  assert.equal(tlPages.length, 1);
  assert.equal(tlPages[0].data.historyPage.canPage, true);

  // 3. Two-frame async up-then-down nudge inside scrollNextPage
  clock += 12000;
  timelineEnv.win.dispatchBridgeMessage({
    protocol: 'SPARKLINK_BRIDGE_V1',
    type: 'HISTORY_NEXT',
    nonce: 'pconf_tl',
    jobId: 'job_pconf',
    bindingId: BINDING_A.bindingId
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(scrollYs, [3000]);
  clock += 1600;
  await new Promise((r) => setTimeout(r, 230));
  assert.equal(scrollYs[1], 2700);
  await new Promise((r) => setTimeout(r, 230));
  assert.ok(scrollYs.length >= 3);
  assert.ok(scrollYs[2] >= 3000);
  clock += 3000;
  timelineEnv.win.dispatchBridgeMessage({
    protocol: 'SPARKLINK_BRIDGE_V1',
    type: 'REVOKE_BINDING',
    nonce: 'pconf_tl',
    bindingId: BINDING_A.bindingId
  });
  await new Promise((r) => setTimeout(r, 10));

  // 4. Pre-confirm SearchTimeline on /search?q=...&f=live replays once SYNC_STATE sets bindingContext + historyScope
  const query = 'from:sample_me filter:replies since:2026-11-16 until:2026-11-17';
  const searchUrl = 'https://x.com/i/api/graphql/Fix/SearchTimeline?variables=' +
    encodeURIComponent(JSON.stringify({ rawQuery: query, product: 'Latest' }));
  const searchPayload = {
    data: {
      search_by_raw_query: {
        search_timeline: {
          timeline: timelineFixtures.ownRepliesTimelineMixed.response.data.user.result.timeline_v2.timeline
        }
      }
    }
  };
  const searchEnv = createMockEnvironment(async () => new Response(JSON.stringify(searchPayload), { status: 200 }));
  searchEnv.win.location.href = 'https://x.com/search?' + new URLSearchParams({ q: query, f: 'live' });
  installMainInterceptor(searchEnv.win, adapterApi);
  searchEnv.win.dispatchBridgeMessage({
    protocol: 'SPARKLINK_BRIDGE_V1',
    type: 'BRIDGE_INIT',
    nonce: 'pconf_search',
    collectionEnabled: false,
    captureSessionId: null,
    bindingContext: null,
    historyScope: null,
    stateConfirmed: false,
    observedPaused: false
  });
  await searchEnv.win.fetch(searchUrl);
  await new Promise((r) => setTimeout(r, 15));
  searchEnv.win.dispatchBridgeMessage({
    protocol: 'SPARKLINK_BRIDGE_V1',
    type: 'SYNC_STATE',
    nonce: 'pconf_search',
    collectionEnabled: true,
    captureSessionId: 10,
    bindingContext: BINDING_A,
    historyScope: { id: 'job_s', actor: BINDING_A.actorUserId, since: clock - 86400000, deadline: clock + 300000, query },
    stateConfirmed: true,
    observedPaused: false
  });
  const searchPages = searchEnv.outboundMessages.filter((m) => m.data.historyPage);
  assert.equal(searchPages.length, 1);
  assert.equal(searchPages[0].data.historyPage.searchQuery, query);

  // 5. UserTweetsAndReplies initiated BEFORE BRIDGE_INIT (state.nonce === null) on /<handle> (before pushState updates pathname to /with_replies) replays once confirmed
  const earlyPage = structuredClone(timelineFixtures.ownRepliesTimelineMixed.response);
  earlyPage.data.user.result.timeline_v2.timeline.instructions[0].entries.push({
    entryId: 'cursor-bottom-preinit',
    content: { entryType: 'TimelineTimelineCursor', cursorType: 'Bottom', value: 'preinit-cursor-2' }
  });
  const preInitEnv = createMockEnvironment(async () => new Response(JSON.stringify(earlyPage), { status: 200 }));
  preInitEnv.win.location.href = 'https://x.com/sample_me';
  preInitEnv.win.document = {};
  preInitEnv.win.scrollTo = () => {};
  installMainInterceptor(preInitEnv.win, adapterApi);
  await preInitEnv.win.fetch(timelineFixtures.ownRepliesTimelineMixed.requestUrl);
  await new Promise((r) => setTimeout(r, 15));
  preInitEnv.win.dispatchBridgeMessage({
    protocol: 'SPARKLINK_BRIDGE_V1',
    type: 'BRIDGE_INIT',
    nonce: 'pre_nonce_ok',
    collectionEnabled: true,
    captureSessionId: 10,
    bindingContext: BINDING_A,
    historyScope: { id: 'job_pre', actor: BINDING_A.actorUserId, since: clock - 86400000, deadline: clock + 300000, query: null },
    stateConfirmed: true,
    observedPaused: false
  });
  const preInitPages = preInitEnv.outboundMessages.filter((m) => m.data.historyPage);
  assert.equal(preInitPages.length, 1);
  assert.equal(preInitPages[0].data.historyPage.canPage, true);
});


