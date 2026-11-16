import test from 'node:test';
import assert from 'node:assert/strict';

import { WINDOW_MS } from '../src/metrics.js';
import { STATE_STORAGE_KEY } from '../src/schema.js';
import { createStorageController } from '../src/storage.js';

const NOW_MS = 1794794402000;

function createMockStorageArea(initialData = {}, options = {}) {
  let store = structuredClone(initialData);
  let failWrites = Boolean(options.failWrites);

  return {
    async get(key) {
      if (typeof key === 'string') {
        return Object.prototype.hasOwnProperty.call(store, key)
          ? { [key]: structuredClone(store[key]) }
          : {};
      }
      return structuredClone(store);
    },
    async set(items) {
      if (failWrites) {
        throw new Error('QuotaExceededError: chrome.storage.local quota exceeded');
      }
      store = { ...store, ...structuredClone(items) };
    },
    async getBytesInUse() {
      return Buffer.byteLength(JSON.stringify(store), 'utf8');
    },
    setFailWrites(flag) {
      failWrites = flag;
    },
    peekRaw() {
      return structuredClone(store);
    }
  };
}

function buildEvent(actorUserId, idx, overrides = {}) {
  return {
    actorUserId,
    replyTweetId: String(2122147641553800000n + BigInt(idx)),
    parentTweetId: String(2121785253688200000n + BigInt(idx)),
    targetUserId: '2002002',
    targetHandle: 'sample_friend',
    targetDisplayName: '示例好友',
    createdAt: NOW_MS - 10000 + idx,
    observedAt: NOW_MS - 5000 + idx,
    source: 'live',
    ...overrides
  };
}

test('Concurrent 100 events across two tabs serialize cleanly to exact count 100, and retry after restart is idempotent', async () => {
  const area = createMockStorageArea();
  const storage = createStorageController(area, { nowFn: () => NOW_MS });

  const enableRes = await storage.setCollectionEnabled(true);
  assert.equal(enableRes.ok, true);
  const captureSessionId = enableRes.settings.captureSessionId;

  const accRes = await storage.ensureViewerAccount({
    actorUserId: '1001001',
    handle: 'sample_me',
    displayName: '示例账号'
  });
  assert.equal(accRes.ok, true);

  const bindingCtx = {
    bindingId: 'bind_1',
    actorUserId: '1001001',
    captureSessionId,
    collectionGeneration: accRes.collectionGeneration,
    accountGeneration: accRes.accountGeneration
  };

  const tab1Events = Array.from({ length: 50 }, (_, i) => buildEvent('1001001', i + 1));
  const tab2Events = Array.from({ length: 50 }, (_, i) => buildEvent('1001001', i + 51));

  // Submit concurrently from two tabs
  const [r1, r2] = await Promise.all([
    storage.mergeObservedBatch({ bindingContext: bindingCtx, events: tab1Events }),
    storage.mergeObservedBatch({ bindingContext: bindingCtx, events: tab2Events })
  ]);
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);

  // Simulate Worker restart on the same underlying storage area and retry tab1 batch
  const restartedStorage = createStorageController(area, { nowFn: () => NOW_MS });
  const retryRes = await restartedStorage.mergeObservedBatch({
    bindingContext: bindingCtx,
    events: tab1Events.map((e) => ({ ...e, source: 'history', observedAt: NOW_MS }))
  });
  assert.equal(retryRes.ok, true);
  assert.equal(retryRes.added, 0);
  assert.equal(retryRes.duplicates, 50);

  const snapshot = await restartedStorage.getAccountSnapshot('1001001', NOW_MS);
  assert.equal(snapshot.summary.totalReplies, 100);
  // Original 'live' source preserved on duplicate retry
  const rawState = area.peekRaw()[STATE_STORAGE_KEY];
  assert.equal(
    rawState.accounts['1001001'].replies[tab1Events[0].replyTweetId].source,
    'live'
  );

  // Conflicting reply with same replyTweetId but different targetUserId preserves original & reports conflict
  const conflictRes = await restartedStorage.mergeObservedBatch({
    bindingContext: bindingCtx,
    events: [{ ...tab1Events[0], targetUserId: '9999999' }]
  });
  assert.equal(conflictRes.ok, true);
  assert.equal(conflictRes.conflicts, 1);
  assert.equal(
    area.peekRaw()[STATE_STORAGE_KEY].accounts['1001001'].replies[tab1Events[0].replyTweetId].targetUserId,
    '2002002'
  );
});

