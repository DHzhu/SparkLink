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
