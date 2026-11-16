import {
  STATE_STORAGE_KEY,
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  BACKUP_DATA_SCHEMA_VERSION,
  APP_BUDGET_BYTES,
  WARN_BUDGET_BYTES,
  MAX_ACCOUNTS,
  MAX_TOTAL_REPLIES,
  utf8ByteSize,
  isPlainObject,
  isValidDecimalId,
  sanitizeHandle,
  sanitizeDisplayName,
  isValidTimestampMs,
  isValidSource,
  formatBackupFilename,
  validateAndMigrateLocalState,
  validateImportBackupText
} from './schema.js';

import {
  WINDOW_MS,
  isReplyInWindow,
  computeAccountSummary,
  computeTargetCounts
} from './metrics.js';

function buildHandleIndex(usersDict) {
  const index = new Map();
  for (const [uid, profile] of Object.entries(usersDict)) {
    if (isPlainObject(profile) && typeof profile.handle === 'string' && profile.handle) {
      index.set(profile.handle.toLowerCase(), uid);
    }
  }
  return index;
}

function detachDuplicateHandleInUsersDict(usersDict, ownerUserId, handle, handleIndex) {
  if (!handle) {
    return;
  }
  const lower = handle.toLowerCase();
  if (handleIndex) {
    const prevUid = handleIndex.get(lower);
    if (prevUid && prevUid !== ownerUserId && isPlainObject(usersDict[prevUid])) {
      usersDict[prevUid].handle = null;
    }
    handleIndex.set(lower, ownerUserId);
    return;
  }
  for (const [uid, profile] of Object.entries(usersDict)) {
    if (uid !== ownerUserId && isPlainObject(profile) && typeof profile.handle === 'string') {
      if (profile.handle.toLowerCase() === lower) {
        profile.handle = null;
      }
    }
  }
}

function upsertReferencedUserProfile(usersDict, targetUserId, incoming, timestampMs, handleIndex) {
  const cleanHandle = sanitizeHandle(incoming && incoming.handle);
  const cleanName = sanitizeDisplayName(incoming && incoming.displayName);
  const existing = isPlainObject(usersDict[targetUserId]) ? usersDict[targetUserId] : null;

  if (!existing) {
    if (cleanHandle) {
      detachDuplicateHandleInUsersDict(usersDict, targetUserId, cleanHandle, handleIndex);
    }
    usersDict[targetUserId] = {
      handle: cleanHandle,
      displayName: cleanName,
      updatedAt: timestampMs
    };
    return true;
  }

  let changed = false;
  if (timestampMs >= (existing.updatedAt || 0)) {
    if (cleanHandle && cleanHandle !== existing.handle) {
      if (handleIndex && typeof existing.handle === 'string' && existing.handle) {
        const oldLower = existing.handle.toLowerCase();
        if (handleIndex.get(oldLower) === targetUserId) {
          handleIndex.delete(oldLower);
        }
      }
      detachDuplicateHandleInUsersDict(usersDict, targetUserId, cleanHandle, handleIndex);
      existing.handle = cleanHandle;
      changed = true;
    }
    if (cleanName && cleanName !== existing.displayName) {
      existing.displayName = cleanName;
      changed = true;
    }
    if (changed) {
      existing.updatedAt = timestampMs;
    }
  } else {
    if (!existing.handle && cleanHandle) {
      detachDuplicateHandleInUsersDict(usersDict, targetUserId, cleanHandle, handleIndex);
      existing.handle = cleanHandle;
      changed = true;
    }
    if (!existing.displayName && cleanName) {
      existing.displayName = cleanName;
      changed = true;
    }
  }
  return changed;
}

