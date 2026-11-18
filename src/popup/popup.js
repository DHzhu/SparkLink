import {
  MAX_IMPORT_FILE_BYTES,
  buildSafeProfileUrl,
  isValidDecimalId
} from '../schema.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

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
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'sparklink-fire-art');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const core = doc.createElementNS(SVG_NS, 'circle');
  core.setAttribute('class', 'sparklink-fire-core');
  core.setAttribute('cx', '12');
  core.setAttribute('cy', '12');
  core.setAttribute('r', '8.2');
  svg.appendChild(core);
  const path = doc.createElementNS(SVG_NS, 'path');
  path.setAttribute('class', 'sparklink-fire-shape');
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
    btnHistorySync: doc.getElementById('btn-history-sync'),
    historyStatus: doc.getElementById('history-sync-status'),
    debugLogsToggle: doc.getElementById('debug-logs-toggle'),
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
  let userSelectedWhenActiveActorId = null;
  let confirmedViewedActorId = null;
  let currentSnapshot = null;
  let refreshSeq = 0;
  let pendingModalAction = null;
  let syncDeadlineTimer = null;

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
    if (snap.diagnostics) {
      if (snap.diagnostics.liveCaptureAnomaly) {
        addBanner(
          '实时回复响应结构无法识别或缺少关键字段，新回复采集可能遗漏，待修订适配规则。',
          true
        );
      }
      if (snap.diagnostics.historyBackfillAnomaly) {
        addBanner(
          '历史补录响应结构部分无法识别，历史补录暂不可用，仍可记录新回复和导入备份。',
          false
        );
      }
      if (snap.diagnostics.observationDropped) {
        addBanner('部分观测事件因队列超限或重试耗尽未能保存，统计可能存在遗漏。', false);
      }
      if (
        !snap.diagnostics.liveCaptureAnomaly &&
        !snap.diagnostics.historyBackfillAnomaly &&
        (snap.diagnostics.partialUnrecognized || snap.diagnostics.incompleteObservation)
      ) {
        addBanner('部分网页响应无法识别或未完整读取，未知结构已安全跳过。', false);
      }
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
      if (snap.diagnostics && snap.diagnostics.liveCaptureAnomaly) {
        els.viewerStatusBadge.textContent = '实时采集异常';
        return;
      }
      if (snap.diagnostics && snap.diagnostics.historyBackfillAnomaly) {
        els.viewerStatusBadge.textContent = '历史补录受限';
        return;
      }
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
      pill.className = `tier-pill sparklink-tier-${tierKey}`;
      pill.setAttribute(
        'title',
        entry.tierInfo && entry.tierInfo.tooltip ? entry.tierInfo.tooltip : tierLabel
      );
      pill.appendChild(createFlameSvg(doc));

      const pillText = doc.createElement('span');
      pillText.textContent = tierLabel;
      pill.appendChild(pillText);

      const count = doc.createElement('span');
      count.textContent = `${entry.count} 次`;
      right.appendChild(pill);
      right.appendChild(count);
      li.appendChild(left);
      li.appendChild(right);
      return li;
    });

    els.top20List.replaceChildren(...rows);
  }

  function isCurrentClearTarget(action, snap) {
    const account = snap?.selectedAccount;
    return Boolean(
      snap?.ok && account &&
      account.actorUserId === action.actorUserId &&
      account.accountGeneration === action.accountGeneration
    );
  }

  function renderHistorySync(snap) {
    if (!els.btnHistorySync || !els.historyStatus) return;
    clearTimeout(syncDeadlineTimer);
    const job = snap?.historySync;
    const running = job?.status === 'running';
    const canStart = snap?.viewerStatus === 'bound' && snap?.settings?.collectionEnabled &&
      snap.selectedAccount?.handle && snap.selectedAccount.actorUserId === snap.activeTabActorUserId;
    const wait = (snap?.historyNextStart || 0) - Date.now();
    const cooling = !running && wait > 0;
    const resumeTime = cooling ? new Date(snap.historyNextStart).toLocaleString('zh-CN',
      { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
    const cooldownText = cooling ? ' 可于 ' + resumeTime + ' 后再次手动同步。' : '';
    if (cooling) {
      syncDeadlineTimer = setTimeout(refresh, Math.min(wait + 100, 2147483647));
      syncDeadlineTimer.unref?.();
    }
    els.btnHistorySync.disabled = !running && (!canStart || cooling);
    els.btnHistorySync.textContent = running ? '停止同步' : '同步近 7 天回复';
    if (!job) {
      els.historyStatus.textContent = (canStart ? '将打开并切换到同步标签页读取本人回复，同步期间请停留在该标签页。' : '开启采集并选中当前 X 页的账号后可同步。') + cooldownText;
      return;
    }
    const reasons = {
      rate_limited: 'X 已限流，同步已停止', verification: 'X 要求登录或验证，同步已停止', unavailable: 'X 暂时无法加载回复',
      searched: '已按日期分段搜索近 7 天回复，可能有遗漏', search_stalled: '未读到当日搜索结果，无法判断当天是否有回复',
      first_page: '未读到回复列表第一页', end: '已读到列表末尾', boundary: '已读到 7 天边界', cancelled: '已停止',
      unrecognized: '部分回复无法识别', stalled: '页面未返回更多回复', timeout: '已达到本次读取时限',
      page_limit: '已达到本次读取上限，可能有遗漏', account_changed: '账号或采集会话已变化',
      navigation: '页面已离开或无法打开回复页', closed: '同步标签页已关闭',
      paused: '采集已暂停', storage: '本地存储写入失败'
    };
    const state = running ? '正在同步' : job.status === 'partial' ? '部分同步' : '同步结束';
    const progress = job.mode === 'search'
      ? '正在搜索 ' + (job.searchQuery?.match(/since:(\d{4}-\d{2}-\d{2})/)?.[1] || '当日') + ' 的回复，同步期间请停留在该标签页'
      : '正在读取本人回复列表，同步期间请停留在该标签页';
    const detail = running ? progress : reasons[job.reason] || '已停止';
    els.historyStatus.textContent = `@${job.handle} ${state} · ${detail}。已读取 ${job.pages} 页，新增 ${job.added} 条，重复 ${job.duplicates} 条。${cooldownText}`;
    if (running) {
      syncDeadlineTimer = setTimeout(refresh, Math.max(250, job.deadline - Date.now() + 100));
      syncDeadlineTimer.unref?.();
    }
  }

  function renderSnapshot(snap) {
    currentSnapshot = snap;
    renderHistorySync(snap);
    if (pendingModalAction?.type === 'CLEAR_ACCOUNT' && !isCurrentClearTarget(pendingModalAction, snap)) {
      closeModal();
      showFeedback('清空操作已取消，请重新核对目标账号。');
    }

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
      if (els.debugLogsToggle) els.debugLogsToggle.checked = false;
      if (els.activationBanner) els.activationBanner.hidden = true;
      if (els.btnClearAccount) els.btnClearAccount.disabled = true;
      return;
    }

    const enabled = Boolean(snap.settings.collectionEnabled);
    if (els.collectionToggle) {
      els.collectionToggle.checked = enabled;
    }
    if (els.debugLogsToggle) {
      els.debugLogsToggle.checked = Boolean(snap.debugLogsEnabled);
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
        const opts = [];
        if (!snap.selectedAccount) {
          const pendingOpt = doc.createElement('option');
          pendingOpt.value = '';
          pendingOpt.textContent = '待确认（请选择查看账号）';
          opts.push(pendingOpt);
        }
        for (const acc of accounts) {
          const opt = doc.createElement('option');
          opt.value = acc.actorUserId;
          opt.textContent = formatAccountOptionLabel(acc, snap.activeTabActorUserId);
          opts.push(opt);
        }
        els.accountSelect.replaceChildren(...opts);
        els.accountSelect.disabled = false;
        els.accountSelect.value = snap.selectedAccount ? snap.selectedAccount.actorUserId : '';
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
    const seq = ++refreshSeq;
    const msg = { type: 'GET_POPUP_SNAPSHOT' };
    if (isValidDecimalId(userSelectedActorId)) {
      msg.preferredActorUserId = userSelectedActorId;
      msg.preferredWhenActiveActorId = userSelectedWhenActiveActorId;
    } else if (isValidDecimalId(confirmedViewedActorId)) {
      msg.fallbackActorUserId = confirmedViewedActorId;
    }
    const snap = await sendToBackground(msg);
    if (seq !== refreshSeq) {
      return snap;
    }
    if (snap && snap.ok && userSelectedActorId) {
      const activeNow = isValidDecimalId(snap.activeTabActorUserId)
        ? snap.activeTabActorUserId
        : null;
      if (
        !snap.selectedAccount ||
        snap.selectedAccount.actorUserId !== userSelectedActorId ||
        (activeNow !== null && activeNow !== userSelectedWhenActiveActorId)
      ) {
        userSelectedActorId = null;
        userSelectedWhenActiveActorId = null;
      }
    }
    if (snap && snap.ok) {
      if (snap.viewerStatus === 'bound' && isValidDecimalId(snap.activeTabActorUserId)) {
        confirmedViewedActorId = snap.activeTabActorUserId;
      } else if (isValidDecimalId(snap.confirmedTabActorUserId)) {
        confirmedViewedActorId = snap.confirmedTabActorUserId;
      } else if (
        confirmedViewedActorId &&
        (!Array.isArray(snap.savedAccounts) ||
          !snap.savedAccounts.some((acc) => acc.actorUserId === confirmedViewedActorId))
      ) {
        confirmedViewedActorId = null;
      }
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
    els.btnHistorySync?.addEventListener('click', async () => {
      const job = currentSnapshot?.historySync;
      els.btnHistorySync.disabled = true;
      const res = await sendToBackground(job?.status === 'running'
        ? { type: 'CANCEL_HISTORY_SYNC', jobId: job.id }
        : { type: 'START_HISTORY_SYNC', actorUserId: currentSnapshot?.selectedAccount?.actorUserId });
      if (!res?.ok) showFeedback(res?.message || '同步未启动，请重试。');
      await refresh();
    });
    if (els.collectionToggle) {
      els.collectionToggle.addEventListener('change', async () => {
        await setEnabled(els.collectionToggle.checked);
      });
    }

    if (els.debugLogsToggle) {
      els.debugLogsToggle.addEventListener('change', async () => {
        const nextDebug = Boolean(els.debugLogsToggle.checked);
        const res = await sendToBackground({
          type: 'SET_DEBUG_LOGS',
          enabled: nextDebug
        });
        if (!res || !res.ok) {
          showFeedback((res && res.message) || '切换调试日志失败');
        } else {
          showFeedback(nextDebug ? '已开启同步调试日志' : '已关闭同步调试日志');
        }
        await refresh();
      });
    }

    if (els.btnEnableCta) {
      els.btnEnableCta.addEventListener('click', async () => {
        await setEnabled(true);
      });
    }

    if (els.accountSelect) {
      els.accountSelect.addEventListener('change', async () => {
        refreshSeq += 1;
        const val = els.accountSelect.value;
        const selectedId = isValidDecimalId(val) ? val : null;
        const activeAtSelect =
          currentSnapshot && isValidDecimalId(currentSnapshot.activeTabActorUserId)
            ? currentSnapshot.activeTabActorUserId
            : null;
        const setRes = await sendToBackground({
          type: 'SET_POPUP_ACCOUNT',
          actorUserId: selectedId
        });
        if (
          activeAtSelect === null &&
          setRes &&
          setRes.ok &&
          setRes.saved === true
        ) {
          userSelectedActorId = null;
          userSelectedWhenActiveActorId = null;
        } else {
          userSelectedActorId = selectedId;
          userSelectedWhenActiveActorId = selectedId ? activeAtSelect : null;
        }
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
        let rawText;
        try {
          rawText = await file.text();
        } catch (_err) {
          showFeedback('读取备份文件失败，请确认文件可访问后重试');
          return;
        }
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
          const latest = await refresh();
          if (action !== pendingModalAction || !isCurrentClearTarget(action, latest)) {
            return;
          }
          const res = await sendToBackground({
            type: 'CLEAR_ACCOUNT',
            actorUserId: action.actorUserId,
            accountGeneration: action.accountGeneration
          });
          closeModal();
          if (res && res.ok) {
            if (userSelectedActorId === action.actorUserId) {
              userSelectedActorId = null;
              userSelectedWhenActiveActorId = null;
            }
            if (confirmedViewedActorId === action.actorUserId) {
              confirmedViewedActorId = null;
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
          if (res && res.ok) {
            userSelectedActorId = null;
            userSelectedWhenActiveActorId = null;
            confirmedViewedActorId = null;
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
      const sessionChanges = options.sessionChanges || globalThis.chrome?.storage?.session?.onChanged;
      sessionChanges?.addListener((changes) => {
        if (changes.sparklink_history_sync) return refresh();
        const change = changes.sparklink_doc_bindings;
        if (!change) {
          return;
        }
        const previous = change.oldValue || {};
        const current = change.newValue || {};
        const tabs = new Set([...Object.keys(previous), ...Object.keys(current)]);
        for (const id of tabs) {
          if (
            previous[id]?.documentId !== current[id]?.documentId ||
            previous[id]?.bindingContext?.bindingId !== current[id]?.bindingContext?.bindingId
          ) {
            return refresh();
          }
        }
      });
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
