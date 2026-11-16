import {
  MAX_IMPORT_FILE_BYTES,
  buildSafeProfileUrl,
  isValidDecimalId
} from '../schema.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const FLAME_PATH_D =
  'M8.6 1.2c.3 2.1-.6 3.5-1.8 4.8-1.1 1.2-2.1 2.4-2.1 4.2 0 2.3 1.8 4.1 4.1 4.1 2.6 0 4.5-2.1 4.5-4.8 0-2.6-1.6-4.7-3.1-6.1-.2 1.1-.8 1.9-1.6 2.4.3-1.4.4-2.9 0-4.6z';

function pad2(num) {
  return String(num).padStart(2, '0');
}

export function formatLocalTimestamp(ms) {
  if (!Number.isSafeInteger(ms) || ms <= 0) {
    return null;
  }
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(
    d.getHours()
  )}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function formatAccountOptionLabel(acc, activeTabActorUserId) {
  const base = acc.handle
    ? `@${acc.handle}`
    : acc.displayName
    ? acc.displayName
    : `ID: ${acc.actorUserId}`;
  return acc.actorUserId === activeTabActorUserId ? `${base} (当前页)` : base;
}

function deriveAvatarInitial(entry) {
  const candidate = (entry.displayName || entry.handle || '').trim();
  if (!candidate) {
    return '#';
  }
  const chars = Array.from(candidate);
  return chars[0] ? chars[0].toUpperCase() : '#';
}

function createFlameSvg(doc) {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '12');
  svg.setAttribute('aria-hidden', 'true');
  const path = doc.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', FLAME_PATH_D);
  path.setAttribute('fill', 'currentColor');
  svg.appendChild(path);
  return svg;
}

