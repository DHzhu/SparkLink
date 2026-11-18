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
  assert.deepEqual(ownRes.historyPage, {
    newestAt: Date.parse('Mon Nov 16 02:38:00 +0000 2026'),
    ended: false,
    pageKey: '2122147641553847006'
  });

  // Browsing another user's Replies timeline must yield 0 history events and no historyPage for SAMPLE_BINDING
  const otherRes = engine.processTimelineResponse({
    operationName: 'UserTweetsAndReplies',
    payload: timelineFixtures.otherUserRepliesTimeline.response,
    bindingContext: SAMPLE_BINDING,
    observedAt: NOW_MS
  });
  assert.equal(otherRes.events.length, 0);
  assert.equal(otherRes.partialUnrecognized, false);
  assert.equal('historyPage' in otherRes, false);
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
  assert.equal(extractViewerFromWindow(fakeWin, { allowInlineScript: false }), null);
  assert.deepEqual(
    extractViewerFromWindow({ __INITIAL_STATE__: viewerFixtures.ownProfileInitialState }, { allowInlineScript: false }),
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
  assert.equal('historyPage' in singleUserRes, false);

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
  assert.equal('historyPage' in homeRes, false);

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

function makeOwnTimelinePayload(instructions, overrides = {}) {
  return {
    data: {
      user: {
        result: {
          __typename: 'User',
          rest_id: overrides.ownerId || '1001001',
          core: { screen_name: 'sample_me', name: '示例账号' },
          timeline_v2: {
            timeline: {
              instructions
            }
          }
        }
      }
    },
    ...(overrides.errors ? { errors: overrides.errors } : {})
  };
}

function makeTweetNode({
  tweetId,
  authorUserId = '1001001',
  handle = 'sample_me',
  createdAt = 'Mon Nov 16 02:00:00 +0000 2026',
  inReplyToStatusId = null,
  inReplyToUserId = null,
  retweetNode = null,
  quotedNode = null
}) {
  const legacy = {
    user_id_str: authorUserId
  };
  if (createdAt !== null) {
    legacy.created_at = createdAt;
  }
  if (inReplyToStatusId) {
    legacy.in_reply_to_status_id_str = inReplyToStatusId;
  }
  if (inReplyToUserId) {
    legacy.in_reply_to_user_id_str = inReplyToUserId;
  }
  if (retweetNode) {
    legacy.retweeted_status_result = { result: retweetNode };
  }
  const node = {
    __typename: 'Tweet',
    rest_id: tweetId,
    core: {
      user_results: {
        result: {
          __typename: 'User',
          rest_id: authorUserId,
          core: { screen_name: handle, name: handle }
        }
      }
    },
    legacy
  };
  if (quotedNode) {
    node.quoted_status_result = { result: quotedNode };
  }
  return node;
}

function makeTweetEntry(entryId, tweetNode, extraItemContent = {}) {
  return {
    entryId,
    content: {
      entryType: 'TimelineTimelineItem',
      itemContent: {
        itemType: 'TimelineTweet',
        ...extraItemContent,
        tweet_results: { result: tweetNode }
      }
    }
  };
}

test('historyPage is omitted for non-UserTweetsAndReplies, unverified/invalid bindings, business errors, and broken or unrecognized instructions', () => {
  const engine = createAdapterEngine();
  const validInstructions = [
    {
      type: 'TimelineAddEntries',
      entries: [makeTweetEntry('tweet-2122147641553847100', makeTweetNode({ tweetId: '2122147641553847100' }))]
    }
  ];

  // Other timeline operations never emit historyPage
  const userTweetsRes = engine.processTimelineResponse({
    operationName: 'UserTweets',
    payload: makeOwnTimelinePayload(validInstructions),
    bindingContext: SAMPLE_BINDING,
    observedAt: NOW_MS
  });
  assert.equal('historyPage' in userTweetsRes, false);
  assert.equal(engine.resolveAuthorByTweetId('2122147641553847100').authorUserId, '1001001');

  // Business errors alongside instructions omit historyPage
  const businessErrorRes = engine.processTimelineResponse({
    operationName: 'UserTweetsAndReplies',
    payload: makeOwnTimelinePayload(validInstructions, { errors: [{ message: 'Rate limited' }] }),
    bindingContext: SAMPLE_BINDING,
    observedAt: NOW_MS
  });
  assert.equal('historyPage' in businessErrorRes, false);

  // Invalid bindingContext omits historyPage
  const badBindingRes = engine.processTimelineResponse({
    operationName: 'UserTweetsAndReplies',
    payload: makeOwnTimelinePayload(validInstructions),
    bindingContext: null,
    observedAt: NOW_MS
  });
  assert.equal('historyPage' in badBindingRes, false);

  // Empty instructions or unrecognized/broken instruction shapes omit historyPage
  for (const brokenInstructions of [
    [],
    [{ foo: 'bar' }],
    [{ type: 'UnknownInstruction' }],
    [{ type: 'TimelineAddEntries', entries: 'not-an-array' }],
    [{ type: 'TimelineTerminateTimeline' }]
  ]) {
    const brokenRes = engine.processTimelineResponse({
      operationName: 'UserTweetsAndReplies',
      payload: makeOwnTimelinePayload(brokenInstructions),
      bindingContext: SAMPLE_BINDING,
      observedAt: NOW_MS
    });
    assert.equal('historyPage' in brokenRes, false);
  }

  // Unavailable user omits historyPage
  const unavailableRes = engine.processTimelineResponse({
    operationName: 'UserTweetsAndReplies',
    payload: {
      data: {
        user: {
          result: {
            __typename: 'UserUnavailable',
            timeline_v2: { timeline: { instructions: validInstructions } }
          }
        }
      }
    },
    bindingContext: SAMPLE_BINDING,
    observedAt: NOW_MS
  });
  assert.equal('historyPage' in unavailableRes, false);
});

test('historyPage newestAt excludes pinned, promoted, retweets, quoted inner tweets, unavailable, and foreign context while preserving author attribution', () => {
  const engine = createAdapterEngine();
  const payload = makeOwnTimelinePayload([
    {
      type: 'TimelinePinEntry',
      entry: makeTweetEntry(
        'tweet-2129999999999999999',
        makeTweetNode({
          tweetId: '2129999999999999999',
          authorUserId: '1001001',
          createdAt: 'Tue Nov 17 12:00:00 +0000 2026'
        })
      )
    },
    {
      type: 'TimelineAddEntries',
      entries: [
        makeTweetEntry(
          'promoted-tweet-2128888888888888888',
          makeTweetNode({
            tweetId: '2128888888888888888',
            authorUserId: '1001001',
            createdAt: 'Tue Nov 17 11:00:00 +0000 2026'
          }),
          { promotedMetadata: { impressionId: 'ad_1' } }
        ),
        makeTweetEntry(
          'tweet-2127777777777777777',
          makeTweetNode({
            tweetId: '2127777777777777777',
            authorUserId: '1001001',
            createdAt: 'Tue Nov 17 10:00:00 +0000 2026',
            retweetNode: makeTweetNode({
              tweetId: '2121111111111111111',
              authorUserId: '4004004',
              handle: 'rt_orig',
              createdAt: 'Mon Jan 01 00:00:00 +0000 2024'
            })
          })
        ),
        makeTweetEntry(
          'tweet-2126666666666666666',
          makeTweetNode({
            tweetId: '2126666666666666666',
            authorUserId: '5005005',
            handle: 'foreign_user',
            createdAt: 'Tue Nov 17 09:30:00 +0000 2026'
          })
        ),
        {
          entryId: 'tweet-unavailable-1',
          content: {
            entryType: 'TimelineTimelineItem',
            itemContent: {
              itemType: 'TimelineTweet',
              tweet_results: { result: { __typename: 'TweetUnavailable' } }
            }
          }
        },
        makeTweetEntry(
          'tweet-2125555555555555555',
          makeTweetNode({
            tweetId: '2125555555555555555',
            authorUserId: '1001001',
            createdAt: 'Mon Nov 16 05:00:00 +0000 2026',
            quotedNode: makeTweetNode({
              tweetId: '2120000000000000009',
              authorUserId: '6006006',
              handle: 'quoted_user',
              createdAt: 'Mon Jan 01 00:00:00 +0000 2024'
            })
          })
        )
      ]
    }
  ]);

  const res = engine.processTimelineResponse({
    operationName: 'UserTweetsAndReplies',
    payload,
    bindingContext: SAMPLE_BINDING,
    observedAt: NOW_MS
  });

  assert.deepEqual(res.historyPage, {
    newestAt: Date.parse('Mon Nov 16 05:00:00 +0000 2026'),
    ended: false,
    pageKey: '2125555555555555555'
  });

  // Author attribution remains intact for pinned, retweeted, foreign, and quoted tweets
  assert.equal(engine.resolveAuthorByTweetId('2129999999999999999').authorUserId, '1001001');
  assert.equal(engine.resolveAuthorByTweetId('2121111111111111111').authorUserId, '4004004');
  assert.equal(engine.resolveAuthorByTweetId('2126666666666666666').authorUserId, '5005005');
  assert.equal(engine.resolveAuthorByTweetId('2120000000000000009').authorUserId, '6006006');
  assert.equal(engine.resolveUserIdByHandle('quoted_user'), '6006006');
});

test('historyPage does not mistake an old conversation parent for a recent thread position and returns null newestAt when uncertain', () => {
  const engine = createAdapterEngine();

  // Case 1: Self-thread reply in 2026 to own 2024 parent tweet -> position is 2026
  const selfThreadPayload = makeOwnTimelinePayload([
    {
      type: 'TimelineAddEntries',
      entries: [
        {
          entryId: 'profile-conversation-self',
          content: {
            entryType: 'TimelineTimelineModule',
            items: [
              {
                entryId: 'profile-conversation-self-tweet-2100000000000000001',
                item: {
                  itemContent: {
                    itemType: 'TimelineTweet',
                    tweet_results: {
                      result: makeTweetNode({
                        tweetId: '2100000000000000001',
                        authorUserId: '1001001',
                        createdAt: 'Mon Jan 01 00:00:00 +0000 2024'
                      })
                    }
                  }
                }
              },
              {
                entryId: 'profile-conversation-self-tweet-2122147641553848001',
                item: {
                  itemContent: {
                    itemType: 'TimelineTweet',
                    tweet_results: {
                      result: makeTweetNode({
                        tweetId: '2122147641553848001',
                        authorUserId: '1001001',
                        createdAt: 'Mon Nov 16 08:00:00 +0000 2026',
                        inReplyToStatusId: '2100000000000000001',
                        inReplyToUserId: '1001001'
                      })
                    }
                  }
                }
              },
              {
                entryId: 'profile-conversation-self-cursor-showmore-0',
                item: {
                  itemContent: {
                    itemType: 'TimelineTimelineCursor',
                    cursorType: 'ShowMoreThreads',
                    value: 'OPAQUE_MODULE_CURSOR'
                  }
                }
              }
            ]
          }
        }
      ]
    }
  ]);
  const selfThreadRes = engine.processTimelineResponse({
    operationName: 'UserTweetsAndReplies',
    payload: selfThreadPayload,
    bindingContext: SAMPLE_BINDING,
    observedAt: NOW_MS
  });
  assert.deepEqual(selfThreadRes.historyPage, {
    newestAt: Date.parse('Mon Nov 16 08:00:00 +0000 2026'),
    ended: false,
    pageKey: '2122147641553848001'
  });

  // Case 2: Old own conversation parent (2024) whose recent leaf is TweetUnavailable -> must NOT return 2024!
  const parentWithUnavailableLeaf = makeOwnTimelinePayload([
    {
      type: 'TimelineAddEntries',
      entries: [
        {
          entryId: 'profile-conversation-broken-leaf',
          content: {
            entryType: 'TimelineTimelineModule',
            items: [
              {
                entryId: 'profile-conversation-broken-leaf-tweet-2100000000000000002',
                item: {
                  itemContent: {
                    itemType: 'TimelineTweet',
                    tweet_results: {
                      result: makeTweetNode({
                        tweetId: '2100000000000000002',
                        authorUserId: '1001001',
                        createdAt: 'Mon Jan 01 00:00:00 +0000 2024'
                      })
                    }
                  }
                }
              },
              {
                entryId: 'profile-conversation-broken-leaf-tweet-2122147641553848002',
                item: {
                  itemContent: {
                    itemType: 'TimelineTweet',
                    tweet_results: { result: { __typename: 'TweetUnavailable' } }
                  }
                }
              }
            ]
          }
        }
      ]
    }
  ]);
  const brokenLeafRes = engine.processTimelineResponse({
    operationName: 'UserTweetsAndReplies',
    payload: parentWithUnavailableLeaf,
    bindingContext: SAMPLE_BINDING,
    observedAt: NOW_MS
  });
  assert.deepEqual(brokenLeafRes.historyPage, {
    newestAt: null,
    ended: false,
    pageKey: null
  });

  // Case 3: Missing created_at or unrecognized non-pinned tweet forces newestAt = null (never stop early)
  const missingCreatedAtRes = engine.processTimelineResponse({
    operationName: 'UserTweetsAndReplies',
    payload: makeOwnTimelinePayload([
      {
        type: 'TimelineAddEntries',
        entries: [
          makeTweetEntry(
            'tweet-2122147641553848003',
            makeTweetNode({ tweetId: '2122147641553848003', createdAt: 'Mon Nov 16 01:00:00 +0000 2026' })
          ),
          makeTweetEntry(
            'tweet-2122147641553848004',
            makeTweetNode({ tweetId: '2122147641553848004', createdAt: null })
          )
        ]
      }
    ]),
    bindingContext: SAMPLE_BINDING,
    observedAt: NOW_MS
  });
  assert.equal(missingCreatedAtRes.historyPage.newestAt, null);
  assert.equal(missingCreatedAtRes.historyPage.ended, false);
  assert.equal(missingCreatedAtRes.historyPage.pageKey, '2122147641553848004');

  const unrecognizedTweetRes = engine.processTimelineResponse({
    operationName: 'UserTweetsAndReplies',
    payload: makeOwnTimelinePayload([
      {
        type: 'TimelineAddEntries',
        entries: [
          makeTweetEntry(
            'tweet-2122147641553848005',
            makeTweetNode({ tweetId: '2122147641553848005', createdAt: 'Mon Nov 16 01:00:00 +0000 2026' })
          ),
          {
            entryId: 'tweet-2122147641553848006',
            content: {
              entryType: 'TimelineTimelineItem',
              itemContent: { itemType: 'TimelineTweet' }
            }
          }
        ]
      }
    ]),
    bindingContext: SAMPLE_BINDING,
    observedAt: NOW_MS
  });
  assert.deepEqual(unrecognizedTweetRes.historyPage, {
    newestAt: null,
    ended: false,
    pageKey: null
  });
});

test('historyPage ended semantics, decimal tie-breaking pageKey, and opaque cursor non-leakage', () => {
  const engine = createAdapterEngine();
  const secretCursor = 'OPAQUE_SECRET_CURSOR_VALUE_DO_NOT_RETAIN_999';

  // 1. TimelineTerminateTimeline direction Bottom -> ended: true (even with bottom cursor present)
  const termBottomRes = engine.processTimelineResponse({
    operationName: 'UserTweetsAndReplies',
    payload: makeOwnTimelinePayload([
      {
        type: 'TimelineAddEntries',
        entries: [
          makeTweetEntry(
            'tweet-2122147641553848010',
            makeTweetNode({ tweetId: '2122147641553848010', createdAt: 'Mon Nov 16 03:00:00 +0000 2026' })
          ),
          {
            entryId: 'cursor-bottom-1',
            content: {
              entryType: 'TimelineTimelineCursor',
              cursorType: 'Bottom',
              value: secretCursor
            }
          }
        ]
      },
      { type: 'TimelineTerminateTimeline', direction: 'Bottom' }
    ]),
    bindingContext: SAMPLE_BINDING,
    observedAt: NOW_MS
  });
  assert.deepEqual(termBottomRes.historyPage, {
    newestAt: Date.parse('Mon Nov 16 03:00:00 +0000 2026'),
    ended: true,
    pageKey: '2122147641553848010'
  });
  assert.equal(JSON.stringify(termBottomRes).includes(secretCursor), false);

  // 2. Clearly recognized terminal empty add entries with no next cursor -> ended: true
  const emptyTerminalRes = engine.processTimelineResponse({
    operationName: 'UserTweetsAndReplies',
    payload: makeOwnTimelinePayload([{ type: 'TimelineAddEntries', entries: [] }]),
    bindingContext: SAMPLE_BINDING,
    observedAt: NOW_MS
  });
  assert.deepEqual(emptyTerminalRes.historyPage, {
    newestAt: null,
    ended: true,
    pageKey: null
  });

  // 3. TimelineTerminateTimeline Top with empty entries -> ended: false
  const termTopRes = engine.processTimelineResponse({
    operationName: 'UserTweetsAndReplies',
    payload: makeOwnTimelinePayload([
      { type: 'TimelineAddEntries', entries: [] },
      { type: 'TimelineTerminateTimeline', direction: 'Top' }
    ]),
    bindingContext: SAMPLE_BINDING,
    observedAt: NOW_MS
  });
  assert.equal(termTopRes.historyPage.ended, false);

  // 4. Only Top cursor or only Bottom cursor -> ended: false, and cursor value never leaked into pageKey
  const topCursorOnlyRes = engine.processTimelineResponse({
    operationName: 'UserTweetsAndReplies',
    payload: makeOwnTimelinePayload([
      {
        type: 'TimelineAddEntries',
        entries: [
          {
            entryId: 'cursor-top-1',
            content: { entryType: 'TimelineTimelineCursor', cursorType: 'Top', value: secretCursor }
          }
        ]
      }
    ]),
    bindingContext: SAMPLE_BINDING,
    observedAt: NOW_MS
  });
  assert.deepEqual(topCursorOnlyRes.historyPage, { newestAt: null, ended: false, pageKey: null });

  const bottomCursorOnlyRes = engine.processTimelineResponse({
    operationName: 'UserTweetsAndReplies',
    payload: makeOwnTimelinePayload([
      {
        type: 'TimelineAddEntries',
        entries: [
          {
            entryId: 'cursor-bottom-2',
            content: { entryType: 'TimelineTimelineCursor', cursorType: 'Bottom', value: secretCursor }
          }
        ]
      }
    ]),
    bindingContext: SAMPLE_BINDING,
    observedAt: NOW_MS
  });
  assert.deepEqual(bottomCursorOnlyRes.historyPage, { newestAt: null, ended: false, pageKey: null });
  assert.equal(JSON.stringify(bottomCursorOnlyRes).includes(secretCursor), false);

  // 5. Same-second decimal tie-breaking (>53-bit Snowflake precision) & distinct pageKeys across pages
  const page1Res = engine.processTimelineResponse({
    operationName: 'UserTweetsAndReplies',
    payload: makeOwnTimelinePayload([
      {
        type: 'TimelineAddEntries',
        entries: [
          makeTweetEntry(
            'tweet-2122147641553848008',
            makeTweetNode({ tweetId: '2122147641553848008', createdAt: 'Mon Nov 16 04:00:00 +0000 2026' })
          ),
          makeTweetEntry(
            'tweet-2122147641553848009',
            makeTweetNode({ tweetId: '2122147641553848009', createdAt: 'Mon Nov 16 04:00:00 +0000 2026' })
          ),
          {
            entryId: 'cursor-bottom-p1',
            content: { entryType: 'TimelineTimelineCursor', cursorType: 'Bottom', value: secretCursor }
          }
        ]
      }
    ]),
    bindingContext: SAMPLE_BINDING,
    observedAt: NOW_MS
  });
  const page2Res = engine.processTimelineResponse({
    operationName: 'UserTweetsAndReplies',
    payload: makeOwnTimelinePayload([
      {
        type: 'TimelineAddEntries',
        entries: [
          makeTweetEntry(
            'tweet-2122147641553847999',
            makeTweetNode({ tweetId: '2122147641553847999', createdAt: 'Mon Nov 16 03:59:00 +0000 2026' })
          ),
          {
            entryId: 'cursor-bottom-p2',
            content: { entryType: 'TimelineTimelineCursor', cursorType: 'Bottom', value: secretCursor }
          }
        ]
      }
    ]),
    bindingContext: SAMPLE_BINDING,
    observedAt: NOW_MS
  });
  assert.equal(page1Res.historyPage.pageKey, '2122147641553848009');
  assert.equal(page2Res.historyPage.pageKey, '2122147641553847999');
  assert.notEqual(page1Res.historyPage.pageKey, page2Res.historyPage.pageKey);
  assert.equal(page1Res.historyPage.ended, false);
  assert.equal(page2Res.historyPage.ended, false);
  assert.equal(JSON.stringify(page1Res).includes(secretCursor), false);
});

test('A reply timeline may identify its owner in the request only; contradictory owners never produce a page', () => {
  const engine = createAdapterEngine();
  const payload = structuredClone(timelineFixtures.ownRepliesTimelineMixed.response);
  const result = payload.data.user.result;
  delete result.rest_id;
  delete result.legacy;
  const match = matchWhitelistedRequest(timelineFixtures.ownRepliesTimelineMixed.requestUrl, 'GET');
  const observe = () => engine.processTimelineResponse({ ...match, payload, bindingContext: SAMPLE_BINDING, observedAt: NOW_MS });
  assert.equal(match.requestedUserId, SAMPLE_BINDING.actorUserId);
  assert.equal(observe().events.length, 2);
  assert.ok(observe().historyPage);
  result.rest_id = '2002002';
  assert.equal(observe().events.length, 0);
  assert.equal(observe().historyPage, undefined);
});

test('Only the dedicated latest search parses own replies; recognized empty results and missing results are distinct', () => {
  const engine = createAdapterEngine();
  const q = 'from:alice filter:replies since:2026-11-16 until:2026-11-17';
  const head = 'https://api.x.com/graphql/Fix/SearchTimeline?variables=';
  const url = (vars) => head + encodeURIComponent(JSON.stringify(vars));
  const match = matchWhitelistedRequest(url({ rawQuery: q, product: 'Latest' }), 'GET');
  assert.equal(match.searchQuery, q);
  assert.equal(matchWhitelistedRequest(url({ rawQuery: q, product: 'Latest', cursor: 'next-page-cursor' }), 'GET').searchQuery, q);
  assert.equal(matchWhitelistedRequest(url({ rawQuery: q, product: 'Top' }), 'GET'), null);
  assert.equal(matchWhitelistedRequest(url({ rawQuery: q, product: 'Latest', cursor: 123 }), 'GET'), null);
  assert.equal(matchWhitelistedRequest(url({ rawQuery: q, product: 'Latest', cursor: '' }), 'GET'), null);
  const timeline = structuredClone(timelineFixtures.ownRepliesTimelineMixed.response.data.user.result.timeline_v2.timeline);
  const payload = { data: { search_by_raw_query: { search_timeline: { timeline } } } };
  const opts = { operationName: 'SearchTimeline', payload, bindingContext: SAMPLE_BINDING };
  assert.equal(engine.processTimelineResponse(opts).events.length, 0);
  const result = engine.processTimelineResponse({ ...opts, manualSearch: true });
  assert.equal(result.events.length, 2);
  assert.ok(result.events.every(event => event.actorUserId === SAMPLE_BINDING.actorUserId));
  timeline.instructions = [{ type: 'TimelineAddEntries', entries: [] }];
  assert.ok(engine.processTimelineResponse({ ...opts, manualSearch: true }).historyPage);
  delete timeline.instructions;
  assert.equal(engine.processTimelineResponse({ ...opts, manualSearch: true }).historyPage, undefined);
  assert.equal(engine.processTimelineResponse({ ...opts, manualSearch: true }).partialUnrecognized, true);
});

test('Adapter tolerates empty tweet_results, extracts search/replace cursors, and backfills mention target info', () => {
  const engine = createAdapterEngine();
  const payload = {
    data: {
      search_by_raw_query: {
        search_timeline: {
          timeline: {
            instructions: [
              {
                type: 'TimelineAddEntries',
                entries: [
                  {
                    entryId: 'tweet-2122147641553848100',
                    content: {
                      entryType: 'TimelineTimelineItem',
                      itemContent: {
                        itemType: 'TimelineTweet',
                        tweet_results: {
                          result: {
                            __typename: 'Tweet',
                            rest_id: '2122147641553848100',
                            core: {
                              user_results: {
                                result: {
                                  __typename: 'User',
                                  rest_id: '1001001',
                                  core: { screen_name: 'sample_me', name: 'Me' }
                                }
                              }
                            },
                            legacy: {
                              user_id_str: '1001001',
                              created_at: 'Mon Nov 16 05:00:00 +0000 2026',
                              in_reply_to_status_id_str: '2121785253688248000',
                              in_reply_to_screen_name: 'mention_friend',
                              entities: {
                                user_mentions: [
                                  { id_str: '2002099', screen_name: 'mention_friend', name: 'Mention Friend' }
                                ]
                              }
                            }
                          }
                        }
                      }
                    }
                  },
                  {
                    entryId: 'tweet-deleted-parent',
                    content: {
                      entryType: 'TimelineTimelineItem',
                      itemContent: {
                        itemType: 'TimelineTweet',
                        tweet_results: {}
                      }
                    }
                  },
                  {
                    entryId: 'cursor-bottom-1',
                    content: {
                      entryType: 'TimelineTimelineCursor',
                      cursorType: 'Bottom',
                      value: 'search-cursor-1'
                    }
                  }
                ]
              },
              {
                type: 'TimelineReplaceEntry',
                entry: {
                  entryId: 'cursor-bottom-1',
                  content: {
                    entryType: 'TimelineTimelineCursor',
                    cursorType: 'Bottom',
                    value: 'search-cursor-2'
                  }
                }
              }
            ]
          }
        }
      }
    }
  };
  const res = engine.processTimelineResponse({
    operationName: 'SearchTimeline',
    manualSearch: true,
    payload,
    bindingContext: SAMPLE_BINDING,
    observedAt: NOW_MS
  });
  assert.equal(res.partialUnrecognized, false);
  assert.equal(res.events.length, 1);
  assert.equal(res.events[0].targetUserId, '2002099');
  assert.equal(res.events[0].targetDisplayName, 'Mention Friend');
  assert.equal(res.historyPage.newestAt, Date.parse('Mon Nov 16 05:00:00 +0000 2026'));
  assert.equal(engine.getRepliesCursor(payload), 'search-cursor-2');

  // Recursive bottomCursor & TimelinePinEntry without entry
  const deepRes = engine.processTimelineResponse({
    operationName: 'UserTweetsAndReplies',
    payload: {
      data: {
        user: {
          result: {
            __typename: 'User',
            rest_id: '1001001',
            custom_timeline_holder: {
              instructions: [
                { type: 'TimelinePinEntry' },
                {
                  type: 'TimelineAddEntries',
                  entries: [
                    timelineFixtures.ownRepliesTimelineMixed.response.data.user.result.timeline_v2.timeline.instructions[0].entries[1]
                  ]
                }
              ],
              extraCursor: { cursorType: 'Bottom', value: 'deep-cursor-99' }
            }
          }
        }
      }
    },
    bindingContext: SAMPLE_BINDING,
    observedAt: NOW_MS
  });
  assert.ok(deepRes.historyPage);
  assert.equal(engine.getRepliesCursor({
    data: {
      user: {
        result: {
          custom: { nested: [{ cursorType: 'Bottom', value: 'deep-cursor-99' }] }
        }
      }
    }
  }), 'deep-cursor-99');
});
