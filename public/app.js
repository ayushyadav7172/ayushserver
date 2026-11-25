// Termux FFmpeg Web Studio - Direct Storage Client

// State
let selectedMedia = null;
let currentExplorerDir = '/sdcard';
let explorerAllowedRoots = ['/sdcard'];
let currentParentDir = null;
let currentJobId = null;
let isConversionRunning = false;
let eventSource = null;

// DOM Elements
const sidebar = document.getElementById('appSidebar');
const btnMobileMenu = document.getElementById('btnMobileMenu');
const ffmpegVersionText = document.getElementById('ffmpegVersionText');
const toastContainer = document.getElementById('toastContainer');

async function readApiPayload(res) {
  const raw = await res.text();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    const message = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    return { error: message || `Request failed (${res.status})` };
  }
}

// Explorer DOM
const btnOpenExplorer = document.getElementById('btnOpenExplorer');
const fileExplorerModal = document.getElementById('fileExplorerModal');
const btnCloseExplorer = document.getElementById('btnCloseExplorer');
const btnCancelExplorer = document.getElementById('btnCancelExplorer');
const btnExplorerUp = document.getElementById('btnExplorerUp');
const btnExplorerRefresh = document.getElementById('btnExplorerRefresh');
const explorerBreadcrumbs = document.getElementById('explorerBreadcrumbs');
const explorerItemList = document.getElementById('explorerItemList');
const explorerLoading = document.getElementById('explorerLoading');
const explorerErrorBanner = document.getElementById('explorerErrorBanner');
const directPathInput = document.getElementById('directPathInput');
const btnLoadPath = document.getElementById('btnLoadPath');

// Selected Media DOM
const selectedMediaCard = document.getElementById('selectedMediaCard');
const selectedMediaIcon = document.getElementById('selectedMediaIcon');
const selectedMediaName = document.getElementById('selectedMediaName');
const selectedMediaPath = document.getElementById('selectedMediaPath');
const selectedMetaPills = document.getElementById('selectedMetaPills');
const btnReopenExplorer = document.getElementById('btnReopenExplorer');
const btnProceedToOperations = document.getElementById('btnProceedToOperations');
const targetFileNameDisplay = document.getElementById('targetFileNameDisplay');

// Active Job DOM
const noActiveJobState = document.getElementById('noActiveJobState');
const activeJobMonitor = document.getElementById('activeJobMonitor');
const activeJobTitle = document.getElementById('activeJobTitle');
const activeJobStatusPill = document.getElementById('activeJobStatusPill');
const activeJobCommand = document.getElementById('activeJobCommand');
const activePercentDisplay = document.getElementById('activePercentDisplay') || document.getElementById('percentageText');
const activeTimeDisplay = document.getElementById('activeTimeDisplay') || document.getElementById('timeText');
const activeDurationDisplay = document.getElementById('activeDurationDisplay') || document.getElementById('durationText');
const activeSpeedDisplay = document.getElementById('activeSpeedDisplay') || document.getElementById('speedText');
const activeFilenameDisplay = document.getElementById('activeFilenameDisplay') || document.getElementById('filenameText');
const activeProgressBar = document.getElementById('progressBar') || document.getElementById('activeProgressBar');
const progressBar = activeProgressBar;
const activePulse = document.getElementById('activePulse');
const termuxLiveStatus = document.getElementById('termuxLiveStatus');
let jobPollingInterval = null;
const jobResultPreviewBox = document.getElementById('jobResultPreviewBox');
const mediaPreviewContainer = document.getElementById('mediaPreviewContainer');
const savedPathLocation = document.getElementById('savedPathLocation');
const btnCopySavedPath = document.getElementById('btnCopySavedPath');
const btnUseAsInput = document.getElementById('btnUseAsInput');
const resultMetaSize = document.getElementById('resultMetaSize');
const btnViewActiveLogs = document.getElementById('btnViewActiveLogs');
const btnCancelJob = document.getElementById('btnCancelJob');

// Modal & Logs DOM
const logModal = document.getElementById('logModal');
const modalCmdText = document.getElementById('modalCmdText');
const modalLogContent = document.getElementById('modalLogContent');
const historyContainer = document.getElementById('historyContainer');
const btnRefreshHistory = document.getElementById('btnRefreshHistory');
const btnClearHistory = document.getElementById('btnClearHistory');

// New Helper DOM
const storageNoticeBanner = document.getElementById('storageNoticeBanner');
const btnCopyStorageCmd = document.getElementById('btnCopyStorageCmd');
const explorerSearchInput = document.getElementById('explorerSearchInput');
const btnClearSearch = document.getElementById('btnClearSearch');
const btnDownloadOutput = document.getElementById('btnDownloadOutput');
const btnProminentDownload = document.getElementById('btnProminentDownload');
const btnMediaModeLocal = document.getElementById('btnMediaModeLocal');
const btnMediaModeRemote = document.getElementById('btnMediaModeRemote');
const mediaLocalSection = document.getElementById('mediaLocalSection');
const mediaRemoteSection = document.getElementById('mediaRemoteSection');
const mediaDropzone = document.getElementById('mediaDropzone');
const mediaFileInput = document.getElementById('mediaFileInput');
const mediaUploadProgress = document.getElementById('mediaUploadProgress');
const mediaUploadProgressBar = document.getElementById('mediaUploadProgressBar');
const mediaUploadProgressText = document.getElementById('mediaUploadProgressText');
const mediaUploadSpeedText = document.getElementById('mediaUploadSpeedText');
const mediaUploadTimer = document.getElementById('mediaUploadTimer');
const mediaOutputTimer = document.getElementById('mediaOutputTimer');
let mediaUploadCountdownTimer = null;
let mediaOutputCountdownTimer = null;
let allExplorerItems = [];

function isMediaRemoteMode() {
  return Boolean(btnMediaModeRemote && btnMediaModeRemote.classList.contains('active'));
}

function initMediaUploadTimer() {
  if (!mediaUploadCountdownTimer) {
    mediaUploadCountdownTimer = new AutoCleanupTimer(mediaUploadTimer, 'ffstudio_media_upload_timer', () => {
      showToast('Uploaded file expired (30-minute limit).', 'warning');
      clearSelectedMedia();
    });
  }
  return mediaUploadCountdownTimer;
}

function initMediaOutputTimer() {
  if (!mediaOutputCountdownTimer) {
    mediaOutputCountdownTimer = new AutoCleanupTimer(mediaOutputTimer, 'ffstudio_media_output_timer', () => {
      showToast('Output file expired (30-minute limit).', 'warning');
      if (btnProminentDownload) btnProminentDownload.style.display = 'none';
    });
  }
  return mediaOutputCountdownTimer;
}

// ======================== AUTO-CLEANUP TIMER & SESSION HELPERS ========================
class AutoCleanupTimer {
  constructor(element, storageKey, onExpire) {
    this.element = typeof element === 'string' ? document.getElementById(element) : element;
    this.storageKey = storageKey;
    this.onExpire = onExpire;
    this.interval = null;
    this.expiresAt = null;
    this.label = 'File will be deleted in';
  }

  start(expiresAt, label = 'File will be deleted in') {
    this.stop();
    const parsed = Number(expiresAt);
    if (!parsed || isNaN(parsed)) return;
    this.expiresAt = parsed;
    this.label = label;
    if (this.storageKey) {
      try {
        sessionStorage.setItem(this.storageKey, JSON.stringify({
          expiresAt: this.expiresAt,
          label: this.label
        }));
      } catch (e) {}
    }
    this.tick();
    this.interval = setInterval(() => this.tick(), 1000);
  }

  showExpired() {
    this.stop();
    if (!this.element) return;
    this.element.style.display = 'inline-flex';
    this.element.className = 'countdown-timer-box is-expired';
    this.element.innerHTML = '⚠️ <span>File expired (auto-deleted)</span>';
    if (this.storageKey) {
      try {
        sessionStorage.removeItem(this.storageKey);
        localStorage.removeItem(this.storageKey);
      } catch (e) {}
    }
  }

  recover() {
    if (!this.storageKey) return false;
    try {
      const raw = sessionStorage.getItem(this.storageKey) || localStorage.getItem(this.storageKey);
      if (!raw) return false;
      const data = JSON.parse(raw);
      if (data && data.expiresAt) {
        const exp = Number(data.expiresAt);
        if (exp > Date.now()) {
          this.start(exp, data.label || 'File will be deleted in');
          return true;
        } else {
          this.showExpired();
          if (typeof this.onExpire === 'function') this.onExpire();
          return false;
        }
      }
    } catch (e) {}
    return false;
  }

