'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const viewerFixtures = require('./fixtures/viewer-states.json');
const createTweetFixtures = require('./fixtures/create-tweet.json');
const timelineFixtures = require('./fixtures/timelines.json');

const {
  isValidDecimalId,
  sanitizeHandle,
  matchWhitelistedRequest,
  extractViewerFromInitialState,
  extractViewerFromGraphql,
  parseCreateTweetRequest,
  createAdapterEngine
} = require('../src/x-adapter.js');

const SAMPLE_BINDING = Object.freeze({
  bindingId: 'bind_1',
  actorUserId: '1001001',
  captureSessionId: 4,
  collectionGeneration: 1,
  accountGeneration: 2
});

const NOW_MS = 1794795000000;

test('ID and handle validators enforce strict decimal string and safe handle bounds', () => {
  assert.equal(isValidDecimalId('1001001'), true);
  assert.equal(isValidDecimalId('2122147641553846272'), true);
  assert.equal(isValidDecimalId('0'), false);
  assert.equal(isValidDecimalId(''), false);
  assert.equal(isValidDecimalId('123abc'), false);
  assert.equal(isValidDecimalId(1001001), false);
  assert.equal(isValidDecimalId('9'.repeat(33)), false);

  assert.equal(sanitizeHandle('@sample_friend'), 'sample_friend');
  assert.equal(sanitizeHandle('valid_Handle_123'), 'valid_Handle_123');
  assert.equal(sanitizeHandle('bad/handle'), null);
  assert.equal(sanitizeHandle('a'.repeat(65)), null);
});

test('matchWhitelistedRequest accepts only allowed X/Twitter GraphQL operations and methods', () => {
  const createMatch = matchWhitelistedRequest(
    'https://x.com/i/api/graphql/aBcDeFg_123-XyZ/CreateTweet',
    'POST'
  );
  assert.deepEqual(createMatch, {
    operationName: 'CreateTweet',
    category: 'create_tweet',
    method: 'POST'
  });

  const twitterRepliesMatch = matchWhitelistedRequest(
    'https://twitter.com/i/api/graphql/qId99/UserTweetsAndReplies?variables=%7B%7D',
    'get'
  );
  assert.deepEqual(twitterRepliesMatch, {
    operationName: 'UserTweetsAndReplies',
    category: 'replies_timeline',
    method: 'GET'
  });

  assert.equal(
    matchWhitelistedRequest('https://x.com/i/api/graphql/aBcDeFg/CreateTweet', 'GET'),
    null
  );
  assert.equal(
    matchWhitelistedRequest('https://x.com/i/api/graphql/aBcDeFg/FavoriteTweet', 'POST'),
    null
  );
  assert.equal(
    matchWhitelistedRequest('https://evil.example.com/i/api/graphql/aBcDeFg/CreateTweet', 'POST'),
    null
  );
});

test('Viewer extraction resolves logged-in account without cookies even on another profile page', () => {
  const ownViewer = extractViewerFromInitialState(viewerFixtures.ownProfileInitialState);
  assert.deepEqual(ownViewer, {
    actorUserId: '1001001',
    handle: 'sample_me',
    displayName: '示例账号'
  });

  const onOtherProfile = extractViewerFromInitialState(viewerFixtures.otherProfileInitialState);
  assert.deepEqual(onOtherProfile, {
    actorUserId: '1001001',
    handle: 'sample_me',
    displayName: '示例账号'
  });

  assert.equal(extractViewerFromInitialState(viewerFixtures.loggedOutInitialState), null);

  const modernGraphql = extractViewerFromGraphql(viewerFixtures.viewerGraphqlModern);
  assert.deepEqual(modernGraphql, {
    actorUserId: '1001001',
    handle: 'sample_me',
    displayName: '示例账号'
  });

  const legacyGraphql = extractViewerFromGraphql(viewerFixtures.viewerGraphqlLegacy);
  assert.deepEqual(legacyGraphql, {
    actorUserId: '9009009',
    handle: 'second_account',
    displayName: '第二账号'
  });
});

