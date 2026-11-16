export const STATE_STORAGE_KEY = 'sparklink_state';
export const SESSION_BINDINGS_KEY = 'sparklink_doc_bindings';
export const LOCAL_SCHEMA_VERSION = 2;
export const BACKUP_FORMAT = 'sparklink-backup';
export const BACKUP_FORMAT_VERSION = 1;
export const BACKUP_DATA_SCHEMA_VERSION = 1;

export const MAX_IMPORT_FILE_BYTES = 9 * 1024 * 1024; // 9 MiB
export const APP_BUDGET_BYTES = 8 * 1024 * 1024; // 8 MiB
export const WARN_BUDGET_BYTES = 7 * 1024 * 1024; // 7 MiB
export const MAX_ACCOUNTS = 10;
export const MAX_TOTAL_REPLIES = 20000;

export const MAX_ID_LEN = 32;
export const MAX_HANDLE_LEN = 64;
export const MAX_DISPLAY_NAME_LEN = 256;
export const MAX_OBJECT_DEPTH = 16;

const DECIMAL_ID_RE = /^[1-9][0-9]{0,31}$/;
const SAFE_HANDLE_RE = /^[A-Za-z0-9_]{1,64}$/;
const VALID_SOURCES = new Set(['live', 'history', 'import']);
const encoder = new TextEncoder();

export function utf8ByteSize(str) {
  if (typeof str !== 'string') {
    return 0;
  }
  return encoder.encode(str).byteLength;
}

export function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function hasDangerousKeys(value, depth = 0, maxDepth = MAX_OBJECT_DEPTH) {
  if (depth > maxDepth) {
    return true;
  }
  if (value === null || typeof value !== 'object') {
    return false;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      if (hasDangerousKeys(value[i], depth + 1, maxDepth)) {
        return true;
      }
    }
    return false;
  }
  const keys = Object.getOwnPropertyNames(value);
  for (let i = 0; i < keys.length; i += 1) {
    const k = keys[i];
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') {
      return true;
    }
    if (hasDangerousKeys(value[k], depth + 1, maxDepth)) {
      return true;
    }
  }
  return false;
}

export function isValidDecimalId(value) {
  return typeof value === 'string' && value.length <= MAX_ID_LEN && DECIMAL_ID_RE.test(value);
}

export function sanitizeHandle(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.startsWith('@') ? value.slice(1).trim() : value.trim();
  if (!trimmed || trimmed.length > MAX_HANDLE_LEN || !SAFE_HANDLE_RE.test(trimmed)) {
    return null;
  }
  return trimmed;
}