  tick() {
    if (!this.element) return;
    if (!this.expiresAt || isNaN(this.expiresAt)) {
      this.clear();
      return;
    }
    const remaining = Math.max(0, this.expiresAt - Date.now());
    if (remaining <= 0) {
      this.showExpired();
      if (typeof this.onExpire === 'function') this.onExpire();
      return;
    }

    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    const formatted = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    this.element.style.display = 'inline-flex';
    this.element.className = 'countdown-timer-box';
    this.element.innerHTML = `⚠️ <span>${this.label} ${formatted}</span>`;
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  clear() {
    this.stop();
    if (this.element) {
      this.element.style.display = 'none';
      this.element.textContent = '';
    }
    if (this.storageKey) {
      try {
        sessionStorage.removeItem(this.storageKey);
        localStorage.removeItem(this.storageKey);
      } catch (e) {}
    }
  }
}

function getOrCreateSessionId() {
  let sid = null;
  try {
    sid = sessionStorage.getItem('ffstudio_session_id');
    if (!sid) {
      sid = 'sess_' + Date.now() + '_' + Math.random().toString(36).substring(2, 10);
      sessionStorage.setItem('ffstudio_session_id', sid);
    }
  } catch (e) {
    sid = 'sess_' + Date.now();
  }
  return sid;
}

function isRemoteModeActive() {
  return Boolean(btnMediaModeRemote && btnMediaModeRemote.classList.contains('active'));
}

// ======================== ROUTING & TAB NAVIGATION ========================
const ROUTE_CONFIG = {
  'home': 'panel-explorer',
  'explorer': 'panel-explorer',
  'upload': 'panel-explorer',
  'operations': 'panel-operations',
  'active-job': 'panel-active-job',
  'task': 'panel-active-job',
  'history': 'panel-history'
};

const PANEL_CONFIG = {
  'panel-explorer': 'home',
  'panel-operations': 'operations',
  'panel-active-job': 'active-job',
  'panel-history': 'history'
};

function getTabFromHash() {
  const hash = window.location.hash || '';
  const clean = hash.replace(/^#\/?/, '').toLowerCase().trim();
  return clean || null;
}

function handleRouting() {
  let tabId = getTabFromHash();

  // If no hash in URL, restore from localStorage (fallback, default to 'home')
  if (!tabId) {
    const savedTab = localStorage.getItem('activeTab');
    tabId = (savedTab && (ROUTE_CONFIG[savedTab] || document.getElementById(savedTab))) ? savedTab : 'home';
    // Update hash to reflect the active tab
    window.location.hash = `#${tabId}`;
    return; // Updating hash fires 'hashchange' which re-invokes handleRouting
  }

  // Determine which panel (div) corresponds to this tabId
  let panelId = ROUTE_CONFIG[tabId];
  if (!panelId) {
    if (document.getElementById(tabId)) {
      panelId = tabId;
    } else if (document.getElementById(`panel-${tabId}`)) {
      panelId = `panel-${tabId}`;
    } else {
      panelId = 'panel-explorer';
      tabId = 'home';
    }
  }

  const canonicalTab = PANEL_CONFIG[panelId] || tabId;

  // Persist the active tab in localStorage
  localStorage.setItem('activeTab', canonicalTab);

  // Show the correct section (div) while hiding others
  document.querySelectorAll('.content-panel').forEach(panel => {
    if (panel.id === panelId) {
      panel.classList.add('active');
    } else {
      panel.classList.remove('active');
    }
  });

  // Update navigation items active state
  document.querySelectorAll('.nav-item').forEach(item => {
    const target = item.getAttribute('data-target');
    const tab = item.getAttribute('data-tab');
    if (target === panelId || tab === canonicalTab || tab === tabId) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });

  // Panel-specific data refresh
  if (panelId === 'panel-history') {
    loadJobHistory();
  }
}

// Global switchPanel function (sets hash and triggers routing)
function switchPanel(panelId) {
  const tabId = PANEL_CONFIG[panelId] || (panelId ? panelId.replace(/^panel-/, '') : 'home');
  localStorage.setItem('activeTab', tabId);
  if (window.location.hash === `#${tabId}`) {
    handleRouting();
  } else {
    window.location.hash = `#${tabId}`;
  }
}
window.switchPanel = switchPanel;
window.handleRouting = handleRouting;

// Routing Event Listeners
window.addEventListener('hashchange', handleRouting);
window.addEventListener('load', handleRouting);
// window.onload = handleRouting; // Removed: duplicate of addEventListener above

// ======================== GLOBAL HELPER FUNCTIONS ========================

// Helper: Format seconds to HH:MM:SS (needed client-side for trim controls, preview player timestamps)
function formatTime(seconds) {
  if (!seconds || isNaN(seconds)) return '00:00:00';
  const sec = Math.max(0, Math.floor(seconds));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
}

// Helper: Parse time string (HH:MM:SS or MM:SS or raw seconds) to seconds
function parseTimeToSeconds(str) {
  if (!str) return 0;
  if (typeof str === 'number') return str;
  const clean = String(str).trim();
  const parts = clean.split(':');
  if (parts.length === 3) {
    const h = parseInt(parts[0], 10) || 0;
    const m = parseInt(parts[1], 10) || 0;
    const s = parseFloat(parts[2]) || 0;
    return h * 3600 + m * 60 + s;
  } else if (parts.length === 2) {
    const m = parseInt(parts[0], 10) || 0;
    const s = parseFloat(parts[1]) || 0;
    return m * 60 + s;
  }
  const val = parseFloat(clean);
  return isNaN(val) ? 0 : val;
}

// Helper: Copy text to clipboard (works on both HTTPS and HTTP localhost)
function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  return new Promise((resolve, reject) => {
    try {
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.style.position = 'fixed';
      textArea.style.left = '-999999px';
      textArea.style.top = '-999999px';
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      const successful = document.execCommand('copy');
      document.body.removeChild(textArea);
      if (successful) resolve();
      else reject(new Error('execCommand failed'));
    } catch (err) {
      reject(err);
    }
  });
}

// ======================== INITIALIZATION & RESTORE STATE ========================
document.addEventListener('DOMContentLoaded', () => {
  setupThemeToggle();
  setupNavigation();
  setupStorageModeAndUpload();
  setupExplorerListeners();
  setupMultiOpListeners();
  setupCustomCommandListeners();
  checkSystemInfo();
  loadJobHistory();

  // Restore selected file state from localStorage (instant, no redundant analyze call)
  restoreSelectedMediaState();

  handleRouting(); // Show correct section on initial DOM load
  checkActiveJobState(); // Check if job is already running on page load

  // Resize preset dropdown listener
  window.handleResizePresetChange = function(val) {
    const customRow = document.getElementById('customResizeRow');
    if (customRow) {
      customRow.style.display = (val === 'custom') ? 'flex' : 'none';
    }
  };
});

function setupStorageModeAndUpload() {
  // Mode Toggle logic
  function setMode(mode) {
    if (isConversionRunning) {
      showToast('A media conversion is currently running. Please wait for it to finish or stop it before switching modes.', 'warning');
      return;
    }
    if (mode === 'remote') {
      if (btnMediaModeLocal) btnMediaModeLocal.classList.remove('active');
      if (btnMediaModeRemote) btnMediaModeRemote.classList.add('active');
      if (mediaLocalSection) mediaLocalSection.style.display = 'none';
      if (mediaRemoteSection) mediaRemoteSection.style.display = 'block';
      localStorage.setItem('ffstudio_media_mode', 'remote');
      initMediaUploadTimer().recover();
      initMediaOutputTimer().recover();
    } else {
      if (btnMediaModeRemote) btnMediaModeRemote.classList.remove('active');
      if (btnMediaModeLocal) btnMediaModeLocal.classList.add('active');
      if (mediaRemoteSection) mediaRemoteSection.style.display = 'none';
      if (mediaLocalSection) mediaLocalSection.style.display = 'block';
      localStorage.setItem('ffstudio_media_mode', 'local');
      if (mediaUploadCountdownTimer) {
        mediaUploadCountdownTimer.clear();
        mediaUploadCountdownTimer = null;
      }
      if (mediaOutputCountdownTimer) {
        mediaOutputCountdownTimer.clear();
        mediaOutputCountdownTimer = null;
      }
      if (mediaOutputTimer) {
        mediaOutputTimer.style.display = 'none';
        mediaOutputTimer.innerHTML = '';
      }
      try {
        sessionStorage.removeItem('ffstudio_media_output_timer');
        localStorage.removeItem('ffstudio_media_output_timer');
      } catch (e) {}
    }

    // Reset selected media and form inputs on mode switch
    clearSelectedMedia();
    if (mediaFileInput) mediaFileInput.value = '';
    if (explorerSearchInput) explorerSearchInput.value = '';
  }

  if (btnMediaModeLocal) {
    btnMediaModeLocal.addEventListener('click', () => setMode('local'));
  }
  if (btnMediaModeRemote) {
    btnMediaModeRemote.addEventListener('click', () => setMode('remote'));
  }

  // Restore saved mode preference
  const savedMode = localStorage.getItem('ffstudio_media_mode') || 'local';
  setMode(savedMode);

  // Manual Reset / Clear Session Handler
  const btnClearMediaSession = document.getElementById('btnClearMediaSession');
  if (btnClearMediaSession) {
    btnClearMediaSession.addEventListener('click', () => {
      if (isConversionRunning) {
        showToast('Cannot reset session while a conversion is currently running.', 'warning');
        return;
      }
      if (confirm('Reset your remote session? This clears your temporary session key and reset timers.')) {
        if (mediaUploadCountdownTimer) mediaUploadCountdownTimer.clear();
        if (mediaOutputCountdownTimer) mediaOutputCountdownTimer.clear();
        mediaUploadCountdownTimer = null;
        mediaOutputCountdownTimer = null;
        clearSelectedMedia();
        try {
          sessionStorage.removeItem('ffstudio_session_id');
          localStorage.removeItem('ffstudio_session_id');
        } catch (e) {}
        showToast('Session reset. A fresh session ID has been generated.', 'info');
      }
    });
  }

  // Upload handler
  function uploadFile(file) {
    if (!file) return;
    if (isConversionRunning) {
      showToast('A conversion is already running. Please wait for it to finish or cancel it before uploading.', 'warning');
      return;
    }

    const ALLOWED_MEDIA = new Set([
      '.mp4', '.mkv', '.avi', '.mov', '.webm',
      '.mp3', '.wav', '.m4a', '.aac',
      '.flac', '.ogg', '.opus', '.ts', '.m4v', '.3gp'
    ]);
    const ext = '.' + (file.name.split('.').pop() || '').toLowerCase();
    if (!ALLOWED_MEDIA.has(ext)) {
      showToast(`Unsupported media format (${ext || 'unknown'}). Please upload a video or audio file (.mp4, .mkv, .mp3, etc.).`, 'error');
      return;
    }

    if (mediaUploadProgress) mediaUploadProgress.style.display = 'block';
    if (mediaUploadProgressBar) mediaUploadProgressBar.style.width = '0%';
    if (mediaUploadProgressText) mediaUploadProgressText.textContent = `Uploading ${file.name} (0%)...`;

    const formData = new FormData();
    formData.append('file', file);

    const xhr = new XMLHttpRequest();
    const startTime = Date.now();

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        const percent = Math.min(100, Math.round((e.loaded / e.total) * 100));
        if (mediaUploadProgressBar) mediaUploadProgressBar.style.width = `${percent}%`;
        const elapsedSec = (Date.now() - startTime) / 1000;
        const bytesPerSec = elapsedSec > 0 ? e.loaded / elapsedSec : 0;
        const speedFormatted = (bytesPerSec / (1024 * 1024)).toFixed(1) + ' MB/s';
        if (mediaUploadProgressText) mediaUploadProgressText.textContent = `Uploading ${file.name} (${percent}%)...`;
        if (mediaUploadSpeedText) mediaUploadSpeedText.textContent = speedFormatted;
      }
    });

    xhr.addEventListener('load', async () => {
      if (mediaUploadProgress) mediaUploadProgress.style.display = 'none';
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300 && data.success) {
          showToast(`File uploaded successfully: ${file.name}`, 'success');
          const uploadedFile = data.file || (data.files && data.files[0]);
          if (uploadedFile) {
            initMediaUploadTimer().start(uploadedFile.expiresAt, 'File will be deleted in');
            // Analyze the uploaded file and transition to Step 2 Configure
            await selectMediaFile(uploadedFile.path);
          }
        } else {
          showToast(data.error || 'Upload failed.', 'error');
        }
      } catch (err) {
        showToast('Error parsing upload response: ' + err.message, 'error');
      }
    });

    xhr.addEventListener('error', () => {
      if (mediaUploadProgress) mediaUploadProgress.style.display = 'none';
      showToast('Network error during file upload.', 'error');
    });

    xhr.open('POST', '/api/upload');
    xhr.setRequestHeader('X-Session-ID', getOrCreateSessionId());
    xhr.send(formData);
  }

  // Drag and drop listeners on mediaDropzone
  if (mediaDropzone) {
    ['dragenter', 'dragover'].forEach(eventName => {
      mediaDropzone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        mediaDropzone.classList.add('dragover');
      });
    });

    ['dragleave', 'dragend', 'drop'].forEach(eventName => {
      mediaDropzone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        mediaDropzone.classList.remove('dragover');
      });
    });

    mediaDropzone.addEventListener('drop', (e) => {
      const dt = e.dataTransfer;
      if (dt && dt.files && dt.files.length > 0) {
        uploadFile(dt.files[0]);
      }
    });
  }

  if (mediaFileInput) {
    mediaFileInput.addEventListener('change', () => {
      if (mediaFileInput.files && mediaFileInput.files.length > 0) {
        uploadFile(mediaFileInput.files[0]);
        mediaFileInput.value = '';
      }
    });
  }
}

// ======================== PROGRESS & SSE FALLBACK ========================

// Central Progress DOM updater: updates progress bar width, percentage, time, speed
function updateProgressStats({ progress, currentTime, totalDuration, speed, filename }) {
  const p = Math.min(100, Math.max(0, parseInt(progress, 10) || 0));
  const curTime = currentTime || '00:00:00';
  const totDur = totalDuration || '00:00:00';

  // Format speed: if N/A or empty, display 'Speed: Calculating...'
  let speedDisplay = 'Speed: Calculating...';
  if (speed && speed !== 'N/A' && speed.trim() !== 'N/A' && speed !== '0.0x' && speed !== '0x') {
    speedDisplay = speed.trim();
  }

  // 1. Progress Bar Width - Required format: document.getElementById('progressBar').style.width = progress + '%';
  const pBar = document.getElementById('progressBar') || document.getElementById('activeProgressBar');
  if (pBar) {
    pBar.style.width = p + '%';
  }
  const altBar = document.getElementById('activeProgressBar');
  if (altBar && altBar !== pBar) {
    altBar.style.width = p + '%';
  }

  // 2. Percentage Text
  const pText = document.getElementById('activePercentDisplay') || document.getElementById('percentageText');
  if (pText) {
    pText.textContent = `${p}%`;
  }
  const altPText = document.getElementById('percentageText');
  if (altPText && altPText !== pText) {
    altPText.textContent = `${p}%`;
  }

  // 3. Elapsed Time Text
  const tText = document.getElementById('activeTimeDisplay') || document.getElementById('timeText');
  if (tText) {
    tText.textContent = curTime;
  }
  const altTText = document.getElementById('timeText');
  if (altTText && altTText !== tText) {
    altTText.textContent = curTime;
  }

  // 4. Target Duration Text
  const dText = document.getElementById('activeDurationDisplay') || document.getElementById('durationText');
  if (dText) {
    dText.textContent = totDur;
  }
  const altDText = document.getElementById('durationText');
  if (altDText && altDText !== dText) {
    altDText.textContent = totDur;
  }

  // 5. Encoding Speed Text: if 'N/A', show 'Speed: Calculating...' instead of breaking
  const sText = document.getElementById('activeSpeedDisplay') || document.getElementById('speedText');
  if (sText) {
    sText.textContent = speedDisplay;
  }
  const altSText = document.getElementById('speedText');
  if (altSText && altSText !== sText) {
    altSText.textContent = speedDisplay;
  }

  // 6. Filename
  if (filename) {
    const fText = document.getElementById('activeFilenameDisplay') || document.getElementById('filenameText');
    if (fText) fText.textContent = filename;
  }

  // 7. Termux Live Status Bar
  const liveStatus = document.getElementById('termuxLiveStatus');
  if (liveStatus) {
    const rawSpd = (!speed || speed === 'N/A' || speed.trim() === 'N/A') ? 'Calculating...' : speed.trim();
    liveStatus.textContent = `Time: ${curTime} / ${totDur} | Speed: ${rawSpd} | ${p}%`;
  }
}

// Polling fallback mechanism: polls /api/current-job with recursive setTimeout if EventSource fails
let jobPollingTimeout = null;
let isPollingFallbackActive = false;

function startPollingFallback() {
  if (isPollingFallbackActive) return;
  isPollingFallbackActive = true;
  console.log('[SSE Fallback] Starting HTTP polling for /api/current-job every 2s');

  const executePoll = () => {
    if (!isPollingFallbackActive) return;
    pollCurrentJob().finally(() => {
      if (isPollingFallbackActive) {
        jobPollingTimeout = setTimeout(executePoll, 2000);
      }
    });
  };

  executePoll();
}

function stopPollingFallback() {
  isPollingFallbackActive = false;
  if (jobPollingTimeout) {
    clearTimeout(jobPollingTimeout);
    jobPollingTimeout = null;
  }
  if (jobPollingInterval) {
    clearInterval(jobPollingInterval);
    jobPollingInterval = null;
  }
  console.log('[SSE Fallback] HTTP polling stopped');
}

async function pollCurrentJob() {
  try {
    const sessionId = getOrCreateSessionId();
    const res = await fetch(`/api/current-job?sessionId=${encodeURIComponent(sessionId)}`);
    if (!res.ok) return;
    const data = await readApiPayload(res);
    if (!data || !data.activeJob) return;

    const job = data.activeJob;
    if (job.status === 'processing') {
      updateProgressStats({
        progress: job.progress || 0,
        currentTime: job.currentTime || '00:00:00',
        totalDuration: job.totalDuration || '00:00:00',
        speed: job.speed || 'N/A',
        filename: job.filename || '-'
      });
    } else if (job.status === 'completed') {
      stopPollingFallback();
      if (eventSource) { try { eventSource.close(); } catch (e) {} eventSource = null; }
      handleJobCompleted(data);
    } else if (job.status === 'failed') {
      stopPollingFallback();
      if (eventSource) { try { eventSource.close(); } catch (e) {} eventSource = null; }
      handleJobFailed(data);
    } else if (job.status === 'cancelled') {
      stopPollingFallback();
      if (eventSource) { try { eventSource.close(); } catch (e) {} eventSource = null; }
      handleJobCancelled(data);
    }
  } catch (err) {
    console.warn('[SSE Fallback] Polling request failed:', err.message);
  }
}

// Check & Restore Active Job State (Preserves UI if user refreshes page)
async function checkActiveJobState() {
  try {
    const sessionId = getOrCreateSessionId();
    const res = await fetch(`/api/current-job?sessionId=${encodeURIComponent(sessionId)}`);
    const data = await readApiPayload(res);
    if (!res.ok || !data.activeJob) return;

    const job = data.activeJob;

    if (job.status === 'processing') {
      console.log('[State Restore] Running job found:', job);
      isConversionRunning = true;
      currentJobId = job.jobId;

      // Only redirect to Active Task panel if user didn't explicitly request another tab in URL
      const currentTab = getTabFromHash();
      if (!currentTab || currentTab === 'home' || currentTab === 'active-job') {
        window.location.hash = '#active-job';
      }

      // Display processing UI
      noActiveJobState.style.display = 'none';
      activeJobMonitor.style.display = 'block';
      jobResultPreviewBox.style.display = 'none';
      if (activePulse) activePulse.style.display = 'inline-block';
      if (btnCancelJob) {
        btnCancelJob.style.display = 'inline-flex';
        btnCancelJob.disabled = false;
        btnCancelJob.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" ry="2"></rect></svg><span>Stop Conversion</span>';
      }

      // Set titles & command
      activeJobTitle.textContent = `Processing: ${job.filename || 'Task'}`;
      activeJobStatusPill.className = 'status-pill status-processing';
      activeJobStatusPill.textContent = 'Processing';
      activeJobCommand.textContent = job.commandString || 'ffmpeg ...';

      // Update progress values
      updateProgressStats({
        progress: job.progress || 0,
        currentTime: job.currentTime || '00:00:00',
        totalDuration: job.totalDuration || '00:00:00',
        speed: job.speed || 'N/A',
        filename: job.filename || '-'
      });

      // Reconnect to SSE stream to get live updates
      listenJobProgress(job.jobId);
      showToast(`Resumed monitoring: ${job.filename}`, 'info');
    } else if (job.status === 'completed' && (data.isAvailable || data.outputAvailable)) {
      console.log('[State Restore] Completed job with valid output file found:', job);
      currentJobId = job.jobId;
      const currentTab = getTabFromHash();
      if (!currentTab || currentTab === 'home' || currentTab === 'active-job') {
        window.location.hash = '#active-job';
      }
      noActiveJobState.style.display = 'none';
      activeJobMonitor.style.display = 'block';
      handleJobCompleted({
        type: 'status',
        status: 'completed',
        jobId: job.jobId,
        outputFile: job.outputFile,
        activeJob: job
      });
    }
  } catch (err) {
    console.warn('Failed to check active job state:', err.message);
  }
}

