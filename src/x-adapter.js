(function (root) {
  'use strict';

  const DECIMAL_ID_RE = /^[1-9][0-9]{0,31}$/;
  const SAFE_HANDLE_RE = /^[A-Za-z0-9_]{1,64}$/;
  const SAFE_QUERY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  const ALLOWED_ORIGINS = new Set(['https://x.com', 'https://twitter.com']);
  const MAX_DISPLAY_NAME_LEN = 256;
  const DEFAULT_MAX_MAP_SIZE = 5000;
  const DEFAULT_MAX_PENDING_REPLIES = 1000;
  const DEFAULT_PENDING_TTL_MS = 10 * 60 * 1000;

  const WHITELISTED_OPERATIONS = Object.freeze({
    CreateTweet: { category: 'create_tweet', methods: new Set(['POST']) },
    Viewer: { category: 'viewer', methods: new Set(['GET', 'POST']) },
    UserTweetsAndReplies: { category: 'replies_timeline', methods: new Set(['GET']) },
    TweetDetail: { category: 'author_mapping', methods: new Set(['GET']) },
    HomeTimeline: { category: 'author_mapping', methods: new Set(['GET', 'POST']) },
    HomeLatestTimeline: { category: 'author_mapping', methods: new Set(['GET', 'POST']) },
    UserTweets: { category: 'author_mapping', methods: new Set(['GET']) },
    UserByScreenName: { category: 'author_mapping', methods: new Set(['GET']) }
  });

  function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }

  function hasDangerousOwnKeys(value, depth) {
    const currentDepth = typeof depth === 'number' ? depth : 0;
    if (currentDepth > 32) {
      return true;
    }
    if (value === null || typeof value !== 'object') {
      return false;
    }
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        if (hasDangerousOwnKeys(value[i], currentDepth + 1)) {
          return true;
        }
      }
      return false;
    }
    const ownKeys = Object.getOwnPropertyNames(value);
    for (let i = 0; i < ownKeys.length; i += 1) {
      const k = ownKeys[i];
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') {
        return true;
      }
      if (hasDangerousOwnKeys(value[k], currentDepth + 1)) {
        return true;
      }
    }
    return false;
  }

  function isValidDecimalId(value) {
    return typeof value === 'string' && DECIMAL_ID_RE.test(value);
  }

  function sanitizeHandle(value) {
    if (typeof value !== 'string') {
      return null;
    }
    const trimmed = value.startsWith('@') ? value.slice(1).trim() : value.trim();
    if (!SAFE_HANDLE_RE.test(trimmed)) {
      return null;
    }
    return trimmed;
  }

  function sanitizeDisplayName(value) {
    if (typeof value !== 'string') {
      return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    return trimmed.length > MAX_DISPLAY_NAME_LEN
      ? trimmed.slice(0, MAX_DISPLAY_NAME_LEN)
      : trimmed;
  }

  function parseServerTimestamp(createdAtRaw) {
    if (typeof createdAtRaw !== 'string' || !createdAtRaw.trim()) {
      return null;
    }
    const ms = Date.parse(createdAtRaw);
    if (!Number.isFinite(ms) || ms <= 0) {
      return null;
    }
    return Math.trunc(ms);
  }

  function matchWhitelistedRequest(urlString, method) {
    if (typeof urlString !== 'string' || typeof method !== 'string') {
      return null;
    }
    let parsed;
    try {
      parsed = new URL(urlString, 'https://x.com');
    } catch (_err) {
      return null;
    }
    if (!ALLOWED_ORIGINS.has(parsed.origin)) {
      return null;
    }
    const normalizedMethod = method.toUpperCase();
    const parts = parsed.pathname.split('/').filter(Boolean);
    // Expected: ['i', 'api', 'graphql', '<queryId>', '<operationName>']
    if (
      parts.length === 5 &&
      parts[0] === 'i' &&
      parts[1] === 'api' &&
      parts[2] === 'graphql'
    ) {
      const queryId = parts[3];
      const operationName = parts[4];
      if (!SAFE_QUERY_ID_RE.test(queryId)) {
        return null;
      }
      if (!Object.prototype.hasOwnProperty.call(WHITELISTED_OPERATIONS, operationName)) {
        return null;
      }
      const spec = WHITELISTED_OPERATIONS[operationName];
      if (!spec.methods.has(normalizedMethod)) {
        return null;
      }
      return {
        operationName,
        category: spec.category,
        method: normalizedMethod
      };
    }
    return null;
  }

  function extractUserFieldsFromGraphqlNode(userNode) {
    if (!isPlainObject(userNode)) {
      return null;
    }
    const unwrapped =
      userNode.__typename === 'UserUnavailable'
        ? null
        : isPlainObject(userNode.result)
          ? userNode.result
          : userNode;
    if (!isPlainObject(unwrapped)) {
      return null;
    }
    const userId = isValidDecimalId(unwrapped.rest_id)
      ? unwrapped.rest_id
      : isPlainObject(unwrapped.legacy) && isValidDecimalId(unwrapped.legacy.id_str)
        ? unwrapped.legacy.id_str
        : null;
    if (!userId) {
      return null;
    }
    const core = isPlainObject(unwrapped.core) ? unwrapped.core : null;
    const legacy = isPlainObject(unwrapped.legacy) ? unwrapped.legacy : null;
    const handle =
      sanitizeHandle(core && core.screen_name) ||
      sanitizeHandle(legacy && legacy.screen_name) ||
      null;
    const displayName =
      sanitizeDisplayName(core && core.name) ||
      sanitizeDisplayName(legacy && legacy.name) ||
      null;
    return {
      userId,
      handle,
      displayName
    };
  }

  function extractViewerFromInitialState(stateObj) {
    if (!isPlainObject(stateObj) || hasDangerousOwnKeys(stateObj, 0)) {
      return null;
    }
    const session = isPlainObject(stateObj.session) ? stateObj.session : null;
    if (!session) {
      return null;
    }
    const rawUserId = isValidDecimalId(session.user_id)
      ? session.user_id
      : isPlainObject(session.user) && isValidDecimalId(session.user.id_str)
        ? session.user.id_str
        : null;
    if (!rawUserId) {
      return null;
    }
    let handle = null;
    let displayName = null;
    const entities =
      isPlainObject(stateObj.entities) &&
      isPlainObject(stateObj.entities.users) &&
      isPlainObject(stateObj.entities.users.entities)
        ? stateObj.entities.users.entities
        : null;
    if (entities && Object.prototype.hasOwnProperty.call(entities, rawUserId)) {
      const u = entities[rawUserId];
      if (isPlainObject(u)) {
        handle = sanitizeHandle(u.screen_name);
        displayName = sanitizeDisplayName(u.name);
      }
    }
    if (!handle && isPlainObject(session.user)) {
      handle = sanitizeHandle(session.user.screen_name);
      displayName = displayName || sanitizeDisplayName(session.user.name);
    }
    return {
      actorUserId: rawUserId,
      handle,
      displayName
    };
  }

  function extractViewerFromGraphql(payload) {
    if (!isPlainObject(payload) || hasDangerousOwnKeys(payload, 0)) {
      return null;
    }
    const data = isPlainObject(payload.data) ? payload.data : null;
    if (!data || !isPlainObject(data.viewer)) {
      return null;
    }
    const viewer = data.viewer;
    const userResult = isPlainObject(viewer.user_results)
      ? viewer.user_results.result
      : viewer.user_result && isPlainObject(viewer.user_result)
        ? viewer.user_result.result
        : null;
    const extracted = extractUserFieldsFromGraphqlNode(userResult);
    if (!extracted) {
      return null;
    }
    return {
      actorUserId: extracted.userId,
      handle: extracted.handle,
      displayName: extracted.displayName
    };
  }

  function parseCreateTweetRequest(rawBody) {
    if (typeof rawBody !== 'string' || !rawBody.trim()) {
      return { expectedParentTweetId: null, isReplyCandidate: false };
    }
    let parsed;
    try {
      parsed = JSON.parse(rawBody);
    } catch (_err) {
      return { expectedParentTweetId: null, isReplyCandidate: false };
    }
    if (!isPlainObject(parsed) || hasDangerousOwnKeys(parsed, 0)) {
      return { expectedParentTweetId: null, isReplyCandidate: false };
    }
    const variables = isPlainObject(parsed.variables) ? parsed.variables : null;
    const reply = variables && isPlainObject(variables.reply) ? variables.reply : null;
    const parentId = reply && isValidDecimalId(reply.in_reply_to_tweet_id)
      ? reply.in_reply_to_tweet_id
      : null;
    return {
      expectedParentTweetId: parentId,
      isReplyCandidate: Boolean(parentId)
    };
  }

  function unwrapTweetNode(rawNode) {
    if (!isPlainObject(rawNode)) {
      return null;
    }
    let node = isPlainObject(rawNode.result) ? rawNode.result : rawNode;
    if (!isPlainObject(node)) {
      return null;
    }
    if (node.__typename === 'TweetWithVisibilityResults' && isPlainObject(node.tweet)) {
      node = node.tweet;
    }
    if (
      node.__typename === 'TweetTombstone' ||
      node.__typename === 'TweetUnavailable'
    ) {
      return null;
    }
    if (!isValidDecimalId(node.rest_id) && !(isPlainObject(node.legacy) && isValidDecimalId(node.legacy.id_str))) {
      return null;
    }
    return node;
  }

  function hasAmbiguousEditHistory(tweetNode, replyTweetId) {
    if (!isPlainObject(tweetNode.edit_control)) {
      return false;
    }
    const ec = tweetNode.edit_control;
    const editIds = Array.isArray(ec.edit_tweet_ids)
      ? ec.edit_tweet_ids
      : isPlainObject(ec.edit_control_initial) && Array.isArray(ec.edit_control_initial.edit_tweet_ids)
        ? ec.edit_control_initial.edit_tweet_ids
        : null;
    if (!editIds || editIds.length <= 1) {
      return false;
    }
    const uniqueIds = new Set(editIds.filter(isValidDecimalId));
    if (uniqueIds.size > 1) {
      return true;
    }
    if (uniqueIds.size === 1 && !uniqueIds.has(replyTweetId)) {
      return true;
    }
    return false;
  }

  function extractTweetCoreFields(rawNode) {
    const node = unwrapTweetNode(rawNode);
    if (!node) {
      return null;
    }
    const legacy = isPlainObject(node.legacy) ? node.legacy : null;
    const tweetId = isValidDecimalId(node.rest_id)
      ? node.rest_id
      : legacy && isValidDecimalId(legacy.id_str)
        ? legacy.id_str
        : null;
    if (!tweetId) {
      return null;
    }
    const coreUser =
      isPlainObject(node.core) && isPlainObject(node.core.user_results)
        ? extractUserFieldsFromGraphqlNode(node.core.user_results)
        : null;
    const authorUserId = coreUser
      ? coreUser.userId
      : legacy && isValidDecimalId(legacy.user_id_str)
        ? legacy.user_id_str
        : null;
    const authorHandle = coreUser ? coreUser.handle : null;
    const authorDisplayName = coreUser ? coreUser.displayName : null;
    const createdAt = legacy ? parseServerTimestamp(legacy.created_at) : null;
    const parentTweetId =
      legacy && isValidDecimalId(legacy.in_reply_to_status_id_str)
        ? legacy.in_reply_to_status_id_str
        : null;
    const directTargetUserId =
      legacy && isValidDecimalId(legacy.in_reply_to_user_id_str)
        ? legacy.in_reply_to_user_id_str
        : null;
    const directTargetHandle =
      legacy ? sanitizeHandle(legacy.in_reply_to_screen_name) : null;
    const isRetweet = Boolean(
      legacy && isPlainObject(legacy.retweeted_status_result)
    );
    const retweetNode = isRetweet ? legacy.retweeted_status_result : null;
    const quotedNode = isPlainObject(node.quoted_status_result)
      ? node.quoted_status_result
      : null;

    return {
      node,
      tweetId,
      authorUserId,
      authorHandle,
      authorDisplayName,
      createdAt,
      parentTweetId,
      directTargetUserId,
      directTargetHandle,
      isRetweet,
      retweetNode,
      quotedNode,
      ambiguousEdit: hasAmbiguousEditHistory(node, tweetId)
    };
  }

  function setBoundedMap(map, key, value, maxSize) {
    if (map.has(key)) {
      map.delete(key);
    }
    map.set(key, value);
    while (map.size > maxSize) {
      const oldestKey = map.keys().next().value;
      map.delete(oldestKey);
    }
  }

  function isValidBindingContext(ctx) {
    return (
      isPlainObject(ctx) &&
      typeof ctx.bindingId === 'string' &&
      ctx.bindingId.length > 0 &&
      isValidDecimalId(ctx.actorUserId) &&
      Number.isInteger(ctx.captureSessionId) &&
      ctx.captureSessionId > 0 &&
      Number.isInteger(ctx.collectionGeneration) &&
      ctx.collectionGeneration >= 0 &&
      Number.isInteger(ctx.accountGeneration) &&
      ctx.accountGeneration > 0
    );
  }

  function createAdapterEngine(options) {
    const opts = isPlainObject(options) ? options : {};
    const maxMapSize =
      Number.isInteger(opts.maxMapSize) && opts.maxMapSize > 0
        ? opts.maxMapSize
        : DEFAULT_MAX_MAP_SIZE;
    const maxPendingReplies =
      Number.isInteger(opts.maxPendingReplies) && opts.maxPendingReplies > 0
        ? opts.maxPendingReplies
        : DEFAULT_MAX_PENDING_REPLIES;
    const pendingTtlMs =
      Number.isInteger(opts.pendingTtlMs) && opts.pendingTtlMs > 0
        ? opts.pendingTtlMs
        : DEFAULT_PENDING_TTL_MS;

    const tweetAuthorMap = new Map(); // tweetId -> { authorUserId, handle, displayName }
    const userByIdMap = new Map(); // userId -> { userId, handle, lowerHandle, displayName }
    const handleToIdMap = new Map(); // lowerHandle -> userId
    const pendingReplies = new Map(); // dedupKey -> PendingReply

    function recordUserProfile(profile, observedUsersOut) {
      if (!profile || !isValidDecimalId(profile.userId)) {
        return;
      }
      const existing = userByIdMap.get(profile.userId) || null;
      const nextHandle = profile.handle || (existing ? existing.handle : null);
      const nextLower = nextHandle ? nextHandle.toLowerCase() : null;
      const nextDisplayName =
        profile.displayName !== null && profile.displayName !== undefined
          ? profile.displayName
          : existing
            ? existing.displayName
            : null;

      // Evict old reverse handle mapping when user renames
      if (existing && existing.lowerHandle && existing.lowerHandle !== nextLower) {
        if (handleToIdMap.get(existing.lowerHandle) === profile.userId) {
          handleToIdMap.delete(existing.lowerHandle);
        }
      }

      // If another user previously held nextLower, detach their stale handle reference
      if (nextLower) {
        const previousHolderId = handleToIdMap.get(nextLower);
        if (previousHolderId && previousHolderId !== profile.userId) {
          const previousHolder = userByIdMap.get(previousHolderId);
          if (previousHolder) {
            previousHolder.handle = null;
            previousHolder.lowerHandle = null;
          }
        }
        setBoundedMap(handleToIdMap, nextLower, profile.userId, maxMapSize);
      }

      const updated = {
        userId: profile.userId,
        handle: nextHandle,
        lowerHandle: nextLower,
        displayName: nextDisplayName
      };
      setBoundedMap(userByIdMap, profile.userId, updated, maxMapSize);

      if (Array.isArray(observedUsersOut)) {
        observedUsersOut.push({
          userId: updated.userId,
          handle: updated.handle,
          displayName: updated.displayName
        });
      }
    }

    function recordTweetAuthor(parsedTweet, observedUsersOut, observedTweetsOut) {
      if (!parsedTweet || !parsedTweet.tweetId || !parsedTweet.authorUserId) {
        return;
      }
      if (parsedTweet.authorHandle || parsedTweet.authorDisplayName) {
        recordUserProfile(
          {
            userId: parsedTweet.authorUserId,
            handle: parsedTweet.authorHandle,
            displayName: parsedTweet.authorDisplayName
          },
          observedUsersOut
        );
      }
      const userRecord = userByIdMap.get(parsedTweet.authorUserId);
      const entry = {
        authorUserId: parsedTweet.authorUserId,
        handle: parsedTweet.authorHandle || (userRecord ? userRecord.handle : null),
        displayName:
          parsedTweet.authorDisplayName || (userRecord ? userRecord.displayName : null)
      };
      setBoundedMap(tweetAuthorMap, parsedTweet.tweetId, entry, maxMapSize);
      if (Array.isArray(observedTweetsOut)) {
        observedTweetsOut.push({
          tweetId: parsedTweet.tweetId,
          authorUserId: entry.authorUserId,
          handle: entry.handle
        });
      }
    }

    function prunePendingReplies(nowMs) {
      const now = Number.isFinite(nowMs) ? Math.trunc(nowMs) : Date.now();
      let evictedCount = 0;
      for (const [key, item] of pendingReplies.entries()) {
        if (now - item.queuedAt > pendingTtlMs) {
          pendingReplies.delete(key);
          evictedCount += 1;
        }
      }
      return {
        evictedCount,
        incompleteObservation: evictedCount > 0
      };
    }

    function resolvePendingReplies(activeBindingId, nowMs) {
      const pruneResult = prunePendingReplies(nowMs);
      const resolved = [];
      for (const [key, item] of pendingReplies.entries()) {
        if (activeBindingId && item.bindingContext.bindingId !== activeBindingId) {
          continue;
        }
        const parentAuthor = tweetAuthorMap.get(item.parentTweetId);
        if (!parentAuthor || !isValidDecimalId(parentAuthor.authorUserId)) {
          continue;
        }
        pendingReplies.delete(key);
        if (parentAuthor.authorUserId === item.actorUserId) {
          // Turned out to be a self-reply; silently drop without counting
          continue;
        }
        const targetProfile = userByIdMap.get(parentAuthor.authorUserId);
        resolved.push({
          actorUserId: item.actorUserId,
          replyTweetId: item.replyTweetId,
          parentTweetId: item.parentTweetId,
          targetUserId: parentAuthor.authorUserId,
          targetHandle:
            parentAuthor.handle || (targetProfile ? targetProfile.handle : null),
          targetDisplayName:
            parentAuthor.displayName ||
            (targetProfile ? targetProfile.displayName : null),
          createdAt: item.createdAt,
          observedAt: item.observedAt,
          source: item.source,
          bindingContext: item.bindingContext
        });
      }
      return {
        resolved,
        incompleteObservation: pruneResult.incompleteObservation
      };
    }

    function enqueuePendingReply(candidate, nowMs) {
      const pruneResult = prunePendingReplies(nowMs);
      let overflowed = false;
      const key = `${candidate.actorUserId}:${candidate.replyTweetId}`;
      if (pendingReplies.has(key)) {
        pendingReplies.delete(key);
      }
      while (pendingReplies.size >= maxPendingReplies) {
        const oldestKey = pendingReplies.keys().next().value;
        pendingReplies.delete(oldestKey);
        overflowed = true;
      }
      pendingReplies.set(key, {
        ...candidate,
        queuedAt: nowMs
      });
      return {
        incompleteObservation: pruneResult.incompleteObservation || overflowed
      };
    }

    function processCreateTweetResponse(params) {
      const empty = {
        events: [],
        observedUsers: [],
        observedTweets: [],
        queuedCount: 0,
        anomalies: [],
        incompleteObservation: false
      };
      if (!isPlainObject(params) || !isValidBindingContext(params.bindingContext)) {
        return empty;
      }
      const { payload, requestMeta, bindingContext } = params;
      const observedAt =
        Number.isInteger(params.observedAt) && params.observedAt > 0
          ? params.observedAt
          : Date.now();

      if (!isPlainObject(payload) || hasDangerousOwnKeys(payload, 0)) {
        return empty;
      }
      const createTweetNode =
        isPlainObject(payload.data) &&
        isPlainObject(payload.data.create_tweet) &&
        isPlainObject(payload.data.create_tweet.tweet_results)
          ? payload.data.create_tweet.tweet_results
          : null;
      if (!createTweetNode) {
        return empty;
      }

      const parsed = extractTweetCoreFields(createTweetNode);
      if (!parsed) {
        return empty;
      }

      const observedUsers = [];
      const observedTweets = [];
      recordTweetAuthor(parsed, observedUsers, observedTweets);
      if (parsed.quotedNode) {
        recordTweetAuthor(extractTweetCoreFields(parsed.quotedNode), observedUsers, observedTweets);
      }

      if (parsed.ambiguousEdit) {
        return {
          ...empty,
          observedUsers,
          observedTweets,
          anomalies: ['multi_version_edit']
        };
      }

      // Plain post (not a reply)
      const expectedParentId =
        isPlainObject(requestMeta) && isValidDecimalId(requestMeta.expectedParentTweetId)
          ? requestMeta.expectedParentTweetId
          : null;

      if (!parsed.parentTweetId) {
        return {
          ...empty,
          observedUsers,
          observedTweets
        };
      }

      // Verify reply relation matches initiating request if request carried parent ID
      if (expectedParentId && parsed.parentTweetId !== expectedParentId) {
        return {
          ...empty,
          observedUsers,
          observedTweets,
          anomalies: ['parent_mismatch']
        };
      }

      // Verify author matches frozen viewer binding
      if (!parsed.authorUserId || parsed.authorUserId !== bindingContext.actorUserId) {
        return {
          ...empty,
          observedUsers,
          observedTweets,
          anomalies: ['actor_mismatch']
        };
      }

      if (!parsed.createdAt) {
        return {
          ...empty,
          observedUsers,
          observedTweets,
          anomalies: ['missing_created_at'],
          incompleteObservation: true
        };
      }

      // Resolve direct target user ID: direct field first, then exact parent tweet map
      let targetUserId = parsed.directTargetUserId;
      let targetHandle = parsed.directTargetHandle;
      let targetDisplayName = null;

      if (targetUserId) {
        const knownTarget = userByIdMap.get(targetUserId);
        if (knownTarget) {
          targetHandle = targetHandle || knownTarget.handle;
          targetDisplayName = knownTarget.displayName;
        } else if (targetHandle) {
          recordUserProfile(
            { userId: targetUserId, handle: targetHandle, displayName: null },
            observedUsers
          );
        }
      } else {
        const mappedParent = tweetAuthorMap.get(parsed.parentTweetId);
        if (mappedParent && isValidDecimalId(mappedParent.authorUserId)) {
          targetUserId = mappedParent.authorUserId;
          targetHandle = mappedParent.handle;
          targetDisplayName = mappedParent.displayName;
        }
      }

      if (!targetUserId) {
        const queueRes = enqueuePendingReply(
          {
            actorUserId: parsed.authorUserId,
            replyTweetId: parsed.tweetId,
            parentTweetId: parsed.parentTweetId,
            createdAt: parsed.createdAt,
            observedAt,
            source: 'live',
            bindingContext
          },
          observedAt
        );
        return {
          events: [],
          observedUsers,
          observedTweets,
          queuedCount: 1,
          anomalies: [],
          incompleteObservation: queueRes.incompleteObservation
        };
      }

      // Self-replies are never counted
      if (targetUserId === bindingContext.actorUserId) {
        return {
          ...empty,
          observedUsers,
          observedTweets
        };
      }

      return {
        events: [
          {
            actorUserId: parsed.authorUserId,
            replyTweetId: parsed.tweetId,
            parentTweetId: parsed.parentTweetId,
            targetUserId,
            targetHandle: targetHandle || null,
            targetDisplayName: targetDisplayName || null,
            createdAt: parsed.createdAt,
            observedAt,
            source: 'live',
            bindingContext
          }
        ],
        observedUsers,
        observedTweets,
        queuedCount: 0,
        anomalies: [],
        incompleteObservation: false
      };
    }

    function collectTimelineTweetItems(instructions) {
      const primaryTweets = [];
      const auxiliaryTweets = [];
      if (!Array.isArray(instructions)) {
        return { primaryTweets, auxiliaryTweets };
      }

      function inspectItemContent(itemContent) {
        if (!isPlainObject(itemContent) || !isPlainObject(itemContent.tweet_results)) {
          return;
        }
        // Skip promoted tweets
        if (isPlainObject(itemContent.promotedMetadata)) {
          return;
        }
        const parsed = extractTweetCoreFields(itemContent.tweet_results);
        if (!parsed) {
          return;
        }
        primaryTweets.push(parsed);
        if (parsed.retweetNode) {
          const rtParsed = extractTweetCoreFields(parsed.retweetNode);
          if (rtParsed) {
            auxiliaryTweets.push(rtParsed);
          }
        }
        if (parsed.quotedNode) {
          const qtParsed = extractTweetCoreFields(parsed.quotedNode);
          if (qtParsed) {
            auxiliaryTweets.push(qtParsed);
          }
        }
      }

      function inspectEntry(entry) {
        if (!isPlainObject(entry) || !isPlainObject(entry.content)) {
          return;
        }
        const content = entry.content;
        if (isPlainObject(content.itemContent)) {
          inspectItemContent(content.itemContent);
        } else if (Array.isArray(content.items)) {
          for (let i = 0; i < content.items.length; i += 1) {
            const modItem = content.items[i];
            if (isPlainObject(modItem) && isPlainObject(modItem.item)) {
              inspectItemContent(modItem.item.itemContent);
            }
          }
        }
      }

      for (let i = 0; i < instructions.length; i += 1) {
        const inst = instructions[i];
        if (!isPlainObject(inst)) {
          continue;
        }
        if (Array.isArray(inst.entries)) {
          for (let j = 0; j < inst.entries.length; j += 1) {
            inspectEntry(inst.entries[j]);
          }
        }
        if (isPlainObject(inst.entry)) {
          inspectEntry(inst.entry);
        }
        if (Array.isArray(inst.moduleItems)) {
          for (let j = 0; j < inst.moduleItems.length; j += 1) {
            const modItem = inst.moduleItems[j];
            if (isPlainObject(modItem) && isPlainObject(modItem.item)) {
              inspectItemContent(modItem.item.itemContent);
            }
          }
        }
      }

      return { primaryTweets, auxiliaryTweets };
    }

    function extractInstructionsAndOwner(operationName, payload) {
      if (!isPlainObject(payload) || !isPlainObject(payload.data)) {
        return { instructions: null, timelineOwnerId: null, singleUser: null };
      }
      const data = payload.data;

      if (operationName === 'UserByScreenName') {
        const singleUser = isPlainObject(data.user)
          ? extractUserFieldsFromGraphqlNode(data.user)
          : null;
        return { instructions: null, timelineOwnerId: null, singleUser };
      }

      if (operationName === 'UserTweetsAndReplies' || operationName === 'UserTweets') {
        const userResult =
          isPlainObject(data.user) && isPlainObject(data.user.result)
            ? data.user.result
            : null;
        if (!userResult) {
          return { instructions: null, timelineOwnerId: null, singleUser: null };
        }
        const ownerUser = extractUserFieldsFromGraphqlNode(userResult);
        const timelineObj = isPlainObject(userResult.timeline_v2)
          ? userResult.timeline_v2.timeline
          : isPlainObject(userResult.timeline)
            ? userResult.timeline.timeline || userResult.timeline
            : null;
        const instructions =
          isPlainObject(timelineObj) && Array.isArray(timelineObj.instructions)
            ? timelineObj.instructions
            : null;
        return {
          instructions,
          timelineOwnerId: ownerUser ? ownerUser.userId : null,
          singleUser: ownerUser
        };
      }

      if (operationName === 'TweetDetail') {
        const tc = data.threaded_conversation_with_injections_v2;
        const instructions =
          isPlainObject(tc) && Array.isArray(tc.instructions) ? tc.instructions : null;
        return { instructions, timelineOwnerId: null, singleUser: null };
      }

      if (operationName === 'HomeTimeline' || operationName === 'HomeLatestTimeline') {
        const home =
          isPlainObject(data.home) && isPlainObject(data.home.home_timeline_urt)
            ? data.home.home_timeline_urt
            : null;
        const instructions =
          isPlainObject(home) && Array.isArray(home.instructions)
            ? home.instructions
            : null;
        return { instructions, timelineOwnerId: null, singleUser: null };
      }

      return { instructions: null, timelineOwnerId: null, singleUser: null };
    }

    function processTimelineResponse(params) {
      const empty = {
        events: [],
        resolvedPendingEvents: [],
        observedUsers: [],
        observedTweets: [],
        partialUnrecognized: false,
        anomalies: []
      };
      if (!isPlainObject(params)) {
        return empty;
      }
      const { operationName, payload, bindingContext } = params;
      const observedAt =
        Number.isInteger(params.observedAt) && params.observedAt > 0
          ? params.observedAt
          : Date.now();

      if (typeof operationName !== 'string' || !isPlainObject(payload) || hasDangerousOwnKeys(payload, 0)) {
        return empty;
      }

      const observedUsers = [];
      const observedTweets = [];
      const { instructions, timelineOwnerId, singleUser } = extractInstructionsAndOwner(
        operationName,
        payload
      );

      if (singleUser) {
        recordUserProfile(singleUser, observedUsers);
      }

      if (!instructions) {
        const pendingCheck = isValidBindingContext(bindingContext)
          ? resolvePendingReplies(bindingContext.bindingId, observedAt)
          : { resolved: [] };
        return {
          ...empty,
          resolvedPendingEvents: pendingCheck.resolved,
          observedUsers,
          observedTweets
        };
      }

      const { primaryTweets, auxiliaryTweets } = collectTimelineTweetItems(instructions);

      // Pass 1: Register all known tweet authors & user profiles in bounded memory
      for (let i = 0; i < auxiliaryTweets.length; i += 1) {
        recordTweetAuthor(auxiliaryTweets[i], observedUsers, observedTweets);
      }
      for (let i = 0; i < primaryTweets.length; i += 1) {
        recordTweetAuthor(primaryTweets[i], observedUsers, observedTweets);
      }

      // Resolve any pending live replies whose parent author just became known
      const pendingResolution = isValidBindingContext(bindingContext)
        ? resolvePendingReplies(bindingContext.bindingId, observedAt)
        : { resolved: [] };

      // Passive history backfill applies ONLY to bound viewer's own UserTweetsAndReplies
      if (
        operationName !== 'UserTweetsAndReplies' ||
        !isValidBindingContext(bindingContext)
      ) {
        return {
          events: [],
          resolvedPendingEvents: pendingResolution.resolved,
          observedUsers,
          observedTweets,
          partialUnrecognized: false,
          anomalies: []
        };
      }

      // Verify timeline ownership belongs to bound viewer
      if (!timelineOwnerId || timelineOwnerId !== bindingContext.actorUserId) {
        return {
          events: [],
          resolvedPendingEvents: pendingResolution.resolved,
          observedUsers,
          observedTweets,
          partialUnrecognized: false,
          anomalies: []
        };
      }

      const events = [];
      const seenReplyIds = new Set();
      const anomalies = [];
      let partialUnrecognized = false;

      // Pass 2: Extract eligible viewer replies from primary timeline items
      for (let i = 0; i < primaryTweets.length; i += 1) {
        const item = primaryTweets[i];
        if (item.isRetweet) {
          continue;
        }
        if (!item.authorUserId || item.authorUserId !== bindingContext.actorUserId) {
          // Conversation context tweet from another author
          continue;
        }
        if (!item.parentTweetId) {
          // Viewer's own non-reply post or standalone quote post
          continue;
        }
        if (seenReplyIds.has(item.tweetId)) {
          continue;
        }
        if (item.ambiguousEdit) {
          partialUnrecognized = true;
          anomalies.push('multi_version_edit');
          continue;
        }
        if (!item.createdAt) {
          partialUnrecognized = true;
          anomalies.push('missing_created_at');
          continue;
        }

        let targetUserId = item.directTargetUserId;
        let targetHandle = item.directTargetHandle;
        let targetDisplayName = null;

        if (targetUserId) {
          const knownTarget = userByIdMap.get(targetUserId);
          if (knownTarget) {
            targetHandle = targetHandle || knownTarget.handle;
            targetDisplayName = knownTarget.displayName;
          } else if (targetHandle) {
            recordUserProfile(
              { userId: targetUserId, handle: targetHandle, displayName: null },
              observedUsers
            );
          }
        } else {
          const mappedParent = tweetAuthorMap.get(item.parentTweetId);
          if (mappedParent && isValidDecimalId(mappedParent.authorUserId)) {
            targetUserId = mappedParent.authorUserId;
            targetHandle = mappedParent.handle;
            targetDisplayName = mappedParent.displayName;
          }
        }

        if (!targetUserId) {
          partialUnrecognized = true;
          anomalies.push('missing_target_user_id');
          continue;
        }

        if (targetUserId === bindingContext.actorUserId) {
          // Self-reply
          continue;
        }

        seenReplyIds.add(item.tweetId);
        events.push({
          actorUserId: bindingContext.actorUserId,
          replyTweetId: item.tweetId,
          parentTweetId: item.parentTweetId,
          targetUserId,
          targetHandle: targetHandle || null,
          targetDisplayName: targetDisplayName || null,
          createdAt: item.createdAt,
          observedAt,
          source: 'history',
          bindingContext
        });
      }

      return {
        events,
        resolvedPendingEvents: pendingResolution.resolved,
        observedUsers,
        observedTweets,
        partialUnrecognized,
        anomalies
      };
    }

    function resolveUserIdByHandle(handle) {
      const clean = sanitizeHandle(handle);
      if (!clean) {
        return null;
      }
      return handleToIdMap.get(clean.toLowerCase()) || null;
    }

    function resolveAuthorByTweetId(tweetId) {
      if (!isValidDecimalId(tweetId)) {
        return null;
      }
      return tweetAuthorMap.get(tweetId) || null;
    }

    function revokeBinding(bindingId) {
      if (!bindingId) {
        pendingReplies.clear();
        return;
      }
      for (const [key, item] of pendingReplies.entries()) {
        if (item.bindingContext.bindingId === bindingId) {
          pendingReplies.delete(key);
        }
      }
    }

    function clearAll() {
      pendingReplies.clear();
      tweetAuthorMap.clear();
      userByIdMap.clear();
      handleToIdMap.clear();
    }

    function getPendingCount() {
      return pendingReplies.size;
    }

    return Object.freeze({
      processCreateTweetResponse,
      processTimelineResponse,
      prunePendingReplies,
      resolveUserIdByHandle,
      resolveAuthorByTweetId,
      revokeBinding,
      clearAll,
      getPendingCount
    });
  }

  function extractViewerFromWindow(win) {
    if (!win || typeof win !== 'object') {
      return null;
    }
    try {
      if (isPlainObject(win.__INITIAL_STATE__)) {
        const direct = extractViewerFromInitialState(win.__INITIAL_STATE__);
        if (direct) {
          return direct;
        }
      }
      const doc = win.document;
      if (doc && typeof doc.querySelectorAll === 'function') {
        const scripts = doc.querySelectorAll('script:not([src])');
        const marker = 'window.__INITIAL_STATE__=';
        const altMarker = 'window.__INITIAL_STATE__ =';
        for (let i = 0; i < scripts.length; i += 1) {
          const text = scripts[i].textContent || '';
          let idx = text.indexOf(marker);
          let offset = marker.length;
          if (idx === -1) {
            idx = text.indexOf(altMarker);
            offset = altMarker.length;
          }
          if (idx !== -1) {
            const slice = text.slice(idx + offset).trim();
            const endIdx = slice.indexOf('};');
            const jsonCandidate = endIdx !== -1 ? slice.slice(0, endIdx + 1) : slice;
            try {
              const parsed = JSON.parse(jsonCandidate);
              const extracted = extractViewerFromInitialState(parsed);
              if (extracted) {
                return extracted;
              }
            } catch (_ignore) {
              // Ignore non-JSON inline script segments
            }
          }
        }
      }
    } catch (_err) {
      return null;
    }
    return null;
  }

  const exportedApi = Object.freeze({
    isPlainObject,
    hasDangerousOwnKeys,
    isValidDecimalId,
    sanitizeHandle,
    sanitizeDisplayName,
    parseServerTimestamp,
    isValidBindingContext,
    matchWhitelistedRequest,
    extractViewerFromInitialState,
    extractViewerFromGraphql,
    extractViewerFromWindow,
    parseCreateTweetRequest,
    createAdapterEngine
  });

  if (typeof module === 'object' && module !== null && module.exports) {
    module.exports = exportedApi;
  }

  if (root && typeof root === 'object') {
    try {
      Object.defineProperty(root, '__sparklinkConsumeAdapter', {
        value: function consumeOnce() {
          try {
            delete root.__sparklinkConsumeAdapter;
          } catch (_e) {
            // Ignore if non-configurable
          }
          return exportedApi;
        },
        configurable: true,
        enumerable: false,
        writable: false
      });
    } catch (_err) {
      // Ignore if root cannot be defined on
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