function cleanupAccountInPlace(accountObj, nowMs, windowMs) {
  const cutoff = nowMs - windowMs;
  let removedReplies = 0;
  let removedUsers = 0;

  const referencedTargetIds = new Set();
  for (const [replyId, reply] of Object.entries(accountObj.replies)) {
    if (!isPlainObject(reply) || reply.createdAt < cutoff) {
      delete accountObj.replies[replyId];
      removedReplies += 1;
    } else {
      referencedTargetIds.add(reply.targetUserId);
    }
  }

  for (const uid of Object.keys(accountObj.users)) {
    if (!referencedTargetIds.has(uid)) {
      delete accountObj.users[uid];
      removedUsers += 1;
    }
  }

  accountObj.lastCleanupAt = nowMs;
  return {
    removedReplies,
    removedUsers,
    mutated: removedReplies > 0 || removedUsers > 0
  };
}

function cleanupAllAccountsInPlace(stateObj, nowMs, windowMs) {
  let totalRemovedReplies = 0;
  let totalRemovedUsers = 0;
  for (const acc of Object.values(stateObj.accounts)) {
    const res = cleanupAccountInPlace(acc, nowMs, windowMs);
    totalRemovedReplies += res.removedReplies;
    totalRemovedUsers += res.removedUsers;
  }
  return {
    removedReplies: totalRemovedReplies,
    removedUsers: totalRemovedUsers,
    mutated: totalRemovedReplies > 0 || totalRemovedUsers > 0
  };
}

function measureSnapshotUsage(candidateState, limits) {
  const accountIds = Object.keys(candidateState.accounts);
  let totalReplies = 0;
  for (const id of accountIds) {
    totalReplies += Object.keys(candidateState.accounts[id].replies).length;
  }
  const serializedBytes = utf8ByteSize(
    JSON.stringify({ [STATE_STORAGE_KEY]: candidateState })
  );
  const exceeded =
    accountIds.length > limits.maxAccounts ||
    totalReplies > limits.maxTotalReplies ||
    serializedBytes > limits.appBudgetBytes;

  return {
    accountCount: accountIds.length,
    totalReplies,
    serializedBytes,
    nearWarning: serializedBytes >= limits.warnBudgetBytes,
    exceeded
  };
}