test('Live CreateTweet handling covers standard, visibility-wrapped media, multi-mention, self-reply, plain post, business error, and multi-edit anomaly', () => {
  const engine = createAdapterEngine();

  // 1. Standard reply
  const stdReq = parseCreateTweetRequest(JSON.stringify(createTweetFixtures.standardReply.requestBody));
  assert.deepEqual(stdReq, { expectedParentTweetId: '2121785253688246272', isReplyCandidate: true });

  const stdRes = engine.processCreateTweetResponse({
    payload: createTweetFixtures.standardReply.response,
    requestMeta: stdReq,
    bindingContext: SAMPLE_BINDING,
    observedAt: 1794794401000
  });
  assert.equal(stdRes.events.length, 1);
  assert.deepEqual(stdRes.events[0], {
    actorUserId: '1001001',
    replyTweetId: '2122147641553846272',
    parentTweetId: '2121785253688246272',
    targetUserId: '2002002',
    targetHandle: 'sample_friend',
    targetDisplayName: null,
    createdAt: 1794794400000,
    observedAt: 1794794401000,
    source: 'live',
    bindingContext: SAMPLE_BINDING
  });

  // 2. Visibility-wrapped media reply
  const mediaReq = parseCreateTweetRequest(JSON.stringify(createTweetFixtures.visibilityWrappedMediaReply.requestBody));
  const mediaRes = engine.processCreateTweetResponse({
    payload: createTweetFixtures.visibilityWrappedMediaReply.response,
    requestMeta: mediaReq,
    bindingContext: SAMPLE_BINDING,
    observedAt: NOW_MS
  });
  assert.equal(mediaRes.events.length, 1);
  assert.equal(mediaRes.events[0].replyTweetId, '2122147641553846301');
  assert.equal(mediaRes.events[0].targetUserId, '2002003');

  // 3. Multi-mention inline reply attributes strictly to direct parent author
  const multiReq = parseCreateTweetRequest(JSON.stringify(createTweetFixtures.multiMentionInlineReply.requestBody));
  const multiRes = engine.processCreateTweetResponse({
    payload: createTweetFixtures.multiMentionInlineReply.response,
    requestMeta: multiReq,
    bindingContext: SAMPLE_BINDING,
    observedAt: NOW_MS
  });
  assert.equal(multiRes.events.length, 1);
  assert.equal(multiRes.events[0].targetUserId, '2002002');

  // 4. Self-reply ignored
  const selfReq = parseCreateTweetRequest(JSON.stringify(createTweetFixtures.selfReply.requestBody));
  const selfRes = engine.processCreateTweetResponse({
    payload: createTweetFixtures.selfReply.response,
    requestMeta: selfReq,
    bindingContext: SAMPLE_BINDING,
    observedAt: NOW_MS
  });
  assert.equal(selfRes.events.length, 0);

  // 5. Plain post ignored
  const plainReq = parseCreateTweetRequest(JSON.stringify(createTweetFixtures.plainPost.requestBody));
  assert.equal(plainReq.isReplyCandidate, false);
  const plainRes = engine.processCreateTweetResponse({
    payload: createTweetFixtures.plainPost.response,
    requestMeta: plainReq,
    bindingContext: SAMPLE_BINDING,
    observedAt: NOW_MS
  });
  assert.equal(plainRes.events.length, 0);

  // 6. HTTP 200 GraphQL business error ignored
  const errReq = parseCreateTweetRequest(JSON.stringify(createTweetFixtures.graphqlBusinessError.requestBody));
  const errRes = engine.processCreateTweetResponse({
    payload: createTweetFixtures.graphqlBusinessError.response,
    requestMeta: errReq,
    bindingContext: SAMPLE_BINDING,
    observedAt: NOW_MS
  });
  assert.equal(errRes.events.length, 0);

  // 7. Multi-version unknown edit history skipped with adapter anomaly
  const editReq = parseCreateTweetRequest(JSON.stringify(createTweetFixtures.multiVersionEditAnomaly.requestBody));
  const editRes = engine.processCreateTweetResponse({
    payload: createTweetFixtures.multiVersionEditAnomaly.response,
    requestMeta: editReq,
    bindingContext: SAMPLE_BINDING,
    observedAt: NOW_MS
  });
  assert.equal(editRes.events.length, 0);
  assert.deepEqual(editRes.anomalies, ['multi_version_edit']);
});

