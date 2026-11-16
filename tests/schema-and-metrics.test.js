import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import {
  WINDOW_MS,
  isReplyInWindow,
  getBadgeTier,
  computeAccountSummary,
  computeTargetCounts
} from '../src/metrics.js';

import {
  createInitialLocalState,
  buildSafeProfileUrl,
  formatBackupFilename,
  validateAndMigrateLocalState,
  validateImportBackupText
} from '../src/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NOW_MS = 1794794402000;

test('manifest.json strictly matches spec Section 11.2 with zero Markdown URLs or extra permissions', () => {
  const manifestRaw = fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestRaw);

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, 'SparkLink - 星火链');
  assert.equal(manifest.short_name, 'SparkLink');
  assert.equal(manifest.minimum_chrome_version, '120');
  assert.deepEqual(manifest.permissions, ['storage']);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.web_accessible_resources, undefined);
  assert.equal(manifest.externally_connectable, undefined);
  assert.deepEqual(manifest.background, {
    service_worker: 'src/background.js',
    type: 'module'
  });
  assert.equal(manifest.action.default_popup, 'src/popup/popup.html');
  assert.equal(manifest.content_scripts.length, 3);
  for (const cs of manifest.content_scripts) {
    assert.deepEqual(cs.matches, ['https://x.com/*', 'https://twitter.com/*']);
    assert.equal(cs.all_frames, false);
  }
});

test('Schema validates safe profile URLs, backup filenames, v2 state, and v1->v2 local state migration', () => {
  assert.equal(buildSafeProfileUrl('sample_friend'), 'https://x.com/sample_friend');
  assert.equal(buildSafeProfileUrl('@sample_friend'), 'https://x.com/sample_friend');
  assert.equal(buildSafeProfileUrl('javascript:alert(1)'), null);
  assert.equal(buildSafeProfileUrl('bad/path'), null);
  assert.equal(buildSafeProfileUrl(null), null);

  const fn = formatBackupFilename(new Date(2026, 10, 16, 9, 5, 7));
  assert.equal(fn, 'sparklink-backup-20261116-090507.json');

  // Empty -> clean initial v2
  const emptyRes = validateAndMigrateLocalState(undefined);
  assert.equal(emptyRes.ok, true);
  assert.equal(emptyRes.migrated, false);
  assert.deepEqual(emptyRes.state, createInitialLocalState());

  // Valid legacy local v1 -> migrated to v2 with new accountGeneration & new captureSessionId when enabled
  const legacyLocalV1 = {
    schemaVersion: 1,
    revision: 5,
    settings: {
      collectionEnabled: true
    },
    accounts: {
      '1001001': {
        handle: 'sample_me',
        displayName: '示例账号',
        users: {
          '2002002': {
            handle: 'sample_friend',
            displayName: '示例好友',
            updatedAt: 1794794401000
          }
        },
        replies: {
          '2122147641553846272': {
            replyTweetId: '2122147641553846272',
            parentTweetId: '2121785253688246272',
            targetUserId: '2002002',
            createdAt: 1794794400000,
            observedAt: 1794794401000,
            source: 'live'
          }
        }
      }
    }
  };

  const migRes = validateAndMigrateLocalState(legacyLocalV1);
  assert.equal(migRes.ok, true);
  assert.equal(migRes.migrated, true);
  assert.equal(migRes.requiresRebind, true);
  assert.equal(migRes.state.schemaVersion, 2);
  assert.equal(migRes.state.settings.collectionEnabled, true);
  assert.equal(migRes.state.settings.captureSessionId, migRes.state.revision);
  assert.ok(migRes.state.accounts['1001001'].accountGeneration >= 6);

  // Corrupted v1 with mismatched reply dictionary key fails migration without clobbering
  const brokenV1 = structuredClone(legacyLocalV1);
  brokenV1.accounts['1001001'].replies['999999'] =
    brokenV1.accounts['1001001'].replies['2122147641553846272'];
  delete brokenV1.accounts['1001001'].replies['2122147641553846272'];
  const brokenRes = validateAndMigrateLocalState(brokenV1);
  assert.equal(brokenRes.ok, false);

  // Valid v2 roundtrip & invalid v2 rejections
  const validV2Res = validateAndMigrateLocalState(migRes.state);
  assert.equal(validV2Res.ok, true);
  assert.equal(validV2Res.migrated, false);
  assert.equal(validV2Res.state.revision, migRes.state.revision);

  const badPausedV2 = structuredClone(migRes.state);
  badPausedV2.settings.collectionEnabled = false;
  badPausedV2.settings.captureSessionId = 99;
  assert.equal(validateAndMigrateLocalState(badPausedV2).ok, false);
  assert.equal(validateAndMigrateLocalState({ schemaVersion: 99 }).ok, false);
});