// Theme Handling (light / dark)
function applyTheme(theme) {
  const next = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', next === 'light' ? '#f6f7f9' : '#0f1115');
  const toggle = document.getElementById('themeToggle');
  if (toggle) toggle.setAttribute('aria-label', next === 'light' ? 'Switch to dark theme' : 'Switch to light theme');
  return next;
}

function setupThemeToggle() {
  const toggle = document.getElementById('themeToggle');
  let current = document.documentElement.getAttribute('data-theme') || 'dark';
  applyTheme(current);

  if (toggle) {
    toggle.addEventListener('click', () => {
      current = current === 'light' ? 'dark' : 'light';
      applyTheme(current);
      try { localStorage.setItem('ffstudio-theme', current); } catch (e) {}
    });
  }

  // Follow the OS preference only while the user hasn't chosen explicitly.
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', (e) => {
      let stored = null;
      try { stored = localStorage.getItem('ffstudio-theme'); } catch (err) {}
      if (stored) return;
      current = applyTheme(e.matches ? 'light' : 'dark');
    });
  }
}

// Navigation Handling
function setupNavigation() {
  const navItems = document.querySelectorAll('.nav-item');
  navItems.forEach(item => {
    item.addEventListener('click', () => {
      const tabId = item.getAttribute('data-tab') || (item.getAttribute('data-target') ? PANEL_CONFIG[item.getAttribute('data-target')] : null) || 'home';
      
      // Save active tab in localStorage
      localStorage.setItem('activeTab', tabId);

      // Update URL hash (e.g. #operations)
      if (window.location.hash === `#${tabId}`) {
        handleRouting();
      } else {
        window.location.hash = `#${tabId}`;
      }

      if (window.innerWidth <= 768 && sidebar) {
        sidebar.classList.remove('open');
      }
    });
  });

  if (btnMobileMenu) {
    btnMobileMenu.addEventListener('click', (e) => {
      e.stopPropagation();
      sidebar.classList.toggle('open');
    });
  }

  // Outside click to close mobile navigation drawer
  document.addEventListener('click', (e) => {
    if (window.innerWidth <= 768 && sidebar && sidebar.classList.contains('open')) {
      if (!sidebar.contains(e.target) && btnMobileMenu && !btnMobileMenu.contains(e.target)) {
        sidebar.classList.remove('open');
      }
    }
  });

  // Global Escape key to dismiss modals and close mobile menu
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (fileExplorerModal && fileExplorerModal.style.display !== 'none') {
        closeExplorer();
      } else if (logModal && logModal.style.display !== 'none') {
        closeLogModal();
      } else if (window.innerWidth <= 768 && sidebar && sidebar.classList.contains('open')) {
        sidebar.classList.remove('open');
      }
    }
  });

  if (btnProceedToOperations) {
    btnProceedToOperations.addEventListener('click', () => {
      localStorage.setItem('activeTab', 'operations');
      window.location.hash = '#operations';
    });
  }

  if (btnRefreshHistory) {
    btnRefreshHistory.addEventListener('click', () => {
      loadJobHistory();
      showToast('Job history updated', 'info');
    });
  }

  // Copy Saved Path
  if (btnCopySavedPath) {
    btnCopySavedPath.addEventListener('click', () => {
      const pathText = savedPathLocation.textContent.trim();
      if (pathText) {
        copyToClipboard(pathText).then(() => {
          showToast('Output path copied to clipboard!', 'success');
        }).catch(() => {
          showToast('Failed to copy path', 'warning');
        });
      }
    });
  }

  // Stop / Cancel Active Job Button
  if (btnCancelJob) {
    btnCancelJob.addEventListener('click', async () => {
      const confirmed = window.confirm("Are you sure you want to stop the conversion? Partial files will be deleted.");
      if (!confirmed) return;

      try {
        btnCancelJob.disabled = true;
        btnCancelJob.innerHTML = '<span>Stopping...</span>';

        const sessionId = getOrCreateSessionId();
        const res = await fetch('/api/cancel-job', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Session-ID': sessionId
          },
          body: JSON.stringify({ jobId: currentJobId, sessionId })
        });
        const data = await readApiPayload(res);
        if (!res.ok || !data.success) {
          throw new Error(data.error || 'Failed to stop conversion');
        }

        handleJobCancelled(data);
      } catch (err) {
        showToast(err.message, 'error');
        if (btnCancelJob) {
          btnCancelJob.disabled = false;
          btnCancelJob.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" ry="2"></rect></svg><span>Stop Conversion</span>';
        }
      }
    });
  }
  // Clear Job History Button
  if (btnClearHistory) {
    btnClearHistory.addEventListener('click', async () => {
      if (!window.confirm('Are you sure you want to clear job history logs?')) return;
      try {
        const sid = isRemoteModeActive() ? getOrCreateSessionId() : '';
        const headers = sid ? { 'X-Session-ID': sid } : {};
        const res = await fetch('/api/jobs' + (sid ? `?sessionId=${encodeURIComponent(sid)}` : ''), { method: 'DELETE', headers });
        const data = await readApiPayload(res);
        if (data.success) {
          showToast('Job history cleared', 'info');
          loadJobHistory();
        }
      } catch (e) {
        showToast('Failed to clear history: ' + e.message, 'error');
      }
    });
  }

  // Copy Termux Storage Command
  if (btnCopyStorageCmd) {
    btnCopyStorageCmd.addEventListener('click', () => {
      copyToClipboard('termux-setup-storage').then(() => {
        showToast('Copied "termux-setup-storage" to clipboard! Paste it into Termux.', 'success');
      }).catch(() => {
        showToast('Run "termux-setup-storage" in your Termux terminal.', 'info');
      });
    });
  }

  // Clear / Remove Selected File Buttons
  const btnClearSelectedFile = document.getElementById('btnClearSelectedFile');
  if (btnClearSelectedFile) {
    btnClearSelectedFile.addEventListener('click', () => {
      clearSelectedMedia();
      showToast('Selected file removed', 'info');
    });
  }

  const btnRemoveTargetFile = document.getElementById('btnRemoveTargetFile');
  if (btnRemoveTargetFile) {
    btnRemoveTargetFile.addEventListener('click', () => {
      clearSelectedMedia();
      showToast('Selected file removed', 'info');
    });
  }
}

// System Information
async function checkSystemInfo() {
  try {
    const res = await fetch('/api/info');
    const data = await readApiPayload(res);
    if (data.ffmpeg && ffmpegVersionText) {
      ffmpegVersionText.textContent = data.ffmpeg.split(' ')[0] + ' ' + (data.ffmpeg.split(' ')[2] || 'Ready');
    }
    // Check storage permission notice
    if (data.storagePermission === false && storageNoticeBanner) {
      storageNoticeBanner.style.display = 'flex';
    } else if (storageNoticeBanner) {
      storageNoticeBanner.style.display = 'none';
    }
  } catch (err) {
    if (ffmpegVersionText) ffmpegVersionText.textContent = 'FFmpeg Ready';
  }
}

// ======================== SERVER-SIDE FILE EXPLORER ========================
function setupExplorerListeners() {
  // Open Explorer
  if (btnOpenExplorer) {
    btnOpenExplorer.addEventListener('click', () => {
      openExplorer(currentExplorerDir || '/sdcard');
    });
  }

  if (btnReopenExplorer) {
    btnReopenExplorer.addEventListener('click', () => {
      const startDir = selectedMedia ? selectedMedia.directory : currentExplorerDir;
      openExplorer(startDir);
    });
  }

  // Close Explorer
  if (btnCloseExplorer) btnCloseExplorer.addEventListener('click', closeExplorer);
  if (btnCancelExplorer) btnCancelExplorer.addEventListener('click', closeExplorer);
  if (fileExplorerModal) {
    fileExplorerModal.addEventListener('click', (e) => {
      if (e.target === fileExplorerModal) closeExplorer();
    });
  }

  const logModalEl = document.getElementById('logModal');
  if (logModalEl) {
    logModalEl.addEventListener('click', (e) => {
      if (e.target === logModalEl) closeLogModal();
    });
  }

  // Up/Back Button
  if (btnExplorerUp) {
    btnExplorerUp.addEventListener('click', () => {
      if (currentParentDir) {
        openExplorer(currentParentDir);
      }
    });
  }

  // Refresh Button
  if (btnExplorerRefresh) {
    btnExplorerRefresh.addEventListener('click', () => {
      openExplorer(currentExplorerDir);
    });
  }

  // Quick Shortcut Chips (in main panel and modal)
  document.querySelectorAll('.chip-shortcut, .mini-shortcut').forEach(chip => {
    chip.addEventListener('click', () => {
      const targetPath = chip.getAttribute('data-path');
      openExplorer(targetPath);
    });
  });

  // Manual Path Input
  if (btnLoadPath) {
    btnLoadPath.addEventListener('click', () => {
      const rawPath = directPathInput ? directPathInput.value.trim() : '';
      if (!rawPath) {
        showToast('Please enter an absolute file path (e.g. /sdcard/Download/movie.mp4)', 'warning');
        if (directPathInput) directPathInput.focus();
        return;
      }
      selectMediaFile(rawPath);
    });
  }

  if (directPathInput) {
    directPathInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        btnLoadPath.click();
      }
    });
  }

  // File Search Filter inside Explorer
  if (explorerSearchInput) {
    explorerSearchInput.addEventListener('input', () => {
      const q = explorerSearchInput.value.toLowerCase().trim();
      if (btnClearSearch) btnClearSearch.style.display = q ? 'block' : 'none';
      if (!q) {
        renderExplorerItems(allExplorerItems);
      } else {
        const filtered = allExplorerItems.filter(item => item.name.toLowerCase().includes(q));
        renderExplorerItems(filtered);
      }
    });
  }

  if (btnClearSearch) {
    btnClearSearch.addEventListener('click', () => {
      explorerSearchInput.value = '';
      btnClearSearch.style.display = 'none';
      renderExplorerItems(allExplorerItems);
      explorerSearchInput.focus();
    });
  }
}

async function openExplorer(dirPath) {
  fileExplorerModal.style.display = 'flex';
  explorerLoading.style.display = 'flex';
  explorerErrorBanner.style.display = 'none';
  explorerItemList.innerHTML = '';

  const target = dirPath || currentExplorerDir || '/sdcard';

  try {
    const res = await fetch(`/api/browse?dir=${encodeURIComponent(target)}`);
    const data = await readApiPayload(res);

    explorerLoading.style.display = 'none';

    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Failed to browse directory');
    }

    currentExplorerDir = data.currentDir;
    currentParentDir = data.parentDir;
    if (Array.isArray(data.allowedRoots) && data.allowedRoots.length > 0) {
      explorerAllowedRoots = data.allowedRoots;
    }

    // Up button status
    if (btnExplorerUp) {
      btnExplorerUp.disabled = !data.parentDir;
      btnExplorerUp.style.opacity = data.parentDir ? '1' : '0.4';
    }

    // Render Breadcrumbs
    renderBreadcrumbs(data.currentDir);

    // Show warning banner if error returned
    if (data.error) {
      explorerErrorBanner.style.display = 'block';
      explorerErrorBanner.textContent = data.error;
    }

    // Store items and render
    allExplorerItems = data.items || [];
    if (explorerSearchInput) {
      explorerSearchInput.value = '';
      if (btnClearSearch) btnClearSearch.style.display = 'none';
    }
    renderExplorerItems(allExplorerItems);
  } catch (err) {
    explorerLoading.style.display = 'none';
    explorerErrorBanner.style.display = 'block';
    explorerErrorBanner.textContent = err.message;
    showToast(err.message, 'error');
  }
}

function closeExplorer() {
  fileExplorerModal.style.display = 'none';
}

function renderBreadcrumbs(currentPath) {
  explorerBreadcrumbs.innerHTML = '';

  const normalized = currentPath.replace(/\/+/g, '/');
  const parts = normalized.split('/').filter(Boolean);

  // Root crumb
  const rootSpan = document.createElement('span');
  rootSpan.className = `crumb ${parts.length === 0 ? 'active' : ''}`;
  rootSpan.textContent = '/';
  rootSpan.onclick = () => openExplorer(explorerAllowedRoots[0] || '/sdcard');
  explorerBreadcrumbs.appendChild(rootSpan);

  let accumulated = '';
  parts.forEach((part, index) => {
    accumulated += '/' + part;
    const isLast = (index === parts.length - 1);

    const sep = document.createElement('span');
    sep.className = 'crumb-sep';
    sep.textContent = '/';
    explorerBreadcrumbs.appendChild(sep);

    const crumb = document.createElement('span');
    crumb.className = `crumb ${isLast ? 'active' : ''}`;
    crumb.textContent = part;

    if (!isLast) {
      const target = accumulated;
      crumb.onclick = () => openExplorer(target);
    }
    explorerBreadcrumbs.appendChild(crumb);
  });

  explorerBreadcrumbs.scrollLeft = explorerBreadcrumbs.scrollWidth;
}

function renderExplorerItems(items) {
  explorerItemList.innerHTML = '';

  if (items.length === 0) {
    const emptyMsg = document.createElement('div');
    emptyMsg.className = 'empty-state';
    emptyMsg.style.padding = '30px 10px';
    emptyMsg.innerHTML = `
      <p style="color:var(--text-muted);font-size:0.9rem;">No media files or subfolders found in this directory.</p>
    `;
    explorerItemList.appendChild(emptyMsg);
    return;
  }

  items.forEach(item => {
    const row = document.createElement('div');
    row.className = `explorer-row ${item.isDirectory ? 'folder-row' : 'file-row'}`;

    if (item.isDirectory) {
      row.innerHTML = `
        <div class="explorer-left">
          <span class="explorer-item-icon">📁</span>
          <span class="explorer-item-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
        </div>
        <div class="explorer-right">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--text-dim);">
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
        </div>
      `;
      row.onclick = () => openExplorer(item.path);
    } else {
      const isVideo = ['MP4', 'MKV', 'WEBM', 'AVI', 'MOV', 'TS', 'M4V', '3GP'].includes(item.ext);
      const icon = isVideo ? '🎬' : '🎵';

      row.innerHTML = `
        <div class="explorer-left">
          <span class="explorer-item-icon">${icon}</span>
          <span class="explorer-item-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
        </div>
        <div class="explorer-right">
          <span class="meta-pill">${item.ext}</span>
          <span class="meta-pill">${item.sizeFormatted}</span>
        </div>
      `;
      row.onclick = () => selectMediaFile(item.path);
    }

    explorerItemList.appendChild(row);
  });
}

