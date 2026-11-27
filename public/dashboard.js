'use strict';

(function () {
  let countdownTimer = null;
  let currentIntervalSec = 10;
  let remainingSeconds = 10;
  let isFetching = false;

  // DOM Elements
  const themeToggle = document.getElementById('themeToggle');
  const refreshIntervalSelect = document.getElementById('refreshInterval');
  const refreshCountdownBadge = document.getElementById('refreshCountdownBadge');
  const btnManualRefresh = document.getElementById('btnManualRefresh');
  const iconRefresh = document.getElementById('iconRefresh');
  const textRefresh = document.getElementById('textRefresh');
  const btnSaveConcurrency = document.getElementById('btnSaveConcurrency');
  const inputConcurrency = document.getElementById('inputConcurrency');
  const btnTriggerCleanup = document.getElementById('btnTriggerCleanup');
  const btnClearErrors = document.getElementById('btnClearErrors');

  // 1. Theme toggle
  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme') || 'dark';
      const next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('ffstudio-theme', next);
    });
  }

  // 2. Countdown & Auto-Refresh Logic
  function updateCountdownDisplay() {
    if (!refreshCountdownBadge) return;
    if (currentIntervalSec <= 0) {
      refreshCountdownBadge.textContent = 'Paused';
      refreshCountdownBadge.style.color = 'var(--dash-muted)';
      refreshCountdownBadge.style.background = 'rgba(255,255,255,0.05)';
    } else {
      refreshCountdownBadge.textContent = `${remainingSeconds}s`;
      refreshCountdownBadge.style.color = 'var(--dash-primary)';
      refreshCountdownBadge.style.background = 'rgba(56,189,248,0.12)';
    }
  }

  function startCountdownTimer() {
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }

    if (currentIntervalSec <= 0) {
      updateCountdownDisplay();
      return;
    }

    remainingSeconds = currentIntervalSec;
    updateCountdownDisplay();

    countdownTimer = setInterval(() => {
      remainingSeconds--;
      if (remainingSeconds <= 0) {
        remainingSeconds = currentIntervalSec;
        triggerRefresh(false);
      }
      updateCountdownDisplay();
    }, 1000);
  }

  function setupAutoRefresh(intervalMs) {
    const sec = Math.floor(intervalMs / 1000);
    currentIntervalSec = sec;
    remainingSeconds = sec;
    startCountdownTimer();
  }

  // Auto-refresh interval change listener
  if (refreshIntervalSelect) {
    // Restore saved preference if exists
    const saved = localStorage.getItem('dashboard_refresh_interval');
    if (saved !== null) {
      refreshIntervalSelect.value = saved;
      currentIntervalSec = Math.floor(parseInt(saved, 10) / 1000);
    }

    refreshIntervalSelect.addEventListener('change', (e) => {
      const ms = parseInt(e.target.value, 10);
      localStorage.setItem('dashboard_refresh_interval', String(ms));
      setupAutoRefresh(ms);
    });
  }

  // Manual refresh button listener
  if (btnManualRefresh) {
    btnManualRefresh.addEventListener('click', () => {
      remainingSeconds = currentIntervalSec;
      updateCountdownDisplay();
      triggerRefresh(true);
    });
  }

  // Re-sync on tab visibility change (e.g. mobile tab resume)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && currentIntervalSec > 0) {
      remainingSeconds = currentIntervalSec;
      updateCountdownDisplay();
      triggerRefresh(false);
    }
  });

  async function triggerRefresh(isManual = false) {
    if (isFetching) return;
    isFetching = true;

    if (iconRefresh) iconRefresh.classList.add('spin');
    if (textRefresh && isManual) textRefresh.textContent = 'Updating...';

    await fetchDashboardStats();

    if (iconRefresh) {
      setTimeout(() => {
        iconRefresh.classList.remove('spin');
      }, 350);
    }
    if (textRefresh) textRefresh.textContent = 'Refresh';

    isFetching = false;
  }

  // 3. Clear Warnings & Errors
  if (btnClearErrors) {
    btnClearErrors.addEventListener('click', async () => {
      btnClearErrors.disabled = true;
      btnClearErrors.textContent = 'Clearing...';
      try {
        const res = await fetch('/api/analytics/clear-errors', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          await fetchDashboardStats();
        } else {
          alert('Failed to clear warnings: ' + (data.error || 'Unknown error'));
        }
      } catch (err) {
        alert('Error clearing warnings: ' + err.message);
      } finally {
        btnClearErrors.disabled = false;
        btnClearErrors.textContent = 'Clear Warnings';
      }
    });
  }

  // 4. Set concurrency button
  if (btnSaveConcurrency && inputConcurrency) {
    btnSaveConcurrency.addEventListener('click', async () => {
      const val = parseInt(inputConcurrency.value, 10);
      if (isNaN(val) || val < 1 || val > 10) {
        alert('Please enter a concurrency value between 1 and 10');
        return;
      }
      try {
        const res = await fetch('/api/queue/concurrency', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ limit: val })
        });
        const data = await res.json();
        if (data.success) {
          triggerRefresh(false);
        } else {
          alert('Failed to update concurrency: ' + (data.error || 'Unknown error'));
        }
      } catch (err) {
        alert('Error: ' + err.message);
      }
    });
  }

  // 5. Run cleanup button
  if (btnTriggerCleanup) {
    btnTriggerCleanup.addEventListener('click', async () => {
      btnTriggerCleanup.disabled = true;
      btnTriggerCleanup.textContent = 'Cleaning...';
      try {
        const res = await fetch('/api/cleanup/run', { method: 'POST' });
        const data = await res.json();
        alert(`Cleanup finished: ${data.totalDeleted || 0} files deleted.`);
        triggerRefresh(false);
      } catch (e) {
        alert('Cleanup error: ' + e.message);
      } finally {
        btnTriggerCleanup.disabled = false;
        btnTriggerCleanup.textContent = 'Run Cleanup';
      }
    });
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/'/g, '&#39;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function formatDuration(sec) {
    const s = Math.floor(sec % 60);
    const m = Math.floor((sec / 60) % 60);
    const h = Math.floor((sec / 3600) % 24);
    const d = Math.floor(sec / 86400);
    const parts = [];
    if (d > 0) parts.push(`${d}d`);
    if (h > 0) parts.push(`${h}h`);
    if (m > 0) parts.push(`${m}m`);
    parts.push(`${s}s`);
    return parts.join(' ');
  }

  async function fetchDashboardStats() {
    try {
      const res = await fetch('/api/analytics/stats');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      renderDashboard(data);
    } catch (e) {
      console.warn('[Dashboard] Failed to fetch stats:', e.message);
      const badge = document.getElementById('serverStatusBadge');
      const text = document.getElementById('serverStatusText');
      if (badge && text) {
        badge.className = 'status-badge status-danger';
        text.textContent = 'Offline';
      }
    }
  }

  function renderDashboard(data) {
    if (!data) return;

    // 1. Server status & uptime
    const serverBadge = document.getElementById('serverStatusBadge');
    const serverText = document.getElementById('serverStatusText');
    const uptimeBadge = document.getElementById('uptimeBadge');

    if (serverBadge && serverText) {
      serverBadge.className = 'status-badge status-healthy';
      serverText.textContent = 'Online';
    }

    if (uptimeBadge && data.server) {
      uptimeBadge.textContent = 'Uptime: ' + formatDuration(data.server.uptimeSeconds || 0);
    }

    // 2. Stat Cards
    const completedEl = document.getElementById('statCompletedJobs');
    const successRateEl = document.getElementById('statSuccessRate');
    if (completedEl && data.processing) {
      completedEl.textContent = data.processing.completedJobs || 0;
      const total = data.processing.totalJobs || 0;
      const success = data.processing.completedJobs || 0;
      const rate = total > 0 ? Math.round((success / total) * 100) : 100;
      if (successRateEl) {
        successRateEl.textContent = `Success rate: ${rate}% (${total} total)`;
      }
    }

    const activeEl = document.getElementById('statActiveJobs');
    const queuedEl = document.getElementById('statQueuedJobs');
    if (activeEl && data.ffmpeg) {
      activeEl.textContent = `${data.ffmpeg.activeWorkers || 0} / ${data.ffmpeg.maxConcurrency || 1}`;
      if (inputConcurrency) {
        inputConcurrency.value = data.ffmpeg.maxConcurrency || 1;
      }
    }
    if (queuedEl && data.processing) {
      queuedEl.textContent = `${data.processing.queuedJobs || 0} jobs waiting in queue`;
    }

    const procRamEl = document.getElementById('statProcessRam');
    const heapRamEl = document.getElementById('statHeapRam');
    if (procRamEl && data.server?.processMemory) {
      procRamEl.textContent = data.server.processMemory.rssFormatted || '0 MB';
      if (heapRamEl) {
        heapRamEl.textContent = `Heap: ${data.server.processMemory.heapUsedFormatted || '0 MB'}`;
      }
    }

    const freeStorageEl = document.getElementById('statFreeStorage');
    const totalStorageEl = document.getElementById('statTotalStorage');
    if (freeStorageEl && data.storage?.diskStorage) {
      freeStorageEl.textContent = data.storage.diskStorage.freeFormatted || '0 GB';
      if (totalStorageEl) {
        totalStorageEl.textContent = `Total capacity: ${data.storage.diskStorage.totalFormatted || '0 GB'}`;
      }
    }

    // 3. System Metrics Panel
    const platformEl = document.getElementById('metricPlatform');
    if (platformEl && data.server) {
      platformEl.textContent = `${data.server.platform || 'Linux'} ${data.server.isTermux ? '(Termux)' : ''}`;
    }

    const nodeEl = document.getElementById('metricNodeVersion');
    if (nodeEl && data.server) {
      nodeEl.textContent = data.server.nodeVersion || '';
    }

    const ramLoadEl = document.getElementById('metricSystemRamLoad');
    const progressRamEl = document.getElementById('progressSystemRam');
    if (ramLoadEl && data.server?.systemMemory) {
      const pct = data.server.systemMemory.usedPercent || 0;
      ramLoadEl.textContent = `${pct}% (${data.server.systemMemory.freeFormatted} free)`;
      if (progressRamEl) {
        progressRamEl.style.width = `${pct}%`;
        progressRamEl.style.background = pct > 85 ? 'var(--dash-danger)' : (pct > 70 ? 'var(--dash-warning)' : 'var(--dash-primary)');
      }
    }

    // 4. Processing Metrics Panel
    const qCountEl = document.getElementById('metricQueuedCount');
    if (qCountEl && data.processing) qCountEl.textContent = data.processing.queuedJobs || 0;

    const actCountEl = document.getElementById('metricActiveWorkers');
    if (actCountEl && data.ffmpeg) actCountEl.textContent = data.ffmpeg.activeWorkers || 0;

    const avgDurEl = document.getElementById('metricAvgDuration');
    if (avgDurEl && data.processing) avgDurEl.textContent = `${data.processing.avgProcessingTimeSeconds || 0}s`;

    const mediaSizeEl = document.getElementById('metricTotalMediaSize');
    if (mediaSizeEl && data.processing) mediaSizeEl.textContent = data.processing.totalProcessedMediaSize || '0 B';

    // 5. Image Studio Metrics Panel
    const imgBadge = document.getElementById('badgeImageStatus');
    if (imgBadge && data.image) {
      if (data.image.isProcessing) {
        imgBadge.className = 'status-badge status-warning';
        imgBadge.textContent = `Active (${data.image.currentOperation || 'processing'})`;
      } else {
        imgBadge.className = 'status-badge status-healthy';
        imgBadge.textContent = 'Idle';
      }
    }
    const imgCompEl = document.getElementById('metricImageCompleted');
    if (imgCompEl && data.image) imgCompEl.textContent = data.image.totalProcessed || 0;

    const imgFailEl = document.getElementById('metricImageFailed');
    if (imgFailEl && data.image) imgFailEl.textContent = data.image.failed || 0;

    const imgAvgDurEl = document.getElementById('metricImageAvgDuration');
    if (imgAvgDurEl && data.image) imgAvgDurEl.textContent = `${data.image.avgProcessingTimeSeconds || 0}s`;

    const imgSizeEl = document.getElementById('metricImageTotalSize');
    if (imgSizeEl && data.image) imgSizeEl.textContent = data.image.totalProcessedSize || '0 B';

    // 6. PDF Studio Metrics Panel
    const pdfBadge = document.getElementById('badgePdfStatus');
    if (pdfBadge && data.pdf) {
      if (data.pdf.isProcessing) {
        pdfBadge.className = 'status-badge status-warning';
        pdfBadge.textContent = `Active (${data.pdf.currentTool || 'processing'})`;
      } else {
        pdfBadge.className = 'status-badge status-healthy';
        pdfBadge.textContent = 'Idle';
      }
    }
    const pdfCompEl = document.getElementById('metricPdfCompleted');
    if (pdfCompEl && data.pdf) pdfCompEl.textContent = data.pdf.totalProcessed || 0;

    const pdfFailEl = document.getElementById('metricPdfFailed');
    if (pdfFailEl && data.pdf) pdfFailEl.textContent = data.pdf.failed || 0;

    const pdfAvgDurEl = document.getElementById('metricPdfAvgDuration');
    if (pdfAvgDurEl && data.pdf) pdfAvgDurEl.textContent = `${data.pdf.avgProcessingTimeSeconds || 0}s`;

    const pdfSizeEl = document.getElementById('metricPdfTotalSize');
    if (pdfSizeEl && data.pdf) pdfSizeEl.textContent = data.pdf.totalProcessedSize || '0 B';

    // 7. Storage Panel
    const appStorageBadge = document.getElementById('appStorageBadge');
    if (appStorageBadge && data.storage?.totalAppStorage) {
      appStorageBadge.textContent = `${data.storage.totalAppStorage.formatted} used`;
    }

    const sTempEl = document.getElementById('storageTempUploads');
    if (sTempEl && data.storage?.tempUploads) sTempEl.textContent = data.storage.tempUploads.formatted || '0 B';

    const sProcEl = document.getElementById('storageProcessed');
    if (sProcEl && data.storage?.processed) sProcEl.textContent = data.storage.processed.formatted || '0 B';

    const sPdfEl = document.getElementById('storagePdfOutputs');
    if (sPdfEl && data.storage?.pdfOutputs) sPdfEl.textContent = data.storage.pdfOutputs.formatted || '0 B';

    const sThumbsEl = document.getElementById('storageThumbs');
    if (sThumbsEl && data.storage?.tempThumbs) sThumbsEl.textContent = data.storage.tempThumbs.formatted || '0 B';

    const sRetentionEl = document.getElementById('storageRetention');
    if (sRetentionEl && data.storage) sRetentionEl.textContent = `${data.storage.retentionMinutes || 30} minutes`;

    // 6. Recent Errors Panel
    const errorContainer = document.getElementById('errorListContainer');
    const errorBadge = document.getElementById('errorCountBadge');
    const recentErrors = data.processing?.recentErrors || [];

    if (errorBadge) {
      errorBadge.textContent = `${recentErrors.length} Issue(s)`;
      errorBadge.className = recentErrors.length > 0 ? 'status-badge status-warning' : 'status-badge status-healthy';
    }

    if (errorContainer) {
      if (recentErrors.length === 0) {
        errorContainer.innerHTML = '<div style="color:var(--dash-muted); padding:16px 0; text-align:center;">No recent errors or warnings. Server is running smoothly.</div>';
      } else {
        errorContainer.innerHTML = recentErrors.map(err => {
          let timeDisplay = 'Earlier';
          if (err.completedAt) {
            try {
              timeDisplay = new Date(err.completedAt).toLocaleTimeString();
            } catch (e) {}
          }
          return `
            <div class="error-item">
              <div><strong>${escapeHtml(err.name || 'Job issue')}</strong> (${escapeHtml(err.operation || 'process')}):</div>
              <div style="color:var(--dash-danger); margin-top:2px;">${escapeHtml(err.error || 'Interrupted or failed')}</div>
              <div style="color:var(--dash-muted); font-size:11px; margin-top:2px;">${escapeHtml(timeDisplay)}</div>
            </div>
          `;
        }).join('');
      }
    }
  }

  // ==================== SYSTEM & TOOLS CENTER ====================
  const btnCheckToolsUpdate = document.getElementById('btnCheckToolsUpdate');
  const btnCheckToolsText = document.getElementById('btnCheckToolsText');
  const btnTriggerToolsUpdate = document.getElementById('btnTriggerToolsUpdate');
  const btnUpdateToolsText = document.getElementById('btnUpdateToolsText');
  const toolsStatusBadge = document.getElementById('toolsStatusBadge');
  const toolsUpdateDrawer = document.getElementById('toolsUpdateDrawer');
  const toolsUpdateLog = document.getElementById('toolsUpdateLog');
  const btnCloseUpdateDrawer = document.getElementById('btnCloseUpdateDrawer');

  async function loadToolsInfo() {
    try {
      const res = await fetch('/api/system/tools-info');
      if (!res.ok) return;
      const data = await res.json();
      if (!data.success) return;

      const fVerEl = document.getElementById('toolFfmpegVersion');
      const fMetaEl = document.getElementById('toolFfmpegMeta');
      if (fVerEl) fVerEl.textContent = data.tools?.ffmpeg?.version ? `v${data.tools.ffmpeg.version}` : 'Not Detected';
      if (fMetaEl) fMetaEl.textContent = `${data.system?.platform || 'linux'} (${data.system?.arch || 'arm64'})`;

      const pVerEl = document.getElementById('toolFfprobeVersion');
      const pMetaEl = document.getElementById('toolFfprobeMeta');
      if (pVerEl) pVerEl.textContent = data.tools?.ffprobe?.version ? `v${data.tools.ffprobe.version}` : 'Not Detected';
      if (pMetaEl) pMetaEl.textContent = 'Analyzer Ready';

      const aVerEl = document.getElementById('toolAppVersion');
      const aMetaEl = document.getElementById('toolAppMeta');
      if (aVerEl) aVerEl.textContent = `v${data.app?.version || '1.0.0'}`;
      if (aMetaEl) aMetaEl.textContent = `Branch: ${data.app?.gitBranch || 'main'} (${data.app?.gitCommit || 'latest'})`;

      const sStatEl = document.getElementById('toolStorageStatus');
      const sMetaEl = document.getElementById('toolStorageMeta');
      if (sStatEl) {
        if (data.storage?.accessible) {
          sStatEl.textContent = data.storage.writable ? 'Full Access ✔' : 'Read Only ⚠';
          sStatEl.style.color = data.storage.writable ? 'var(--dash-success)' : 'var(--dash-warning)';
        } else {
          sStatEl.textContent = 'Locked 🔒';
          sStatEl.style.color = 'var(--dash-danger)';
        }
      }
      if (sMetaEl) sMetaEl.textContent = data.storage?.path ? `${data.storage.path} available` : 'Internal storage';
    } catch (_) {}
  }

  if (btnCloseUpdateDrawer) {
    btnCloseUpdateDrawer.addEventListener('click', () => {
      if (toolsUpdateDrawer) toolsUpdateDrawer.style.display = 'none';
    });
  }

  if (btnCheckToolsUpdate) {
    btnCheckToolsUpdate.addEventListener('click', async () => {
      try {
        if (btnCheckToolsText) btnCheckToolsText.textContent = 'Checking...';
        btnCheckToolsUpdate.disabled = true;

        const res = await fetch('/api/system/check-updates', { method: 'POST' });
        const data = await res.json();

        if (toolsUpdateDrawer) toolsUpdateDrawer.style.display = 'block';
        if (toolsUpdateLog) {
          if (data.updateAvailable) {
            toolsUpdateLog.textContent = `[UPDATE AVAILABLE]\nLatest version: ${data.latestAppRelease?.tag || 'Newer'}\nPublished: ${data.latestAppRelease?.publishedAt || 'Recently'}\n\nNotes:\n${data.latestAppRelease?.notes || 'Bug fixes and performance improvements.'}`;
            if (toolsStatusBadge) {
              toolsStatusBadge.textContent = 'Update Available 🚀';
              toolsStatusBadge.className = 'status-badge status-warning';
            }
          } else {
            toolsUpdateLog.textContent = `[STATUS]\nAll tools and app engine are up to date!\nCurrent Version: v${data.currentAppVersion}\nFFmpeg: v${data.tools?.ffmpeg?.version || 'Installed'}\nCan Update via Package Manager: ${data.canUpdateTools ? 'Yes' : 'Manual'}`;
            if (toolsStatusBadge) {
              toolsStatusBadge.textContent = 'Up to Date ✔';
              toolsStatusBadge.className = 'status-badge status-healthy';
            }
          }
        }
      } catch (err) {
        if (toolsUpdateDrawer) toolsUpdateDrawer.style.display = 'block';
        if (toolsUpdateLog) toolsUpdateLog.textContent = `[Error checking updates]: ${err.message}`;
      } finally {
        if (btnCheckToolsText) btnCheckToolsText.textContent = 'Check for Updates';
        btnCheckToolsUpdate.disabled = false;
      }
    });
  }

  if (btnTriggerToolsUpdate) {
    btnTriggerToolsUpdate.addEventListener('click', async () => {
      const confirmRun = confirm('Do you want to update FFmpeg and native media tools now?');
      if (!confirmRun) return;

      try {
        if (btnUpdateToolsText) btnUpdateToolsText.textContent = 'Updating...';
        btnTriggerToolsUpdate.disabled = true;
        if (toolsUpdateDrawer) toolsUpdateDrawer.style.display = 'block';
        if (toolsUpdateLog) toolsUpdateLog.textContent = '[Executing Tools Update Command...]\nPlease wait, this may take a moment...';

        const res = await fetch('/api/system/update-tools', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target: 'ffmpeg' })
        });
        const result = await res.json();

        if (toolsUpdateLog) {
          toolsUpdateLog.textContent = `[Update ${result.success ? 'COMPLETED' : 'RESULT'}]\n${result.message || ''}\n\n${result.output || result.error || ''}`;
        }
        await loadToolsInfo();
      } catch (err) {
        if (toolsUpdateLog) toolsUpdateLog.textContent = `[Update Failed]: ${err.message}`;
      } finally {
        if (btnUpdateToolsText) btnUpdateToolsText.textContent = '⬇ Update Tools';
        btnTriggerToolsUpdate.disabled = false;
      }
    });
  }

  // Initial load and start timer
  const initialMs = refreshIntervalSelect ? parseInt(refreshIntervalSelect.value, 10) : 10000;
  triggerRefresh(false);
  loadToolsInfo();
  setupAutoRefresh(initialMs);
})();