export function sanitizeDisplayName(value) {
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

export function isValidTimestampMs(value) {
  return Number.isSafeInteger(value) && value > 0;
}

export function isValidSource(value) {
  return typeof value === 'string' && VALID_SOURCES.has(value);
}

export function buildSafeProfileUrl(handle) {
  const clean = sanitizeHandle(handle);
  if (!clean) {
    return null;
  }
  return `https://x.com/${clean}`;
}

export function formatBackupFilename(dateObj = new Date()) {
  const pad2 = (n) => String(n).padStart(2, '0');
  const y = dateObj.getFullYear();
  const m = pad2(dateObj.getMonth() + 1);
  const d = pad2(dateObj.getDate());
  const hh = pad2(dateObj.getHours());
  const mm = pad2(dateObj.getMinutes());
  const ss = pad2(dateObj.getSeconds());
  return `sparklink-backup-${y}${m}${d}-${hh}${mm}${ss}.json`;
}

export function createInitialLocalState() {
  return {
    schemaVersion: LOCAL_SCHEMA_VERSION,
    revision: 0,
    collectionGeneration: 1,
    settings: {
      collectionEnabled: false,
      captureSessionId: null
    },
    accounts: {}
  };
}

function validateStrictReplyRecord(actorUserId, dictKey, rawReply) {
  if (!isPlainObject(rawReply)) {
    return { ok: false, reason: 'invalid_reply_object' };
  }
  const { replyTweetId, parentTweetId, targetUserId, createdAt, observedAt, source } = rawReply;
  if (!isValidDecimalId(dictKey) || !isValidDecimalId(replyTweetId)) {
    return { ok: false, reason: 'invalid_reply_id' };
  }
  if (dictKey !== replyTweetId) {
    return { ok: false, reason: 'reply_key_conflict' };
  }
  if (!isValidDecimalId(parentTweetId) || !isValidDecimalId(targetUserId)) {
    return { ok: false, reason: 'invalid_parent_or_target_id' };
  }
  if (targetUserId === actorUserId) {
    return { ok: false, reason: 'self_reply_forbidden' };
  }
  if (!isValidTimestampMs(createdAt) || !isValidTimestampMs(observedAt)) {
    return { ok: false, reason: 'invalid_timestamp' };
  }
  if (!isValidSource(source)) {
    return { ok: false, reason: 'invalid_source' };
  }
  return {
    ok: true,
    record: {
      replyTweetId,
      parentTweetId,
      targetUserId,
      createdAt,
      observedAt,
      source
    }
  };
}

function validateStrictAccountObject(actorUserId, rawAcc, requireGeneration) {
  if (!isValidDecimalId(actorUserId) || !isPlainObject(rawAcc)) {
    return { ok: false, reason: 'invalid_account_structure' };
  }
  if (requireGeneration) {
    if (!Number.isSafeInteger(rawAcc.accountGeneration) || rawAcc.accountGeneration <= 0) {
      return { ok: false, reason: 'invalid_account_generation' };
    }
  }
  if (!isPlainObject(rawAcc.users) || !isPlainObject(rawAcc.replies)) {
    return { ok: false, reason: 'missing_users_or_replies_dict' };
  }

  const cleanUsers = {};
  for (const [uid, uVal] of Object.entries(rawAcc.users)) {
    if (!isValidDecimalId(uid) || !isPlainObject(uVal)) {
      return { ok: false, reason: 'invalid_user_entry' };
    }
    cleanUsers[uid] = {
      handle: sanitizeHandle(uVal.handle),
      displayName: sanitizeDisplayName(uVal.displayName),
      updatedAt: isValidTimestampMs(uVal.updatedAt) ? uVal.updatedAt : 1
    };
  }

  const cleanReplies = {};
  for (const [rKey, rVal] of Object.entries(rawAcc.replies)) {
    const checked = validateStrictReplyRecord(actorUserId, rKey, rVal);
    if (!checked.ok) {
      return checked;
    }
    cleanReplies[rKey] = checked.record;
    if (!Object.prototype.hasOwnProperty.call(cleanUsers, checked.record.targetUserId)) {
      cleanUsers[checked.record.targetUserId] = {
        handle: null,
        displayName: null,
        updatedAt: checked.record.observedAt
      };
    }
  }

  return {
    ok: true,
    account: {
      accountGeneration: requireGeneration ? rawAcc.accountGeneration : 0,
      handle: sanitizeHandle(rawAcc.handle),
      displayName: sanitizeDisplayName(rawAcc.displayName),
      lastCleanupAt: isValidTimestampMs(rawAcc.lastCleanupAt) ? rawAcc.lastCleanupAt : 0,
      users: cleanUsers,
      replies: cleanReplies
    }
  };
}

export function validateAndMigrateLocalState(rawState) {
  if (rawState === undefined || rawState === null) {
    return {
      ok: true,
      migrated: false,
      requiresRebind: false,
      state: createInitialLocalState()
    };
  }

  if (!isPlainObject(rawState) || hasDangerousKeys(rawState)) {
    return { ok: false, reason: 'corrupted_or_dangerous_root' };
  }

  // Case 1: Current local schemaVersion === 2
  if (rawState.schemaVersion === LOCAL_SCHEMA_VERSION) {
    if (
      !Number.isSafeInteger(rawState.revision) ||
      rawState.revision < 0 ||
      !Number.isSafeInteger(rawState.collectionGeneration) ||
      rawState.collectionGeneration < 1 ||
      !isPlainObject(rawState.settings) ||
      typeof rawState.settings.collectionEnabled !== 'boolean' ||
      !isPlainObject(rawState.accounts)
    ) {
      return { ok: false, reason: 'invalid_v2_envelope' };
    }

    const enabled = rawState.settings.collectionEnabled;
    const sessionId = rawState.settings.captureSessionId;
    if (enabled && (!Number.isSafeInteger(sessionId) || sessionId <= 0)) {
      return { ok: false, reason: 'invalid_v2_session_id' };
    }
    if (!enabled && sessionId !== null) {
      return { ok: false, reason: 'paused_v2_must_have_null_session' };
    }

    const accountIds = Object.keys(rawState.accounts);
    if (accountIds.length > MAX_ACCOUNTS) {
      return { ok: false, reason: 'too_many_accounts' };
    }

    const cleanAccounts = {};
    let totalReplies = 0;
    for (const actorId of accountIds) {
      const accRes = validateStrictAccountObject(actorId, rawState.accounts[actorId], true);
      if (!accRes.ok) {
        return accRes;
      }
      totalReplies += Object.keys(accRes.account.replies).length;
      if (totalReplies > MAX_TOTAL_REPLIES) {
        return { ok: false, reason: 'too_many_replies' };
      }
      cleanAccounts[actorId] = accRes.account;
    }

    return {
      ok: true,
      migrated: false,
      requiresRebind: false,
      state: {
        schemaVersion: LOCAL_SCHEMA_VERSION,
        revision: rawState.revision,
        collectionGeneration: rawState.collectionGeneration,
        settings: {
          collectionEnabled: enabled,
          captureSessionId: enabled ? sessionId : null
        },
        accounts: cleanAccounts
      }
    };
  }

  // Case 2: Legacy draft local schemaVersion === 1 -> Migrate to v2
  if (rawState.schemaVersion === 1) {
    if (!isPlainObject(rawState.accounts)) {
      return { ok: false, reason: 'invalid_v1_accounts' };
    }
    const accountIds = Object.keys(rawState.accounts);
    if (accountIds.length > MAX_ACCOUNTS) {
      return { ok: false, reason: 'too_many_accounts_in_v1' };
    }

    let nextRevision =
      Number.isSafeInteger(rawState.revision) && rawState.revision >= 0
        ? rawState.revision
        : 0;

    const cleanAccounts = {};
    let totalReplies = 0;
    for (const actorId of accountIds) {
      const accRes = validateStrictAccountObject(actorId, rawState.accounts[actorId], false);
      if (!accRes.ok) {
        return accRes;
      }
      totalReplies += Object.keys(accRes.account.replies).length;
      if (totalReplies > MAX_TOTAL_REPLIES) {
        return { ok: false, reason: 'too_many_replies_in_v1' };
      }
      nextRevision += 1;
      accRes.account.accountGeneration = nextRevision;
      cleanAccounts[actorId] = accRes.account;
    }

    const preserveEnabled = Boolean(
      isPlainObject(rawState.settings) && rawState.settings.collectionEnabled === true
    );
    nextRevision += 1;

    return {
      ok: true,
      migrated: true,
      requiresRebind: true,
      state: {
        schemaVersion: LOCAL_SCHEMA_VERSION,
        revision: nextRevision,
        collectionGeneration: 1,
        settings: {
          collectionEnabled: preserveEnabled,
          captureSessionId: preserveEnabled ? nextRevision : null
        },
        accounts: cleanAccounts
      }
    };
  }

  return { ok: false, reason: 'unsupported_schema_version' };
}

export function validateImportBackupText(rawText, nowMs, windowMs) {
  if (typeof rawText !== 'string') {
    return { ok: false, code: 'INVALID_FILE', message: '备份文件内容无法读取' };
  }
  const byteSize = utf8ByteSize(rawText);
  if (byteSize === 0 || byteSize > MAX_IMPORT_FILE_BYTES) {
    return {
      ok: false,
      code: 'FILE_TOO_LARGE',
      message: '备份文件为空或超过 9 MiB 上限'
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (_err) {
    return { ok: false, code: 'INVALID_JSON', message: '备份文件不是合法的 JSON' };
  }

  if (!isPlainObject(parsed) || hasDangerousKeys(parsed)) {
    return {
      ok: false,
      code: 'DANGEROUS_OR_INVALID_OBJECT',
      message: '备份文件包含非法结构或危险键名'
    };
  }

  // Explicit check for legacy x_pulse_interactions separated arrays
  if (Object.prototype.hasOwnProperty.call(parsed, 'x_pulse_interactions')) {
    return {
      ok: false,
      code: 'LEGACY_XPULSE_UNSUPPORTED',
      message: '不支持旧版 x_pulse_interactions 分离数组格式，无法可靠确定账号归属'
    };
  }

  if (
    parsed.format !== BACKUP_FORMAT ||
    parsed.formatVersion !== BACKUP_FORMAT_VERSION ||
    !isPlainObject(parsed.data) ||
    parsed.data.schemaVersion !== BACKUP_DATA_SCHEMA_VERSION ||
    !isPlainObject(parsed.data.accounts)
  ) {
    return {
      ok: false,
      code: 'UNSUPPORTED_BACKUP_FORMAT',
      message: '备份格式或版本受限，仅支持 sparklink-backup v1'
    };
  }

  const rawAccounts = parsed.data.accounts;
  const actorIds = Object.keys(rawAccounts);
  if (actorIds.length > MAX_ACCOUNTS) {
    return {
      ok: false,
      code: 'TOO_MANY_ACCOUNTS',
      message: `备份包含超过 ${MAX_ACCOUNTS} 个账号上限`
    };
  }

  const cutoff = nowMs - windowMs;
  const normalizedAccounts = {};
  const stats = {
    accountCount: actorIds.length,
    totalInspected: 0,
    eligible: 0,
    expired: 0,
    future: 0,
    selfReplies: 0,
    invalid: 0,
    keyConflicts: 0
  };

  for (const actorId of actorIds) {
    if (!isValidDecimalId(actorId)) {
      return {
        ok: false,
        code: 'INVALID_ACCOUNT_ID',
        message: '备份中存在非法的账号稳定 ID'
      };
    }
    const rawAcc = rawAccounts[actorId];
    if (
      !isPlainObject(rawAcc) ||
      !isPlainObject(rawAcc.users) ||
      !isPlainObject(rawAcc.replies)
    ) {
      return {
        ok: false,
        code: 'INVALID_ACCOUNT_DICT',
        message: '备份账号缺少必需的 users 或 replies 字典结构'
      };
    }

    const inputUsers = {};
    for (const [uid, uObj] of Object.entries(rawAcc.users)) {
      if (!isValidDecimalId(uid) || !isPlainObject(uObj)) {
        continue;
      }
      inputUsers[uid] = {
        handle: sanitizeHandle(uObj.handle),
        displayName: sanitizeDisplayName(uObj.displayName),
        updatedAt: isValidTimestampMs(uObj.updatedAt) ? uObj.updatedAt : 1
      };
    }

    const acceptedReplies = {};
    const acceptedUsers = {};
    const replyEntries = Object.entries(rawAcc.replies);

    for (let i = 0; i < replyEntries.length; i += 1) {
      const [dictKey, rVal] = replyEntries[i];
      stats.totalInspected += 1;
      if (stats.totalInspected > MAX_TOTAL_REPLIES) {
        return {
          ok: false,
          code: 'TOO_MANY_REPLIES',
          message: `备份回复条数超过 ${MAX_TOTAL_REPLIES} 条上限`
        };
      }

      if (!isPlainObject(rVal)) {
        stats.invalid += 1;
        continue;
      }

      const { replyTweetId, parentTweetId, targetUserId, createdAt, observedAt, source } = rVal;

      // Legacy draft dict key != valid replyTweetId -> compatibility conflict & skip
      if (
        isValidDecimalId(dictKey) &&
        isValidDecimalId(replyTweetId) &&
        dictKey !== replyTweetId
      ) {
        stats.keyConflicts += 1;
        continue;
      }

      if (
        !isValidDecimalId(dictKey) ||
        !isValidDecimalId(replyTweetId) ||
        !isValidDecimalId(parentTweetId) ||
        !isValidDecimalId(targetUserId) ||
        !isValidTimestampMs(createdAt) ||
        !isValidTimestampMs(observedAt) ||
        !isValidSource(source)
      ) {
        stats.invalid += 1;
        continue;
      }

      if (targetUserId === actorId) {
        stats.selfReplies += 1;
        continue;
      }

      if (createdAt > nowMs) {
        stats.future += 1;
        continue;
      }

      if (createdAt < cutoff) {
        stats.expired += 1;
        continue;
      }

      acceptedReplies[replyTweetId] = {
        replyTweetId,
        parentTweetId,
        targetUserId,
        createdAt,
        observedAt,
        source
      };
      stats.eligible += 1;

      if (!Object.prototype.hasOwnProperty.call(acceptedUsers, targetUserId)) {
        if (Object.prototype.hasOwnProperty.call(inputUsers, targetUserId)) {
          acceptedUsers[targetUserId] = inputUsers[targetUserId];
        } else {
          acceptedUsers[targetUserId] = {
            handle: null,
            displayName: null,
            updatedAt: observedAt
          };
        }
      }
    }

    normalizedAccounts[actorId] = {
      handle: sanitizeHandle(rawAcc.handle),
      displayName: sanitizeDisplayName(rawAcc.displayName),
      users: acceptedUsers,
      replies: acceptedReplies
    };
  }

  return {
    ok: true,
    accounts: normalizedAccounts,
    stats
  };
}