test('PendingReplyQueue resolves missing target when parent tweet appears later, enforces 1000/10m bounds, and updates renamed handles', () => {
  const engine = createAdapterEngine({ maxPendingReplies: 3, pendingTtlMs: 600000 });
  const reqMeta = parseCreateTweetRequest(
    JSON.stringify(createTweetFixtures.missingDirectTargetReply.requestBody)
  );

  // Reply arrives before parent author is known -> queued
  const initialRes = engine.processCreateTweetResponse({
    payload: createTweetFixtures.missingDirectTargetReply.response,
    requestMeta: reqMeta,
    bindingContext: SAMPLE_BINDING,
    observedAt: 1794795300000
  });
  assert.equal(initialRes.events.length, 0);
  assert.equal(initialRes.queuedCount, 1);

  // Pre-seed old handle mapping to test rename eviction
  engine.processTimelineResponse({
    operationName: 'UserTweetsAndReplies',
    payload: timelineFixtures.ownRepliesTimelineMixed.response,
    bindingContext: SAMPLE_BINDING,
    observedAt: 1794795310000
  });
  assert.equal(engine.resolveUserIdByHandle('sample_friend'), '2002002');

  // TweetDetail arrives: parent tweet 2121789999999999999 belongs to 2002002 (now @renamed_friend),
  // while @sample_friend is now owned by 3003003!
  const detailRes = engine.processTimelineResponse({
    operationName: 'TweetDetail',
    payload: timelineFixtures.tweetDetailResolutionAndRename.response,
    bindingContext: SAMPLE_BINDING,
    observedAt: 1794795350000
  });

  // Pending live reply is now resolved with its original frozen bindingContext!
  assert.equal(detailRes.resolvedPendingEvents.length, 1);
  assert.equal(detailRes.resolvedPendingEvents[0].replyTweetId, '2122147641553846500');
  assert.equal(detailRes.resolvedPendingEvents[0].targetUserId, '2002002');
  assert.equal(detailRes.resolvedPendingEvents[0].targetHandle, 'renamed_friend');
  assert.equal(detailRes.resolvedPendingEvents[0].source, 'live');
  assert.deepEqual(detailRes.resolvedPendingEvents[0].bindingContext, SAMPLE_BINDING);

  // Handle mapping reflects rename and does not collide old handle with old user
  assert.equal(engine.resolveUserIdByHandle('renamed_friend'), '2002002');
  assert.equal(engine.resolveUserIdByHandle('sample_friend'), '3003003');

  // Overflow & TTL bounds check
  for (let i = 1; i <= 4; i += 1) {
    const syntheticPayload = structuredClone(createTweetFixtures.missingDirectTargetReply.response);
    syntheticPayload.data.create_tweet.tweet_results.result.rest_id = `212214764155384900${i}`;
    syntheticPayload.data.create_tweet.tweet_results.result.legacy.in_reply_to_status_id_str = `212199999999999900${i}`;
    const r = engine.processCreateTweetResponse({
      payload: syntheticPayload,
      requestMeta: { expectedParentTweetId: `212199999999999900${i}`, isReplyCandidate: true },
      bindingContext: SAMPLE_BINDING,
      observedAt: 1794795400000 + i
    });
    if (i === 4) {
      assert.equal(r.incompleteObservation, true);
    }
  }
  assert.equal(engine.getPendingCount(), 3);

  // Advance past 10 minutes TTL -> expired items evicted with incompleteObservation
  const expiredSweep = engine.prunePendingReplies(1794795400000 + 600005);
  assert.equal(expiredSweep.evictedCount, 3);
  assert.equal(expiredSweep.incompleteObservation, true);
  assert.equal(engine.getPendingCount(), 0);
});

test('Passive UserTweetsAndReplies extracts only bound viewer replies, skips missing fields with partialUnrecognized, and ignores other users timelines', () => {
  const engine = createAdapterEngine();

  const ownRes = engine.processTimelineResponse({
    operationName: 'UserTweetsAndReplies',
    payload: timelineFixtures.ownRepliesTimelineMixed.response,
    bindingContext: SAMPLE_BINDING,
    observedAt: NOW_MS
  });

  // Should include 2122147641553846272 (in conversation module) and 2122147641553847003 (direct item)
  // Should skip 2122147641553847004 (missing target & unknown parent) with partialUnrecognized = true
  // Should exclude parent context tweet, retweet, and quote post
  assert.equal(ownRes.events.length, 2);
  assert.deepEqual(
    ownRes.events.map((e) => e.replyTweetId),
    ['2122147641553846272', '2122147641553847003']
  );
  assert.equal(ownRes.events[0].source, 'history');
  assert.equal(ownRes.events[0].targetUserId, '2002002');
  assert.equal(ownRes.events[0].targetDisplayName, '示例好友');
  assert.equal(ownRes.events[1].targetUserId, '2002005');
  assert.equal(ownRes.partialUnrecognized, true);

  // Browsing another user's Replies timeline must yield 0 history events for SAMPLE_BINDING
  const otherRes = engine.processTimelineResponse({
    operationName: 'UserTweetsAndReplies',
    payload: timelineFixtures.otherUserRepliesTimeline.response,
    bindingContext: SAMPLE_BINDING,
    observedAt: NOW_MS
  });
  assert.equal(otherRes.events.length, 0);
  assert.equal(otherRes.partialUnrecognized, false);
});

