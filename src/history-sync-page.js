(function () {
  'use strict';
  const origins = new Set(['https://x.com', 'https://twitter.com']);
  function installHistorySyncPage(win, chromeApi, options = {}) {
    if (!win || win !== win.top || !origins.has(win.location.origin) || !chromeApi?.runtime?.sendMessage) return null;
    const now = options.nowFn || Date.now;
    const later = options.setTimeoutFn || setTimeout;
    const clear = options.clearTimeoutFn || clearTimeout;
    const customTimers = Boolean(options.setTimeoutFn);
    let timer, stopped = false, ticking = false, resync = false, unsub = null;
    let clicked = false, clickedAt = 0, repliesRequested = false, enteredReplies = false, navigating = false;
    let debugLogsEnabled = false;
    let lastLogKey = '';
    function logSync(key, ...args) {
      if (!debugLogsEnabled) return;
      if (key && key === lastLogKey) return;
      if (key) lastLogKey = key;
      try {
        if (win.console && typeof win.console.info === 'function') {
          win.console.info('[SparkLink Sync/Page]', ...args);
        }
      } catch {}
    }
    async function send(message) {
      try { return await chromeApi.runtime.sendMessage(message); } catch { return null; }
    }
    function destroy() {
      stopped = true;
      clear(timer);
      if (typeof unsub === 'function') {
        try { unsub(); } catch {}
        unsub = null;
      }
      win.removeEventListener('pagehide', destroy);
    }
    function computeDelay(elapsed, binding, job, path, profile) {
      if (customTimers) return 1500;
      if (!binding) return 1500;
      if (job.mode !== 'search' && path === profile && !repliesRequested) {
        return 1000;
      }
      if (elapsed < 12000 && (job.hasNext || (job.mode === 'search' && job.dayRead) ||
          (job.mode !== 'search' && (job.pages > 0 || job.missingTimeline)))) {
        return Math.max(1500, 12050 - elapsed);
      }
      return Math.max(1500, Math.min(12000, 45050 - elapsed));
    }
    function wakeTick() {
      if (stopped) return;
      if (ticking) {
        resync = true;
        return;
      }
      clear(timer);
      tick();
    }
    function ensureBridgeSubscription(bridge) {
      if (!unsub && bridge && typeof bridge.subscribe === 'function') {
        unsub = bridge.subscribe((ev) => {
          if (!ev || stopped) return;
          if (ev.type === 'HISTORY_PAGE_SYNCED' || ev.type === 'BINDING_READY' ||
              ev.type === 'REVISION_UPDATED' || ev.type === 'HISTORY_SYNC_ENDED') {
            wakeTick();
          }
        });
      }
    }
    async function tick() {
      if (stopped) return;
      if (ticking) {
        resync = true;
        return;
      }
      ticking = true;
      let nextDelay = 1500;
      try {
        const res = await send({ type: 'GET_HISTORY_SYNC_TASK' });
        const bridge = win.__sparklinkIsolatedBridge;
        if (typeof res?.debugLogsEnabled === 'boolean') {
          debugLogsEnabled = res.debugLogsEnabled;
        } else if (bridge && typeof bridge.isDebugLogsEnabled === 'function') {
          debugLogsEnabled = Boolean(bridge.isDebugLogsEnabled());
        }
        const job = res?.job;
        if (stopped || !res?.ok || job?.status !== 'running') return destroy();
        ensureBridgeSubscription(bridge);
        const binding = bridge?.getBindingContext();
        const stop = (reason, retryAt) => {
          logSync('stop:' + reason, 'stopping history sync', { reason, path: win.location?.pathname, mode: job.mode, pages: job.pages, retryAt: retryAt || null });
          destroy();
          return send({ type: 'STOP_HISTORY_SYNC_TASK', jobId: job.id, reason, retryAt });
        };
        const blocked = bridge?.getHistoryStop?.(job.id);
        if (blocked) return stop(blocked.reason, blocked.retryAt);
        const url = new URL(win.location.href);
        if (/^\/(account\/access|i\/flow\/(login|challenge)|login)(\/|$)/i.test(url.pathname) ||
            win.document.querySelector('iframe[src*="arkoselabs.com"], [data-testid="ocfEnterTextTextInput"]')) return stop('verification');
        if (binding && (binding.actorUserId !== job.actorUserId || binding.captureSessionId !== job.captureSessionId)) return stop('account_changed');
        const path = url.pathname.replace(/\/$/, '').toLowerCase();
        const profile = '/' + job.handle.toLowerCase();
        const replies = profile + '/with_replies';
        const time = now();
        const elapsed = time - Math.max(job.pageAt, job.actionAt);
        if (time >= job.deadline) return stop('timeout');
        if (!binding && elapsed >= 45000) return stop('account_changed');
        let action;
        let nowPath = path;
        if (job.mode === 'search') {
          if (path !== '/search' || url.searchParams.get('q') !== job.searchQuery || url.searchParams.get('f') !== 'live') {
            return navigating ? destroy() : stop('navigation');
          }
          navigating = false;
          if (job.hasNext) {
            if (elapsed >= 45000) return stop('search_stalled');
            action = 'next';
          } else if (job.dayRead) action = 'search';
          else if (elapsed >= 45000) return stop('search_stalled');
        } else {
          if (path !== profile && path !== replies || enteredReplies && path === profile) return stop('navigation');
          const wasOnReplies = path === replies;
          if (wasOnReplies) navigating = false;
          enteredReplies ||= wasOnReplies;
          const repliesGateMs = customTimers ? 12000 : 500;
          if (binding && path === profile && elapsed >= repliesGateMs) {
            if (!clicked) {
              const link = Array.from(win.document.querySelectorAll('a[href]')).find(node => {
                let href;
                try { href = new URL(node.getAttribute('href'), url); } catch { return false; }
                return href.origin === url.origin && href.pathname.toLowerCase() === replies && !href.search && !href.hash;
              });
              if (link) {
                clicked = true;
                clickedAt = time;
                logSync('click:' + replies, 'clicking native Replies tab link', { href: link.getAttribute('href'), elapsed });
                link.click();
              }
            }
            nowPath = new URL(win.location.href).pathname.replace(/\/$/, '').toLowerCase();
            if (nowPath === profile && !repliesRequested && (!clicked || time - clickedAt >= 3000)) {
              action = 'replies';
            }
          }
          enteredReplies ||= nowPath === replies;
          if (job.hasNext && elapsed >= 45000) return stop('stalled');
          if (job.hasNext) action = 'next';
          else if (!action && (
            (wasOnReplies && (job.pages > 0 || job.missingTimeline)) ||
            (nowPath === profile && repliesRequested && !clicked && job.missingTimeline) ||
            elapsed >= 45000
          )) action = 'search';
        }
        const actionGateMs = action === 'replies' && !customTimers ? 500 : 12000;
        if (binding && action && elapsed >= actionGateMs) {
          navigating = action === 'search' || action === 'replies';
          if (action === 'replies') repliesRequested = true;
          logSync(
            'action:' + action + ':' + job.pages + ':' + job.mode,
            'requesting advance',
            { action, mode: job.mode, path: nowPath, pages: job.pages, hasNext: job.hasNext, missingTimeline: job.missingTimeline, elapsed }
          );
          const grant = await send({ type: 'ADVANCE_HISTORY_SYNC', jobId: job.id, bindingContext: binding, action });
          if (!stopped && grant?.next) bridge.requestHistoryNext(job.id);
        } else {
          logSync(
            'wait:' + job.mode + ':' + nowPath + ':' + Boolean(binding) + ':' + job.pages + ':' + job.hasNext + ':' + Boolean(job.missingTimeline),
            'tick state',
            { mode: job.mode, path: nowPath, hasBinding: Boolean(binding), pages: job.pages, hasNext: job.hasNext, dayRead: job.dayRead, missingTimeline: job.missingTimeline, action: action || null, elapsed }
          );
        }
        nextDelay = computeDelay(elapsed, binding, job, path, profile);
      } finally {
        ticking = false;
        if (!stopped) {
          if (resync) {
            resync = false;
            return tick();
          }
          clear(timer);
          timer = later(tick, nextDelay);
          timer?.unref?.();
        }
      }
    }
    win.addEventListener('pagehide', destroy);
    return { ready: tick(), destroy };
  }
  if (typeof module === 'object' && module.exports) module.exports = { installHistorySyncPage };
  if (typeof window === 'object' && typeof chrome === 'object') installHistorySyncPage(window, chrome);
})();