test('Import backup validation covers spec 9.1 sample, mixed validity, key conflict, expired/future/self filters, and legacy/dangerous rejections', () => {
  const specSampleBackup = {
    format: 'sparklink-backup',
    formatVersion: 1,
    exportedAt: '2026-11-16T02:00:01.000Z',
    data: {
      schemaVersion: 1,
      accounts: {
        '1001001': {
          handle: 'sample_me',
          displayName: '示例账号',
          firstObservedAt: 1790000000000,
          lastCleanupAt: 1794000000000,
          users: {
            '2002002': {
              handle: 'sample_friend',
              displayName: '示例好友',
              updatedAt: 1794794401000
            }
          },
          replies: {
            '2122147641553846272': {
              replyTweetId: '2122147641553846272',
              parentTweetId: '2121785253688246272',
              targetUserId: '2002002',
              createdAt: 1794794400000,
              observedAt: 1794794401000,
              source: 'live'
            }
          }
        }
      }
    }
  };

  const validRes = validateImportBackupText(JSON.stringify(specSampleBackup), NOW_MS, WINDOW_MS);
  assert.equal(validRes.ok, true);
  assert.equal(validRes.stats.eligible, 1);
  assert.equal(validRes.accounts['1001001'].firstObservedAt, undefined);

  // Mixed validity backup (Section 13 acceptance criterion):
  // 1 missing targetUserId -> invalid: 1
  // 1 valid targetUserId without user profile -> eligible: 1 with minimal user entry
  // plus 1 dict-key mismatch -> conflicts: 1, 1 expired, 1 future, 1 self-reply
  const mixedBackup = {
    format: 'sparklink-backup',
    formatVersion: 1,
    exportedAt: '2026-11-16T02:00:01.000Z',
    data: {
      schemaVersion: 1,
      accounts: {
        '1001001': {
          handle: 'sample_me',
          displayName: '示例账号',
          users: {},
          replies: {
            '2122000000000000001': {
              replyTweetId: '2122000000000000001',
              parentTweetId: '2121000000000000001',
              createdAt: NOW_MS - 1000,
              observedAt: NOW_MS - 500,
              source: 'import'
            },
            '2122000000000000002': {
              replyTweetId: '2122000000000000002',
              parentTweetId: '2121000000000000002',
              targetUserId: '3003003',
              createdAt: NOW_MS - 1000,
              observedAt: NOW_MS - 500,
              source: 'import'
            },
            '9999999999999999999': {
              replyTweetId: '2122000000000000003',
              parentTweetId: '2121000000000000003',
              targetUserId: '3003003',
              createdAt: NOW_MS - 1000,
              observedAt: NOW_MS - 500,
              source: 'live'
            },
            '2122000000000000004': {
              replyTweetId: '2122000000000000004',
              parentTweetId: '2121000000000000004',
              targetUserId: '3003003',
              createdAt: NOW_MS - WINDOW_MS - 1,
              observedAt: NOW_MS - 500,
              source: 'history'
            },
            '2122000000000000005': {
              replyTweetId: '2122000000000000005',
              parentTweetId: '2121000000000000005',
              targetUserId: '3003003',
              createdAt: NOW_MS + 5000,
              observedAt: NOW_MS,
              source: 'live'
            },
            '2122000000000000006': {
              replyTweetId: '2122000000000000006',
              parentTweetId: '2121000000000000006',
              targetUserId: '1001001',
              createdAt: NOW_MS - 1000,
              observedAt: NOW_MS,
              source: 'live'
            }
          }
        }
      }
    }
  };

  const mixedRes = validateImportBackupText(JSON.stringify(mixedBackup), NOW_MS, WINDOW_MS);
  assert.equal(mixedRes.ok, true);
  assert.equal(mixedRes.stats.eligible, 1);
  assert.equal(mixedRes.stats.invalid, 1);
  assert.equal(mixedRes.stats.keyConflicts, 1);
  assert.equal(mixedRes.stats.expired, 1);
  assert.equal(mixedRes.stats.future, 1);
  assert.equal(mixedRes.stats.selfReplies, 1);
  assert.deepEqual(mixedRes.accounts['1001001'].users['3003003'], {
    handle: null,
    displayName: null,
    updatedAt: NOW_MS - 500
  });

  // Reject legacy x_pulse_interactions, wrong formatVersion, and __proto__
  assert.equal(
    validateImportBackupText('{"x_pulse_interactions":{"alice":{"timestamps":[1]}}}', NOW_MS, WINDOW_MS).code,
    'LEGACY_XPULSE_UNSUPPORTED'
  );
  assert.equal(
    validateImportBackupText('{"format":"sparklink-backup","formatVersion":99,"data":{}}', NOW_MS, WINDOW_MS).ok,
    false
  );
  assert.equal(
    validateImportBackupText(
      '{"format":"sparklink-backup","formatVersion":1,"__proto__":{"a":1},"data":{"schemaVersion":1,"accounts":{}}}',
      NOW_MS,
      WINDOW_MS
    ).ok,
    false
  );
});

