(() => {
  'use strict';

  const REFRESH_MS = 3000;
  const $ = (selector) => document.querySelector(selector);
  const dom = {
    connectionPill: $('#connection-pill'),
    connectionText: $('#connection-text'),
    themeToggle: $('#theme-toggle'),
    testAlertButton: $('#test-alert-button'),
    stopAlertButton: $('#stop-alert-button'),
    alertFeedback: $('#alert-feedback'),
    refreshButton: $('#refresh-button'),
    runningCount: $('#running-count'),
    completedCount: $('#completed-count'),
    planValue: $('#plan-value'),
    accountType: $('#account-type'),
    runningHeadingCount: $('#running-heading-count'),
    attentionPanel: $('#attention-panel'),
    attentionHeadingCount: $('#attention-heading-count'),
    attentionList: $('#attention-list'),
    completedHeadingCount: $('#completed-heading-count'),
    runningList: $('#running-list'),
    completedList: $('#completed-list'),
    usageUnavailable: $('#usage-unavailable'),
    usageUnavailableMessage: $('#usage-unavailable-message'),
    usageContent: $('#usage-content'),
    usagePlan: $('#usage-plan'),
    usageLimitName: $('#usage-limit-name'),
    usageWindows: $('#usage-windows'),
    creditsCard: $('#credits-card'),
    creditsValue: $('#credits-value'),
    creditsNote: $('#credits-note'),
    lastUpdated: $('#last-updated'),
  };
  let latestState = null;
  let refreshing = false;
  let alertFeedbackTimer = null;

  const statusLabels = {
    active: '运行中',
    waitingOnApproval: '等待授权',
    waitingOnUserInput: '等待输入',
    systemError: '系统错误',
    stale: '可能已失联',
    completed: '已完成',
    failed: '失败',
    interrupted: '已中断',
    idle: '空闲',
    notLoaded: '未加载',
    unknown: '未知',
  };

  function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function displayValue(value, fallback = '—') {
    const text = String(value === null || value === undefined ? '' : value).trim();
    return text || fallback;
  }

  function formatDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).format(date);
  }

  function formatFullDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).format(date);
  }

  function formatDuration(minutes) {
    const number = Number(minutes);
    if (!Number.isFinite(number)) return '窗口时长未知';
    if (number >= 1440 && number % 1440 === 0) return `每 ${number / 1440} 天`;
    if (number >= 60 && number % 60 === 0) return `每 ${number / 60} 小时`;
    return `每 ${number} 分钟`;
  }

  function formatCountdown(resetsAt) {
    const seconds = Math.max(0, Math.floor((new Date(resetsAt).getTime() - Date.now()) / 1000));
    if (!Number.isFinite(seconds) || seconds <= 0) return '即将重置';
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0) return `${days} 天 ${hours} 小时后`;
    if (hours > 0) return `${hours} 小时 ${minutes} 分钟后`;
    return `${Math.max(1, minutes)} 分钟后`;
  }

  function formatPercent(value) {
    const number = Number(value);
    return Number.isFinite(number) ? `${Math.round(number)}%` : '—';
  }

  function statusBadge(task) {
    const status = task && task.status ? task.status : 'unknown';
    const label = displayValue(task && task.statusLabel, statusLabels[status] || '未知');
    return `<span class="status-badge status-${escapeHtml(status)}">${escapeHtml(label)}</span>`;
  }

  function taskCard(task) {
    const summary = displayValue(task && task.summary, '暂无步骤详情');
    const summaryClass = task && task.summary ? '' : ' empty';
    const cwd = displayValue(task && task.cwd);
    return `<article class="task-card">
      <div class="task-card-header"><h3 class="task-title" title="${escapeHtml(displayValue(task && task.title, '未命名任务'))}">${escapeHtml(displayValue(task && task.title, '未命名任务'))}</h3>${statusBadge(task)}</div>
      <p class="task-summary${summaryClass}">${escapeHtml(summary)}</p>
      <div class="task-meta">
        <div class="task-meta-row"><span class="task-meta-label">模型</span><span class="task-meta-value">${escapeHtml(displayValue(task && task.model))}</span></div>
        <div class="task-meta-row"><span class="task-meta-label">目录</span><span class="task-meta-value" title="${escapeHtml(cwd)}"><code>${escapeHtml(cwd)}</code></span></div>
        <div class="task-meta-row"><span class="task-meta-label">开始</span><span class="task-meta-value">${escapeHtml(formatDate(task && task.startedAtIso))} · 最近更新 ${escapeHtml(formatDate(task && task.updatedAtIso))}</span></div>
      </div>
    </article>`;
  }

  function historyRow(task) {
    const subtitle = task && task.error ? `错误：${task.error}` : `${displayValue(task && task.model)} · ${displayValue(task && task.cwd)}`;
    return `<article class="history-row">
      <div class="history-main"><div class="history-title" title="${escapeHtml(displayValue(task && task.title, '未命名任务'))}">${escapeHtml(displayValue(task && task.title, '未命名任务'))}</div><div class="history-subtitle" title="${escapeHtml(subtitle)}">${escapeHtml(subtitle)}</div></div>
      ${statusBadge(task)}
      <time class="history-time" datetime="${escapeHtml(task && task.completedAtIso || task && task.updatedAtIso || '')}">${escapeHtml(formatDate(task && (task.completedAtIso || task.updatedAtIso)))}</time>
    </article>`;
  }

  function emptyState(title, detail) {
    return `<div class="empty-state"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span></div>`;
  }

  function renderTasks(state) {
    const running = Array.isArray(state && state.running) ? state.running : [];
    const attention = Array.isArray(state && state.attention) ? state.attention : [];
    const completed = Array.isArray(state && state.completed) ? state.completed : [];
    dom.runningCount.textContent = String(Number.isFinite(state && state.runningCount) ? state.runningCount : running.length);
    dom.completedCount.textContent = String(completed.length);
    dom.runningHeadingCount.textContent = String(running.length);
    dom.attentionHeadingCount.textContent = String(attention.length);
    dom.completedHeadingCount.textContent = String(completed.length);
    dom.runningList.innerHTML = running.length
      ? running.map(taskCard).join('')
      : emptyState('现在没有运行中的任务', '启动 Codex 任务后，这里会自动出现');
    dom.attentionPanel.hidden = attention.length === 0;
    dom.attentionList.innerHTML = attention.map(taskCard).join('');
    dom.completedList.innerHTML = completed.length
      ? completed.map(historyRow).join('')
      : emptyState('还没有已结束任务', '完成、失败或中断的任务会显示在这里');
  }

  function renderUsage(usage) {
    const account = usage && usage.account ? usage.account : {};
    const plan = displayValue(usage && usage.plan || account.plan, '暂不可用');
    dom.planValue.textContent = plan;
    dom.usagePlan.textContent = plan;
    dom.accountType.textContent = account.type === 'chatgpt' ? 'ChatGPT 账户' : displayValue(account.type, '账户信息暂不可用');
    dom.usageLimitName.textContent = displayValue(usage && usage.limitName, 'Codex');

    const available = Boolean(usage && usage.available);
    dom.usageUnavailable.hidden = available;
    dom.usageContent.hidden = !available;
    if (!available) {
      dom.usageUnavailableMessage.textContent = displayValue(usage && usage.message, '请稍后刷新，或打开官方用量页查看。');
      return;
    }

    const windows = [
      ['主窗口', usage.primary],
      ['次窗口', usage.secondary],
    ].filter(([, window]) => window);
    dom.usageWindows.innerHTML = windows.length ? windows.map(([name, window]) => {
      const remaining = window.remainingPercent;
      const used = window.usedPercent;
      const reset = window.resetsAtIso ? formatCountdown(window.resetsAtIso) : '重置时间未知';
      return `<div class="usage-window">
        <div class="usage-window-top"><span class="usage-window-name">${escapeHtml(name)}</span><span class="usage-window-remaining">${escapeHtml(formatPercent(remaining))}<small>剩余</small></span></div>
        <div class="usage-bar" aria-label="已用 ${escapeHtml(formatPercent(used))}"><div class="usage-bar-fill" style="width:${Number.isFinite(Number(used)) ? Math.max(0, Math.min(100, Number(used))) : 0}%"></div></div>
        <div class="usage-window-details"><span>已用 ${escapeHtml(formatPercent(used))} · ${escapeHtml(formatDuration(window.windowDurationMins))}</span><span data-reset-at="${escapeHtml(window.resetsAtIso || '')}">${escapeHtml(reset)}</span></div>
      </div>`;
    }).join('') : emptyState('窗口数据暂不可用', '请打开官方用量页查看');

    const credits = usage.credits;
    dom.creditsCard.hidden = !credits;
    if (credits) {
      dom.creditsValue.textContent = credits.unlimited ? '无限' : displayValue(credits.balance, '—');
      dom.creditsNote.textContent = credits.hasCredits ? '来自 account/rateLimits/read' : '账户未启用 Credits';
    }
  }

  function connectionLabel(connection) {
    if (!connection) return ['connecting', '连接中'];
    if (connection.status === 'connected') return ['connected', '已连接'];
    if (connection.status === 'degraded') return ['degraded', '部分可用'];
    if (connection.status === 'offline') return ['offline', '离线'];
    return ['connecting', '连接中'];
  }

  function render(state) {
    if (!state) return;
    latestState = state;
    renderTasks(state);
    renderUsage(state.usage || {});
    const [className, label] = connectionLabel(state.connection);
    dom.connectionPill.className = `connection-pill is-${className}`;
    dom.connectionText.textContent = label;
    dom.lastUpdated.textContent = state.lastUpdated ? formatFullDate(state.lastUpdated) : '—';
    dom.lastUpdated.dateTime = state.lastUpdated || '';
    updateCountdowns();
  }

  function updateCountdowns() {
    document.querySelectorAll('[data-reset-at]').forEach((element) => {
      const value = element.getAttribute('data-reset-at');
      element.textContent = value ? formatCountdown(value) : '重置时间未知';
    });
  }

  async function refresh(manual = false) {
    if (refreshing) return;
    refreshing = true;
    dom.refreshButton.disabled = true;
    dom.refreshButton.classList.add('is-loading');
    try {
      const response = await fetch(`/api/state${manual ? '?refresh=1' : ''}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      render(await response.json());
    } catch (error) {
      const fallback = latestState ? { ...latestState, connection: { ...(latestState.connection || {}), status: 'offline', message: '无法读取仪表盘数据' } } : { connection: { status: 'offline' }, running: [], completed: [], runningCount: 0, usage: { available: false, message: '暂不可用' } };
      render(fallback);
    } finally {
      refreshing = false;
      dom.refreshButton.disabled = false;
      dom.refreshButton.classList.remove('is-loading');
    }
  }

  function setAlertFeedback(message, kind = '') {
    if (alertFeedbackTimer) clearTimeout(alertFeedbackTimer);
    dom.alertFeedback.textContent = message;
    dom.alertFeedback.className = `alert-feedback${kind ? ` is-${kind}` : ''}`;
    if (message) {
      alertFeedbackTimer = setTimeout(() => {
        dom.alertFeedback.textContent = '';
        dom.alertFeedback.className = 'alert-feedback';
        alertFeedbackTimer = null;
      }, 5000);
    }
  }

  function alertChannelText(channel, sentText, disabledText) {
    if (!channel || channel.enabled === false) return disabledText;
    if (channel.ok === false) return `${sentText}失败`;
    return sentText;
  }

  async function testAlert() {
    if (dom.testAlertButton.disabled) return;
    dom.testAlertButton.disabled = true;
    dom.testAlertButton.classList.add('is-loading');
    setAlertFeedback('正在发送测试提醒…');
    try {
      const response = await fetch('/api/test-alert', {
        method: 'POST',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
      let result = null;
      try { result = await response.json(); } catch (_) {}
      if (!response.ok || !result || result.ok === false) {
        throw new Error(result && (result.error || result.message) || `HTTP ${response.status}`);
      }
      const notification = alertChannelText(result.notification, '通知已发出', '通知已关闭');
      const sound = alertChannelText(result.sound, '强提醒已启动', '声音已关闭');
      setAlertFeedback(`测试强提醒：${notification}，${sound}`, 'success');
    } catch (error) {
      setAlertFeedback(`测试强提醒失败：${error && error.message ? error.message : '本地服务不可用'}`, 'error');
    } finally {
      dom.testAlertButton.disabled = false;
      dom.testAlertButton.classList.remove('is-loading');
    }
  }

  async function stopAlert() {
    if (dom.stopAlertButton.disabled) return;
    dom.stopAlertButton.disabled = true;
    dom.stopAlertButton.classList.add('is-loading');
    setAlertFeedback('正在停止强提醒…');
    try {
      const response = await fetch('/api/stop-alert', {
        method: 'POST',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
      let result = null;
      try { result = await response.json(); } catch (_) {}
      if (!response.ok || !result || result.ok === false) {
        throw new Error(result && (result.error || result.message) || `HTTP ${response.status}`);
      }
      setAlertFeedback(result.stopped ? '强提醒已停止' : '当前没有正在播放的提醒', 'success');
    } catch (error) {
      setAlertFeedback(`停止提醒失败：${error && error.message ? error.message : '本地服务不可用'}`, 'error');
    } finally {
      dom.stopAlertButton.disabled = false;
      dom.stopAlertButton.classList.remove('is-loading');
    }
  }

  function setTheme(theme) {
    if (theme === 'dark' || theme === 'light') {
      document.documentElement.dataset.theme = theme;
      localStorage.setItem('codex-radar-theme', theme);
    } else {
      document.documentElement.removeAttribute('data-theme');
      localStorage.removeItem('codex-radar-theme');
    }
    dom.themeToggle.textContent = theme === 'dark' ? '☀' : theme === 'light' ? '◐' : '☼';
    dom.themeToggle.title = theme === 'dark' ? '切换为浅色' : theme === 'light' ? '跟随系统主题' : '切换为深色';
  }

  dom.refreshButton.addEventListener('click', () => refresh(true));
  dom.testAlertButton.addEventListener('click', testAlert);
  dom.stopAlertButton.addEventListener('click', stopAlert);
  dom.themeToggle.addEventListener('click', () => {
    const current = document.documentElement.dataset.theme || 'system';
    setTheme(current === 'system' ? 'dark' : current === 'dark' ? 'light' : 'system');
  });
  setTheme(localStorage.getItem('codex-radar-theme') || 'system');
  setInterval(() => refresh(false), REFRESH_MS);
  setInterval(updateCountdowns, 1000);
  refresh(false);
})();