// ======================== PERSISTENT STATE & STORAGE HELPERS ========================
function clearSelectedMedia() {
  selectedMedia = null;
  try {
    sessionStorage.removeItem('selectedFilePath');
    sessionStorage.removeItem('selectedFileMetadata');
    localStorage.removeItem('selectedFilePath');
    localStorage.removeItem('selectedFileMetadata');
  } catch (e) {}

  if (selectedMediaCard) selectedMediaCard.style.display = 'none';
  if (selectedMediaName) selectedMediaName.textContent = '';
  if (selectedMediaPath) selectedMediaPath.textContent = '';
  if (selectedMetaPills) selectedMetaPills.innerHTML = '';

  const targetMediaCard = document.getElementById('targetMediaCard');
  if (targetMediaCard) targetMediaCard.style.display = 'none';
  if (targetFileNameDisplay) targetFileNameDisplay.textContent = 'No file selected';

  renderAudioTrackCheckboxes([]);
  renderSubtitleTrackCheckboxes([]);
  updateOperationsSummary();
  updateCustomCmdState();
}

function handleMissingFileError(errMessage) {
  const msg = (errMessage || '').toLowerCase();
  if (msg.includes('not found') || msg.includes('no such file') || msg.includes('does not exist') || msg.includes('enoent')) {
    clearSelectedMedia();
    switchPanel('panel-explorer');
    showToast('The selected file no longer exists on storage. Please select a new file.', 'error');
    return true;
  }
  return false;
}

function populateSelectedMediaUI(data) {
  if (!data) return;

  selectedMedia = data;
  selectedMedia.path = data.filePath || data.path;
  selectedMedia.filePath = data.filePath || data.path;
  selectedMedia.name = data.name || data.filename || selectedMedia.path.split('/').pop();
  selectedMedia.directory = data.directory || selectedMedia.path.substring(0, selectedMedia.path.lastIndexOf('/')) || '/sdcard';

  // 1. Update Explorer preview card
  if (selectedMediaCard) selectedMediaCard.style.display = 'block';
  if (selectedMediaName) selectedMediaName.textContent = selectedMedia.name;
  if (selectedMediaPath) selectedMediaPath.textContent = selectedMedia.filePath;

  const isVideo = Boolean(selectedMedia.hasVideo !== false && selectedMedia.video);
  const selThumbImg = document.getElementById('selectedMediaThumbImg');
  const selFallback = document.getElementById('selectedMediaIconFallback');
  const tgtThumbImg = document.getElementById('targetMediaThumbImg');
  const tgtFallback = document.getElementById('targetMediaIconFallback');

  if (isVideo) {
    const thumbUrl = `/api/get-thumbnail?path=${encodeURIComponent(selectedMedia.filePath)}`;
    if (selThumbImg) {
      selThumbImg.src = thumbUrl;
      selThumbImg.style.display = 'block';
      selThumbImg.onload = () => { if (selFallback) selFallback.style.display = 'none'; };
      selThumbImg.onerror = () => {
        selThumbImg.style.display = 'none';
        if (selFallback) { selFallback.style.display = 'inline-block'; selFallback.textContent = '🎬'; }
      };
    }
    if (tgtThumbImg) {
      tgtThumbImg.src = thumbUrl;
      tgtThumbImg.style.display = 'block';
      tgtThumbImg.onload = () => { if (tgtFallback) tgtFallback.style.display = 'none'; };
      tgtThumbImg.onerror = () => {
        tgtThumbImg.style.display = 'none';
        if (tgtFallback) { tgtFallback.style.display = 'inline-block'; tgtFallback.textContent = '🎬'; }
      };
    }
  } else {
    if (selThumbImg) selThumbImg.style.display = 'none';
    if (tgtThumbImg) tgtThumbImg.style.display = 'none';
    if (selFallback) { selFallback.style.display = 'inline-block'; selFallback.textContent = '🎵'; }
    if (tgtFallback) { tgtFallback.style.display = 'inline-block'; tgtFallback.textContent = '🎵'; }
  }

  // 2. Update Target badge & Target Media Details Card in Operations Panel
  if (targetFileNameDisplay) {
    targetFileNameDisplay.textContent = selectedMedia.name;
  }
  const targetMediaCard = document.getElementById('targetMediaCard');
  const targetMediaName = document.getElementById('targetMediaName');
  const targetMediaPath = document.getElementById('targetMediaPath');
  const targetMediaPills = document.getElementById('targetMediaPills');

  if (targetMediaCard) targetMediaCard.style.display = 'flex';
  if (targetMediaName) targetMediaName.textContent = selectedMedia.name;
  if (targetMediaPath) targetMediaPath.textContent = selectedMedia.filePath;

  // Render metadata badges
  const pills = [];
  pills.push(`📦 ${selectedMedia.sizeFormatted || '0 B'}`);
  if (selectedMedia.durationFormatted && selectedMedia.durationFormatted !== '00:00:00') {
    pills.push(`⏱ ${selectedMedia.durationFormatted}`);
  }
  if (selectedMedia.video) {
    pills.push(`📐 ${selectedMedia.video.width}x${selectedMedia.video.height}`);
    pills.push(`🎬 ${selectedMedia.video.codec.toUpperCase()} (${selectedMedia.video.fps}fps)`);
  } else {
    pills.push(`🎬 No Video Stream`);
  }

  const audioStreams = selectedMedia.audioStreams || [];
  if (audioStreams.length > 0) {
    pills.push(`🎵 ${audioStreams.length} Audio ${audioStreams.length === 1 ? 'Track' : 'Tracks'}`);
  } else {
    pills.push(`🔇 No Audio Tracks`);
  }

  const subtitleStreams = selectedMedia.subtitleStreams || [];
  if (subtitleStreams.length > 0) {
    pills.push(`💬 ${subtitleStreams.length} Subtitle ${subtitleStreams.length === 1 ? 'Track' : 'Tracks'}`);
  }

  if (selectedMetaPills) {
    selectedMetaPills.innerHTML = '';
    pills.forEach(text => {
      const pill = document.createElement('span');
      pill.className = 'meta-pill';
      pill.textContent = text;
      selectedMetaPills.appendChild(pill);
    });
  }

  if (targetMediaPills) {
    targetMediaPills.innerHTML = '';
    pills.forEach(text => {
      const pill = document.createElement('span');
      pill.className = 'meta-pill';
      pill.textContent = text;
      targetMediaPills.appendChild(pill);
    });
  }

  // 4. Populate Audio Tracks Checklist (dynamically rendered, checked by default)
  renderAudioTrackCheckboxes(audioStreams);

  // 4b. Populate Subtitle Tracks Checklist
  renderSubtitleTrackCheckboxes(subtitleStreams);

  // 5. Auto-fill initial operation values
  const trimEnd = document.getElementById('opTrimEnd');
  if (trimEnd && selectedMedia.durationFormatted && selectedMedia.durationFormatted !== '00:00:00') {
    trimEnd.value = selectedMedia.durationFormatted;
  }
  const resizeW = document.getElementById('opResizeWidth');
  const resizeH = document.getElementById('opResizeHeight');
  if (selectedMedia.video) {
    if (resizeW) resizeW.value = selectedMedia.video.width || '';
    if (resizeH) resizeH.value = selectedMedia.video.height || '';
  }

  // Update Summary & Debug Command Preview
  updateOperationsSummary();

  // Update Custom Command Section
  updateCustomCmdState();
}

function restoreSelectedMediaState() {
  let savedPath = null;
  let savedMetadataStr = null;
  try {
    savedPath = sessionStorage.getItem('selectedFilePath') || localStorage.getItem('selectedFilePath');
    savedMetadataStr = sessionStorage.getItem('selectedFileMetadata') || localStorage.getItem('selectedFileMetadata');
  } catch (e) {}

  if (!savedPath || !savedMetadataStr) {
    if (selectedMediaCard) selectedMediaCard.style.display = 'none';
    const targetMediaCard = document.getElementById('targetMediaCard');
    if (targetMediaCard) targetMediaCard.style.display = 'none';
    if (targetFileNameDisplay) targetFileNameDisplay.textContent = 'No file selected';
    updateCustomCmdState();
    return;
  }

  try {
    const metadata = JSON.parse(savedMetadataStr);
    if (!metadata || (!metadata.filePath && !metadata.path)) {
      throw new Error('Invalid metadata in storage');
    }

    console.log('[State Restore] Restoring selected media from storage (instant, no extra probe):', savedPath);
    // Populate UI immediately from cached metadata (instant UI)
    populateSelectedMediaUI(metadata);

    // Optional background check: verify the file still exists on disk without blocking UI
    fetch(`/api/analyze-media?path=${encodeURIComponent(savedPath)}`)
      .then(async (res) => {
        if (res.status === 404) {
          console.warn('[State Restore] Cached file no longer exists on disk:', savedPath);
          clearSelectedMedia();
        } else if (res.ok) {
          const freshData = await readApiPayload(res);
          if (freshData && freshData.success) {
            freshData.path = freshData.filePath;
            try {
              sessionStorage.setItem('selectedFileMetadata', JSON.stringify(freshData));
            } catch (e) {}
          }
        }
      })
      .catch((err) => {
        console.warn('[State Restore] Background check error:', err.message);
      });
  } catch (err) {
    console.warn('[State Restore] Failed to restore media state from storage:', err.message);
    try {
      sessionStorage.removeItem('selectedFilePath');
      sessionStorage.removeItem('selectedFileMetadata');
      localStorage.removeItem('selectedFilePath');
      localStorage.removeItem('selectedFileMetadata');
    } catch (e) {}
  }
}

// Select Media File & Probe Details (Auto-Detects Audio Tracks & Details via /api/analyze-media)
async function selectMediaFile(filePath) {
  closeExplorer();
  showToast('Analyzing media details and audio tracks...', 'info');

  try {
    const res = await fetch(`/api/analyze-media?path=${encodeURIComponent(filePath)}`);
    const data = await readApiPayload(res);
    if (!res.ok || !data.success) {
      if (res.status === 404 || (data && data.error && (data.error.includes('not found') || data.error.includes('No such file')))) {
        clearSelectedMedia();
        showToast(`File not found: ${filePath}`, 'error');
        return;
      }
      throw new Error(data.error || 'Failed to inspect file');
    }

    selectedMedia = data;
    selectedMedia.path = data.filePath || filePath;
    selectedMedia.filePath = data.filePath || filePath;
    selectedMedia.name = data.filename || data.name || selectedMedia.path.split('/').pop();
    selectedMedia.directory = data.directory || selectedMedia.path.substring(0, selectedMedia.path.lastIndexOf('/')) || '/sdcard';

    // 1. Save state to sessionStorage (tab-isolated)
    try {
      sessionStorage.setItem('selectedFilePath', selectedMedia.filePath);
      sessionStorage.setItem('selectedFileMetadata', JSON.stringify(selectedMedia));
    } catch (storageErr) {
      console.warn('[State Persist] Could not save selected file to sessionStorage:', storageErr.message);
    }

    // 2. Populate UI
    populateSelectedMediaUI(selectedMedia);

    showToast(`Loaded: ${selectedMedia.name}`, 'success');
    if (selectedMediaCard) selectedMediaCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    if (handleMissingFileError(err.message)) return;
    showToast(err.message, 'error');
  }
}

// Render Audio Track Checkboxes
function renderAudioTrackCheckboxes(audioStreams) {
  const container = document.getElementById('audioTracksContainer');
  if (!container) return;
  container.innerHTML = '';

  if (!audioStreams || audioStreams.length === 0) {
    container.innerHTML = `
      <div class="audio-track-empty">
        <span class="empty-hint">No audio tracks detected in this file.</span>
      </div>
    `;
    return;
  }

  audioStreams.forEach((stream, idx) => {
    const item = document.createElement('div');
    item.className = 'audio-track-item';

    const checkboxId = `audio_track_${idx}`;
    const trackVal = stream.index || (stream.streamIndex != null ? `0:${stream.streamIndex}` : ''); // Explicit stream specifier, e.g. '0:1'
    const codecBadge = stream.codec ? stream.codec.toUpperCase() : 'AUDIO';
    const channelsText = stream.channels === 1 ? 'Mono' : (stream.channels === 6 ? '5.1' : (stream.channels ? `${stream.channels}ch` : ''));

    item.innerHTML = `
      <label class="custom-checkbox audio-track-label" for="${checkboxId}">
        <input type="checkbox" id="${checkboxId}" class="audio-track-checkbox" value="${escapeHtml(trackVal)}" data-index="${escapeHtml(stream.index)}" data-lang="${escapeHtml(stream.language || '')}" checked>
        <span class="checkmark"></span>
        <div class="audio-track-text-group">
          <span class="audio-track-title">${escapeHtml(stream.label || ('Audio Track ' + (idx + 1)))}</span>
          <div class="audio-track-badges">
            <span class="meta-pill-sm">${escapeHtml(codecBadge)}</span>
            <span class="meta-pill-sm">${escapeHtml(stream.index)}</span>
            ${channelsText ? `<span class="meta-pill-sm">${escapeHtml(channelsText)}</span>` : ''}
          </div>
        </div>
      </label>
    `;

    container.appendChild(item);
  });

  // Attach change listener to each audio track checkbox
  container.querySelectorAll('.audio-track-checkbox').forEach(chk => {
    chk.addEventListener('change', () => {
      updateOperationsSummary();
    });
  });
}

