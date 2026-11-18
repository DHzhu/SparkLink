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

test('An authorized cursor grant reuses only the observed own replies GET and drops duplicate grants and redirects', async (t) => {
  let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  const requests = [];
  const payload = structuredClone(timelineFixtures.ownRepliesTimelineMixed.response);
  const entries = payload.data.user.result.timeline_v2.timeline.instructions.find(i => Array.isArray(i.entries)).entries;
  for (const entry of entries) if (entry.content?.cursorType === 'Bottom') entry.content.value = 'page-two';
  if (!entries.some(e => e.content?.cursorType === 'Bottom')) {
    entries.push({ entryId: 'cursor-bottom', content: { cursorType: 'Bottom', value: 'page-two' } });
  }
  const { win, outboundMessages } = createMockEnvironment(async (input, init) => {
    requests.push({ input, init });
    return new Response(JSON.stringify(payload));
  });
  const msg = (type, extra) => win.dispatchBridgeMessage({ type, protocol: 'SPARKLINK_BRIDGE_V1', nonce: 'history_cursor', ...extra });
  const state = { collectionEnabled: true, captureSessionId: BINDING_A.captureSessionId, bindingContext: BINDING_A,
    historyScope: { id: 'job', actor: BINDING_A.actorUserId, deadline: clock + 300000, query: null } };
  installMainInterceptor(win, adapterApi);
  msg('BRIDGE_INIT', state);
  const grant = { jobId: 'job', bindingId: BINDING_A.bindingId };
  const url = timelineFixtures.ownRepliesTimelineMixed.requestUrl;
  const pages = () => outboundMessages.filter(m => m.data.historyPage);
  const waitPage = async (num) => {
    for (let i = 0; i < 100 && pages().length < num; ++i) await new Promise(r => setTimeout(r, 2));
    assert.equal(pages().length, num);
  };
  await win.fetch(url);
  await waitPage(1);
  assert.equal(pages()[0].data.historyPage.canPage, true);
  msg('HISTORY_NEXT', grant);
  assert.equal(requests.length, 1);
  clock += 12000;
  msg('HISTORY_NEXT', { ...grant, jobId: 'stale' });
  msg('HISTORY_NEXT', grant);
  msg('HISTORY_NEXT', grant);
  await waitPage(2);
  assert.equal(requests.length, 2);
  const request = requests[1].input;
  const next = new URL(request.url);
  assert.equal(next.origin + next.pathname, url.split('?')[0]);
  assert.deepEqual(JSON.parse(next.searchParams.get('variables')), { ...JSON.parse(new URL(url).searchParams.get('variables')), cursor: 'page-two' });
  assert.equal(request.redirect, 'error');
  assert.equal(pages()[1].data.historyPage.canPage, false);
  assert.ok(pages().every(m => !JSON.stringify(m).includes('page-two')));
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

test('XHR with custom headers (including x-client-transaction-id) supports timeline and search cursor pagination, and buffers pre-binding timeline', async (t) => {
  let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  const fetchRequests = [];
  const query = 'from:sample_me filter:replies since:2026-11-16 until:2026-11-17';
  const searchPayload = {
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
  const replyPayload = structuredClone(timelineFixtures.ownRepliesTimelineMixed.response);
  const replyEntries = replyPayload.data.user.result.timeline_v2.timeline.instructions[0].entries;
  for (const e of replyEntries) if (e.content?.cursorType === 'Bottom') e.content.value = 'xhr-cursor-2';
  if (!replyEntries.some(e => e.content?.cursorType === 'Bottom')) {
    replyEntries.push({ entryId: 'cursor-bottom', content: { entryType: 'TimelineTimelineCursor', cursorType: 'Bottom', value: 'xhr-cursor-2' } });
  }

  const { win, FakeXHR, outboundMessages } = createMockEnvironment(async (input) => {
    fetchRequests.push(input);
    return new Response(JSON.stringify(
      String(input.url).includes('SearchTimeline') ? searchPayload : replyPayload
    ));
  });
  FakeXHR.prototype.setRequestHeader = function (name, value) {
    this._headers = this._headers || [];
    this._headers.push([name, value]);
  };
  win.location.href = 'https://x.com/sample_me/with_replies';
  installMainInterceptor(win, adapterApi);
  const sync = (type, extra) => win.dispatchBridgeMessage({
    protocol: 'SPARKLINK_BRIDGE_V1', nonce: 'xhr_cursor', collectionEnabled: true, captureSessionId: 10, type, ...extra
  });
  const replyScope = { id: 'job1', actor: BINDING_A.actorUserId, deadline: clock + 300000, query: null };
  sync('BRIDGE_INIT', { bindingContext: null, historyScope: null });

  // Pre-binding XHR with custom headers & x-client-transaction-id
  const xhr = new FakeXHR();
  xhr.withCredentials = true;
  xhr.open('GET', timelineFixtures.ownRepliesTimelineMixed.requestUrl);
  xhr.setRequestHeader('x-client-transaction-id', 'tx_abc_123');
  xhr.setRequestHeader('x-twitter-active-user', 'yes');
  xhr.send();
  xhr.dispatchLoad(200, replyPayload, 'json');

  // Binding + scope arrive afterward -> pendingTimeline and pendingTemplate promote cleanly
  sync('SYNC_STATE', { bindingContext: BINDING_A, historyScope: replyScope });
  const pages = () => outboundMessages.filter(m => m.data.historyPage);
  assert.equal(pages().length, 1);
  assert.equal(pages()[0].data.historyPage.canPage, true);

  clock += 12000;
  sync('HISTORY_NEXT', { jobId: 'job1', bindingId: BINDING_A.bindingId });
  for (let i = 0; i < 100 && pages().length < 2; ++i) await new Promise(r => setTimeout(r, 2));
  assert.equal(pages().length, 2);
  assert.equal(fetchRequests[0].headers.get('x-twitter-active-user'), 'yes');
  assert.equal(fetchRequests[0].headers.get('x-client-transaction-id'), null);

  // Search mode XHR pagination
  win.location.href = 'https://x.com/search?' + new URLSearchParams({ q: query, f: 'live' });
  const searchScope = { id: 'job1', actor: BINDING_A.actorUserId, deadline: clock + 300000, query };
  sync('SYNC_STATE', { bindingContext: BINDING_A, historyScope: searchScope });
  const searchUrl = 'https://x.com/i/api/graphql/Fix/SearchTimeline?variables=' +
    encodeURIComponent(JSON.stringify({ rawQuery: query, product: 'Latest' }));
  xhr.open('GET', searchUrl);
  xhr.setRequestHeader('x-client-transaction-id', 'tx_search_1');
  xhr.send();
  xhr.dispatchLoad(200, searchPayload, 'json');
  assert.equal(pages().length, 3);
  assert.equal(pages()[2].data.historyPage.canPage, true);

  clock += 12000;
  sync('HISTORY_NEXT', { jobId: 'job1', bindingId: BINDING_A.bindingId });
  for (let i = 0; i < 100 && pages().length < 4; ++i) await new Promise(r => setTimeout(r, 2));
  assert.equal(pages().length, 4);
  const nextSearchUrl = new URL(fetchRequests[1].url);
  assert.equal(JSON.parse(nextSearchUrl.searchParams.get('variables')).cursor, 'search-p2');
});

test('Direct timeline bootstrap discovers queryId from client-web scripts, self-heals missing features, and ends timeline cleanly without false search fallback', async (t) => {
  let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  const fetchCalls = [];
  const page1Payload = structuredClone(timelineFixtures.ownRepliesTimelineMixed.response);
  page1Payload.data.user.result.timeline_v2.timeline.instructions[0].entries.push({
    entryId: 'cursor-bottom-1',
    content: { entryType: 'TimelineTimelineCursor', cursorType: 'Bottom', value: 'direct-p2' }
  });
  const page2Payload = structuredClone(timelineFixtures.ownRepliesTimelineMixed.response);

  let qidVersion = 'staleQid1';
  const { win, outboundMessages } = createMockEnvironment(async (input) => {
    const reqUrl = typeof input === 'string' ? input : input.url;
    fetchCalls.push({ url: reqUrl, headers: input.headers || null });
    if (reqUrl.includes('client-web/main.')) {
      return new Response(
        `blah;queryId:"${qidVersion}",operationName:"UserTweetsAndReplies",operationType:"query",metadata:{featureSwitches:["view_counts_everywhere_api_enabled"],fieldToggles:["withArticlePlainText"]};blah`,
        { status: 200 }
      );
    }
    if (reqUrl.includes('staleQid1/UserTweetsAndReplies')) {
      qidVersion = 'freshQid2';
      return new Response('{}', { status: 404 });
    }
    if (reqUrl.includes('freshQid2/UserTweetsAndReplies')) {
      const vars = JSON.parse(new URL(reqUrl).searchParams.get('variables'));
      const feats = JSON.parse(new URL(reqUrl).searchParams.get('features') || '{}');
      if (!feats.rweb_extra_required_flag) {
        return new Response(
          JSON.stringify({ errors: [{ message: 'The following features cannot be null: rweb_extra_required_flag' }] }),
          { status: 400 }
        );
      }
      return new Response(JSON.stringify(vars.cursor ? page2Payload : page1Payload), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  });
  win.location.href = 'https://x.com/sample_me';
  win.document = {
    documentElement: { lang: 'zh-cn' },
    scripts: [{ src: 'https://abs.twimg.com/responsive-web/client-web/main.123.js' }],
    querySelectorAll: () => []
  };
  installMainInterceptor(win, adapterApi);
  const sync = (type, extra) => win.dispatchBridgeMessage({
    protocol: 'SPARKLINK_BRIDGE_V1', nonce: 'direct_boot', collectionEnabled: true, captureSessionId: 10, type, ...extra
  });
  const scope = { id: 'job_direct', actor: BINDING_A.actorUserId, since: clock - 7 * 86400000, deadline: clock + 300000, query: null };
  sync('BRIDGE_INIT', { bindingContext: BINDING_A, historyScope: scope });

  const pages = () => outboundMessages.filter(m => m.data.historyPage);
  for (let i = 0; i < 150 && pages().length < 1; ++i) await new Promise(r => setTimeout(r, 10));
  assert.equal(pages().length, 1);
  assert.equal(pages()[0].data.historyPage.canPage, true);
  assert.equal(pages()[0].data.historyPage.ended, false);

  clock += 12000;
  sync('HISTORY_NEXT', { jobId: 'job_direct', bindingId: BINDING_A.bindingId });
  for (let i = 0; i < 100 && pages().length < 2; ++i) await new Promise(r => setTimeout(r, 5));
  assert.equal(pages().length, 2);
  assert.equal(pages()[1].data.historyPage.canPage, false);
  assert.equal(pages()[1].data.historyPage.ended, true);
});

test('Failed direct bootstrap (HTTP 403/404) never emits unrecognized stop, and HISTORY_NEXT uses scrollScan to capture native pagination first', async (t) => {
  let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  const page1Payload = structuredClone(timelineFixtures.ownRepliesTimelineMixed.response);
  page1Payload.data.user.result.timeline_v2.timeline.instructions[0].entries.push({
    entryId: 'cursor-bottom-1',
    content: { entryType: 'TimelineTimelineCursor', cursorType: 'Bottom', value: 'scroll-p2' }
  });
  const page2Payload = structuredClone(timelineFixtures.ownRepliesTimelineMixed.response);

  let nativeFetches = 0;
  const scrollTargets = [];
  const { win, outboundMessages } = createMockEnvironment(async (input) => {
    const reqUrl = typeof input === 'string' ? input : input.url;
    if (reqUrl.includes('client-web/main.')) {
      return new Response('queryId:"bootQid",operationName:"UserTweetsAndReplies"', { status: 200 });
    }
    if (reqUrl.includes('bootQid/UserTweetsAndReplies')) {
      return new Response('{}', { status: 403 });
    }
    nativeFetches += 1;
    return new Response(JSON.stringify(page2Payload), { status: 200 });
  });

  win.location.href = 'https://x.com/sample_me';
  const se = { scrollTop: 0, scrollHeight: 3000 };
  win.document = {
    documentElement: se,
    scrollingElement: se,
    scripts: [{ src: 'https://abs.twimg.com/responsive-web/client-web/main.abc.js' }],
    querySelector(sel) {
      return sel.includes('cellInnerDiv') ? { scrollIntoView() {} } : null;
    },
    querySelectorAll() {
      return [{ scrollIntoView() {} }];
    }
  };
  let scrolledTrigger = false;
  win.scrollTo = (_x, y) => {
    scrollTargets.push(y);
    se.scrollTop = y;
    if (!scrolledTrigger && nativeFetches === 0 && outboundMessages.some((m) => m.data.historyPage)) {
      scrolledTrigger = true;
      const p2Url = timelineFixtures.ownRepliesTimelineMixed.requestUrl.replace(
        encodeURIComponent('{}'),
        encodeURIComponent(JSON.stringify({ userId: BINDING_A.actorUserId, cursor: 'scroll-p2' }))
      );
      queueMicrotask(() => { win.fetch(p2Url); });
    }
  };

  installMainInterceptor(win, adapterApi);
  const sync = (type, extra) => win.dispatchBridgeMessage({
    protocol: 'SPARKLINK_BRIDGE_V1', nonce: 'scroll_scan_nonce', collectionEnabled: true, captureSessionId: 10, type, ...extra
  });
  const scope = { id: 'job_scroll', actor: BINDING_A.actorUserId, since: clock - 7 * 86400000, deadline: clock + 300000, query: null };
  sync('BRIDGE_INIT', { bindingContext: BINDING_A, historyScope: scope });

  // Wait past bootstrap timer (350ms): 403 on synthetic bootstrap must NOT trigger HISTORY_STOP
  await new Promise((r) => setTimeout(r, 420));
  assert.equal(outboundMessages.filter((m) => m.data.type === 'HISTORY_STOP').length, 0);

  // Navigate to /with_replies -> X loads Page 1 natively
  win.location.href = 'https://x.com/sample_me/with_replies';
  const origFetch = win.fetch;
  // Simulate X firing Page 1 via XHR or fetch with real page1Payload
  const xhr = new win.XMLHttpRequest();
  xhr.open('GET', timelineFixtures.ownRepliesTimelineMixed.requestUrl);
  xhr.send();
  xhr.dispatchLoad(200, page1Payload, 'json');

  const pages = () => outboundMessages.filter((m) => m.data.historyPage);
  assert.equal(pages().length, 1);
  assert.equal(pages()[0].data.historyPage.canPage, true);

  // Advance 12s and send HISTORY_NEXT -> must scroll and capture X's native page 2 fetch
  clock += 12000;
  sync('HISTORY_NEXT', { jobId: 'job_scroll', bindingId: BINDING_A.bindingId });
  for (let i = 0; i < 100 && pages().length < 2; ++i) await new Promise((r) => setTimeout(r, 10));
  assert.ok(scrollTargets.length >= 1);
  assert.equal(pages().length, 2);
  assert.equal(pages()[1].data.historyPage.ended, true);
  assert.equal(typeof origFetch, 'function');
});