test('Metrics enforce exact 30x24h rolling boundaries, badge tiers (0/1/10/11/50/51), Top 20 tie-breaking, and clock skew', () => {
  assert.equal(WINDOW_MS, 2592000000);
  assert.equal(isReplyInWindow(NOW_MS - WINDOW_MS, NOW_MS), true);
  assert.equal(isReplyInWindow(NOW_MS, NOW_MS), true);
  assert.equal(isReplyInWindow(NOW_MS - WINDOW_MS - 1, NOW_MS), false);
  assert.equal(isReplyInWindow(NOW_MS + 1, NOW_MS), false);

  assert.equal(getBadgeTier(0).render, false);
  assert.equal(getBadgeTier(1).tier, 'acquaintance');
  assert.equal(getBadgeTier(10).tier, 'acquaintance');
  assert.equal(getBadgeTier(11).tier, 'active');
  assert.equal(getBadgeTier(50).tier, 'active');
  assert.equal(getBadgeTier(51).tier, 'deep');
  assert.equal(getBadgeTier(51).showCount, true);
  assert.equal(getBadgeTier(51).tooltip, '近30天已记录你回复TA 51 次（含导入）');

  const replies = {};
  let tweetSeq = 1;
  function addReplies(targetUserId, count, lastCreatedAt) {
    for (let i = 0; i < count; i += 1) {
      const id = String(3000000000000000000n + BigInt(tweetSeq++));
      replies[id] = {
        replyTweetId: id,
        parentTweetId: String(2000000000000000000n + BigInt(tweetSeq)),
        targetUserId,
        createdAt: i === count - 1 ? lastCreatedAt : NOW_MS - 100000 - i,
        observedAt: NOW_MS,
        source: 'live'
      };
    }
  }

  // Deep user (51), Active user (11), Tie-break pair on count=5 & same lastCreatedAt ('2009' vs '2002'),
  //Tie-break pair on count=5 & different lastCreatedAt ('3001' newer than '3002'), plus 1 expired & 1 future
  addReplies('10051', 51, NOW_MS - 1000);
  addReplies('10011', 11, NOW_MS - 2000);
  addReplies('3002', 5, NOW_MS - 5000);
  addReplies('3001', 5, NOW_MS - 3000);
  addReplies('2009', 5, NOW_MS - 8000);
  addReplies('2002', 5, NOW_MS - 8000);

  // Expired (now - WINDOW_MS - 1) & future (now + 120_000 -> clock skew)
  replies['9000000000000000001'] = {
    replyTweetId: '9000000000000000001',
    parentTweetId: '8000000000000000001',
    targetUserId: '2002',
    createdAt: NOW_MS - WINDOW_MS - 1,
    observedAt: NOW_MS,
    source: 'history'
  };
  replies['9000000000000000002'] = {
    replyTweetId: '9000000000000000002',
    parentTweetId: '8000000000000000002',
    targetUserId: '2002',
    createdAt: NOW_MS + 120000,
    observedAt: NOW_MS,
    source: 'live'
  };

  const accountObj = {
    accountGeneration: 1,
    handle: 'sample_me',
    displayName: '示例账号',
    users: {
      '10051': { handle: 'deep_friend', displayName: 'Deep', updatedAt: NOW_MS },
      '10011': { handle: 'active_friend', displayName: 'Active', updatedAt: NOW_MS }
    },
    replies
  };

  const summary = computeAccountSummary(accountObj, NOW_MS);
  assert.equal(summary.totalReplies, 51 + 11 + 5 * 4);
  assert.equal(summary.activeTargetsCount, 2); // deep is included in active (>=11)
  assert.equal(summary.deepTargetsCount, 1);
  assert.equal(summary.latestReplyAt, NOW_MS - 1000);
  assert.equal(summary.clockSkewDetected, true);
  assert.deepEqual(
    summary.top20.map((item) => item.targetUserId),
    ['10051', '10011', '3001', '3002', '2002', '2009']
  );

  const targetCounts = computeTargetCounts(accountObj, ['10051', '2002', '99999'], NOW_MS);
  assert.deepEqual(targetCounts, {
    '10051': 51,
    '2002': 5,
    '99999': 0
  });
});