test('Single-account clear isolates Account A from Account B and rejects late batches even after A is recreated', async () => {
  const area = createMockStorageArea();
  const storage = createStorageController(area, { nowFn: () => NOW_MS });

  const { settings } = await storage.setCollectionEnabled(true);
  const accA1 = await storage.ensureViewerAccount({ actorUserId: '1001001', handle: 'user_a' });
  const accB1 = await storage.ensureViewerAccount({ actorUserId: '9009009', handle: 'user_b' });

  const bindA1 = {
    bindingId: 'bind_a1',
    actorUserId: '1001001',
    captureSessionId: settings.captureSessionId,
    collectionGeneration: accA1.collectionGeneration,
    accountGeneration: accA1.accountGeneration
  };
  const bindB1 = {
    bindingId: 'bind_b1',
    actorUserId: '9009009',
    captureSessionId: settings.captureSessionId,
    collectionGeneration: accB1.collectionGeneration,
    accountGeneration: accB1.accountGeneration
  };

  // Clear Account A
  const clearARes = await storage.clearAccount('1001001', accA1.accountGeneration);
  assert.equal(clearARes.ok, true);

  // Recreate Account A with same ID -> gets strictly larger accountGeneration
  const accA2 = await storage.ensureViewerAccount({ actorUserId: '1001001', handle: 'user_a' });
  assert.ok(accA2.accountGeneration > accA1.accountGeneration);

  // Late batches from both old A1 and existing B1 arrive now:
  // A1 must be rejected as STALE_BINDING (0 added), B1 must succeed (+1 added)!
  const lateA = await storage.mergeObservedBatch({
    bindingContext: bindA1,
    events: [buildEvent('1001001', 1)]
  });
  const lateB = await storage.mergeObservedBatch({
    bindingContext: bindB1,
    events: [buildEvent('9009009', 2)]
  });

  assert.equal(lateA.ok, false);
  assert.equal(lateA.code, 'STALE_BINDING');
  assert.equal(lateB.ok, true);
  assert.equal(lateB.added, 1);

  assert.equal((await storage.getAccountSnapshot('1001001', NOW_MS)).summary.totalReplies, 0);
  assert.equal((await storage.getAccountSnapshot('9009009', NOW_MS)).summary.totalReplies, 1);
});