function renderSubtitleTrackCheckboxes(subtitleStreams) {
  const container = document.getElementById('subtitlesContainer');
  const subModeContainer = document.getElementById('subModeContainer');
  const subBurnSelect = document.getElementById('subBurnSelect');
  if (!container) return;
  container.innerHTML = '';

  if (!subtitleStreams || subtitleStreams.length === 0) {
    container.innerHTML = `
      <div class="audio-track-empty" id="subEmptyNotice">
        <span class="empty-hint">No subtitle tracks detected in this media file.</span>
      </div>
    `;
    if (subModeContainer) subModeContainer.style.display = 'none';
    if (subBurnSelect) subBurnSelect.innerHTML = '';
    return;
  }

  if (subModeContainer) subModeContainer.style.display = 'block';
  if (subBurnSelect) subBurnSelect.innerHTML = '';

  subtitleStreams.forEach((stream, idx) => {
    const item = document.createElement('div');
    item.className = 'audio-track-item';

    const checkboxId = `sub_track_${idx}`;
    const trackVal = stream.index;
    const codecBadge = stream.codec ? stream.codec.toUpperCase() : 'SUB';
    const langBadge = (stream.language || 'UND').toUpperCase();

    item.innerHTML = `
      <label class="custom-checkbox audio-track-label" for="${checkboxId}">
        <input type="checkbox" id="${checkboxId}" class="subtitle-track-checkbox" value="${escapeHtml(trackVal)}" data-index="${escapeHtml(stream.index)}" data-sub-index="${stream.subIndex}" data-lang="${escapeHtml(stream.language || '')}" checked>
        <span class="checkmark"></span>
        <div class="audio-track-text-group">
          <span class="audio-track-title">${escapeHtml(stream.label || ('Subtitle Track ' + (idx + 1)))}</span>
          <div class="audio-track-badges">
            <span class="meta-pill-sm">${escapeHtml(codecBadge)}</span>
            <span class="meta-pill-sm">${escapeHtml(langBadge)}</span>
            <span class="meta-pill-sm">${escapeHtml(stream.index)}</span>
          </div>
        </div>
      </label>
    `;

    container.appendChild(item);

    if (subBurnSelect) {
      const opt = document.createElement('option');
      opt.value = stream.subIndex;
      opt.textContent = `${stream.label} (${codecBadge} • ${langBadge})`;
      subBurnSelect.appendChild(opt);
    }
  });

  container.querySelectorAll('.subtitle-track-checkbox').forEach(chk => {
    chk.addEventListener('change', () => {
      updateOperationsSummary();
    });
  });
}

// UI Feedback: Live Summary & Debug Command Generator
function checkLosslessWarning() {
  const opCheckLossless = document.getElementById('opCheckLossless');
  const opCheckFormat = document.getElementById('opCheckFormat');
  const opCheckTrim = document.getElementById('opCheckTrim');
  const opCheckResize = document.getElementById('opCheckResize');
  const opCheckAudioOnly = document.getElementById('opCheckAudioOnly');
  const subModeBurn = document.getElementById('subModeBurn');

  const isLossless = Boolean(opCheckLossless && opCheckLossless.checked);
  const isFormat = Boolean(opCheckFormat && opCheckFormat.checked);
  const isBurnSub = Boolean(subModeBurn && subModeBurn.checked);
  const hasFilterOrAudio = Boolean((opCheckTrim && opCheckTrim.checked) || 
                                   (opCheckResize && opCheckResize.checked) || 
                                   (opCheckAudioOnly && opCheckAudioOnly.checked) ||
                                   isBurnSub);

  if (isLossless && isFormat && hasFilterOrAudio) {
    if (isBurnSub) {
      showToast("Lossless mode disabled: Burning subtitles requires video re-encoding.", "warning");
      if (opCheckLossless) opCheckLossless.checked = false;
    } else {
      showToast("Lossless mode is only for container changes. Filters require re-encoding. Lossless mode will be disabled for video.", "warning");
    }
  }
}