test('Defensive branches: prototype pollution rejection, inline script viewer extraction, HomeTimeline/UserByScreenName, mismatches, and binding revocation', () => {
  const {
    hasDangerousOwnKeys,
    extractViewerFromWindow
  } = require('../src/x-adapter.js');

  const polluted = JSON.parse('{"__proto__": {"polluted": true}, "session": {"user_id": "1001001"}}');
  assert.equal(hasDangerousOwnKeys(polluted), true);
  assert.equal(extractViewerFromInitialState(polluted), null);
  assert.equal(parseCreateTweetRequest('{"__proto__":{},"variables":{"reply":{"in_reply_to_tweet_id":"123"}}}').isReplyCandidate, false);
  assert.equal(parseCreateTweetRequest('not-json').isReplyCandidate, false);

  // Window extraction from inline script
  const fakeWin = {
    document: {
      querySelectorAll() {
        return [
          { textContent: 'console.log("noop");' },
          {
            textContent:
              'window.__INITIAL_STATE__ = {"session":{"user_id":"1001001","user":{"screen_name":"inline_me","name":"Inline User"}}};'
          }
        ];
      }
    }
  };
  assert.deepEqual(extractViewerFromWindow(fakeWin), {
    actorUserId: '1001001',
    handle: 'inline_me',
    displayName: 'Inline User'
  });
  assert.deepEqual(
    extractViewerFromWindow({ __INITIAL_STATE__: viewerFixtures.ownProfileInitialState }),
    { actorUserId: '1001001', handle: 'sample_me', displayName: '示例账号' }
  );

  // Consume once hook test
  assert.equal(typeof globalThis.__sparklinkConsumeAdapter, 'function');
  const consumed = globalThis.__sparklinkConsumeAdapter();
  assert.equal(typeof consumed.createAdapterEngine, 'function');
  assert.equal(globalThis.__sparklinkConsumeAdapter, undefined);

  const engine = createAdapterEngine({ maxMapSize: 5 });

  // UserByScreenName & HomeTimeline branches
  const singleUserRes = engine.processTimelineResponse({
    operationName: 'UserByScreenName',
    payload: {
      data: {
        user: {
          result: {
            __typename: 'User',
            rest_id: '5005005',
            core: { screen_name: 'screen_target', name: 'Screen Target' }
          }
        }
      }
    },
    bindingContext: SAMPLE_BINDING,
    observedAt: NOW_MS
  });
  assert.equal(singleUserRes.observedUsers.length, 1);
  assert.equal(engine.resolveUserIdByHandle('screen_target'), '5005005');

  const homeRes = engine.processTimelineResponse({
    operationName: 'HomeTimeline',
    payload: {
      data: {
        home: {
          home_timeline_urt: {
            instructions: [
              {
                type: 'TimelinePinEntry',
                entry: {
                  content: {
                    itemContent: {
                      tweet_results: {
                        result: {
                          __typename: 'Tweet',
                          rest_id: '2123000000000000001',
                          core: {
                            user_results: {
                              result: {
                                __typename: 'User',
                                rest_id: '5005005',
                                core: { screen_name: 'screen_target', name: 'Screen Target' }
                              }
                            }
                          },
                          legacy: { created_at: 'Mon Nov 16 02:00:00 +0000 2026' }
                        }
                      }
                    }
                  }
                }
              }
            ]
          }
        }
      }
    },
    bindingContext: SAMPLE_BINDING,
    observedAt: NOW_MS
  });
  assert.equal(homeRes.observedTweets.length, 1);
  assert.equal(engine.resolveAuthorByTweetId('2123000000000000001').authorUserId, '5005005');

  // Parent mismatch & actor mismatch in CreateTweet
  const mismatchParent = engine.processCreateTweetResponse({
    payload: createTweetFixtures.standardReply.response,
    requestMeta: { expectedParentTweetId: '9999999999999999999', isReplyCandidate: true },
    bindingContext: SAMPLE_BINDING,
    observedAt: NOW_MS
  });
  assert.deepEqual(mismatchParent.anomalies, ['parent_mismatch']);

  const mismatchActor = engine.processCreateTweetResponse({
    payload: createTweetFixtures.standardReply.response,
    requestMeta: { expectedParentTweetId: '2121785253688246272', isReplyCandidate: true },
    bindingContext: { ...SAMPLE_BINDING, actorUserId: '8888888' },
    observedAt: NOW_MS
  });
  assert.deepEqual(mismatchActor.anomalies, ['actor_mismatch']);

  // Enqueue pending then revoke specific binding and clearAll
  engine.processCreateTweetResponse({
    payload: createTweetFixtures.missingDirectTargetReply.response,
    requestMeta: { expectedParentTweetId: '2121789999999999999', isReplyCandidate: true },
    bindingContext: SAMPLE_BINDING,
    observedAt: NOW_MS
  });
  assert.equal(engine.getPendingCount(), 1);
  engine.revokeBinding('other_bind');
  assert.equal(engine.getPendingCount(), 1);
  engine.revokeBinding('bind_1');
  assert.equal(engine.getPendingCount(), 0);
  engine.clearAll();
  assert.equal(engine.resolveAuthorByTweetId('2123000000000000001'), null);
});