test('Backup export/import roundtrip, stale preview rejection after Clear All, expired orphan cleanup, and quota/write failure rollback', async () => {
  let clock = NOW_MS;
  const area = createMockStorageArea();
  const storage = createStorageController(area, {
    nowFn: () => clock,
    warnBudgetBytes: 500,
    appBudgetBytes: 3000,
    maxTotalReplies: 5
  });

  const { settings } = await storage.setCollectionEnabled(true);
  const acc = await storage.ensureViewerAccount({
    actorUserId: '1001001',
    handle: 'sample_me',
    displayName: '示例账号'
  });
  const bind = {
    bindingId: 'bind_1',
    actorUserId: '1001001',
    captureSessionId: settings.captureSessionId,
    collectionGeneration: acc.collectionGeneration,
    accountGeneration: acc.accountGeneration
  };

  // Insert 1 reply that will expire soon (target 4004) and 1 fresh reply (target 2002002)
  await storage.mergeObservedBatch({
    bindingContext: bind,
    events: [
      buildEvent('1001001', 1, {
        targetUserId: '4004',
        targetHandle: 'soon_expired',
        createdAt: clock - WINDOW_MS + 100
      }),
      buildEvent('1001001', 2, {
        targetUserId: '2002002',
        targetHandle: 'sample_friend',
        createdAt: clock - 1000
      })
    ]
  });

  // Advance clock by 200ms so reply #1 expires -> exportBackup cleans expired reply AND orphan user '4004'
  clock += 200;
  const exported = await storage.exportBackup(clock);
  assert.equal(exported.ok, true);
  assert.equal(exported.backup.format, 'sparklink-backup');
  assert.equal(exported.backup.formatVersion, 1);
  assert.equal(Object.keys(exported.backup.data.accounts['1001001'].replies).length, 1);
  assert.equal(exported.backup.data.accounts['1001001'].users['4004'], undefined);
  assert.equal(exported.backup.data.accounts['1001001'].accountGeneration, undefined);

  const backupJson = JSON.stringify(exported.backup);

  // Preview import on current state, then Clear All BEFORE confirming -> commitImport must return PREVIEW_STALE!
  const previewBeforeClear = await storage.previewImport(backupJson, clock);
  assert.equal(previewBeforeClear.ok, true);
  assert.equal(previewBeforeClear.preview.duplicates, 1);

  const clearAllRes = await storage.clearAllData();
  assert.equal(clearAllRes.ok, true);
  assert.equal(clearAllRes.settings.collectionEnabled, false);

  const staleCommit = await storage.commitImport(
    backupJson,
    previewBeforeClear.baseline,
    clock
  );
  assert.equal(staleCommit.ok, false);
  assert.equal(staleCommit.code, 'PREVIEW_STALE');
  assert.equal(staleCommit.freshPreview.preview.added, 1);

  // Confirm with fresh baseline on empty device -> restores 1 record while keeping collectionEnabled = false!
  const validCommit = await storage.commitImport(
    backupJson,
    staleCommit.freshPreview.baseline,
    clock
  );
  assert.equal(validCommit.ok, true);
  assert.equal(validCommit.added, 1);

  const stateAfterImport = await storage.getPopupSnapshot(null, clock);
  assert.equal(stateAfterImport.settings.collectionEnabled, false);
  assert.equal(stateAfterImport.selectedAccount.summary.totalReplies, 1);
  assert.equal(stateAfterImport.selectedAccount.summary.latestReplyAt, NOW_MS - 1000);
  assert.equal(stateAfterImport.nearQuotaWarning, true); // >500 bytes warn threshold

  // Re-importing same backup keeps count = 1 and preserves original source & observedAt
  const dupPreview = await storage.previewImport(backupJson, clock);
  const dupCommit = await storage.commitImport(backupJson, dupPreview.baseline, clock);
  assert.equal(dupCommit.ok, true);
  assert.equal(dupCommit.added, 0);
  assert.equal(dupCommit.duplicates, 1);

  // Exceeding maxTotalReplies (5) rejects batch without deleting existing in-window data
  const reEnable = await storage.setCollectionEnabled(true);
  const curAccGen = area.peekRaw()[STATE_STORAGE_KEY].accounts['1001001'].accountGeneration;
  const curColGen = area.peekRaw()[STATE_STORAGE_KEY].collectionGeneration;
  const bindAfter = {
    bindingId: 'bind_after',
    actorUserId: '1001001',
    captureSessionId: reEnable.settings.captureSessionId,
    collectionGeneration: curColGen,
    accountGeneration: curAccGen
  };

  const quotaFail = await storage.mergeObservedBatch({
    bindingContext: bindAfter,
    events: Array.from({ length: 6 }, (_, i) => buildEvent('1001001', 100 + i, { createdAt: clock - 50 }))
  });
  assert.equal(quotaFail.ok, false);
  assert.equal(quotaFail.code, 'QUOTA_EXCEEDED');
  // Existing 1 reply still intact and export still works!
  assert.equal((await storage.getAccountSnapshot('1001001', clock)).summary.totalReplies, 1);
  assert.equal((await storage.exportBackup(clock)).ok, true);

  // Underlying Chrome storage write failure rolls back cleanly without corrupting memory
  area.setFailWrites(true);
  const writeFail = await storage.mergeObservedBatch({
    bindingContext: bindAfter,
    events: [buildEvent('1001001', 999, { createdAt: clock - 10 })]
  });
  assert.equal(writeFail.ok, false);
  assert.equal(writeFail.code, 'STORAGE_WRITE_FAILED');
  assert.equal((await storage.getAccountSnapshot('1001001', clock)).summary.totalReplies, 1);
});