// Escape a file path for safe use inside an FFmpeg filter argument
function escapeFilterPath(p) {
  return String(p).replace(/([\\':\[\],;])/g, '\\$1');
}

// Helper to strictly wrap file paths in double quotes for preview commands
function quotePath(p) {
  if (!p) return '""';
  let str = String(p).trim();
  if ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'"))) {
    str = str.slice(1, -1);
  }
  const escaped = str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`');
  return `"${escaped}"`;
}

function updateOperationsSummary() {
  const summaryBox = document.getElementById('operationsSummaryText');
  const debugDisplay = document.getElementById('debugCommandDisplay');
  const debugBadge = document.getElementById('debugStatusBadge');

  const opCheckFormat = document.getElementById('opCheckFormat');
  const opFormatSelect = document.getElementById('opFormatSelect');
  const opCheckLossless = document.getElementById('opCheckLossless');
  const opCheckResize = document.getElementById('opCheckResize');
  const opResizeWidth = document.getElementById('opResizeWidth');
  const opResizeHeight = document.getElementById('opResizeHeight');
  const opCrf = document.getElementById('opCrf');
  const opCheckTrim = document.getElementById('opCheckTrim');
  const opTrimStart = document.getElementById('opTrimStart');
  const opTrimEnd = document.getElementById('opTrimEnd');
  const opCheckAudioOnly = document.getElementById('opCheckAudioOnly');
  const opCheckHwAccel = document.getElementById('opCheckHwAccel');
  const opHwBitrate = document.getElementById('opHwBitrate');

  const crfContainer = document.getElementById('crfSliderContainer');
  const presetsContainer = document.getElementById('resizePresetsContainer');
  const losslessNotice = document.getElementById('losslessEncodingNotice');
  const hwBitrateContainer = document.getElementById('hwBitrateContainer');

  const subModeBurn = document.getElementById('subModeBurn');
  const isBurnSub = Boolean(subModeBurn && subModeBurn.checked);
  const subBurnSelect = document.getElementById('subBurnSelect');
  const subBurnIdx = subBurnSelect && subBurnSelect.value !== '' ? parseInt(subBurnSelect.value, 10) : 0;

  const isAudioOnlyChecked = Boolean(opCheckAudioOnly && opCheckAudioOnly.checked);
  const isFormat = Boolean(opCheckFormat && opCheckFormat.checked);
  const isHwAccel = Boolean(opCheckHwAccel && opCheckHwAccel.checked);
  const hwBitrate = opHwBitrate ? opHwBitrate.value : '2M';
  const isResize = Boolean(opCheckResize && opCheckResize.checked);
  const isTrim = Boolean(opCheckTrim && opCheckTrim.checked);
  const selectedFormat = opFormatSelect ? opFormatSelect.value.toUpperCase() : 'MP4';
  // Audio-only containers (MP3/WAV/...) cannot hold a video stream, so
  // selecting one behaves exactly like "Extract audio only".
  const isAudioContainerFormat = isFormat && ['MP3', 'WAV', 'AAC', 'FLAC', 'OGG', 'M4A', 'OPUS'].includes(selectedFormat);
  const isAudioOnly = isAudioOnlyChecked || isAudioContainerFormat;

  // Subtitles
  const subCheckboxes = document.querySelectorAll('.subtitle-track-checkbox');
  const totalSubTracks = subCheckboxes.length;
  const checkedSubTracks = [];
  subCheckboxes.forEach(chk => {
    if (chk.checked) checkedSubTracks.push(chk.value);
  });
  const isSubBurnActive = !isAudioOnly && isBurnSub && totalSubTracks > 0;

  // Lossless mode is disabled if burning subtitles
  let isLossless = Boolean(opCheckLossless && opCheckLossless.checked && !isSubBurnActive);

  // Toggle visibility of HW bitrate vs CRF slider
  if (hwBitrateContainer) {
    hwBitrateContainer.style.display = isHwAccel ? 'block' : 'none';
  }

  // Toggle visibility of CRF & Presets options vs Lossless Notice
  const hideEncodingOptions = isFormat && isLossless && !isResize && !isTrim && !isAudioOnly && !isHwAccel;
  if (crfContainer) {
    crfContainer.style.display = (hideEncodingOptions || isHwAccel) ? 'none' : 'block';
  }
  if (presetsContainer) {
    presetsContainer.style.display = hideEncodingOptions ? 'none' : 'block';
  }
  if (losslessNotice) {
    losslessNotice.style.display = hideEncodingOptions ? 'block' : 'none';
  }

  const operations = [];

  // 1. Format & Lossless Container Change
  if (isAudioOnly) {
    operations.push(`Extracting Audio Only (${isFormat ? selectedFormat : 'MP3'})`);
  } else if (isFormat) {
    if (isLossless && !isResize && !isTrim) {
      operations.push("Container change only (Lossless Copy)");
    } else if (isLossless && (isResize || isTrim)) {
      operations.push(`Converting to ${selectedFormat} (Video re-encode with filters, Audio copy)`);
    } else {
      operations.push(`Converting to ${selectedFormat}`);
    }
  }

  // 2. Hardware Acceleration
  if (isHwAccel && !isAudioOnly) {
    operations.push(`⚡ Fast Mode (MediaCodec ${hwBitrate})`);
  }

  // 3. Audio Tracks
  const audioCheckboxes = document.querySelectorAll('.audio-track-checkbox');
  const totalAudioTracks = audioCheckboxes.length;
  const checkedAudioTracks = [];
  const checkedLabels = [];

  audioCheckboxes.forEach(chk => {
    if (chk.checked) {
      checkedAudioTracks.push(chk.value);
      const titleSpan = chk.closest('.audio-track-item')?.querySelector('.audio-track-title');
      if (titleSpan) checkedLabels.push(titleSpan.textContent.trim());
    }
  });

  if (totalAudioTracks > 0) {
    if (checkedAudioTracks.length === totalAudioTracks) {
      operations.push(`Keeping all audio tracks (${checkedLabels.join(', ')})`);
    } else if (checkedAudioTracks.length > 0) {
      operations.push(`Keeping ${checkedLabels.join(', ')} Audio`);
    } else if (isAudioOnly) {
      operations.push(`⚠️ No audio track selected for extraction`);
    } else {
      operations.push(`Audio muted (all tracks removed)`);
    }
  }

  // 4. Subtitle Tracks
  if (totalSubTracks > 0) {
    if (isSubBurnActive) {
      const burnLabel = subBurnSelect?.selectedOptions[0]?.text || `Track ${subBurnIdx + 1}`;
      operations.push(`🔥 Burn Subtitles (${burnLabel})`);
    } else if (checkedSubTracks.length === totalSubTracks) {
      operations.push(`Keeping all subtitle tracks (${totalSubTracks})`);
    } else if (checkedSubTracks.length > 0) {
      operations.push(`Keeping ${checkedSubTracks.length} of ${totalSubTracks} subtitle tracks`);
    } else {
      operations.push(`No subtitles preserved`);
    }
  }

  // 5. Compress / Resize
  if (isResize && !isAudioOnly) {
    const w = opResizeWidth && opResizeWidth.value ? opResizeWidth.value.trim() : null;
    const h = opResizeHeight && opResizeHeight.value ? opResizeHeight.value.trim() : null;
    const crf = opCrf ? opCrf.value : '23';

    if (w && h) {
      operations.push(`Resizing to ${w}x${h} ${isHwAccel ? `(${hwBitrate})` : `(CRF ${crf})`}`);
    } else if (w) {
      operations.push(`Resizing to ${w}p width`);
    } else if (h) {
      operations.push(`Resizing to ${h}p height`);
    } else {
      operations.push(`Compressing ${isHwAccel ? `(${hwBitrate})` : `(CRF ${crf})`}`);
    }
  }

  // 6. Trim
  if (isTrim) {
    const start = opTrimStart && opTrimStart.value.trim() ? opTrimStart.value.trim() : '00:00:00';
    const end = opTrimEnd && opTrimEnd.value.trim() ? opTrimEnd.value.trim() : null;
    operations.push(`Trimming from ${start} to ${end || 'End'}`);
  }

  // Render Summary Text
  if (summaryBox) {
    if (operations.length === 0) {
      summaryBox.textContent = 'No operations selected. Check one or more operations above to begin.';
    } else {
      summaryBox.textContent = operations.join(', ');
    }
  }

  // Generate Predicted Command Preview for Debug Console
  if (debugDisplay) {
    if (!selectedMedia || !selectedMedia.filePath) {
      debugDisplay.textContent = 'Select a media file from Phone Storage to preview FFmpeg command.';
      if (debugBadge) debugBadge.textContent = 'Ready';
      return;
    }

    const previewArgs = ['ffmpeg', '-hide_banner', '-stats', '-i', quotePath(selectedMedia.filePath)];
    const targetFmt = isAudioOnly ? (isFormat ? selectedFormat.toLowerCase() : 'mp3') : (isFormat ? selectedFormat.toLowerCase() : 'mp4');

    if (isAudioOnly) {
      previewArgs.push('-vn');
      if (checkedAudioTracks.length > 0) {
        if (targetFmt === 'mp3' || targetFmt === 'wav') {
          const trk = checkedAudioTracks[0];
          previewArgs.push(trk.startsWith('0:') ? `-map ${trk}` : `-map 0:a:m:language:${trk}`);
        } else {
          checkedAudioTracks.forEach(trk => {
            previewArgs.push(trk.startsWith('0:') ? `-map ${trk}` : `-map 0:a:m:language:${trk}`);
          });
        }
      } else if (totalAudioTracks > 0) {
        previewArgs.push('# select an audio track');
      } else {
        previewArgs.push(targetFmt === 'mp3' || targetFmt === 'wav' ? '-map 0:a:0?' : '-map 0:a?');
      }
    } else {
      if (selectedMedia.hasVideo !== false) {
        previewArgs.push('-map 0:v');
      }
      if (totalAudioTracks > 0 && checkedAudioTracks.length === 0) {
        previewArgs.push('-an');
      } else if (checkedAudioTracks.length > 0 && checkedAudioTracks.length < totalAudioTracks) {
        checkedAudioTracks.forEach(trk => {
          previewArgs.push(trk.startsWith('0:') ? `-map ${trk}` : `-map 0:a:m:language:${trk}`);
        });
      } else {
        previewArgs.push('-map 0:a?');
      }

      // Soft Subtitles Mapping
      if (!isSubBurnActive && checkedSubTracks.length > 0) {
        checkedSubTracks.forEach(strk => {
          previewArgs.push(strk.startsWith('0:') ? `-map ${strk}` : `-map 0:s:m:language:${strk}`);
        });
      }
    }

    // Video Filters (Resize + Burning Subtitles)
    const videoFilters = [];
    if (!isAudioOnly && isResize) {
      const w = opResizeWidth && opResizeWidth.value ? opResizeWidth.value.trim() : null;
      const h = opResizeHeight && opResizeHeight.value ? opResizeHeight.value.trim() : null;
      if (w && h) videoFilters.push(`scale=${w}:${h}`);
      else if (w) videoFilters.push(`scale=${w}:-2`);
      else if (h) videoFilters.push(`scale=-2:${h}`);
      else videoFilters.push('scale=1280:720');
    }

    if (isSubBurnActive) {
      const escapedSubPath = escapeFilterPath(selectedMedia.filePath);
      videoFilters.push(`subtitles='${escapedSubPath}':si=${subBurnIdx}`);
    }

    if (videoFilters.length > 0) {
      previewArgs.push('-vf', `"${videoFilters.join(',')}"`);
    }

    if (isTrim) {
      const start = opTrimStart && opTrimStart.value.trim() ? opTrimStart.value.trim() : '00:00:00';
      const end = opTrimEnd && opTrimEnd.value.trim() ? opTrimEnd.value.trim() : null;
      previewArgs.push(`-ss ${start}`);
      if (end) previewArgs.push(`-to ${end}`);
    }

    if (isAudioOnly) {
      if (targetFmt === 'mp3') previewArgs.push('-c:a libmp3lame -q:a 2');
      else if (targetFmt === 'wav') previewArgs.push('-c:a pcm_s16le');
      else previewArgs.push('-c:a aac -b:a 192k');
    } else {
      if (!isSubBurnActive && checkedSubTracks.length > 0) {
        previewArgs.push(targetFmt === 'mp4' ? '-c:s mov_text' : '-c:s copy');
      }

      const crf = opCrf ? opCrf.value : '23';
      const vCodecStr = isHwAccel ? `-c:v h264_mediacodec -b:v ${hwBitrate}` : `-c:v libx264 -crf ${crf} -preset fast`;

      if (isLossless && isFormat && videoFilters.length === 0 && !isTrim) {
        if (targetFmt === 'mp4') {
          previewArgs.push('-c:v copy -c:a copy -movflags +faststart');
        } else {
          previewArgs.push('-c:v copy -c:a copy');
        }
      } else if (isLossless && isFormat && (videoFilters.length > 0 || isTrim)) {
        if (targetFmt === 'mp4') {
          previewArgs.push(`${vCodecStr} -c:a copy -movflags +faststart`);
        } else {
          previewArgs.push(`${vCodecStr} -c:a copy`);
        }
      } else {
        if (targetFmt === 'mp4') {
          previewArgs.push(`${vCodecStr} -c:a aac -b:a 192k -movflags +faststart`);
        } else if (targetFmt === 'mkv') {
          previewArgs.push(`${vCodecStr} -c:a aac`);
        } else {
          previewArgs.push(isResize ? `${vCodecStr} -c:a aac` : `${vCodecStr} -c:a aac`);
        }
      }
    }

    const outExt = isAudioOnly ? (isFormat ? `.${selectedFormat.toLowerCase()}` : '.mp3') : (isFormat ? `.${selectedFormat.toLowerCase()}` : '.mp4');
    const baseName = selectedMedia.name ? selectedMedia.name.substring(0, selectedMedia.name.lastIndexOf('.')) : 'output';
    previewArgs.push('-y', quotePath(`${selectedMedia.directory}/${baseName}_processed${outExt}`));

    debugDisplay.textContent = previewArgs.join(' ');
    if (debugBadge && debugBadge.textContent !== 'Running') {
      debugBadge.textContent = 'Preview';
    }
  }
}

// Gather Current Operations Configuration
function gatherOperationsPayload() {
  if (!selectedMedia || !selectedMedia.filePath) return null;

  const opCheckFormat = document.getElementById('opCheckFormat');
  const opFormatSelect = document.getElementById('opFormatSelect');
  const opCheckLossless = document.getElementById('opCheckLossless');
  const opCheckResize = document.getElementById('opCheckResize');
  const opResizeWidth = document.getElementById('opResizeWidth');
  const opResizeHeight = document.getElementById('opResizeHeight');
  const opCrf = document.getElementById('opCrf');
  const opCheckTrim = document.getElementById('opCheckTrim');
  const opTrimStart = document.getElementById('opTrimStart');
  const opTrimEnd = document.getElementById('opTrimEnd');
  const opCheckAudioOnly = document.getElementById('opCheckAudioOnly');
  const opCheckHwAccel = document.getElementById('opCheckHwAccel');
  const opHwBitrate = document.getElementById('opHwBitrate');

  const subModeBurn = document.getElementById('subModeBurn');
  const isBurnSub = Boolean(subModeBurn && subModeBurn.checked);
  const subBurnSelect = document.getElementById('subBurnSelect');
  const subBurnIdx = subBurnSelect && subBurnSelect.value !== '' ? parseInt(subBurnSelect.value, 10) : 0;

  const audioTrackCheckboxes = document.querySelectorAll('.audio-track-checkbox');
  const totalAudioTracks = audioTrackCheckboxes.length;
  const checkedAudioTracks = [];
  audioTrackCheckboxes.forEach(cb => {
    if (cb.checked) checkedAudioTracks.push(cb.value);
  });

  const checkedSubTracks = [];
  document.querySelectorAll('.subtitle-track-checkbox').forEach(cb => {
    if (cb.checked) checkedSubTracks.push(cb.value);
  });

  const isAudioOnlyChecked = Boolean(opCheckAudioOnly && opCheckAudioOnly.checked);
  const isFormat = Boolean(opCheckFormat && opCheckFormat.checked);
  const isHwAccel = Boolean(opCheckHwAccel && opCheckHwAccel.checked);
  const hwBitrate = opHwBitrate ? opHwBitrate.value : '2M';
  const isResize = Boolean(opCheckResize && opCheckResize.checked);
  const isTrim = Boolean(opCheckTrim && opCheckTrim.checked);
  const selectedFormat = opFormatSelect ? opFormatSelect.value.toLowerCase() : 'mp4';
  // Mirror the server rule: an audio-only container implies audio-only output.
  const isAudioContainerFormat = isFormat && ['mp3', 'wav', 'aac', 'flac', 'ogg', 'm4a', 'opus'].includes(selectedFormat);
  const isAudioOnly = isAudioOnlyChecked || isAudioContainerFormat;
  const isLossless = Boolean(isFormat && opCheckLossless && opCheckLossless.checked && !isBurnSub && !isAudioOnly);

  const operations = {
    isLosslessCopy: isLossless,
    hardwareAccel: isHwAccel,
    bitrate: hwBitrate
  };

  if (isFormat) {
    operations.format = {
      enabled: true,
      format: (opFormatSelect ? opFormatSelect.value : 'mp4').toLowerCase()
    };
  }

  if (isResize) {
    operations.resize = {
      enabled: true,
      width: (opResizeWidth && parseInt(opResizeWidth.value, 10)) || null,
      height: (opResizeHeight && parseInt(opResizeHeight.value, 10)) || null,
      crf: (opCrf && parseInt(opCrf.value, 10)) || 23
    };
  }

  if (isTrim) {
    operations.trim = {
      enabled: true,
      start: (opTrimStart && opTrimStart.value.trim()) || '00:00:00',
      end: (opTrimEnd && opTrimEnd.value.trim()) || null
    };
  }

  if (isAudioOnly) {
    operations.audioOnly = { enabled: true };
  }

  return {
    filePath: selectedMedia.filePath,
    operations,
    audioTracks: checkedAudioTracks,
    muteAudio: totalAudioTracks > 0 && checkedAudioTracks.length === 0,
    subtitleConfig: {
      mode: isBurnSub ? 'burn' : 'keep',
      tracks: checkedSubTracks,
      burnIndex: subBurnIdx
    },
    hardwareAccel: isHwAccel,
    isLosslessCopy: isLossless
  };
}

// Execute All Operations
async function executeAllOperations() {
  if (isConversionRunning) {
    showToast('Please stop the current conversion before starting a new one.', 'error');
    return;
  }

  if (!selectedMedia || !selectedMedia.filePath) {
    showToast('Please select a media file from Phone Storage first', 'warning');
    switchPanel('panel-explorer');
    openExplorer(currentExplorerDir || '/sdcard');
    return;
  }

  const payload = gatherOperationsPayload();
  if (!payload) return;

  const ops = payload.operations || {};
  const hasSelectedOp = Boolean(
    ops.format?.enabled ||
    ops.resize?.enabled ||
    ops.trim?.enabled ||
    ops.audioOnly?.enabled
  );

  if (!hasSelectedOp) {
    showToast('Please select at least one operation (e.g. Convert Format, Compress/Resize, Trim, or Extract Audio).', 'warning');
    return;
  }

  if (ops.audioOnly?.enabled && (payload.audioTracks || []).length === 0) {
    showToast('Select at least one audio track to extract.', 'warning');
    return;
  }

  if (ops.trim?.enabled) {
    const startSec = parseTimeToSeconds(ops.trim.start || '00:00:00');
    const endSec = ops.trim.end ? parseTimeToSeconds(ops.trim.end) : null;
    if (endSec !== null && endSec <= startSec) {
      showToast('Trim End time must be greater than Start time.', 'warning');
      return;
    }
  }

  try {
    showToast('Dispatching Multi-Operation FFmpeg job...', 'info');

    const debugBadge = document.getElementById('debugStatusBadge');
    if (debugBadge) debugBadge.textContent = 'Launching';

    payload.isRemoteUpload = isRemoteModeActive();
    payload.sessionId = getOrCreateSessionId();

    const res = await fetch('/api/process-direct', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await readApiPayload(res);
    if (!res.ok || !data.success) {
      if (res.status === 404 || (data && data.error && (data.error.includes('not found') || data.error.includes('No such file')))) {
        clearSelectedMedia();
        switchPanel('panel-explorer');
        showToast('The selected file no longer exists on storage. Please select a new file.', 'error');
        return;
      }
      throw new Error(data.error || 'Failed to start multi-operation processing');
    }

    isConversionRunning = true;
    currentJobId = data.jobId;

    const debugDisplay = document.getElementById('debugCommandDisplay');
    if (debugDisplay) debugDisplay.textContent = data.commandString || 'ffmpeg ...';
    if (debugBadge) debugBadge.textContent = 'Running';

    // Switch to active task panel & connect SSE
    switchPanel('panel-active-job');
    initActiveJobView(data);
    listenJobProgress(data.jobId);
    showToast(`Processing: ${data.name}`, 'info');
  } catch (err) {
    isConversionRunning = false;
    if (handleMissingFileError(err.message)) return;
    const debugBadge = document.getElementById('debugStatusBadge');
    if (debugBadge) debugBadge.textContent = 'Error';
    showToast(err.message, 'error');
  }
}

// Multi-Operation Form Event Listeners Setup
function setupMultiOpListeners() {
  // Audio Select All / Deselect All
  const btnAudioSelectAll = document.getElementById('btnAudioSelectAll');
  if (btnAudioSelectAll) {
    btnAudioSelectAll.addEventListener('click', () => {
      document.querySelectorAll('.audio-track-checkbox').forEach(chk => { chk.checked = true; });
      updateOperationsSummary();
    });
  }

  const btnAudioDeselectAll = document.getElementById('btnAudioDeselectAll');
  if (btnAudioDeselectAll) {
    btnAudioDeselectAll.addEventListener('click', () => {
      document.querySelectorAll('.audio-track-checkbox').forEach(chk => { chk.checked = false; });
      updateOperationsSummary();
    });
  }

  // Format Toggle
  const opCheckFormat = document.getElementById('opCheckFormat');
  const opFormatControls = document.getElementById('opFormatControls');
  if (opCheckFormat && opFormatControls) {
    opCheckFormat.addEventListener('change', () => {
      opFormatControls.style.display = opCheckFormat.checked ? 'block' : 'none';
      if (opCheckFormat.checked) {
        checkLosslessWarning();
      }
      updateOperationsSummary();
    });
  }

  const opFormatSelect = document.getElementById('opFormatSelect');
  if (opFormatSelect) {
    opFormatSelect.addEventListener('change', updateOperationsSummary);
  }

  // Lossless Mode Toggle
  const opCheckLossless = document.getElementById('opCheckLossless');
  if (opCheckLossless) {
    opCheckLossless.addEventListener('change', () => {
      if (opCheckLossless.checked) {
        checkLosslessWarning();
      }
      updateOperationsSummary();
    });
  }

  // Resize Toggle
  const opCheckResize = document.getElementById('opCheckResize');
  const opResizeControls = document.getElementById('opResizeControls');
  if (opCheckResize && opResizeControls) {
    opCheckResize.addEventListener('change', () => {
      opResizeControls.style.display = opCheckResize.checked ? 'block' : 'none';
      if (opCheckResize.checked) {
        checkLosslessWarning();
      }
      updateOperationsSummary();
    });
  }

  const opResizeWidth = document.getElementById('opResizeWidth');
  const opResizeHeight = document.getElementById('opResizeHeight');
  if (opResizeWidth) opResizeWidth.addEventListener('input', updateOperationsSummary);
  if (opResizeHeight) opResizeHeight.addEventListener('input', updateOperationsSummary);

  // Preset Buttons
  const btnPreset720 = document.getElementById('btnPreset720');
  if (btnPreset720) {
    btnPreset720.addEventListener('click', () => {
      if (opResizeWidth) opResizeWidth.value = 1280;
      if (opResizeHeight) opResizeHeight.value = 720;
      updateOperationsSummary();
    });
  }

  const btnPreset1080 = document.getElementById('btnPreset1080');
  if (btnPreset1080) {
    btnPreset1080.addEventListener('click', () => {
      if (opResizeWidth) opResizeWidth.value = 1920;
      if (opResizeHeight) opResizeHeight.value = 1080;
      updateOperationsSummary();
    });
  }

  const btnPreset480 = document.getElementById('btnPreset480');
  if (btnPreset480) {
    btnPreset480.addEventListener('click', () => {
      if (opResizeWidth) opResizeWidth.value = 854;
      if (opResizeHeight) opResizeHeight.value = 480;
      updateOperationsSummary();
    });
  }

  // CRF Slider
  const opCrf = document.getElementById('opCrf');
  const opCrfDisplay = document.getElementById('opCrfDisplay');
  if (opCrf) {
    opCrf.addEventListener('input', () => {
      if (opCrfDisplay) opCrfDisplay.textContent = opCrf.value;
      updateOperationsSummary();
    });
  }

  // Trim Toggle
  const opCheckTrim = document.getElementById('opCheckTrim');
  const opTrimControls = document.getElementById('opTrimControls');
  if (opCheckTrim && opTrimControls) {
    opCheckTrim.addEventListener('change', () => {
      opTrimControls.style.display = opCheckTrim.checked ? 'block' : 'none';
      if (opCheckTrim.checked) {
        checkLosslessWarning();
      }
      updateOperationsSummary();
    });
  }

  const opTrimStart = document.getElementById('opTrimStart');
  const opTrimEnd = document.getElementById('opTrimEnd');
  if (opTrimStart) opTrimStart.addEventListener('input', updateOperationsSummary);
  if (opTrimEnd) opTrimEnd.addEventListener('input', updateOperationsSummary);

  // Audio Only Toggle
  const opCheckAudioOnly = document.getElementById('opCheckAudioOnly');
  if (opCheckAudioOnly) {
    opCheckAudioOnly.addEventListener('change', () => {
      if (opCheckAudioOnly.checked) {
        checkLosslessWarning();
      }
      updateOperationsSummary();
    });
  }

  // Single "Execute All Operations" Button
  const btnExecuteAll = document.getElementById('btnExecuteAll');
  if (btnExecuteAll) {
    btnExecuteAll.addEventListener('click', executeAllOperations);
  }

  // Subtitle Select All / Deselect All
  const btnSubSelectAll = document.getElementById('btnSubSelectAll');
  if (btnSubSelectAll) {
    btnSubSelectAll.addEventListener('click', () => {
      document.querySelectorAll('.subtitle-track-checkbox').forEach(chk => { chk.checked = true; });
      updateOperationsSummary();
    });
  }

  const btnSubDeselectAll = document.getElementById('btnSubDeselectAll');
  if (btnSubDeselectAll) {
    btnSubDeselectAll.addEventListener('click', () => {
      document.querySelectorAll('.subtitle-track-checkbox').forEach(chk => { chk.checked = false; });
      updateOperationsSummary();
    });
  }

  // Subtitle Mode Radios (Keep soft subtitles vs Burn hard subtitles)
  const subModeRadios = document.querySelectorAll('input[name="subtitleMode"]');
  const subBurnOptions = document.getElementById('subBurnOptions');
  subModeRadios.forEach(radio => {
    radio.addEventListener('change', () => {
      const isBurn = document.getElementById('subModeBurn')?.checked;
      if (subBurnOptions) {
        subBurnOptions.style.display = isBurn ? 'block' : 'none';
      }
      if (isBurn) {
        const opCheckLossless = document.getElementById('opCheckLossless');
        if (opCheckLossless && opCheckLossless.checked) {
          opCheckLossless.checked = false;
          showToast('Lossless mode disabled: Burning subtitles requires video re-encoding.', 'warning');
        }
      }
      updateOperationsSummary();
    });
  });

  // Subtitle Burn Track Select
  const subBurnSelect = document.getElementById('subBurnSelect');
  if (subBurnSelect) {
    subBurnSelect.addEventListener('change', updateOperationsSummary);
  }

  // Hardware Acceleration Toggle
  const opCheckHwAccel = document.getElementById('opCheckHwAccel');
  const hwBitrateContainer = document.getElementById('hwBitrateContainer');
  if (opCheckHwAccel) {
    opCheckHwAccel.addEventListener('change', () => {
      if (hwBitrateContainer) {
        hwBitrateContainer.style.display = opCheckHwAccel.checked ? 'block' : 'none';
      }
      updateOperationsSummary();
    });
  }

  const opHwBitrate = document.getElementById('opHwBitrate');
  if (opHwBitrate) {
    opHwBitrate.addEventListener('change', updateOperationsSummary);
  }

  // Collapsible Debug Console Toggle
  const btnToggleDebugConsole = document.getElementById('btnToggleDebugConsole');
  const debugConsoleBody = document.getElementById('debugConsoleBody');
  const debugToggleArrow = document.getElementById('debugToggleArrow');
  if (btnToggleDebugConsole && debugConsoleBody) {
    btnToggleDebugConsole.addEventListener('click', (e) => {
      if (e.target && e.target.id === 'btnCopyDebugCmd') return;
      const isClosed = debugConsoleBody.style.display === 'none';
      debugConsoleBody.style.display = isClosed ? 'block' : 'none';
      if (debugToggleArrow) debugToggleArrow.textContent = isClosed ? '▲' : '▼';
    });
  }

  // Copy Debug Command Button
  const btnCopyDebugCmd = document.getElementById('btnCopyDebugCmd');
  if (btnCopyDebugCmd) {
    btnCopyDebugCmd.addEventListener('click', (e) => {
      e.stopPropagation();
      const debugDisplay = document.getElementById('debugCommandDisplay');
      if (debugDisplay && debugDisplay.textContent) {
        copyToClipboard(debugDisplay.textContent.trim()).then(() => {
          showToast('Raw FFmpeg command copied to clipboard!', 'success');
        }).catch(() => {
          showToast('Failed to copy command', 'warning');
        });
      }
    });
  }
}

// ======================== ADVANCED: CUSTOM FFMPEG COMMAND ========================
function updateCustomCmdState() {
  const customInput = document.getElementById('customCommandInput');
  const btnExec = document.getElementById('btnExecuteCustomCmd');
  const notice = document.getElementById('customCmdTargetNotice');
  const card = document.getElementById('customCmdCard');

  if (selectedMedia && selectedMedia.filePath) {
    if (customInput) {
      customInput.disabled = false;
      if (!customInput.value.trim()) {
        const outExt = selectedMedia.hasVideo !== false ? 'mp4' : 'mp3';
        customInput.value = `ffmpeg -i {input} -c:v copy -c:a copy output.${outExt}`;
      }
    }
    if (btnExec) btnExec.disabled = false;
    if (notice) {
      notice.textContent = `Target: ${selectedMedia.name}`;
      notice.style.color = 'var(--success)';
    }
    if (card) card.classList.add('active-target');
  } else {
    if (customInput) {
      customInput.disabled = true;
    }
    if (btnExec) btnExec.disabled = true;
    if (notice) {
      notice.textContent = 'No file selected';
      notice.style.color = 'var(--warning)';
    }
    if (card) card.classList.remove('active-target');
  }
}

async function executeCustomCommand() {
  if (isConversionRunning) {
    showToast('Please stop the current conversion before starting a new one.', 'error');
    return;
  }

  if (!selectedMedia || !selectedMedia.filePath) {
    showToast('Please select a media file from Phone Storage first', 'warning');
    switchPanel('panel-explorer');
    openExplorer(currentExplorerDir || '/sdcard');
    return;
  }

  const cmdInput = document.getElementById('customCommandInput');
  const rawCmd = cmdInput ? cmdInput.value.trim() : '';

  if (!rawCmd) {
    showToast('Please enter an FFmpeg/FFprobe command to execute', 'warning');
    if (cmdInput) cmdInput.focus();
    return;
  }

  const lowerCmd = rawCmd.toLowerCase();
  if (!lowerCmd.startsWith('ffmpeg') && !lowerCmd.startsWith('ffprobe')) {
    showToast('Only FFmpeg/FFprobe commands are allowed.', 'error');
    return;
  }

  const btnExec = document.getElementById('btnExecuteCustomCmd');

  try {
    showToast('Launching custom command...', 'info');
    if (btnExec) btnExec.disabled = true;

    const res = await fetch('/api/run-custom', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: rawCmd,
        filePath: selectedMedia.filePath,
        isRemoteUpload: isRemoteModeActive(),
        sessionId: getOrCreateSessionId()
      })
    });

    const data = await readApiPayload(res);
    if (btnExec) btnExec.disabled = false;

    if (!res.ok || !data.success) {
      if (res.status === 404 || (data && data.error && (data.error.includes('not found') || data.error.includes('No such file')))) {
        clearSelectedMedia();
        switchPanel('panel-explorer');
        showToast('The selected file no longer exists on storage. Please select a new file.', 'error');
        return;
      }
      throw new Error(data.error || 'Failed to start custom command');
    }

    isConversionRunning = true;
    currentJobId = data.jobId;

    // Update Debug Console with the exact command executed on Termux
    const debugDisplay = document.getElementById('debugCommandDisplay');
    if (debugDisplay) debugDisplay.textContent = data.commandString || rawCmd;
    const debugBadge = document.getElementById('debugStatusBadge');
    if (debugBadge) debugBadge.textContent = 'Running';

    // Switch to active task panel & connect SSE
    switchPanel('panel-active-job');
    initActiveJobView(data);
    listenJobProgress(data.jobId);
    showToast(`Processing custom command for: ${data.name || selectedMedia.name}`, 'info');
  } catch (err) {
    isConversionRunning = false;
    if (btnExec) btnExec.disabled = false;
    if (handleMissingFileError(err.message)) return;
    showToast(err.message, 'error');
  }
}

function setupCustomCommandListeners() {
  const btnToggle = document.getElementById('btnToggleCustomCmd');
  const body = document.getElementById('customCmdBody');
  const arrow = document.getElementById('customCmdToggleArrow');
  const btnExec = document.getElementById('btnExecuteCustomCmd');
  const cmdInput = document.getElementById('customCommandInput');

  if (btnToggle && body) {
    btnToggle.addEventListener('click', () => {
      const isClosed = body.style.display === 'none';
      body.style.display = isClosed ? 'block' : 'none';
      if (arrow) arrow.textContent = isClosed ? '▲' : '▼';
    });
  }

  if (btnExec) {
    btnExec.addEventListener('click', executeCustomCommand);
  }

  if (cmdInput) {
    cmdInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        executeCustomCommand();
      }
    });
  }

  updateCustomCmdState();
}

// ======================== OPERATION EXECUTION ========================
window.executeOp = async function(operation) {
  if (!selectedMedia || !selectedMedia.path) {
    showToast('Please select a media file from the File Explorer first', 'warning');
    switchPanel('panel-explorer');
    openExplorer(currentExplorerDir || '/sdcard');
    return;
  }

  const options = gatherOperationOptions(operation);
  await launchDirectJob(operation, options, selectedMedia.path);
};

function gatherOperationOptions(operation) {
  const options = {};
  switch (operation) {
    case 'convert':
      options.format = document.getElementById('convertFormat')?.value || document.getElementById('opFormatSelect')?.value || 'mp4';
      options.videoMode = document.getElementById('convertVideoMode') ? document.getElementById('convertVideoMode').value : 'original';
      break;
    case 'change_audio':
      options.audioCodec = document.getElementById('changeAudioCodec')?.value || 'aac';
      options.audioBitrate = document.getElementById('changeAudioBitrate')?.value || '192k';
      options.volume = document.getElementById('changeAudioVolume') ? document.getElementById('changeAudioVolume').value : '1.0';
      break;
    case 'extract_audio':
      options.format = document.getElementById('audioFormat')?.value || document.getElementById('opFormatSelect')?.value || 'mp3';
      break;
    case 'compress':
      options.crf = document.getElementById('compressCrf')?.value || document.getElementById('opCrf')?.value || '23';
      options.preset = document.getElementById('compressPreset')?.value || 'fast';
      options.audioBitrate = document.getElementById('compressAudioBitrate')?.value || '128k';
      break;
    case 'trim':
      options.start = document.getElementById('trimStart')?.value || document.getElementById('opTrimStart')?.value || '00:00:00';
      options.end = document.getElementById('trimEnd')?.value || document.getElementById('opTrimEnd')?.value || '';
      options.mode = document.getElementById('trimMode')?.value || 'accurate';
      break;
    case 'resize':
      options.preset = document.getElementById('resizePreset')?.value || '720p';
      options.width = document.getElementById('resizeWidth')?.value || document.getElementById('opResizeWidth')?.value || '';
      options.height = document.getElementById('resizeHeight')?.value || document.getElementById('opResizeHeight')?.value || '';
      options.keepAspect = document.getElementById('resizeKeepAspect') ? document.getElementById('resizeKeepAspect').checked : true;
      break;
    case 'rotate':
      options.action = document.getElementById('rotateAction')?.value || 'cw90';
      break;
    case 'gif':
      options.fps = document.getElementById('gifFps')?.value || '15';
      options.width = document.getElementById('gifWidth')?.value || '480';
      options.start = document.getElementById('gifStart')?.value || '00:00:00';
      options.duration = document.getElementById('gifDuration')?.value || '5';
      break;
    case 'speed':
      options.speed = document.getElementById('videoSpeedRate')?.value || '2.0';
      break;
    case 'raw':
      options.rawCommand = document.getElementById('rawCommandInput')?.value || document.getElementById('customCommandInput')?.value || '';
      options.outputExt = document.getElementById('rawOutputExt')?.value || 'mp4';
      break;
  }
  return options;
}

async function launchDirectJob(operation, options, filePath) {
  if (isConversionRunning) {
    showToast('Please stop the current conversion before starting a new one.', 'error');
    return;
  }

  try {
    showToast(`Launching ${operation}...`, 'info');

    const res = await fetch('/api/process-direct', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filePath,
        operation,
        options,
        isRemoteUpload: isRemoteModeActive(),
        sessionId: getOrCreateSessionId()
      })
    });

    const data = await readApiPayload(res);
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Failed to start direct processing');
    }

    isConversionRunning = true;
    currentJobId = data.jobId;
    switchPanel('panel-active-job');
    initActiveJobView(data);
    listenJobProgress(data.jobId);
    showToast(`Processing: ${data.name}`, 'info');
  } catch (err) {
    isConversionRunning = false;
    showToast(err.message, 'error');
  }
}

// Active Job Monitor View
function initActiveJobView(jobData) {
  noActiveJobState.style.display = 'none';
  activeJobMonitor.style.display = 'block';
  jobResultPreviewBox.style.display = 'none';
  if (activePulse) activePulse.style.display = 'inline-block';
  if (btnCancelJob) {
    btnCancelJob.style.display = 'inline-flex';
    btnCancelJob.disabled = false;
    btnCancelJob.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" ry="2"></rect></svg><span>Stop Conversion</span>';
  }

  const job = jobData.activeJob || jobData;

  if (job.status === 'queued') {
    const queuePos = job.queuePosition || 1;
    activeJobTitle.textContent = `In Queue: ${job.filename || jobData.name || 'Task'}`;
    activeJobStatusPill.className = 'status-pill status-queued';
    activeJobStatusPill.textContent = `Queued (Position #${queuePos})`;
    activeJobCommand.textContent = `Waiting for active processes to finish... File position in queue: #${queuePos}`;
    updateProgressStats({
      progress: 0,
      currentTime: 'In Queue',
      totalDuration: `Position #${queuePos}`,
      speed: 'Waiting in line...',
      filename: job.filename || jobData.name || '-'
    });
  } else {
    activeJobTitle.textContent = `Processing: ${job.filename || jobData.name || 'Task'}`;
    activeJobStatusPill.className = 'status-pill status-processing';
    activeJobStatusPill.textContent = 'Processing';
    activeJobCommand.textContent = jobData.commandString || job.commandString || 'ffmpeg ...';

    updateProgressStats({
      progress: job.progress || 0,
      currentTime: job.currentTime || '00:00:00',
      totalDuration: job.totalDuration || '00:00:00',
      speed: job.speed || 'N/A',
      filename: job.filename || jobData.name || '-'
    });
  }

  if (btnViewActiveLogs) {
    btnViewActiveLogs.onclick = () => openLogModal(jobData.jobId || currentJobId, jobData.commandString || job.commandString);
  }
}

function listenJobProgress(jobId) {
  if (eventSource) {
    try { eventSource.close(); } catch (e) {}
    eventSource = null;
  }
  stopPollingFallback();

  const targetJobId = jobId || currentJobId;
  const sidParam = `sessionId=${encodeURIComponent(getOrCreateSessionId())}`;
  const sseUrl = targetJobId ? `/api/progress/${targetJobId}?${sidParam}` : `/api/progress?${sidParam}`;

  try {
    eventSource = new EventSource(sseUrl);

    eventSource.onopen = () => {
      console.log(`[SSE] Connected to ${sseUrl}`);
      stopPollingFallback();
    };

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        console.log('[SSE] Message received:', data.type, data);

        if (data.type === 'progress' || data.type === 'init') {
          const status = data.status || data.activeJob?.status || 'idle';
          if (status === 'queued') {
            const queuePos = data.queuePosition || data.activeJob?.queuePosition || 1;
            if (activeJobStatusPill) {
              activeJobStatusPill.className = 'status-pill status-queued';
              activeJobStatusPill.textContent = `Queued (Position #${queuePos})`;
            }
            if (activeJobTitle) {
              activeJobTitle.textContent = `In Queue: ${data.activeJob?.filename || selectedMedia?.name || 'Task'}`;
            }
            updateProgressStats({
              progress: 0,
              currentTime: 'In Queue',
              totalDuration: `Position #${queuePos}`,
              speed: 'Waiting in line...',
              filename: data.activeJob?.filename || selectedMedia?.name || '-'
            });
            return;
          } else if (status === 'processing') {
            if (activeJobStatusPill && activeJobStatusPill.textContent.includes('Queued')) {
              activeJobStatusPill.className = 'status-pill status-processing';
              activeJobStatusPill.textContent = 'Processing';
              if (activeJobTitle) {
                activeJobTitle.textContent = `Processing: ${data.activeJob?.filename || selectedMedia?.name || 'Task'}`;
              }
            }
          }

          const pct = data.progress !== undefined ? data.progress : (data.activeJob?.progress || 0);
          const curTime = data.currentTime || data.activeJob?.currentTime || '00:00:00';
          const totDur = data.totalDuration || data.activeJob?.totalDuration || '00:00:00';
          const spd = data.speed || data.activeJob?.speed || 'N/A';
          const filename = data.activeJob?.filename || selectedMedia?.name || '-';

          updateProgressStats({
            progress: pct,
            currentTime: curTime,
            totalDuration: totDur,
            speed: spd,
            filename: filename
          });
        }

        if (data.type === 'status') {
          if (data.status === 'warning') {
            showToast(data.message || 'Warning', 'warning');
          } else if (data.status === 'completed') {
            stopPollingFallback();
            if (eventSource) { try { eventSource.close(); } catch (e) {} eventSource = null; }
            handleJobCompleted(data);
          } else if (data.status === 'failed') {
            stopPollingFallback();
            if (eventSource) { try { eventSource.close(); } catch (e) {} eventSource = null; }
            handleJobFailed(data);
          } else if (data.status === 'cancelled') {
            stopPollingFallback();
            if (eventSource) { try { eventSource.close(); } catch (e) {} eventSource = null; }
            handleJobCancelled(data);
          }
        }
      } catch (e) {
        console.error('[SSE] JSON error:', e);
      }
    };

    eventSource.onerror = (err) => {
      console.warn('[SSE] EventSource disconnected or error. Triggering fallback polling...', err);
      startPollingFallback();
    };
  } catch (err) {
    console.warn('[SSE] EventSource could not be initialized. Triggering fallback polling...', err);
    startPollingFallback();
  }
}

