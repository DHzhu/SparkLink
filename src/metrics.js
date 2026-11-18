import { isPlainObject, isValidDecimalId, isValidTimestampMs } from './schema.js';

export const WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 2,592,000,000 ms
export const CLOCK_SKEW_TOLERANCE_MS = 60 * 1000; // 1 minute threshold for warning

export function isReplyInWindow(createdAt, nowMs) {
  if (!isValidTimestampMs(createdAt) || !isValidTimestampMs(nowMs)) {
    return false;
  }
  const cutoff = nowMs - WINDOW_MS;
  return createdAt >= cutoff && createdAt <= nowMs;
}

export function formatBadgeTooltip(count) {
  return `近30天已记录你回复TA ${count} 次（含导入）`;
}

export function getBadgeTier(count) {
  const safeCount = Number.isInteger(count) && count > 0 ? count : 0;
  if (safeCount === 0) {
    return {
      count: 0,
      tier: 'none',
      label: '尚无已记录回复',
      render: false,
      showCount: false,
      tooltip: ''
    };
  }
  if (safeCount <= 10) {
    return {
      count: safeCount,
      tier: 'acquaintance',
      label: '初识互动',
      render: true,
      showCount: false,
      tooltip: formatBadgeTooltip(safeCount)
    };
  }
  if (safeCount <= 50) {
    return {
      count: safeCount,
      tier: 'active',
      label: '活跃互动',
      render: true,
      showCount: false,
      tooltip: formatBadgeTooltip(safeCount)
    };
  }
  return {
    count: safeCount,
    tier: 'deep',
    label: '深度互动',
    render: true,
    showCount: false,
    tooltip: formatBadgeTooltip(safeCount)
  };
}

export function compareLeaderboardEntries(a, b) {
  if (b.count !== a.count) {
    return b.count - a.count;
  }
  if (b.lastReplyAt !== a.lastReplyAt) {
    return b.lastReplyAt - a.lastReplyAt;
  }
  if (a.targetUserId < b.targetUserId) {
    return -1;
  }
  if (a.targetUserId > b.targetUserId) {
    return 1;
  }
  return 0;
}

export function computeAccountSummary(accountObj, nowMs = Date.now()) {
  if (!isPlainObject(accountObj) || !isPlainObject(accountObj.replies)) {
    return {
      totalReplies: 0,
      activeTargetsCount: 0,
      deepTargetsCount: 0,
      latestReplyAt: null,
      clockSkewDetected: false,
      top20: []
    };
  }

  const usersDict = isPlainObject(accountObj.users) ? accountObj.users : {};
  const byTarget = new Map();
  let totalReplies = 0;
  let latestReplyAt = null;
  let clockSkewDetected = false;

  for (const [dictKey, reply] of Object.entries(accountObj.replies)) {
    if (!isPlainObject(reply) || dictKey !== reply.replyTweetId) {
      continue;
    }
    if (!isValidDecimalId(reply.targetUserId) || !isValidTimestampMs(reply.createdAt)) {
      continue;
    }
    if (reply.createdAt > nowMs) {
      if (reply.createdAt > nowMs + CLOCK_SKEW_TOLERANCE_MS) {
        clockSkewDetected = true;
      }
      continue;
    }
    if (!isReplyInWindow(reply.createdAt, nowMs)) {
      continue;
    }

    totalReplies += 1;
    if (latestReplyAt === null || reply.createdAt > latestReplyAt) {
      latestReplyAt = reply.createdAt;
    }

    let agg = byTarget.get(reply.targetUserId);
    if (!agg) {
      const profile = isPlainObject(usersDict[reply.targetUserId])
        ? usersDict[reply.targetUserId]
        : null;
      agg = {
        targetUserId: reply.targetUserId,
        handle: profile && profile.handle ? profile.handle : null,
        displayName: profile && profile.displayName ? profile.displayName : null,
        count: 0,
        lastReplyAt: 0
      };
      byTarget.set(reply.targetUserId, agg);
    }
    agg.count += 1;
    if (reply.createdAt > agg.lastReplyAt) {
      agg.lastReplyAt = reply.createdAt;
    }
  }

  let activeTargetsCount = 0;
  let deepTargetsCount = 0;
  const entries = [];

  for (const entry of byTarget.values()) {
    if (entry.count >= 11) {
      activeTargetsCount += 1;
    }
    if (entry.count >= 51) {
      deepTargetsCount += 1;
    }
    entries.push({
      ...entry,
      tierInfo: getBadgeTier(entry.count)
    });
  }

  entries.sort(compareLeaderboardEntries);

  return {
    totalReplies,
    activeTargetsCount,
    deepTargetsCount,
    latestReplyAt,
    clockSkewDetected,
    top20: entries.slice(0, 20)
  };
}

export function computeTargetCounts(accountObj, targetUserIds, nowMs = Date.now()) {
  const counts = {};
  if (!Array.isArray(targetUserIds)) {
    return counts;
  }
  const requestedSet = new Set();
  for (let i = 0; i < targetUserIds.length; i += 1) {
    const id = targetUserIds[i];
    if (isValidDecimalId(id)) {
      counts[id] = 0;
      requestedSet.add(id);
    }
  }
  if (
    requestedSet.size === 0 ||
    !isPlainObject(accountObj) ||
    !isPlainObject(accountObj.replies)
  ) {
    return counts;
  }

  for (const [dictKey, reply] of Object.entries(accountObj.replies)) {
    if (!isPlainObject(reply) || dictKey !== reply.replyTweetId) {
      continue;
    }
    if (!requestedSet.has(reply.targetUserId)) {
      continue;
    }
    if (isReplyInWindow(reply.createdAt, nowMs)) {
      counts[reply.targetUserId] += 1;
    }
  }

  return counts;
}