export function createPopupController(options = {}) {
  const doc = options.document || (typeof document !== 'undefined' ? document : null);
  const runtime =
    options.runtime ||
    (typeof chrome === 'object' && chrome && chrome.runtime ? chrome.runtime : null);
  const urlApi = options.urlApi || (typeof URL !== 'undefined' ? URL : null);

  if (!doc || !runtime || typeof runtime.sendMessage !== 'function') {
    return null;
  }

  const els = {
    collectionToggle: doc.getElementById('collection-toggle'),
    btnEnableCta: doc.getElementById('btn-enable-cta'),
    activationBanner: doc.getElementById('initial-activation-banner'),
    accountSelect: doc.getElementById('account-select'),
    viewerStatusBadge: doc.getElementById('viewer-status-badge'),
    statusBanners: doc.getElementById('status-banners'),
    overviewTitle: doc.getElementById('overview-title'),
    overviewCoverage: doc.getElementById('overview-coverage'),
    latestReplyTime: doc.getElementById('latest-reply-time'),
    statTotalReplies: doc.getElementById('stat-total-replies'),
    statActiveTargets: doc.getElementById('stat-active-targets'),
    statDeepTargets: doc.getElementById('stat-deep-targets'),
    top20List: doc.getElementById('top20-list'),
    top20Empty: doc.getElementById('top20-empty'),
    btnCleanup: doc.getElementById('btn-cleanup'),
    btnExport: doc.getElementById('btn-export'),
    btnImport: doc.getElementById('btn-import'),
    fileImport: doc.getElementById('file-import'),
    btnClearAccount: doc.getElementById('btn-clear-account'),
    btnClearAll: doc.getElementById('btn-clear-all'),
    actionFeedback: doc.getElementById('action-feedback'),
    modalOverlay: doc.getElementById('modal-overlay'),
    modalTitle: doc.getElementById('modal-title'),
    modalBody: doc.getElementById('modal-body'),
    btnModalConfirm: doc.getElementById('btn-modal-confirm'),
    btnModalCancel: doc.getElementById('btn-modal-cancel')
  };

  let userSelectedActorId = null;
  let currentSnapshot = null;
  let pendingModalAction = null;

  async function sendToBackground(payload) {
    try {
      const res = await runtime.sendMessage(payload);
      return res || { ok: false, message: '后台未返回响应' };
    } catch (_err) {
      return { ok: false, message: '无法连接扩展后台服务' };
    }
  }

  function showFeedback(text) {
    if (!els.actionFeedback) {
      return;
    }
    if (!text) {
      els.actionFeedback.hidden = true;
      els.actionFeedback.textContent = '';
      return;
    }
    els.actionFeedback.textContent = text;
    els.actionFeedback.hidden = false;
  }

  function closeModal() {
    pendingModalAction = null;
    if (els.modalOverlay) {
      els.modalOverlay.hidden = true;
    }
    if (els.modalBody) {
      els.modalBody.replaceChildren();
    }
    if (els.btnModalConfirm) {
      els.btnModalConfirm.disabled = false;
    }
  }

  function openModal({ title, lines, confirmText = '确认', confirmDisabled = false, action }) {
    pendingModalAction = action;
    if (els.modalTitle) {
      els.modalTitle.textContent = title;
    }
    if (els.modalBody) {
      const pNodes = lines.map((line) => {
        const p = doc.createElement('p');
        p.textContent = line;
        return p;
      });
      els.modalBody.replaceChildren(...pNodes);
    }
    if (els.btnModalConfirm) {
      els.btnModalConfirm.textContent = confirmText;
      els.btnModalConfirm.disabled = Boolean(confirmDisabled);
    }
    if (els.modalOverlay) {
      els.modalOverlay.hidden = false;
    }
  }

  function buildImportPreviewLines(preview) {
    const accNames =
      Array.isArray(preview.involvedAccounts) && preview.involvedAccounts.length > 0
        ? preview.involvedAccounts
            .map((a) => (a.handle ? `@${a.handle}` : a.displayName || a.actorUserId))
            .join(', ')
        : '无有效账号记录';

    const lines = [
      `涉及账号：${accNames}`,
      `预计新增：${preview.added} 条`,
      `重复跳过：${preview.duplicates} 条`,
      `过期过滤：${preview.expired} 条`,
      `无效记录：${preview.invalid} 条`,
      `兼容或字段冲突：${preview.conflicts} 条`
    ];
    if (preview.future > 0) {
      lines.push(`未来时间过滤：${preview.future} 条`);
    }
    if (preview.selfReplies > 0) {
      lines.push(`自回复过滤：${preview.selfReplies} 条`);
    }
    if (preview.wouldExceedQuota) {
      lines.push('警告：合并后超出本地存储上限，无法导入。');
    } else if (preview.nearQuotaWarning) {
      lines.push('提示：合并后存储占用接近 7 MiB 预警线。');
    }
    return lines;
  }

  function renderBanners(snap) {
    if (!els.statusBanners) {
      return;
    }
    const items = [];

    const addBanner = (text, isError = false) => {
      const div = doc.createElement('div');
      div.className = isError ? 'banner-item banner-error' : 'banner-item';
      div.textContent = text;
      items.push(div);
    };

    if (!snap || !snap.ok) {
      addBanner((snap && snap.message) || '本地存储状态异常，已保留原快照', true);
      els.statusBanners.replaceChildren(...items);
      return;
    }

    if (snap.lastStorageError) {
      addBanner(snap.lastStorageError, true);
    }
    if (snap.nearQuotaWarning) {
      addBanner('本地存储占用接近 7 MiB，建议导出备份并清理数据。', false);
    }
    if (snap.viewerStatus === 'unconfirmed') {
      addBanner('当前 X 页面登录账号尚未确认，请在页面正常浏览或刷新后同步。', false);
    }
    if (
      snap.diagnostics &&
      (snap.diagnostics.partialUnrecognized ||
        snap.diagnostics.incompleteObservation ||
        snap.diagnostics.observationDropped)
    ) {
      addBanner('部分网页响应无法识别或未完整读取，未知结构已安全跳过。', false);
    }
    if (snap.selectedAccount && snap.selectedAccount.summary.clockSkewDetected) {
      addBanner('检测到异常未来时间记录，请检查当前设备系统时钟。', false);
    }

    els.statusBanners.replaceChildren(...items);
  }

  function renderViewerStatusBadge(snap) {
    if (!els.viewerStatusBadge) {
      return;
    }
    if (!snap || !snap.ok) {
      els.viewerStatusBadge.textContent = '存储异常';
      return;
    }
    if (!snap.settings.collectionEnabled) {
      els.viewerStatusBadge.textContent = '已暂停';
      return;
    }
    if (snap.viewerStatus === 'bound') {
      els.viewerStatusBadge.textContent = '采集中';
      return;
    }
    if (snap.viewerStatus === 'unconfirmed') {
      els.viewerStatusBadge.textContent = '账号待确认';
      return;
    }
    els.viewerStatusBadge.textContent = '无活动 X 页';
  }

  function renderTop20(summary) {
    if (!els.top20List || !els.top20Empty) {
      return;
    }
    const list = summary && Array.isArray(summary.top20) ? summary.top20 : [];
    if (list.length === 0) {
      els.top20Empty.hidden = false;
      els.top20List.replaceChildren();
      return;
    }

    els.top20Empty.hidden = true;
    const rows = list.map((entry, idx) => {
      const li = doc.createElement('li');
      li.className = 'top20-item';

      const left = doc.createElement('div');
      left.className = 'top20-left';

      const rank = doc.createElement('span');
      rank.className = 'rank-num';
      rank.textContent = `${idx + 1}`;

      const avatar = doc.createElement('div');
      avatar.className = 'local-avatar';
      avatar.setAttribute('aria-hidden', 'true');
      avatar.textContent = deriveAvatarInitial(entry);

      const meta = doc.createElement('div');
      meta.className = 'user-meta';

      const primaryLabel =
        entry.displayName || (entry.handle ? `@${entry.handle}` : `ID: ${entry.targetUserId}`);
      const safeUrl = buildSafeProfileUrl(entry.handle);

      if (safeUrl) {
        const link = doc.createElement('a');
        link.className = 'user-name-link';
        link.setAttribute('href', safeUrl);
        link.setAttribute('target', '_blank');
        link.setAttribute('rel', 'noopener noreferrer');
        link.textContent = primaryLabel;
        meta.appendChild(link);
      } else {
        const plain = doc.createElement('span');
        plain.className = 'user-name-plain';
        plain.textContent = primaryLabel;
        meta.appendChild(plain);
      }

      const subLine = doc.createElement('span');
      subLine.className = 'user-handle-line';
      subLine.textContent = entry.handle
        ? `@${entry.handle}`
        : `用户 ID: ${entry.targetUserId}`;
      meta.appendChild(subLine);

      left.appendChild(rank);
      left.appendChild(avatar);
      left.appendChild(meta);

      const right = doc.createElement('div');
      right.className = 'top20-right';

      const tierKey = entry.tierInfo ? entry.tierInfo.tier : 'acquaintance';
      const tierLabel = entry.tierInfo ? entry.tierInfo.label : '初识互动';

      const pill = doc.createElement('span');
      pill.className = `tier-pill tier-pill-${tierKey}`;
      pill.setAttribute(
        'title',
        entry.tierInfo && entry.tierInfo.tooltip ? entry.tierInfo.tooltip : tierLabel
      );
      pill.appendChild(createFlameSvg(doc));

      const pillText = doc.createElement('span');
      pillText.textContent = `${tierLabel} · ${entry.count}`;
      pill.appendChild(pillText);

      right.appendChild(pill);
      li.appendChild(left);
      li.appendChild(right);
      return li;
    });

    els.top20List.replaceChildren(...rows);
  }

  function renderSnapshot(snap) {
    currentSnapshot = snap;

    if (els.overviewTitle) {
      els.overviewTitle.textContent = '近 30 天已记录的主动回复（含导入）';
    }
    if (els.overviewCoverage) {
      els.overviewCoverage.textContent =
        '来源包括本机网页活动和导入的备份，历史记录可能不完整。';
    }

    renderViewerStatusBadge(snap);
    renderBanners(snap);

    if (!snap || !snap.ok) {
      if (els.collectionToggle) els.collectionToggle.checked = false;
      if (els.activationBanner) els.activationBanner.hidden = true;
      if (els.btnClearAccount) els.btnClearAccount.disabled = true;
      return;
    }

    const enabled = Boolean(snap.settings.collectionEnabled);
    if (els.collectionToggle) {
      els.collectionToggle.checked = enabled;
    }
    if (els.activationBanner) {
      els.activationBanner.hidden = enabled;
    }

    // Account selector options
    if (els.accountSelect) {
      const accounts = Array.isArray(snap.savedAccounts) ? snap.savedAccounts : [];
      if (accounts.length === 0) {
        const emptyOpt = doc.createElement('option');
        emptyOpt.value = '';
        emptyOpt.textContent = '暂无已存账号';
        els.accountSelect.replaceChildren(emptyOpt);
        els.accountSelect.value = '';
        els.accountSelect.disabled = true;
      } else {
        const opts = accounts.map((acc) => {
          const opt = doc.createElement('option');
          opt.value = acc.actorUserId;
          opt.textContent = formatAccountOptionLabel(acc, snap.activeTabActorUserId);
          return opt;
        });
        els.accountSelect.replaceChildren(...opts);
        els.accountSelect.disabled = false;
        const selectedId = snap.selectedAccount ? snap.selectedAccount.actorUserId : accounts[0].actorUserId;
        els.accountSelect.value = selectedId;
      }
    }

    const summary = snap.selectedAccount ? snap.selectedAccount.summary : null;
    const totalReplies = summary ? summary.totalReplies : 0;
    const activeCount = summary ? summary.activeTargetsCount : 0;
    const deepCount = summary ? summary.deepTargetsCount : 0;

    if (els.statTotalReplies) els.statTotalReplies.textContent = String(totalReplies);
    if (els.statActiveTargets) els.statActiveTargets.textContent = String(activeCount);
    if (els.statDeepTargets) els.statDeepTargets.textContent = String(deepCount);

    if (els.latestReplyTime) {
      const formattedLatest =
        summary && summary.latestReplyAt ? formatLocalTimestamp(summary.latestReplyAt) : null;
      els.latestReplyTime.textContent = formattedLatest
        ? `最近回复时间：${formattedLatest}`
        : '尚无已记录回复';
    }

    if (els.btnClearAccount) {
      els.btnClearAccount.disabled = !snap.selectedAccount;
    }

    renderTop20(summary);
  }

  async function refresh() {
    const msg = { type: 'GET_POPUP_SNAPSHOT' };
    if (isValidDecimalId(userSelectedActorId)) {
      msg.preferredActorUserId = userSelectedActorId;
    }
    const snap = await sendToBackground(msg);
    if (
      snap &&
      snap.ok &&
      userSelectedActorId &&
      (!snap.selectedAccount || snap.selectedAccount.actorUserId !== userSelectedActorId)
    ) {
      userSelectedActorId = null;
    }
    renderSnapshot(snap);
    return snap;
  }

  async function setEnabled(nextEnabled) {
    const res = await sendToBackground({
      type: 'SET_COLLECTION_ENABLED',
      enabled: Boolean(nextEnabled)
    });
    if (!res || !res.ok) {
      showFeedback((res && res.message) || '切换采集状态失败');
    } else {
      showFeedback(nextEnabled ? '已开启本浏览器本地统计' : '已暂停本浏览器采集');
    }
    await refresh();
  }

  function triggerJsonDownload(filename, backupObj, rawJson) {
    // Use compact JSON serialization so states near the 8 MiB app budget stay well under the 9 MiB import limit
    const jsonText = typeof rawJson === 'string' ? rawJson : JSON.stringify(backupObj);
    const blob = new Blob([jsonText], { type: 'application/json' });
    const objectUrl = urlApi.createObjectURL(blob);
    try {
      const a = doc.createElement('a');
      a.setAttribute('href', objectUrl);
      a.setAttribute('download', filename);
      doc.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      urlApi.revokeObjectURL(objectUrl);
    }
  }

  function bindEvents() {
    if (els.collectionToggle) {
      els.collectionToggle.addEventListener('change', async () => {
        await setEnabled(els.collectionToggle.checked);
      });
    }

    if (els.btnEnableCta) {
      els.btnEnableCta.addEventListener('click', async () => {
        await setEnabled(true);
      });
    }

    if (els.accountSelect) {
      els.accountSelect.addEventListener('change', async () => {
        const val = els.accountSelect.value;
        userSelectedActorId = isValidDecimalId(val) ? val : null;
        await refresh();
      });
    }

    if (els.btnCleanup) {
      els.btnCleanup.addEventListener('click', async () => {
        const res = await sendToBackground({ type: 'CLEANUP_EXPIRED' });
        if (res && res.ok) {
          showFeedback(`已清理 ${res.removedReplies || 0} 条过期记录`);
        } else {
          showFeedback((res && res.message) || '清理失败');
        }
        await refresh();
      });
    }

    if (els.btnExport) {
      els.btnExport.addEventListener('click', () => {
        openModal({
          title: '导出全部本地备份',
          lines: [
            '导出范围：本浏览器保存的全部账号有效记录。',
            '安全提示：导出的 JSON 文件包含明文社交关系数据（账号 ID、昵称、回复时间），请妥善保管，勿随意分享。'
          ],
          confirmText: '确认导出',
          action: { type: 'EXPORT' }
        });
      });
    }

    if (els.btnImport && els.fileImport) {
      els.btnImport.addEventListener('click', () => {
        els.fileImport.value = '';
        els.fileImport.click();
      });

      els.fileImport.addEventListener('change', async () => {
        const file = els.fileImport.files && els.fileImport.files[0];
        if (!file) {
          return;
        }
        if (typeof file.size === 'number' && file.size > MAX_IMPORT_FILE_BYTES) {
          showFeedback('备份文件超过 9 MiB 上限，已拒绝导入');
          return;
        }
        const rawText = await file.text();
        const res = await sendToBackground({
          type: 'PREVIEW_IMPORT',
          rawText
        });
        if (!res || !res.ok) {
          showFeedback((res && res.message) || '备份文件校验失败，未修改本地数据');
          return;
        }
        openModal({
          title: '导入备份预览',
          lines: buildImportPreviewLines(res.preview),
          confirmText: '确认合并',
          confirmDisabled: Boolean(res.preview.wouldExceedQuota),
          action: {
            type: 'IMPORT',
            rawText,
            baseline: res.baseline
          }
        });
      });
    }

    if (els.btnClearAccount) {
      els.btnClearAccount.addEventListener('click', () => {
        const acc = currentSnapshot && currentSnapshot.selectedAccount;
        if (!acc) {
          return;
        }
        const label = acc.handle ? `@${acc.handle}` : acc.displayName || acc.actorUserId;
        openModal({
          title: '清空当前查看账号',
          lines: [
            `目标账号：${label} (${acc.actorUserId})`,
            '确认后仅删除该账号的本地回复与对象资料，不影响其他本地账号。'
          ],
          confirmText: '确认清空该账号',
          action: {
            type: 'CLEAR_ACCOUNT',
            actorUserId: acc.actorUserId,
            accountGeneration: acc.accountGeneration
          }
        });
      });
    }

    if (els.btnClearAll) {
      els.btnClearAll.addEventListener('click', () => {
        openModal({
          title: '清空全部本地数据',
          lines: [
            '此操作将删除本浏览器内全部账号的记录，并自动关闭采集开关。',
            '清空前如未导出 JSON 备份，数据将无法恢复。'
          ],
          confirmText: '确认清空全部',
          action: { type: 'CLEAR_ALL' }
        });
      });
    }

    if (els.btnModalCancel) {
      els.btnModalCancel.addEventListener('click', () => {
        closeModal();
      });
    }

    if (els.btnModalConfirm) {
      els.btnModalConfirm.addEventListener('click', async () => {
        if (!pendingModalAction) {
          return;
        }
        const action = pendingModalAction;

        if (action.type === 'EXPORT') {
          const res = await sendToBackground({ type: 'EXPORT_BACKUP' });
          closeModal();
          if (res && res.ok && res.backup) {
            triggerJsonDownload(res.filename, res.backup, res.rawJson);
            showFeedback(`已导出备份：${res.filename}`);
          } else {
            showFeedback((res && res.message) || '导出失败');
          }
          await refresh();
          return;
        }

        if (action.type === 'IMPORT') {
          const res = await sendToBackground({
            type: 'COMMIT_IMPORT',
            rawText: action.rawText,
            baseline: action.baseline
          });
          if (res && !res.ok && res.code === 'PREVIEW_STALE' && res.freshPreview) {
            showFeedback(res.message || '本地数据在确认前已变化，请核对最新预览后再次确认');
            openModal({
              title: '导入预览已更新，请重新确认',
              lines: buildImportPreviewLines(res.freshPreview.preview),
              confirmText: '确认最新预览',
              confirmDisabled: Boolean(res.freshPreview.preview.wouldExceedQuota),
              action: {
                type: 'IMPORT',
                rawText: action.rawText,
                baseline: res.freshPreview.baseline
              }
            });
            return;
          }
          closeModal();
          if (res && res.ok) {
            showFeedback(`导入完成：新增 ${res.added} 条，重复 ${res.duplicates} 条`);
          } else {
            showFeedback((res && res.message) || '导入失败，已保留原数据');
          }
          await refresh();
          return;
        }

        if (action.type === 'CLEAR_ACCOUNT') {
          const res = await sendToBackground({
            type: 'CLEAR_ACCOUNT',
            actorUserId: action.actorUserId,
            accountGeneration: action.accountGeneration
          });
          closeModal();
          if (res && res.ok) {
            if (userSelectedActorId === action.actorUserId) {
              userSelectedActorId = null;
            }
            showFeedback('已清空指定账号数据');
          } else {
            showFeedback((res && res.message) || '清空账号失败');
          }
          await refresh();
          return;
        }

        if (action.type === 'CLEAR_ALL') {
          const res = await sendToBackground({ type: 'CLEAR_ALL' });
          closeModal();
          userSelectedActorId = null;
          if (res && res.ok) {
            showFeedback('已清空全部数据并暂停采集');
          } else {
            showFeedback((res && res.message) || '清空全部数据失败');
          }
          await refresh();
        }
      });
    }
  }

  return Object.freeze({
    async init() {
      bindEvents();
      return refresh();
    },
    refresh
  });
}

if (
  typeof document === 'object' &&
  document &&
  typeof document.getElementById === 'function' &&
  document.getElementById('collection-toggle') &&
  typeof chrome === 'object' &&
  chrome &&
  chrome.runtime &&
  typeof chrome.runtime.sendMessage === 'function'
) {
  const controller = createPopupController();
  if (controller) {
    controller.init();
  }
}