function handleJobCompleted(data) {
  isConversionRunning = false;
  currentJobId = null;
  stopPollingFallback();
  if (eventSource) {
    try { eventSource.close(); } catch (e) {}
    eventSource = null;
  }

  const debugBadge = document.getElementById('debugStatusBadge');
  if (debugBadge) debugBadge.textContent = 'Ready';

  if (btnCancelJob) btnCancelJob.style.display = 'none';
  activeJobStatusPill.className = 'status-pill status-completed';
  activeJobStatusPill.textContent = 'Completed';
  if (activePulse) activePulse.style.display = 'none';

  const file = data.outputFile || (data.activeJob && data.activeJob.outputFile);
  const curTime = data.currentTime || data.activeJob?.currentTime || '00:00:00';
  const totDur = data.totalDuration || data.activeJob?.totalDuration || curTime;
  const spd = data.speed || data.activeJob?.speed || 'N/A';

  updateProgressStats({
    progress: 100,
    currentTime: totDur,
    totalDuration: totDur,
    speed: spd,
    filename: file?.filename || '-'
  });

  jobResultPreviewBox.style.display = 'block';

  if (file && file.path) {
    resultMetaSize.textContent = `Size: ${file.sizeFormatted || ''}`;
    savedPathLocation.textContent = file.path;

    // Direct Browser Preview — video/audio streaming is disabled to save Cloudflare Tunnel data
    mediaPreviewContainer.innerHTML = '';
    const ext = file.path.split('.').pop().toLowerCase();
    const outFilename = file.filename || file.path.split('/').pop();

    if (['gif', 'png', 'jpg', 'jpeg'].includes(ext)) {
      const img = document.createElement('img');
      img.src = file.previewUrl || `/api/stream-file?path=${encodeURIComponent(file.path)}`;
      img.alt = 'Processed output';
      mediaPreviewContainer.appendChild(img);
    } else {
      const isAud = ['mp3', 'wav', 'aac', 'flac', 'ogg', 'm4a'].includes(ext);
      const icon = isAud ? '🎵' : '🎬';
      const typeLabel = isAud ? 'Audio' : 'Video';
      const safeFilename = escapeHtml(outFilename);
      mediaPreviewContainer.innerHTML = `
        <div class="result-media-card">
          <div class="result-media-icon">${icon}</div>
          <div class="result-media-details">
            <span class="result-media-title">${safeFilename}</span>
            <span class="result-media-sub">${typeLabel} processed successfully • Saved on device (streaming disabled to save data)</span>
          </div>
        </div>
      `;
    }

    // "Use as New Input" handler
    btnUseAsInput.onclick = () => {
      selectMediaFile(file.path);
      switchPanel('panel-operations');
      showToast('Newly generated file selected as input!', 'success');
    };

    // Download / Save Button & Prominent Download Result Button
    const downloadEndpoint = file.downloadUrl || (file.isDirectPath ? `/api/download/${encodeURIComponent(outFilename)}?path=${encodeURIComponent(file.path)}` : `/api/download/${encodeURIComponent(outFilename)}`);

    if (btnProminentDownload) {
      btnProminentDownload.href = downloadEndpoint;
      btnProminentDownload.download = outFilename;
      btnProminentDownload.style.display = 'inline-flex';
    }

    if (btnDownloadOutput) {
      btnDownloadOutput.href = downloadEndpoint;
      btnDownloadOutput.download = outFilename;
      btnDownloadOutput.style.display = 'inline-flex';
    }

    // Start 30-minute countdown timer on mediaOutputTimer ONLY for Remote Upload (WAN) mode
    const isRemote = isMediaRemoteMode() || Boolean(file.isRemoteUpload);
    if (isRemote) {
      const outTimer = initMediaOutputTimer();
      const expiresAt = file.expiresAt || (Date.now() + 30 * 60 * 1000);
      outTimer.start(expiresAt, 'Output file will be deleted in');
    } else {
      if (mediaOutputCountdownTimer) {
        mediaOutputCountdownTimer.clear();
        mediaOutputCountdownTimer = null;
      }
      if (mediaOutputTimer) {
        mediaOutputTimer.style.display = 'none';
        mediaOutputTimer.innerHTML = '';
      }
      try {
        sessionStorage.removeItem('ffstudio_media_output_timer');
        localStorage.removeItem('ffstudio_media_output_timer');
      } catch (e) {}
    }

    showToast(`File saved successfully at ${file.path}`, 'success');
  }

  loadJobHistory();
}