export function createStorageController(storageArea, options = {}) {
  if (!storageArea || typeof storageArea.get !== 'function' || typeof storageArea.set !== 'function') {
    throw new TypeError('Valid chrome.storage area required');
  }

  const nowFn = typeof options.nowFn === 'function' ? options.nowFn : () => Date.now();
  const windowMs =
    Number.isSafeInteger(options.windowMs) && options.windowMs > 0
      ? options.windowMs
      : WINDOW_MS;
  const limits = Object.freeze({
    maxAccounts:
      Number.isSafeInteger(options.maxAccounts) && options.maxAccounts > 0
        ? options.maxAccounts
        : MAX_ACCOUNTS,
    maxTotalReplies:
      Number.isSafeInteger(options.maxTotalReplies) && options.maxTotalReplies > 0
        ? options.maxTotalReplies
        : MAX_TOTAL_REPLIES,
    appBudgetBytes:
      Number.isSafeInteger(options.appBudgetBytes) && options.appBudgetBytes > 0
        ? options.appBudgetBytes
        : APP_BUDGET_BYTES,
    warnBudgetBytes:
      Number.isSafeInteger(options.warnBudgetBytes) && options.warnBudgetBytes > 0
        ? options.warnBudgetBytes
        : WARN_BUDGET_BYTES
  });

  let cachedState = null;
  let corruptedReason = null;
  let migratedOnBoot = false;
  let lastStorageError = null;
  let initPromise = null;
  let writeTail = Promise.resolve();

  async function doInitialize() {
    try {
      const rawContainer = await storageArea.get(STATE_STORAGE_KEY);
      const rawState = isPlainObject(rawContainer)
        ? rawContainer[STATE_STORAGE_KEY]
        : undefined;
      const checked = validateAndMigrateLocalState(rawState);
      if (!checked.ok) {
        corruptedReason = checked.reason || 'invalid_local_state';
        lastStorageError = `本地状态结构异常（${corruptedReason}），已保留原快照`;
        return;
      }
      if (checked.migrated) {
        try {
          await storageArea.set({ [STATE_STORAGE_KEY]: checked.state });
          cachedState = checked.state;
          migratedOnBoot = true;
        } catch (_writeErr) {
          corruptedReason = 'migration_write_failed';
          lastStorageError = '旧版本状态迁移写入失败，已保留原快照';
          return;
        }
      } else {
        cachedState = checked.state;
      }
    } catch (_readErr) {
      corruptedReason = 'storage_read_failed';
      lastStorageError = '无法读取本地扩展存储';
    }
  }

  function ensureInitialized() {
    if (!initPromise) {
      initPromise = doInitialize();
    }
    return initPromise;
  }

  function enqueueMutation(mutatorFn) {
    const run = async () => {
      await ensureInitialized();
      if (corruptedReason || !cachedState) {
        return {
          ok: false,
          code: 'STATE_CORRUPTED',
          message: lastStorageError || '本地状态不可用，已保护原数据'
        };
      }
      return mutatorFn();
    };
    const taskPromise = writeTail.then(run, run);
    writeTail = taskPromise.then(
      () => undefined,
      () => undefined
    );
    return taskPromise;
  }

  async function commitCandidate(candidate, enforceQuota) {
    const usage = measureSnapshotUsage(candidate, limits);
    if (enforceQuota && usage.exceeded) {
      lastStorageError = '存储空间不足，部分新记录未保存';
      return {
        ok: false,
        code: 'QUOTA_EXCEEDED',
        message: lastStorageError,
        usage
      };
    }

    try {
      await storageArea.set({ [STATE_STORAGE_KEY]: candidate });
      cachedState = candidate;
      lastStorageError = null;
      return {
        ok: true,
        usage
      };
    } catch (_err) {
      lastStorageError = '存储空间不足，部分新记录未保存';
      return {
        ok: false,
        code: 'STORAGE_WRITE_FAILED',
        message: lastStorageError,
        usage
      };
    }
  }

  function simulateImportMerge(baseState, rawText, nowMs) {
    const validated = validateImportBackupText(rawText, nowMs, windowMs);
    if (!validated.ok) {
      return validated;
    }

    const candidate = structuredClone(baseState);
    cleanupAllAccountsInPlace(candidate, nowMs, windowMs);
    const nextRevision = candidate.revision + 1;

    const baselineAccountGenerations = {};
    let added = 0;
    let duplicates = 0;
    let dataConflicts = 0;

    const incomingAccountIds = Object.keys(validated.accounts).sort();

    for (const actorId of incomingAccountIds) {
      const incomingAcc = validated.accounts[actorId];
      const existingAcc = candidate.accounts[actorId] || null;
      baselineAccountGenerations[actorId] = existingAcc
        ? existingAcc.accountGeneration
        : null;

      let targetAcc = existingAcc;
      if (!targetAcc) {
        targetAcc = {
          accountGeneration: nextRevision,
          handle: incomingAcc.handle,
          displayName: incomingAcc.displayName,
          lastCleanupAt: nowMs,
          users: {},
          replies: {}
        };
        candidate.accounts[actorId] = targetAcc;
      } else {
        if (incomingAcc.handle) {
          targetAcc.handle = incomingAcc.handle;
        }
        if (incomingAcc.displayName) {
          targetAcc.displayName = incomingAcc.displayName;
        }
      }

      const handleIndex = buildHandleIndex(targetAcc.users);

      for (const [replyId, inReply] of Object.entries(incomingAcc.replies)) {
        const localReply = targetAcc.replies[replyId];
        if (localReply) {
          if (
            localReply.parentTweetId === inReply.parentTweetId &&
            localReply.targetUserId === inReply.targetUserId &&
            localReply.createdAt === inReply.createdAt
          ) {
            duplicates += 1;
            const inUser = incomingAcc.users[inReply.targetUserId];
            if (inUser) {
              upsertReferencedUserProfile(
                targetAcc.users,
                inReply.targetUserId,
                inUser,
                inUser.updatedAt || inReply.observedAt,
                handleIndex
              );
            }
          } else {
            dataConflicts += 1;
          }
          continue;
        }

        targetAcc.replies[replyId] = { ...inReply };
        added += 1;
        const inUser = incomingAcc.users[inReply.targetUserId] || {
          handle: null,
          displayName: null,
          updatedAt: inReply.observedAt
        };
        upsertReferencedUserProfile(
          targetAcc.users,
          inReply.targetUserId,
          inUser,
          inUser.updatedAt || inReply.observedAt,
          handleIndex
        );
      }
    }

    candidate.revision = nextRevision;
    const usage = measureSnapshotUsage(candidate, limits);
    const totalConflicts = validated.stats.keyConflicts + dataConflicts;

    const preview = {
      involvedAccounts: incomingAccountIds.map((id) => ({
        actorUserId: id,
        handle: candidate.accounts[id].handle,
        displayName: candidate.accounts[id].displayName
      })),
      added,
      duplicates,
      expired: validated.stats.expired,
      future: validated.stats.future,
      selfReplies: validated.stats.selfReplies,
      invalid: validated.stats.invalid,
      conflicts: totalConflicts,
      wouldExceedQuota: usage.exceeded,
      nearQuotaWarning: usage.nearWarning
    };

    const baseline = {
      collectionGeneration: baseState.collectionGeneration,
      accountGenerations: baselineAccountGenerations,
      expectedSummary: {
        added,
        duplicates,
        conflicts: totalConflicts
      }
    };

    return {
      ok: true,
      candidate,
      usage,
      preview,
      baseline
    };
  }

  return Object.freeze({
    async init() {
      await ensureInitialized();
      return {
        ok: !corruptedReason,
        migratedOnBoot,
        corruptedReason,
        lastStorageError
      };
    },

    async getControlState() {
      await ensureInitialized();
      if (corruptedReason || !cachedState) {
        return {
          ok: false,
          code: 'STATE_CORRUPTED',
          message: lastStorageError
        };
      }
      const accountGenerations = {};
      for (const [actorId, acc] of Object.entries(cachedState.accounts)) {
        accountGenerations[actorId] = acc.accountGeneration;
      }
      return {
        ok: true,
        revision: cachedState.revision,
        collectionGeneration: cachedState.collectionGeneration,
        settings: structuredClone(cachedState.settings),
        accountGenerations,
        migratedOnBoot,
        lastStorageError
      };
    },

    async setCollectionEnabled(enabled) {
      return enqueueMutation(async () => {
        const nextEnabled = Boolean(enabled);
        const candidate = structuredClone(cachedState);
        candidate.revision = cachedState.revision + 1;
        candidate.settings.collectionEnabled = nextEnabled;
        candidate.settings.captureSessionId = nextEnabled ? candidate.revision : null;

        const res = await commitCandidate(candidate, false);
        if (!res.ok) {
          return res;
        }
        return {
          ok: true,
          revision: cachedState.revision,
          collectionGeneration: cachedState.collectionGeneration,
          settings: structuredClone(cachedState.settings)
        };
      });
    },

    async ensureViewerAccount(viewer) {
      if (!isPlainObject(viewer) || !isValidDecimalId(viewer.actorUserId)) {
        return { ok: false, code: 'INVALID_VIEWER', message: '无效的当前账号标识' };
      }
      return enqueueMutation(async () => {
        const now = nowFn();
        const actorId = viewer.actorUserId;
        const cleanHandle = sanitizeHandle(viewer.handle);
        const cleanName = sanitizeDisplayName(viewer.displayName);

        const existing = cachedState.accounts[actorId];
        if (
          existing &&
          (!cleanHandle || existing.handle === cleanHandle) &&
          (!cleanName || existing.displayName === cleanName)
        ) {
          return {
            ok: true,
            created: false,
            revision: cachedState.revision,
            collectionGeneration: cachedState.collectionGeneration,
            accountGeneration: existing.accountGeneration
          };
        }

        const candidate = structuredClone(cachedState);
        cleanupAllAccountsInPlace(candidate, now, windowMs);
        candidate.revision = cachedState.revision + 1;

        if (!candidate.accounts[actorId]) {
          candidate.accounts[actorId] = {
            accountGeneration: candidate.revision,
            handle: cleanHandle,
            displayName: cleanName,
            lastCleanupAt: now,
            users: {},
            replies: {}
          };
        } else {
          if (cleanHandle) {
            candidate.accounts[actorId].handle = cleanHandle;
          }
          if (cleanName) {
            candidate.accounts[actorId].displayName = cleanName;
          }
        }

        const res = await commitCandidate(candidate, true);
        if (!res.ok) {
          return res;
        }
        return {
          ok: true,
          created: !existing,
          revision: cachedState.revision,
          collectionGeneration: cachedState.collectionGeneration,
          accountGeneration: cachedState.accounts[actorId].accountGeneration
        };
      });
    },

    async mergeObservedBatch(params) {
      if (!isPlainObject(params) || !isPlainObject(params.bindingContext)) {
        return { ok: false, code: 'INVALID_BATCH' };
      }
      return enqueueMutation(async () => {
        const now = nowFn();
        const ctx = params.bindingContext;
        if (!cachedState.settings.collectionEnabled || cachedState.settings.captureSessionId === null) {
          return { ok: false, code: 'PAUSED' };
        }
        if (
          ctx.captureSessionId !== cachedState.settings.captureSessionId ||
          ctx.collectionGeneration !== cachedState.collectionGeneration
        ) {
          return { ok: false, code: 'STALE_BINDING' };
        }
        const existingAcc = cachedState.accounts[ctx.actorUserId];
        if (!existingAcc || existingAcc.accountGeneration !== ctx.accountGeneration) {
          return { ok: false, code: 'STALE_BINDING' };
        }

        const candidate = structuredClone(cachedState);
        const cleanupRes = cleanupAllAccountsInPlace(candidate, now, windowMs);
        const targetAcc = candidate.accounts[ctx.actorUserId];
        const handleIndex = buildHandleIndex(targetAcc.users);

        const rawEvents = Array.isArray(params.events) ? params.events : [];
        const rawUsers = Array.isArray(params.observedUsers) ? params.observedUsers : [];

        let added = 0;
        let duplicates = 0;
        let conflicts = 0;
        let skippedExpiredOrFuture = 0;
        let profileUpdated = false;

        for (let i = 0; i < rawEvents.length; i += 1) {
          const ev = rawEvents[i];
          if (
            !isPlainObject(ev) ||
            ev.actorUserId !== ctx.actorUserId ||
            !isValidDecimalId(ev.replyTweetId) ||
            !isValidDecimalId(ev.parentTweetId) ||
            !isValidDecimalId(ev.targetUserId) ||
            ev.targetUserId === ctx.actorUserId ||
            !isValidTimestampMs(ev.createdAt) ||
            !isValidTimestampMs(ev.observedAt) ||
            !isValidSource(ev.source)
          ) {
            continue;
          }

          const existingReply = targetAcc.replies[ev.replyTweetId];
          if (existingReply) {
            if (
              existingReply.parentTweetId === ev.parentTweetId &&
              existingReply.targetUserId === ev.targetUserId &&
              existingReply.createdAt === ev.createdAt
            ) {
              duplicates += 1;
              if (ev.targetHandle || ev.targetDisplayName) {
                profileUpdated =
                  upsertReferencedUserProfile(
                    targetAcc.users,
                    ev.targetUserId,
                    { handle: ev.targetHandle, displayName: ev.targetDisplayName },
                    ev.observedAt,
                    handleIndex
                  ) || profileUpdated;
              }
            } else {
              conflicts += 1;
            }
            continue;
          }

          if (!isReplyInWindow(ev.createdAt, now)) {
            skippedExpiredOrFuture += 1;
            continue;
          }

          targetAcc.replies[ev.replyTweetId] = {
            replyTweetId: ev.replyTweetId,
            parentTweetId: ev.parentTweetId,
            targetUserId: ev.targetUserId,
            createdAt: ev.createdAt,
            observedAt: ev.observedAt,
            source: ev.source
          };
          added += 1;

          upsertReferencedUserProfile(
            targetAcc.users,
            ev.targetUserId,
            { handle: ev.targetHandle, displayName: ev.targetDisplayName },
            ev.observedAt,
            handleIndex
          );
        }

        // Update profiles for already-referenced targets (e.g. handle renames)
        for (let i = 0; i < rawUsers.length; i += 1) {
          const u = rawUsers[i];
          if (!isPlainObject(u) || !isValidDecimalId(u.userId)) {
            continue;
          }
          if (u.userId === ctx.actorUserId) {
            const h = sanitizeHandle(u.handle);
            const d = sanitizeDisplayName(u.displayName);
            if (h && h !== targetAcc.handle) {
              targetAcc.handle = h;
              profileUpdated = true;
            }
            if (d && d !== targetAcc.displayName) {
              targetAcc.displayName = d;
              profileUpdated = true;
            }
          } else if (Object.prototype.hasOwnProperty.call(targetAcc.users, u.userId)) {
            profileUpdated =
              upsertReferencedUserProfile(targetAcc.users, u.userId, u, now, handleIndex) ||
              profileUpdated;
          }
        }

        if (added === 0 && !cleanupRes.mutated && !profileUpdated) {
          // Pure idempotent duplicate / empty batch: confirm without unnecessary disk write
          return {
            ok: true,
            added: 0,
            duplicates,
            conflicts,
            skippedExpiredOrFuture,
            revision: cachedState.revision
          };
        }

        candidate.revision = cachedState.revision + 1;
        const commitRes = await commitCandidate(candidate, added > 0);
        if (!commitRes.ok) {
          return commitRes;
        }

        return {
          ok: true,
          added,
          duplicates,
          conflicts,
          skippedExpiredOrFuture,
          revision: cachedState.revision,
          nearQuotaWarning: commitRes.usage.nearWarning
        };
      });
    },

    async cleanupExpired(explicitNowMs) {
      return enqueueMutation(async () => {
        const now = isValidTimestampMs(explicitNowMs) ? explicitNowMs : nowFn();
        const candidate = structuredClone(cachedState);
        const res = cleanupAllAccountsInPlace(candidate, now, windowMs);
        if (!res.mutated) {
          return {
            ok: true,
            removedReplies: 0,
            removedUsers: 0,
            revision: cachedState.revision
          };
        }
        candidate.revision = cachedState.revision + 1;
        const commitRes = await commitCandidate(candidate, false);
        if (!commitRes.ok) {
          return commitRes;
        }
        return {
          ok: true,
          removedReplies: res.removedReplies,
          removedUsers: res.removedUsers,
          revision: cachedState.revision
        };
      });
    },

    async clearAccount(actorUserId, expectedAccountGeneration) {
      if (!isValidDecimalId(actorUserId) || !Number.isSafeInteger(expectedAccountGeneration)) {
        return { ok: false, code: 'INVALID_ARGS', message: '无效的账号清空参数' };
      }
      return enqueueMutation(async () => {
        const acc = cachedState.accounts[actorUserId];
        if (!acc || acc.accountGeneration !== expectedAccountGeneration) {
          return {
            ok: false,
            code: 'ACCOUNT_VERSION_MISMATCH',
            message: '目标账号状态已变化，请刷新后再试'
          };
        }
        const candidate = structuredClone(cachedState);
        delete candidate.accounts[actorUserId];
        candidate.revision = cachedState.revision + 1;

        const commitRes = await commitCandidate(candidate, false);
        if (!commitRes.ok) {
          return commitRes;
        }
        return {
          ok: true,
          clearedActorUserId: actorUserId,
          revision: cachedState.revision
        };
      });
    },

    async clearAllData() {
      return enqueueMutation(async () => {
        const candidate = structuredClone(cachedState);
        candidate.revision = cachedState.revision + 1;
        candidate.collectionGeneration = cachedState.collectionGeneration + 1;
        candidate.settings = {
          collectionEnabled: false,
          captureSessionId: null
        };
        candidate.accounts = {};

        const commitRes = await commitCandidate(candidate, false);
        if (!commitRes.ok) {
          return commitRes;
        }
        return {
          ok: true,
          revision: cachedState.revision,
          collectionGeneration: cachedState.collectionGeneration,
          settings: structuredClone(cachedState.settings)
        };
      });
    },

    async exportBackup(explicitNowMs) {
      return enqueueMutation(async () => {
        const now = isValidTimestampMs(explicitNowMs) ? explicitNowMs : nowFn();
        const candidate = structuredClone(cachedState);
        const cleanupRes = cleanupAllAccountsInPlace(candidate, now, windowMs);
        if (cleanupRes.mutated) {
          candidate.revision = cachedState.revision + 1;
          // Persist cleanup if possible; even if quota blocks write, still allow export!
          await commitCandidate(candidate, false);
        }

        const sourceState = cachedState;
        const portableAccounts = {};
        for (const [actorId, acc] of Object.entries(sourceState.accounts)) {
          // Ensure exported view strictly excludes any expired records even if cleanup write failed
          const exportedReplies = {};
          const referencedTargets = new Set();
          for (const [replyId, reply] of Object.entries(acc.replies)) {
            if (isReplyInWindow(reply.createdAt, now)) {
              exportedReplies[replyId] = {
                replyTweetId: reply.replyTweetId,
                parentTweetId: reply.parentTweetId,
                targetUserId: reply.targetUserId,
                createdAt: reply.createdAt,
                observedAt: reply.observedAt,
                source: reply.source
              };
              referencedTargets.add(reply.targetUserId);
            }
          }
          const exportedUsers = {};
          for (const [uid, u] of Object.entries(acc.users)) {
            if (referencedTargets.has(uid)) {
              exportedUsers[uid] = {
                handle: u.handle,
                displayName: u.displayName,
                updatedAt: u.updatedAt
              };
            }
          }
          portableAccounts[actorId] = {
            handle: acc.handle,
            displayName: acc.displayName,
            users: exportedUsers,
            replies: exportedReplies
          };
        }

        const exportDate = new Date(now);
        const backup = {
          format: BACKUP_FORMAT,
          formatVersion: BACKUP_FORMAT_VERSION,
          exportedAt: exportDate.toISOString(),
          data: {
            schemaVersion: BACKUP_DATA_SCHEMA_VERSION,
            accounts: portableAccounts
          }
        };

        const rawJson = JSON.stringify(backup);

        return {
          ok: true,
          filename: formatBackupFilename(exportDate),
          backup,
          rawJson
        };
      });
    },

    async previewImport(rawText, explicitNowMs) {
      await ensureInitialized();
      if (corruptedReason || !cachedState) {
        return {
          ok: false,
          code: 'STATE_CORRUPTED',
          message: lastStorageError
        };
      }
      const now = isValidTimestampMs(explicitNowMs) ? explicitNowMs : nowFn();
      const sim = simulateImportMerge(cachedState, rawText, now);
      if (!sim.ok) {
        return sim;
      }
      return {
        ok: true,
        preview: sim.preview,
        baseline: sim.baseline
      };
    },

    async commitImport(rawText, expectedBaseline, explicitNowMs) {
      if (!isPlainObject(expectedBaseline) || !isPlainObject(expectedBaseline.accountGenerations)) {
        return { ok: false, code: 'INVALID_BASELINE', message: '缺少导入确认基线' };
      }
      return enqueueMutation(async () => {
        const now = isValidTimestampMs(explicitNowMs) ? explicitNowMs : nowFn();
        const sim = simulateImportMerge(cachedState, rawText, now);
        if (!sim.ok) {
          return sim;
        }

        // Verify collectionGeneration, involved accountGenerations, and merge outcome match preview
        let baselineMatched =
          expectedBaseline.collectionGeneration === cachedState.collectionGeneration;
        if (baselineMatched) {
          for (const [actorId, expectedGen] of Object.entries(expectedBaseline.accountGenerations)) {
            const currentGen = cachedState.accounts[actorId]
              ? cachedState.accounts[actorId].accountGeneration
              : null;
            if (currentGen !== expectedGen) {
              baselineMatched = false;
              break;
            }
          }
        }
        if (baselineMatched && isPlainObject(expectedBaseline.expectedSummary)) {
          const exp = expectedBaseline.expectedSummary;
          if (
            exp.added !== sim.preview.added ||
            exp.duplicates !== sim.preview.duplicates ||
            exp.conflicts !== sim.preview.conflicts
          ) {
            baselineMatched = false;
          }
        }

        if (!baselineMatched) {
          return {
            ok: false,
            code: 'PREVIEW_STALE',
            message: '本地数据在确认前已变化，请核对最新导入预览后再次确认',
            freshPreview: {
              ok: true,
              preview: sim.preview,
              baseline: sim.baseline
            }
          };
        }

        const commitRes = await commitCandidate(sim.candidate, true);
        if (!commitRes.ok) {
          return commitRes;
        }

        return {
          ok: true,
          added: sim.preview.added,
          duplicates: sim.preview.duplicates,
          conflicts: sim.preview.conflicts,
          revision: cachedState.revision,
          nearQuotaWarning: commitRes.usage.nearWarning
        };
      });
    },

    async queryCountsForAccount(actorUserId, targetUserIds, explicitNowMs) {
      await ensureInitialized();
      if (corruptedReason || !cachedState) {
        return { ok: false, code: 'STATE_CORRUPTED' };
      }
      const now = isValidTimestampMs(explicitNowMs) ? explicitNowMs : nowFn();
      const acc = cachedState.accounts[actorUserId];
      if (!acc) {
        return {
          ok: true,
          counts: computeTargetCounts(null, targetUserIds, now),
          revision: cachedState.revision
        };
      }
      return {
        ok: true,
        counts: computeTargetCounts(acc, targetUserIds, now),
        revision: cachedState.revision
      };
    },

    async getAccountSnapshot(actorUserId, explicitNowMs) {
      await ensureInitialized();
      if (corruptedReason || !cachedState) {
        return null;
      }
      const now = isValidTimestampMs(explicitNowMs) ? explicitNowMs : nowFn();
      const acc = cachedState.accounts[actorUserId];
      if (!acc) {
        return null;
      }
      return {
        actorUserId,
        accountGeneration: acc.accountGeneration,
        handle: acc.handle,
        displayName: acc.displayName,
        summary: computeAccountSummary(acc, now)
      };
    },

    async getPopupSnapshot(preferredActorUserId, explicitNowMs) {
      await ensureInitialized();
      const now = isValidTimestampMs(explicitNowMs) ? explicitNowMs : nowFn();
      if (corruptedReason || !cachedState) {
        return {
          ok: false,
          code: 'STATE_CORRUPTED',
          message: lastStorageError || '本地状态异常'
        };
      }

      // Opportunistically clean expired records when Popup opens (Section 7.3)
      await this.cleanupExpired(now);

      const usage = measureSnapshotUsage(cachedState, limits);
      const savedAccounts = Object.entries(cachedState.accounts)
        .map(([actorId, acc]) => ({
          actorUserId: actorId,
          accountGeneration: acc.accountGeneration,
          handle: acc.handle,
          displayName: acc.displayName
        }))
        .sort((a, b) => (a.actorUserId < b.actorUserId ? -1 : 1));

      let selectedId = null;
      if (preferredActorUserId && cachedState.accounts[preferredActorUserId]) {
        selectedId = preferredActorUserId;
      } else if (savedAccounts.length > 0) {
        selectedId = savedAccounts[0].actorUserId;
      }

      const selectedAccount = selectedId
        ? {
            actorUserId: selectedId,
            accountGeneration: cachedState.accounts[selectedId].accountGeneration,
            handle: cachedState.accounts[selectedId].handle,
            displayName: cachedState.accounts[selectedId].displayName,
            summary: computeAccountSummary(cachedState.accounts[selectedId], now)
          }
        : null;

      return {
        ok: true,
        revision: cachedState.revision,
        collectionGeneration: cachedState.collectionGeneration,
        settings: structuredClone(cachedState.settings),
        savedAccounts,
        selectedAccount,
        nearQuotaWarning: usage.nearWarning,
        usageBytes: usage.serializedBytes,
        lastStorageError
      };
    }
  });
}
