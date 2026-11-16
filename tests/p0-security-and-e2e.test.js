'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const adapterApi = require('../src/x-adapter.js');
const { installMainInterceptor } = require('../src/interceptor.js');
const { installIsolatedBridge } = require('../src/bridge.js');
const viewerFixtures = require('./fixtures/viewer-states.json');
const createTweetFixtures = require('./fixtures/create-tweet.json');

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

test('Static security audit: P0 classic scripts contain zero cookie/auth-header reads, zero eval, zero toString tampering, and zero top-level ESM', () => {
  const files = ['x-adapter.js', 'interceptor.js', 'bridge.js'];
  for (const name of files) {
    const srcPath = path.join(__dirname, '..', 'src', name);
    const code = stripComments(fs.readFileSync(srcPath, 'utf8'));

    assert.equal(/\bdocument\.cookie\b/.test(code), false, `${name} must not access document.cookie`);
    assert.equal(/x-csrf-token|bearer\s+/i.test(code), false, `${name} must not inspect auth tokens`);
    assert.equal(/\beval\s*\(|new\s+Function\s*\(/.test(code), false, `${name} must not use eval/new Function`);
    assert.equal(/Function\.prototype\.toString/.test(code), false, `${name} must not touch Function.prototype.toString`);
    assert.equal(/^\s*(import|export)\s+/m.test(code), false, `${name} must be a classic script without top-level ESM`);
  }
});

test('End-to-end MAIN <-> ISOLATED pipeline works seamlessly with poisoned document.cookie trap', async () => {
  const listeners = new Map();
  const submittedBatches = [];

  const docTrap = {
    visibilityState: 'visible',
    addEventListener() {},
    querySelectorAll() {
      return [];
    }
  };
  Object.defineProperty(docTrap, 'cookie', {
    get() {
      throw new Error('FORBIDDEN_COOKIE_ACCESS');
    },
    set() {
      throw new Error('FORBIDDEN_COOKIE_WRITE');
    }
  });

  const sharedWin = {
    location: { origin: 'https://x.com', href: 'https://x.com/other_user' },
    document: docTrap,
    // Simulating browsing another user's profile while logged in as 1001001
    __INITIAL_STATE__: viewerFixtures.otherProfileInitialState,
    async fetch() {
      return new Response(JSON.stringify(createTweetFixtures.standardReply.response), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer SECRET_MUST_NOT_BE_READ',
          'x-csrf-token': 'CSRF_SECRET_MUST_NOT_BE_READ'
        }
      });
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      if (listeners.has(type)) listeners.get(type).delete(fn);
    },
    postMessage(data, targetOrigin) {
      assert.equal(targetOrigin, 'https://x.com');
      queueMicrotask(() => {
        const set = listeners.get('message');
        if (set) {
          for (const fn of set) {
            fn({ data, origin: 'https://x.com', source: sharedWin });
          }
        }
      });
    }
  };
  sharedWin.top = sharedWin;

  const mockChrome = {
    runtime: {
      id: 'ext_e2e',
      onMessage: { addListener() {}, removeListener() {} },
      async sendMessage(msg) {
        if (msg.type === 'HELLO') {
          return {
            ok: true,
            collectionEnabled: true,
            captureSessionId: 7,
            bindingContext: null,
            bindRequired: true,
            revision: 1
          };
        }
        if (msg.type === 'BIND_VIEWER') {
          assert.equal(msg.viewer.actorUserId, '1001001');
          return {
            ok: true,
            bindingContext: {
              bindingId: 'bind_e2e_7',
              actorUserId: '1001001',
              captureSessionId: 7,
              collectionGeneration: 1,
              accountGeneration: 1
            },
            revision: 2
          };
        }
        if (msg.type === 'SUBMIT_OBSERVED_BATCH') {
          submittedBatches.push(msg);
          return { ok: true, revision: 3 };
        }
        return { ok: true };
      }
    }
  };

  installMainInterceptor(sharedWin, adapterApi);
  const bridge = installIsolatedBridge(sharedWin, mockChrome, { retryDelayMs: 5 });

  await new Promise((r) => setTimeout(r, 40));
  assert.equal(bridge.getBindingContext().bindingId, 'bind_e2e_7');
  assert.equal(bridge.getBindingContext().actorUserId, '1001001');

  // Trigger a live reply fetch on the page
  await sharedWin.fetch(createTweetFixtures.standardReply.requestUrl, {
    method: 'POST',
    headers: {
      authorization: 'Bearer DO_NOT_TOUCH',
      'x-csrf-token': 'DO_NOT_TOUCH'
    },
    body: JSON.stringify(createTweetFixtures.standardReply.requestBody)
  });

  await new Promise((r) => setTimeout(r, 40));
  assert.equal(submittedBatches.length, 1);
  assert.equal(submittedBatches[0].events.length, 1);
  assert.equal(submittedBatches[0].events[0].replyTweetId, '2122147641553846272');
  assert.equal(submittedBatches[0].events[0].targetUserId, '2002002');
  // Ensure no auth tokens leaked into submitted batch
  const serialized = JSON.stringify(submittedBatches);
  assert.equal(serialized.includes('DO_NOT_TOUCH'), false);
  assert.equal(serialized.includes('SECRET'), false);

  bridge.destroy();
});