function handleJobFailed(data) {
  isConversionRunning = false;
  currentJobId = null;
  stopPollingFallback();
  if (eventSource) {
    try { eventSource.close(); } catch (e) {}
    eventSource = null;
  }

  const debugBadge = document.getElementById('debugStatusBadge');
  if (debugBadge) debugBadge.textContent = 'Ready';

  if (btnCancelJob) btnCancelJob.style.display = 'none';
  activeJobStatusPill.className = 'status-pill status-failed';
  activeJobStatusPill.textContent = 'Failed';
  if (activePulse) activePulse.style.display = 'none';

  const errMsg = (data.error || '').toString();
  const rawStderr = (data.stderr || '').toString();
  const isDirectCopyFail = errMsg.includes('Direct copy failed') || 
                           rawStderr.includes('codec not currently supported in container') ||
                           rawStderr.includes('Could not find tag for codec') ||
                           rawStderr.includes('not supported by MP4') ||
                           (activeJobCommand && activeJobCommand.textContent.includes('-c:v copy'));

  if (isDirectCopyFail) {
    showToast('Direct copy failed. The source file has codecs not supported by MP4. Please try Re-encoding.', 'error');
  } else {
    showToast('FFmpeg process failed: ' + (errMsg || 'Check logs'), 'error');
  }

  loadJobHistory();
  openLogModal(data.jobId || currentJobId, activeJobCommand.textContent, data.stderr || data.error);
}

function handleJobCancelled(data) {
  isConversionRunning = false;
  currentJobId = null;
  stopPollingFallback();
  if (eventSource) {
    try { eventSource.close(); } catch (e) {}
    eventSource = null;
  }
  if (activePulse) activePulse.style.display = 'none';

  const debugBadge = document.getElementById('debugStatusBadge');
  if (debugBadge) debugBadge.textContent = 'Ready';

  if (btnCancelJob) {
    btnCancelJob.style.display = 'none';
    btnCancelJob.disabled = false;
    btnCancelJob.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" ry="2"></rect></svg><span>Stop Conversion</span>';
  }

  updateProgressStats({
    progress: 0,
    currentTime: '00:00:00',
    totalDuration: '00:00:00',
    speed: '0.0x',
    filename: '-'
  });

  if (termuxLiveStatus) {
    termuxLiveStatus.textContent = 'Conversion cancelled by user';
  }

  activeJobStatusPill.className = 'status-pill status-cancelled';
  activeJobStatusPill.textContent = 'Cancelled';
  noActiveJobState.style.display = 'block';
  activeJobMonitor.style.display = 'none';
  jobResultPreviewBox.style.display = 'none';

  showToast('Conversion cancelled by user.', 'info');
  loadJobHistory();

  // Reset UI to operations or explorer
  if (selectedMedia && selectedMedia.path) {
    window.location.hash = '#operations';
  } else {
    window.location.hash = '#home';
  }
}

// ======================== HISTORY & LOGS ========================
async function loadJobHistory() {
  try {
    const sid = isRemoteModeActive() ? getOrCreateSessionId() : '';
    const url = '/api/jobs' + (sid ? `?sessionId=${encodeURIComponent(sid)}` : '');
    const headers = sid ? { 'X-Session-ID': sid } : {};
    const res = await fetch(url, { headers });
    const data = await readApiPayload(res);
    renderHistory(data.jobs || []);
  } catch (err) {
    console.error('History fetch error:', err);
  }
}

function renderHistory(jobs) {
  if (!historyContainer) return;

  if (jobs.length === 0) {
    historyContainer.innerHTML = `
      <div class="empty-state">
        <p>No processed jobs yet. Process a video from your phone storage to start logging.</p>
      </div>
    `;
    return;
  }

  historyContainer.innerHTML = '';
  jobs.forEach(job => {
    const card = document.createElement('div');
    card.className = 'history-card';

    const dateStr = new Date(job.createdAt).toLocaleTimeString();
    const isSuccess = job.status === 'completed';
    const statusClass = isSuccess ? 'status-completed' : (job.status === 'processing' ? 'status-processing' : (job.status === 'cancelled' ? 'status-cancelled' : 'status-failed'));

    let outputBadge = '';
    let downloadLink = '';
    if (job.outputFile && job.outputFile.path) {
      const baseName = job.outputFile.path.split('/').pop();
      outputBadge = `
        <span class="direct-path-badge" title="${escapeHtml(job.outputFile.path)}">
          Saved: ${escapeHtml(baseName)}
        </span>
      `;
      if (job.status === 'completed') {
        downloadLink = `
          <a href="/api/stream-file?path=${encodeURIComponent(job.outputFile.path)}&download=1" download="${escapeHtml(baseName)}" class="btn-secondary btn-sm" style="text-decoration:none; display:inline-flex; align-items:center; gap:4px;">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
              <polyline points="7 10 12 15 17 10"></polyline>
              <line x1="12" y1="15" x2="12" y2="3"></line>
            </svg>
            Download
          </a>
        `;
      }
    }

    card.innerHTML = `
      <div class="history-left">
        <span class="status-pill ${statusClass}">${job.status}</span>
        <div>
          <div class="history-title">${escapeHtml(job.name)}</div>
          <div class="history-time">Started: ${dateStr} • Duration: ${job.durationMs ? (job.durationMs / 1000).toFixed(1) + 's' : 'N/A'}</div>
        </div>
      </div>
      <div class="history-actions">
        ${outputBadge}
        ${downloadLink}
        <button class="btn-secondary btn-sm view-logs-btn" data-job-id="${escapeHtml(job.id)}" data-command="${escapeHtml(job.commandString || '')}">View Logs</button>
      </div>
    `;

    const logsBtn = card.querySelector('.view-logs-btn');
    if (logsBtn) {
      logsBtn.addEventListener('click', () => {
        window.openLogModal(logsBtn.dataset.jobId, logsBtn.dataset.command || '');
      });
    }

    historyContainer.appendChild(card);
  });
}

// Modal Handlers
window.openLogModal = async function(jobId, commandStr = '', defaultStderr = '') {
  modalCmdText.textContent = commandStr || 'ffmpeg ...';
  modalLogContent.textContent = defaultStderr || 'Fetching logs from Termux...';
  logModal.style.display = 'flex';

  if (jobId) {
    try {
      const sid = getOrCreateSessionId();
      const url = `/api/jobs/${jobId}/logs` + (sid ? `?sessionId=${encodeURIComponent(sid)}` : '');
      const headers = sid ? { 'X-Session-ID': sid } : {};
      const res = await fetch(url, { headers });
      const data = await readApiPayload(res);
      if (data.stderr || data.logs) {
        modalLogContent.textContent = data.stderr || data.logs || 'No log output captured.';
      }
    } catch (e) {}
  }
};

window.closeLogModal = function() {
  logModal.style.display = 'none';
};

window.copyLogModal = function() {
  const text = `${modalCmdText.textContent}\n\n=== LOGS ===\n${modalLogContent.textContent}`;
  copyToClipboard(text).then(() => {
    showToast('Logs copied to clipboard', 'success');
  }).catch(() => {
    showToast('Failed to copy to clipboard', 'warning');
  });
};

// Toast Notifications
function showToast(message, type = 'info') {
  if (!toastContainer) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;

  toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(40px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Immediate wake-up on tab refocus (prevents background throttling on mobile devices)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && isConversionRunning) {
    if (typeof pollCurrentJob === 'function') {
      pollCurrentJob();
    }
  }
});