test('Boot-time v1->v2 migration persistence, corrupted state protection, queryCountsForAccount, and observedUsers handle rename', async () => {
  const v1Area = createMockStorageArea({
    [STATE_STORAGE_KEY]: {
      schemaVersion: 1,
      revision: 2,
      settings: { collectionEnabled: true },
      accounts: {
        '1001001': {
          handle: 'old_me',
          displayName: 'Old Me',
          users: {
            '2002002': { handle: 'old_friend', displayName: 'Old Friend', updatedAt: NOW_MS - 10000 }
          },
          replies: {
            '2122147641553846272': {
              replyTweetId: '2122147641553846272',
              parentTweetId: '2121785253688246272',
              targetUserId: '2002002',
              createdAt: NOW_MS - 5000,
              observedAt: NOW_MS - 4000,
              source: 'live'
            }
          }
        }
      }
    }
  });

  const migratedCtrl = createStorageController(v1Area, { nowFn: () => NOW_MS });
  const bootInfo = await migratedCtrl.init();
  assert.equal(bootInfo.ok, true);
  assert.equal(bootInfo.migratedOnBoot, true);

  const ctrlState = await migratedCtrl.getControlState();
  assert.equal(ctrlState.ok, true);
  assert.equal(ctrlState.settings.collectionEnabled, true);
  assert.ok(ctrlState.settings.captureSessionId > 2);

  // Update profiles via observedUsers & queryCountsForAccount
  const bind = {
    bindingId: 'bind_mig',
    actorUserId: '1001001',
    captureSessionId: ctrlState.settings.captureSessionId,
    collectionGeneration: ctrlState.collectionGeneration,
    accountGeneration: ctrlState.accountGenerations['1001001']
  };
  const upd = await migratedCtrl.mergeObservedBatch({
    bindingContext: bind,
    events: [],
    observedUsers: [
      { userId: '1001001', handle: 'new_me', displayName: 'New Me' },
      { userId: '2002002', handle: 'renamed_friend', displayName: 'Renamed Friend' }
    ]
  });
  assert.equal(upd.ok, true);

  const counts = await migratedCtrl.queryCountsForAccount('1001001', ['2002002', '404'], NOW_MS);
  assert.deepEqual(counts.counts, { '2002002': 1, '404': 0 });

  const snap = await migratedCtrl.getAccountSnapshot('1001001', NOW_MS);
  assert.equal(snap.handle, 'new_me');
  assert.equal(snap.summary.top20[0].handle, 'renamed_friend');

  // Corrupted snapshot is preserved untouched and returns STATE_CORRUPTED
  const badRaw = { [STATE_STORAGE_KEY]: { schemaVersion: 999, keepMe: 'untouched' } };
  const badArea = createMockStorageArea(badRaw);
  const badCtrl = createStorageController(badArea);
  const badInit = await badCtrl.init();
  assert.equal(badInit.ok, false);
  assert.equal((await badCtrl.setCollectionEnabled(true)).code, 'STATE_CORRUPTED');
  assert.equal(badArea.peekRaw()[STATE_STORAGE_KEY].keepMe, 'untouched');
});
