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
    SearchTimeline: { category: 'manual_search', methods: new Set(['GET', 'POST']) },
    UserTweetsAndReplies: { category: 'replies_timeline', methods: new Set(['GET', 'POST']) },
    TweetDetail: { category: 'author_mapping', methods: new Set(['GET', 'POST']) },
    HomeTimeline: { category: 'author_mapping', methods: new Set(['GET', 'POST']) },
    HomeLatestTimeline: { category: 'author_mapping', methods: new Set(['GET', 'POST']) },
    UserTweets: { category: 'author_mapping', methods: new Set(['GET', 'POST']) },
    UserByScreenName: { category: 'author_mapping', methods: new Set(['GET', 'POST']) }
  });

  function isRepliesTimelineOperation(op) {
    return typeof op === 'string' && /^(?:User|Profile)[A-Za-z0-9_]*Replies[A-Za-z0-9_]*$/i.test(op);
  }

  function isUserProfileTimelineOperation(op) {
    return (
      typeof op === 'string' &&
      !/^UserByScreenName$/i.test(op) &&
      (isRepliesTimelineOperation(op) ||
        /^(?:User|Profile)[A-Za-z0-9_]*(?:Tweets|Posts|Timeline)[A-Za-z0-9_]*$/i.test(op))
    );
  }

  function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }

  function hasDangerousOwnKeys(value, depth) {
    const currentDepth = typeof depth === 'number' ? depth : 0;
    if (currentDepth > 128) {
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

  function compareDecimalIds(a, b) {
    if (a === b) {
      return 0;
    }
    if (a.length !== b.length) {
      return a.length < b.length ? -1 : 1;
    }
    return a < b ? -1 : 1;
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

  function matchWhitelistedRequest(urlString, method, requestBodyText) {
    if (typeof urlString !== 'string' || typeof method !== 'string') {
      return null;
    }
    let parsed;
    try {
      parsed = new URL(urlString, 'https://x.com');
    } catch (_err) {
      return null;
    }
    const validOrigin =
      ALLOWED_ORIGINS.has(parsed.origin) ||
      parsed.origin === 'https://api.x.com' ||
      parsed.origin === 'https://api.twitter.com';
    const validRoute = /^(?:\/i\/api)?\/graphql\//.test(parsed.pathname);
    if (!validOrigin || !validRoute) return null;
    const path = parsed.pathname.match(/^(?:\/i\/api)?\/graphql\/([^/]+)\/([^/]+)\/?$/);
    if (!path || !SAFE_QUERY_ID_RE.test(path[1])) return null;
    const operationName = path[2];
    const normalizedMethod = method.toUpperCase();
    const spec =
      (Object.hasOwn(WHITELISTED_OPERATIONS, operationName) && WHITELISTED_OPERATIONS[operationName]) ||
      (isRepliesTimelineOperation(operationName)
        ? { category: 'replies_timeline', methods: new Set(['GET', 'POST']) }
        : isUserProfileTimelineOperation(operationName)
          ? { category: 'author_mapping', methods: new Set(['GET', 'POST']) }
          : null);
    if (!spec || !spec.methods.has(normalizedMethod)) return null;
    const match = { operationName, category: spec.category, method: normalizedMethod };
    if (
      match.category === 'replies_timeline' ||
      isUserProfileTimelineOperation(operationName) ||
      operationName === 'SearchTimeline'
    ) {
      try {
        let vars = null;
        const raw = parsed.searchParams.get('variables');
        if (raw && raw.length < 32768) {
          const parsedUrlVars = JSON.parse(raw);
          if (isPlainObject(parsedUrlVars) && !hasDangerousOwnKeys(parsedUrlVars)) {
            vars = parsedUrlVars;
          }
        } else if (
          normalizedMethod === 'POST' &&
          typeof requestBodyText === 'string' &&
          requestBodyText.length > 0 &&
          requestBodyText.length <= 262144
        ) {
          const bodyObj = JSON.parse(requestBodyText);
          if (isPlainObject(bodyObj) && !hasDangerousOwnKeys(bodyObj)) {
            const rawVars = bodyObj.variables;
            if (isPlainObject(rawVars)) {
              vars = rawVars;
            } else if (typeof rawVars === 'string' && rawVars.length > 0 && rawVars.length < 32768) {
              const parsedBodyVars = JSON.parse(rawVars);
              if (isPlainObject(parsedBodyVars) && !hasDangerousOwnKeys(parsedBodyVars)) {
                vars = parsedBodyVars;
              }
            }
          }
        }
        const rawUid = vars?.userId ?? vars?.rest_id ?? vars?.id ?? vars?.user_id;
        const uid = typeof rawUid === 'number' ? String(rawUid) : rawUid;
        if (isValidDecimalId(uid)) match.requestedUserId = uid;
        if (
          match.category === 'author_mapping' &&
          isUserProfileTimelineOperation(operationName) &&
          (vars?.includeReplies === true ||
            vars?.withReplies === true ||
            /replies/i.test(String(vars?.timelineType || vars?.tab || '')))
        ) {
          match.category = 'replies_timeline';
        }
        if (operationName === 'SearchTimeline') {
          const validCursor =
            vars?.cursor === undefined ||
            (typeof vars.cursor === 'string' && vars.cursor.length > 0 && vars.cursor.length <= 4096);
          if (
            !vars ||
            vars.product !== 'Latest' ||
            !validCursor ||
            typeof vars.rawQuery !== 'string' ||
            !/^from:[A-Za-z0-9_]{1,64} filter:replies since:\d{4}-\d{2}-\d{2}(?: until:\d{4}-\d{2}-\d{2})?$/.test(vars.rawQuery)
          ) {
            return null;
          }
          match.searchQuery = vars.rawQuery;
        }
      } catch { if (operationName === 'SearchTimeline') return null; }
    }
    return match;
  }

  function unwrapGraphqlUserNode(userNode) {
    let cur = userNode;
    for (let depth = 0; depth < 4 && isPlainObject(cur); depth += 1) {
      if (cur.__typename === 'UserUnavailable') {
        return null;
      }
      if (cur.__typename === 'UserWithVisibilityResults' && isPlainObject(cur.user)) {
        cur = cur.user;
        continue;
      }
      if (isPlainObject(cur.result)) {
        cur = cur.result;
        continue;
      }
      break;
    }
    return isPlainObject(cur) && cur.__typename !== 'UserUnavailable' ? cur : null;
  }

  function extractUserFieldsFromGraphqlNode(userNode) {
    const unwrapped = unwrapGraphqlUserNode(userNode);
    if (!unwrapped) {
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
    const coreUserNode = isPlainObject(node.core)
      ? isPlainObject(node.core.user_results)
        ? node.core.user_results
        : isPlainObject(node.core.user_result)
          ? node.core.user_result
          : null
      : null;
    const coreUser = coreUserNode ? extractUserFieldsFromGraphqlNode(coreUserNode) : null;
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
    let directTargetUserId =
      legacy && isValidDecimalId(legacy.in_reply_to_user_id_str)
        ? legacy.in_reply_to_user_id_str
        : null;
    let directTargetHandle =
      legacy ? sanitizeHandle(legacy.in_reply_to_screen_name) : null;
    let directTargetDisplayName = null;
    const mentions =
      legacy && isPlainObject(legacy.entities) && Array.isArray(legacy.entities.user_mentions)
        ? legacy.entities.user_mentions
        : null;
    if (mentions && (directTargetUserId || directTargetHandle)) {
      for (let i = 0; i < mentions.length; i += 1) {
        const m = mentions[i];
        if (!isPlainObject(m)) {
          continue;
        }
        const mId = isValidDecimalId(m.id_str) ? m.id_str : null;
        const mHandle = sanitizeHandle(m.screen_name);
        const matchesId = Boolean(directTargetUserId && mId === directTargetUserId);
        const matchesHandle = Boolean(
          directTargetHandle && mHandle && mHandle.toLowerCase() === directTargetHandle.toLowerCase()
        );
        if (matchesId || matchesHandle) {
          if (!directTargetUserId && mId) {
            directTargetUserId = mId;
          }
          if (!directTargetHandle && mHandle) {
            directTargetHandle = mHandle;
          }
          directTargetDisplayName = sanitizeDisplayName(m.name);
          break;
        }
      }
    }
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
      directTargetDisplayName,
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
      const hasBusinessErrors = Array.isArray(payload.errors) && payload.errors.length > 0;
      const isReplyCandidate = Boolean(
        isPlainObject(requestMeta) && requestMeta.isReplyCandidate
      );

      const createTweetNode =
        isPlainObject(payload.data) &&
        isPlainObject(payload.data.create_tweet) &&
        isPlainObject(payload.data.create_tweet.tweet_results)
          ? payload.data.create_tweet.tweet_results
          : null;
      if (!createTweetNode) {
        if (!hasBusinessErrors && isReplyCandidate) {
          return {
            ...empty,
            anomalies: ['unrecognized_reply_schema'],
            incompleteObservation: true
          };
        }
        return empty;
      }

      const parsed = extractTweetCoreFields(createTweetNode);
      if (!parsed) {
        if (!hasBusinessErrors && isReplyCandidate) {
          return {
            ...empty,
            anomalies: ['unrecognized_reply_schema'],
            incompleteObservation: true
          };
        }
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

      // Plain post (not a reply) vs reply schema missing parent reference
      const expectedParentId =
        isPlainObject(requestMeta) && isValidDecimalId(requestMeta.expectedParentTweetId)
          ? requestMeta.expectedParentTweetId
          : null;

      if (!parsed.parentTweetId) {
        if (!hasBusinessErrors && isReplyCandidate) {
          return {
            ...empty,
            observedUsers,
            observedTweets,
            anomalies: ['unrecognized_reply_schema'],
            incompleteObservation: true
          };
        }
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
      if (!parsed.authorUserId) {
        return {
          ...empty,
          observedUsers,
          observedTweets,
          anomalies: ['unrecognized_reply_schema'],
          incompleteObservation: true
        };
      }
      if (parsed.authorUserId !== bindingContext.actorUserId) {
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

    function isRecognizableTimelineInstruction(inst) {
      if (!isPlainObject(inst)) {
        return { recognizable: false, broken: false };
      }
      if (typeof inst.type === 'string') {
        switch (inst.type) {
          case 'TimelineAddEntries':
            return Array.isArray(inst.entries)
              ? { recognizable: true, broken: false }
              : { recognizable: false, broken: true };
          case 'TimelineAddToModule':
            return Array.isArray(inst.moduleItems)
              ? { recognizable: true, broken: false }
              : { recognizable: false, broken: true };
          case 'TimelinePinEntry':
          case 'TimelineReplaceEntry':
            return { recognizable: isPlainObject(inst.entry), broken: false };
          case 'TimelineTerminateTimeline':
            return {
              recognizable: typeof inst.direction === 'string' && inst.direction.length > 0,
              broken: false
            };
          case 'TimelineClearCache':
          case 'TimelineShowAlert':
          case 'TimelineRemoveEntries':
          case 'TimelineClearEntriesUnreadState':
          case 'TimelineMarkEntriesUnreadGreaterThanSortIndex':
            return { recognizable: true, broken: false };
          default:
            return { recognizable: false, broken: false };
        }
      }
      const hasLegacyShape =
        Array.isArray(inst.entries) ||
        isPlainObject(inst.entry) ||
        Array.isArray(inst.moduleItems);
      return { recognizable: hasLegacyShape, broken: false };
    }

    function hasRecognizableTimelineInstructions(instructions) {
      if (!Array.isArray(instructions) || instructions.length === 0) {
        return false;
      }
      let recognizableCount = 0;
      for (let i = 0; i < instructions.length; i += 1) {
        const check = isRecognizableTimelineInstruction(instructions[i]);
        if (check.broken) {
          return false;
        }
        if (check.recognizable) {
          recognizableCount += 1;
        }
      }
      return recognizableCount > 0;
    }

    function isCursorObject(obj) {
      return (
        isPlainObject(obj) &&
        (obj.entryType === 'TimelineTimelineCursor' ||
          obj.itemType === 'TimelineTimelineCursor' ||
          obj.__typename === 'TimelineTimelineCursor' ||
          typeof obj.cursorType === 'string')
      );
    }

    function getCursorDirection(entryId, contentObj, itemContentObj) {
      if (isCursorObject(contentObj)) {
        return typeof contentObj.cursorType === 'string'
          ? contentObj.cursorType.toLowerCase()
          : 'unknown';
      }
      if (isCursorObject(itemContentObj)) {
        return typeof itemContentObj.cursorType === 'string'
          ? itemContentObj.cursorType.toLowerCase()
          : 'unknown';
      }
      if (typeof entryId === 'string') {
        if (/^cursor-bottom(?:-|$)/i.test(entryId)) {
          return 'bottom';
        }
        if (/^cursor-top(?:-|$)/i.test(entryId)) {
          return 'top';
        }
      }
      return null;
    }

    function isExplicitTweetItemContent(itemContent, entryId) {
      if (
        isPlainObject(itemContent) &&
        (itemContent.itemType === 'TimelineTweet' ||
          itemContent.__typename === 'TimelineTweet' ||
          isPlainObject(itemContent.tweet_results))
      ) {
        return true;
      }
      return typeof entryId === 'string' && /(?:^|-)tweet-\d+$/.test(entryId);
    }

    function collectTimelineTweetItems(instructions, actorUserId) {
      const primaryTweets = [];
      const auxiliaryTweets = [];
      let unrecognizedTweetCount = 0;
      const historyMeta = {
        eligiblePrimaryItems: [],
        hasUnknownPrimaryTweet: false,
        hasMissingCreatedAt: false,
        hasBottomCursor: false,
        hasTerminateBottom: false,
        hasTerminateTop: false,
        hasEmptyAddEntries: false,
        hasNonEmptyAddEntries: false,
        hasAddToModuleItems: false
      };
      if (!Array.isArray(instructions)) {
        return { primaryTweets, auxiliaryTweets, unrecognizedTweetCount, historyMeta };
      }

      // An unrecognized slot can conceal a recent primary tweet. Known tombstones
      // and foreign or retweeted posts carry no boundary evidence.
      function recordBoundaryItem(parsed) {
        if (parsed === undefined || (parsed && !parsed.authorUserId)) {
          historyMeta.hasUnknownPrimaryTweet = true;
        } else if (parsed && !parsed.isRetweet && parsed.authorUserId === actorUserId) {
          historyMeta.eligiblePrimaryItems.push(parsed);
          if (!parsed.createdAt) historyMeta.hasMissingCreatedAt = true;
        }
      }

      function inspectItemContent(itemContent) {
        if (!isPlainObject(itemContent)) {
          return;
        }
        // Skip promoted tweets
        if (isPlainObject(itemContent.promotedMetadata)) {
          return;
        }
        const isExplicitTweetItem =
          itemContent.itemType === 'TimelineTweet' ||
          itemContent.__typename === 'TimelineTweet';
        if (!isPlainObject(itemContent.tweet_results)) {
          if (isExplicitTweetItem) {
            unrecognizedTweetCount += 1;
          }
          return;
        }
        if (Object.keys(itemContent.tweet_results).length === 0) {
          return null;
        }
        let rawRes = isPlainObject(itemContent.tweet_results.result)
          ? itemContent.tweet_results.result
          : itemContent.tweet_results;
        if (isPlainObject(rawRes) && rawRes.__typename === 'TweetWithVisibilityResults' && isPlainObject(rawRes.tweet)) {
          rawRes = rawRes.tweet;
        }
        if (
          !isPlainObject(rawRes) ||
          Object.keys(rawRes).length === 0 ||
          rawRes.__typename === 'TweetTombstone' ||
          rawRes.__typename === 'TweetUnavailable' ||
          rawRes.__typename === 'TweetPreviewDisplay'
        ) {
          return null;
        }
        const parsed = extractTweetCoreFields(itemContent.tweet_results);
        if (!parsed) {
          unrecognizedTweetCount += 1;
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
        return parsed;
      }

      function inspectModuleItems(items, isPinnedEntry) {
        let hasLeaf = false;
        let leaf;
        for (let i = 0; i < items.length; i += 1) {
          const modItem = items[i];
          if (!isPlainObject(modItem) || !isPlainObject(modItem.item)) {
            continue;
          }
          const itemContent = modItem.item.itemContent;
          let parsed;
          if (isPlainObject(itemContent)) {
            parsed = inspectItemContent(itemContent);
          } else if (
            typeof modItem.entryId === 'string' &&
            /(?:^|-)tweet-\d+$/.test(modItem.entryId)
          ) {
            unrecognizedTweetCount += 1;
          }

          if (!actorUserId || isPinnedEntry) continue;
          const cursorDir = getCursorDirection(modItem.entryId, modItem.item, itemContent);
          if (cursorDir) {
            continue;
          }
          const isModPromoted =
            (typeof modItem.entryId === 'string' && /^promoted(?:-|$)/i.test(modItem.entryId)) ||
            isPlainObject(modItem.item.promotedMetadata) ||
            (isPlainObject(itemContent) && isPlainObject(itemContent.promotedMetadata));
          if (isModPromoted) {
            continue;
          }
          if (isExplicitTweetItemContent(itemContent, modItem.entryId)) {
            hasLeaf = true;
            leaf = parsed;
          }
        }
        // Only the leaf tweet slot in a conversation module reflects the thread's timeline position,
        // preventing an old conversation parent from masquerading as a recent thread position.
        if (hasLeaf) recordBoundaryItem(leaf);
      }

      function inspectEntry(entry, isPinnedInstruction) {
        if (!isPlainObject(entry) || !isPlainObject(entry.content)) {
          return;
        }
        const content = entry.content;
        const entryPinned =
          isPinnedInstruction ||
          (typeof entry.entryId === 'string' && /^pinned(?:-|$)/i.test(entry.entryId));
        const cursorDir = getCursorDirection(entry.entryId, content, content.itemContent);
        if (cursorDir) {
          if (cursorDir === 'bottom') {
            historyMeta.hasBottomCursor = true;
          }
          return;
        }
        const entryPromoted =
          (typeof entry.entryId === 'string' && /^promoted(?:-|$)/i.test(entry.entryId)) ||
          isPlainObject(content.promotedMetadata) ||
          (isPlainObject(content.itemContent) && isPlainObject(content.itemContent.promotedMetadata));

        if (isPlainObject(content.itemContent)) {
          const parsed = inspectItemContent(content.itemContent);
          if (
            actorUserId && !entryPinned &&
            !entryPromoted &&
            isExplicitTweetItemContent(content.itemContent, entry.entryId)
          ) {
            recordBoundaryItem(parsed);
          }
        } else if (Array.isArray(content.items)) {
          inspectModuleItems(content.items, entryPinned || entryPromoted);
        } else if (
          typeof entry.entryId === 'string' &&
          /^tweet-\d+$/.test(entry.entryId)
        ) {
          unrecognizedTweetCount += 1;
          if (!entryPinned && !entryPromoted) {
            historyMeta.hasUnknownPrimaryTweet = true;
          }
        }
      }

      for (let i = 0; i < instructions.length; i += 1) {
        const inst = instructions[i];
        if (!isPlainObject(inst)) {
          continue;
        }
        const isPinnedInstruction = inst.type === 'TimelinePinEntry';
        if (inst.type === 'TimelineTerminateTimeline' && typeof inst.direction === 'string') {
          const dir = inst.direction.toLowerCase();
          if (dir === 'bottom' || dir === 'topandbottom') {
            historyMeta.hasTerminateBottom = true;
          } else if (dir === 'top') {
            historyMeta.hasTerminateTop = true;
          }
        }
        if (Array.isArray(inst.entries)) {
          if (inst.type === 'TimelineAddEntries') {
            if (inst.entries.length === 0) {
              historyMeta.hasEmptyAddEntries = true;
            } else {
              historyMeta.hasNonEmptyAddEntries = true;
            }
          }
          for (let j = 0; j < inst.entries.length; j += 1) {
            inspectEntry(inst.entries[j], isPinnedInstruction);
          }
        }
        if (isPlainObject(inst.entry)) {
          inspectEntry(inst.entry, isPinnedInstruction);
        }
        if (Array.isArray(inst.moduleItems)) {
          if (inst.moduleItems.length > 0) {
            historyMeta.hasAddToModuleItems = true;
          }
          inspectModuleItems(inst.moduleItems, isPinnedInstruction);
        }
      }

      return { primaryTweets, auxiliaryTweets, unrecognizedTweetCount, historyMeta };
    }

    function buildHistoryPage(historyMeta) {
      const ended = Boolean(
        historyMeta.hasTerminateBottom ||
          (historyMeta.hasEmptyAddEntries &&
            !historyMeta.hasNonEmptyAddEntries &&
            !historyMeta.hasAddToModuleItems &&
            !historyMeta.hasBottomCursor &&
            !historyMeta.hasTerminateTop)
      );

      if (
        historyMeta.hasUnknownPrimaryTweet ||
        historyMeta.hasMissingCreatedAt ||
        historyMeta.eligiblePrimaryItems.length === 0
      ) {
        let fallbackPageKey = null;
        if (!historyMeta.hasUnknownPrimaryTweet && historyMeta.eligiblePrimaryItems.length > 0) {
          let newest = historyMeta.eligiblePrimaryItems[0];
          for (let i = 1; i < historyMeta.eligiblePrimaryItems.length; i += 1) {
            const cand = historyMeta.eligiblePrimaryItems[i];
            if (compareDecimalIds(cand.tweetId, newest.tweetId) > 0) {
              newest = cand;
            }
          }
          fallbackPageKey = newest.tweetId;
        }
        return {
          newestAt: null,
          ended,
          pageKey: fallbackPageKey
        };
      }

      let newest = historyMeta.eligiblePrimaryItems[0];
      for (let i = 1; i < historyMeta.eligiblePrimaryItems.length; i += 1) {
        const cand = historyMeta.eligiblePrimaryItems[i];
        if (
          cand.createdAt > newest.createdAt ||
          (cand.createdAt === newest.createdAt &&
            compareDecimalIds(cand.tweetId, newest.tweetId) > 0)
        ) {
          newest = cand;
        }
      }

      return {
        newestAt: newest.createdAt,
        ended,
        pageKey: newest.tweetId
      };
    }

    function findInstructionsDeep(node, depth) {
      const d = typeof depth === 'number' ? depth : 0;
      if (d > 12 || !node || typeof node !== 'object') {
        return null;
      }
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i += 1) {
          const found = findInstructionsDeep(node[i], d + 1);
          if (found) return found;
        }
        return null;
      }
      if (Array.isArray(node.instructions)) {
        return node.instructions;
      }
      const keys = Object.keys(node);
      for (let i = 0; i < keys.length; i += 1) {
        const found = findInstructionsDeep(node[keys[i]], d + 1);
        if (found) return found;
      }
      return null;
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

      if (isUserProfileTimelineOperation(operationName)) {
        const rawUserResult =
          isPlainObject(data.user) && isPlainObject(data.user.result)
            ? data.user.result
            : isPlainObject(data.user_result) && isPlainObject(data.user_result.result)
              ? data.user_result.result
              : isPlainObject(data.user_results) && isPlainObject(data.user_results.result)
                ? data.user_results.result
                : isPlainObject(data.viewer?.user_results?.result)
                  ? data.viewer.user_results.result
                  : null;
        if (!rawUserResult) {
          return { instructions: null, timelineOwnerId: null, singleUser: null };
        }
        const userResult = unwrapGraphqlUserNode(rawUserResult);
        if (!userResult) {
          return { instructions: null, timelineOwnerId: null, singleUser: null };
        }
        const ownerUser = extractUserFieldsFromGraphqlNode(userResult);
        const timelineHolder =
          isPlainObject(userResult.timeline_v3) ||
          isPlainObject(userResult.timeline_v2) ||
          isPlainObject(userResult.timeline)
            ? userResult
            : rawUserResult;
        const timelineObj = isPlainObject(timelineHolder.timeline_v3)
          ? timelineHolder.timeline_v3.timeline || timelineHolder.timeline_v3
          : isPlainObject(timelineHolder.timeline_v2)
            ? timelineHolder.timeline_v2.timeline || timelineHolder.timeline_v2
            : isPlainObject(timelineHolder.timeline)
              ? timelineHolder.timeline.timeline || timelineHolder.timeline
              : null;
        const instructions =
          isPlainObject(timelineObj) && Array.isArray(timelineObj.instructions)
            ? timelineObj.instructions
            : findInstructionsDeep(userResult, 0) ||
              (timelineHolder !== userResult ? findInstructionsDeep(timelineHolder, 0) : null);
        return {
          instructions,
          timelineOwnerId: ownerUser ? ownerUser.userId : null,
          singleUser: ownerUser
        };
      }

      if (operationName === 'SearchTimeline') {
        const timeline =
          data.search_by_raw_query?.search_timeline?.timeline ||
          data.search_by_raw_query?.search_timeline;
        const instructions = Array.isArray(timeline?.instructions)
          ? timeline.instructions
          : findInstructionsDeep(data.search_by_raw_query, 0);
        return { instructions, timelineOwnerId: null, singleUser: null };
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

      const hasAnyErrors = Array.isArray(payload.errors) && payload.errors.length > 0;
      const hasBusinessErrors =
        hasAnyErrors &&
        payload.errors.some(
          (err) => !isPlainObject(err) || !Array.isArray(err.path) || err.path.length === 0
        );
      const rawDataUserResult =
        isPlainObject(payload.data) &&
        isPlainObject(payload.data.user) &&
        isPlainObject(payload.data.user.result)
          ? payload.data.user.result
          : null;
      const isUnavailableUser =
        Boolean(rawDataUserResult) &&
        (rawDataUserResult.__typename === 'UserUnavailable' ||
          (rawDataUserResult.__typename === 'UserWithVisibilityResults' &&
            isPlainObject(rawDataUserResult.user) &&
            rawDataUserResult.user.__typename === 'UserUnavailable'));

      const observedUsers = [];
      const observedTweets = [];
      const { instructions, timelineOwnerId: responseOwner, singleUser } = extractInstructionsAndOwner(
        operationName,
        payload
      );

      const search = operationName === 'SearchTimeline' && params.manualSearch === true;
      const requestOwner = isValidDecimalId(params.requestedUserId) ? params.requestedUserId : null;
      const conflictingOwner = responseOwner && requestOwner && responseOwner !== requestOwner;
      const timelineOwnerId = search ? bindingContext?.actorUserId : conflictingOwner ? null : responseOwner || requestOwner;
      const ownTimelineOperation = isRepliesTimelineOperation(operationName) || params.repliesTimeline === true || search;
      if (search && (hasBusinessErrors || !hasRecognizableTimelineInstructions(instructions))) {
        return { ...empty, partialUnrecognized: true, anomalies: ['unrecognized_search_page'] };
      }
      if (singleUser) {
        recordUserProfile(singleUser, observedUsers);
      }

      if (!instructions) {
        const pendingCheck = isValidBindingContext(bindingContext)
          ? resolvePendingReplies(bindingContext.bindingId, observedAt)
          : { resolved: [] };
        const isDriftedOwnRepliesTimeline =
          ownTimelineOperation &&
          isValidBindingContext(bindingContext) &&
          !hasAnyErrors &&
          !isUnavailableUser &&
          (!timelineOwnerId || timelineOwnerId === bindingContext.actorUserId);
        return {
          ...empty,
          resolvedPendingEvents: pendingCheck.resolved,
          observedUsers,
          observedTweets,
          partialUnrecognized: isDriftedOwnRepliesTimeline,
          anomalies: isDriftedOwnRepliesTimeline ? ['unrecognized_timeline_schema'] : []
        };
      }

      const verifiedActorId =
        ownTimelineOperation &&
        isValidBindingContext(bindingContext) &&
        timelineOwnerId &&
        timelineOwnerId === bindingContext.actorUserId
          ? bindingContext.actorUserId
          : null;

      const { primaryTweets, auxiliaryTweets, unrecognizedTweetCount, historyMeta } =
        collectTimelineTweetItems(instructions, verifiedActorId);

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
        !ownTimelineOperation ||
        isUnavailableUser ||
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
      if (unrecognizedTweetCount > 0) {
        partialUnrecognized = true;
        anomalies.push('unrecognized_timeline_tweet_schema');
      }

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

        if (!targetUserId && targetHandle) {
          const mappedId = handleToIdMap.get(targetHandle.toLowerCase());
          if (isValidDecimalId(mappedId)) {
            targetUserId = mappedId;
          }
        }

        if (targetUserId) {
          const knownTarget = userByIdMap.get(targetUserId);
          if (knownTarget) {
            targetHandle = targetHandle || knownTarget.handle;
            targetDisplayName = knownTarget.displayName || item.directTargetDisplayName || null;
            if (!knownTarget.displayName && targetDisplayName) {
              recordUserProfile(
                { userId: targetUserId, handle: targetHandle, displayName: targetDisplayName },
                observedUsers
              );
            }
          } else {
            targetDisplayName = item.directTargetDisplayName || null;
            if (targetHandle || targetDisplayName) {
              recordUserProfile(
                { userId: targetUserId, handle: targetHandle, displayName: targetDisplayName },
                observedUsers
              );
            }
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

      const result = {
        events,
        resolvedPendingEvents: pendingResolution.resolved,
        observedUsers,
        observedTweets,
        partialUnrecognized,
        anomalies
      };
      if (
        verifiedActorId &&
        !hasBusinessErrors &&
        !isUnavailableUser &&
        hasRecognizableTimelineInstructions(instructions)
      ) {
        result.historyPage = buildHistoryPage(historyMeta);
      }
      return result;
    }

    function findBottomCursorDeep(node, depth) {
      const d = typeof depth === 'number' ? depth : 0;
      if (d > 24 || !node || typeof node !== 'object') {
        return null;
      }
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i += 1) {
          const found = findBottomCursorDeep(node[i], d + 1);
          if (found) return found;
        }
        return null;
      }
      if (
        String(node.cursorType || '').toLowerCase() === 'bottom' &&
        typeof node.value === 'string' &&
        node.value.length > 0 &&
        node.value.length <= 4096
      ) {
        return node.value;
      }
      const nodeEntryId = typeof node.entryId === 'string' ? node.entryId : '';
      if (/^cursor-bottom(?:-|$)/i.test(nodeEntryId) && isPlainObject(node.content)) {
        const fallbackNode = isPlainObject(node.content.itemContent) && !node.content.value
          ? node.content.itemContent
          : node.content;
        const explicitDir = typeof fallbackNode.cursorType === 'string'
          ? fallbackNode.cursorType.toLowerCase()
          : '';
        if (
          (!explicitDir || explicitDir === 'bottom') &&
          typeof fallbackNode.value === 'string' &&
          fallbackNode.value.length > 0 &&
          fallbackNode.value.length <= 4096
        ) {
          return fallbackNode.value;
        }
      }
      const keys = Object.keys(node);
      for (let i = 0; i < keys.length; i += 1) {
        const found = findBottomCursorDeep(node[keys[i]], d + 1);
        if (found) return found;
      }
      return null;
    }

    function getRepliesCursor(payload) {
      const instructions =
        extractInstructionsAndOwner('UserTweetsAndReplies', payload).instructions ||
        extractInstructionsAndOwner('SearchTimeline', payload).instructions ||
        findInstructionsDeep(payload?.data, 0);
      let cursor = null;
      let cursorFromReplace = false;
      let sawConflict = false;
      for (const inst of instructions || []) {
        const isReplace = inst?.type === 'TimelineReplaceEntry';
        const entries = Array.isArray(inst?.entries)
          ? inst.entries
          : isPlainObject(inst?.entry)
            ? [inst.entry]
            : [];
        for (const entry of entries) {
          const content = entry?.content;
          const entryId = typeof entry?.entryId === 'string' ? entry.entryId : '';
          const cursorNode = content?.cursorType
            ? content
            : content?.itemContent?.cursorType
              ? content.itemContent
              : /^cursor-bottom(?:-|$)/i.test(entryId)
                ? (typeof content?.value === 'string'
                    ? content
                    : typeof content?.itemContent?.value === 'string'
                      ? content.itemContent
                      : null)
                : null;
          const isBottomCursor =
            Boolean(cursorNode) &&
            (typeof cursorNode.cursorType === 'string'
              ? cursorNode.cursorType.toLowerCase() === 'bottom'
              : /^cursor-bottom(?:-|$)/i.test(entryId));
          if (
            !isBottomCursor ||
            typeof cursorNode.value !== 'string' ||
            !cursorNode.value ||
            cursorNode.value.length > 4096
          ) {
            continue;
          }
          if (cursor && cursor !== cursorNode.value) {
            if (isReplace || cursorFromReplace) {
              cursor = cursorNode.value;
              cursorFromReplace = isReplace;
              continue;
            }
            sawConflict = true;
            return null;
          }
          cursor = cursorNode.value;
          cursorFromReplace = isReplace;
        }
      }
      if (cursor || sawConflict) {
        return cursor;
      }
      return findBottomCursorDeep(payload?.data || payload, 0);
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
      getRepliesCursor,
      prunePendingReplies,
      resolveUserIdByHandle,
      resolveAuthorByTweetId,
      revokeBinding,
      clearAll,
      getPendingCount
    });
  }

  function extractViewerFromWindow(win, options) {
    if (!win || typeof win !== 'object') {
      return null;
    }
    const allowDynamicState =
      !isPlainObject(options) || options.allowDynamicState !== false;
    const allowInlineScript =
      !isPlainObject(options) || options.allowInlineScript !== false;
    try {
      if (allowDynamicState && isPlainObject(win.__INITIAL_STATE__)) {
        const direct = extractViewerFromInitialState(win.__INITIAL_STATE__);
        if (direct) {
          return direct;
        }
      }
      if (!allowInlineScript) {
        return null;
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
            let jsonCandidate = null;
            if (slice.startsWith('{')) {
              let depth = 0;
              let inStr = false;
              let escaped = false;
              for (let pos = 0; pos < slice.length; pos += 1) {
                const ch = slice[pos];
                if (escaped) {
                  escaped = false;
                  continue;
                }
                if (ch === '\\' && inStr) {
                  escaped = true;
                  continue;
                }
                if (ch === '"') {
                  inStr = !inStr;
                  continue;
                }
                if (!inStr) {
                  if (ch === '{') depth += 1;
                  else if (ch === '}') {
                    depth -= 1;
                    if (depth === 0) {
                      jsonCandidate = slice.slice(0, pos + 1);
                      break;
                    }
                  }
                }
              }
            }
            if (!jsonCandidate) {
              const endIdx = slice.indexOf('};');
              jsonCandidate = endIdx !== -1 ? slice.slice(0, endIdx + 1) : slice;
            }
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
