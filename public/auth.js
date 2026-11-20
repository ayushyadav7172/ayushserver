// Termux Utility Studio - Client Authentication Manager
(function () {
  'use strict';

  const TOKEN_STORAGE_KEY = 'ffstudio_api_token';

  // Read token from localStorage
  function getApiToken() {
    try {
      return localStorage.getItem(TOKEN_STORAGE_KEY) || '';
    } catch (e) {
      return '';
    }
  }

  // Save token to localStorage
  function setApiToken(token) {
    try {
      if (token && typeof token === 'string' && token.trim()) {
        localStorage.setItem(TOKEN_STORAGE_KEY, token.trim());
      } else {
        localStorage.removeItem(TOKEN_STORAGE_KEY);
      }
    } catch (e) {}
  }

  // Clear token
  function clearApiToken() {
    try {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
    } catch (e) {}
  }

  // 1. Capture token from URL if present (?token=xxx or ?apiKey=xxx)
  try {
    const urlParams = new URLSearchParams(window.location.search);
    const tokenParam = urlParams.get('token') || urlParams.get('apiKey') || urlParams.get('api_token');
    if (tokenParam) {
      setApiToken(tokenParam);
      urlParams.delete('token');
      urlParams.delete('apiKey');
      urlParams.delete('api_token');
      const cleanSearch = urlParams.toString();
      const newUrl = window.location.pathname + (cleanSearch ? '?' + cleanSearch : '') + window.location.hash;
      window.history.replaceState({}, document.title, newUrl);
    }
  } catch (e) {}

  // 2. Helper to append token query parameter to URLs (EventSource, <img>, <a>)
  function appendStudioToken(url) {
    if (!url || typeof url !== 'string') return url;
    const token = getApiToken();
    if (!token) return url;
    // Only apply to internal API endpoints
    if (url.startsWith('/api/') || url.includes('/api/')) {
      if (/[?&](token|apiKey|api_token)=/.test(url)) return url;
      const sep = url.includes('?') ? '&' : '?';
      return url + sep + 'token=' + encodeURIComponent(token);
    }
    return url;
  }

  window.getStudioApiToken = getApiToken;
  window.setStudioApiToken = setApiToken;
  window.clearStudioApiToken = clearApiToken;
  window.appendStudioToken = appendStudioToken;

  // 3. Global fetch Interceptor
  const originalFetch = window.fetch;
  window.fetch = function (input, init) {
    const token = getApiToken();
    let url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
    init = init || {};

    const isApiRequest = url.startsWith('/api/') || (!url.startsWith('http') && url.includes('/api/')) || url.startsWith(window.location.origin + '/api/');

    if (token && isApiRequest) {
      let headers = init.headers;
      if (!headers) {
        headers = {};
        init.headers = headers;
      }
      if (typeof Headers !== 'undefined' && headers instanceof Headers) {
        if (!headers.has('Authorization')) headers.set('Authorization', 'Bearer ' + token);
        if (!headers.has('x-api-token')) headers.set('x-api-token', token);
      } else if (Array.isArray(headers)) {
        headers.push(['Authorization', 'Bearer ' + token]);
        headers.push(['x-api-token', token]);
      } else {
        if (!headers['Authorization']) headers['Authorization'] = 'Bearer ' + token;
        if (!headers['x-api-token']) headers['x-api-token'] = token;
      }
    }

    return originalFetch.call(this, input, init).then(res => {
      if (res.status === 401 && !url.includes('/api/auth/status')) {
        showAuthModal('Unauthorized: Invalid or missing API token. Please enter a valid token.');
      }
      return res;
    });
  };

  // 4. Global XMLHttpRequest Interceptor
  const originalXhrOpen = XMLHttpRequest.prototype.open;
  const originalXhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...args) {
    this._studioUrl = url;
    return originalXhrOpen.apply(this, [method, url, ...args]);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    const token = getApiToken();
    const url = this._studioUrl;
    const isApiRequest = url && typeof url === 'string' && (
      url.startsWith('/api/') || (!url.startsWith('http') && url.includes('/api/')) || url.startsWith(window.location.origin + '/api/')
    );

    if (token && isApiRequest) {
      try {
        this.setRequestHeader('Authorization', 'Bearer ' + token);
        this.setRequestHeader('x-api-token', token);
      } catch (e) {}
    }

    this.addEventListener('load', () => {
      if (this.status === 401 && this._studioUrl && !this._studioUrl.includes('/api/auth/status')) {
        showAuthModal('Unauthorized: Invalid or missing API token. Please enter a valid token.');
      }
    });

    return originalXhrSend.apply(this, args);
  };

  // 5. Auth Modal UI
  let authModalEl = null;

  function createAuthModal() {
    if (authModalEl) return authModalEl;

    const overlay = document.createElement('div');
    overlay.id = 'studioAuthOverlay';
    overlay.style.cssText = `
      position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
      background: rgba(0, 0, 0, 0.75); backdrop-filter: blur(4px);
      z-index: 99999; display: none; align-items: center; justify-content: center;
      padding: 16px; box-sizing: border-box; font-family: inherit;
    `;

    overlay.innerHTML = `
      <div style="background:#161922; border:1px solid #2d3343; border-radius:12px; width:100%; max-width:440px; padding:24px; box-shadow:0 20px 40px rgba(0,0,0,0.5); color:#f3f4f6;">
        <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:12px;">
          <div style="display:flex; align-items:center; gap:8px;">
            <span style="display:inline-flex; align-items:center; justify-content:center; width:32px; height:32px; border-radius:8px; background:rgba(99,102,241,0.15); color:#818cf8;">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2l-2 2m-1-1l-3 3m2-2l-3 3m-4 1a7 7 0 1 0 0 14 7 7 0 0 0 7-7v-3l-4-4z"></path></svg>
            </span>
            <strong style="font-size:16px;">API Authentication</strong>
          </div>
          <button id="studioAuthCloseBtn" type="button" style="background:transparent; border:none; color:#9ca3af; cursor:pointer; font-size:20px; padding:4px 8px; border-radius:4px;">&times;</button>
        </div>
        <p style="margin:0 0 16px 0; font-size:13px; color:#9ca3af; line-height:1.5;">
          This server is protected with token-based authentication. Enter your API token below to execute commands, browse files, and upload media.
        </p>
        <div id="studioAuthAlert" style="display:none; padding:10px 12px; margin-bottom:14px; border-radius:6px; font-size:12px; line-height:1.4;"></div>
        <div style="margin-bottom:16px;">
          <label style="display:block; font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:0.5px; color:#d1d5db; margin-bottom:6px;">API Token</label>
          <div style="position:relative;">
            <input id="studioAuthInput" type="password" placeholder="Enter API token..." style="width:100%; box-sizing:border-box; background:#0f1115; border:1px solid #374151; color:#fff; padding:10px 40px 10px 12px; border-radius:8px; font-size:14px; font-family:monospace; outline:none;" />
            <button id="studioAuthToggleVis" type="button" style="position:absolute; right:8px; top:50%; transform:translateY(-50%); background:transparent; border:none; color:#9ca3af; cursor:pointer; padding:4px 6px; font-size:12px;">Show</button>
          </div>
        </div>
        <div style="display:flex; gap:10px; justify-content:flex-end;">
          <button id="studioAuthClearBtn" type="button" style="background:#2d3343; border:none; color:#d1d5db; padding:8px 14px; border-radius:6px; font-size:13px; font-weight:500; cursor:pointer;">Clear</button>
          <button id="studioAuthSaveBtn" type="button" style="background:#4f46e5; border:none; color:#fff; padding:8px 18px; border-radius:6px; font-size:13px; font-weight:600; cursor:pointer;">Save &amp; Connect</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    authModalEl = overlay;

    const input = overlay.querySelector('#studioAuthInput');
    const toggleVis = overlay.querySelector('#studioAuthToggleVis');
    const closeBtn = overlay.querySelector('#studioAuthCloseBtn');
    const saveBtn = overlay.querySelector('#studioAuthSaveBtn');
    const clearBtn = overlay.querySelector('#studioAuthClearBtn');
    const alertBox = overlay.querySelector('#studioAuthAlert');

    toggleVis.addEventListener('click', () => {
      if (input.type === 'password') {
        input.type = 'text';
        toggleVis.textContent = 'Hide';
      } else {
        input.type = 'password';
        toggleVis.textContent = 'Show';
      }
    });

    closeBtn.addEventListener('click', () => {
      overlay.style.display = 'none';
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        overlay.style.display = 'none';
      }
    });

    clearBtn.addEventListener('click', () => {
      clearApiToken();
      input.value = '';
      alertBox.style.display = 'block';
      alertBox.style.background = 'rgba(239, 68, 68, 0.15)';
      alertBox.style.border = '1px solid #ef4444';
      alertBox.style.color = '#fca5a5';
      alertBox.textContent = 'API token cleared from local storage.';
      updateTopbarBadge(false);
    });

    saveBtn.addEventListener('click', async () => {
      const val = input.value.trim();
      if (!val) {
        alertBox.style.display = 'block';
        alertBox.style.background = 'rgba(239, 68, 68, 0.15)';
        alertBox.style.border = '1px solid #ef4444';
        alertBox.style.color = '#fca5a5';
        alertBox.textContent = 'Please enter a token.';
        return;
      }

      setApiToken(val);
      saveBtn.disabled = true;
      saveBtn.textContent = 'Verifying...';

      try {
        const res = await originalFetch('/api/auth/status', {
          headers: {
            'Authorization': 'Bearer ' + val,
            'x-api-token': val
          }
        });
        const data = await res.json();
        if (data.authenticated) {
          alertBox.style.display = 'block';
          alertBox.style.background = 'rgba(16, 185, 129, 0.15)';
          alertBox.style.border = '1px solid #10b981';
          alertBox.style.color = '#6ee7b7';
          alertBox.textContent = 'Authentication successful! Reloading...';
          updateTopbarBadge(true);
          setTimeout(() => {
            overlay.style.display = 'none';
            window.location.reload();
          }, 600);
        } else {
          alertBox.style.display = 'block';
          alertBox.style.background = 'rgba(239, 68, 68, 0.15)';
          alertBox.style.border = '1px solid #ef4444';
          alertBox.style.color = '#fca5a5';
          alertBox.textContent = 'Token rejected by server. Please check your API token.';
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save & Connect';
        }
      } catch (err) {
        alertBox.style.display = 'block';
        alertBox.style.background = 'rgba(239, 68, 68, 0.15)';
        alertBox.style.border = '1px solid #ef4444';
        alertBox.style.color = '#fca5a5';
        alertBox.textContent = 'Failed to verify token: ' + err.message;
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save & Connect';
      }
    });

    return overlay;
  }

  function showAuthModal(errorMsg) {
    const modal = createAuthModal();
    const input = modal.querySelector('#studioAuthInput');
    const alertBox = modal.querySelector('#studioAuthAlert');
    input.value = getApiToken();

    if (errorMsg) {
      alertBox.style.display = 'block';
      alertBox.style.background = 'rgba(239, 68, 68, 0.15)';
      alertBox.style.border = '1px solid #ef4444';
      alertBox.style.color = '#fca5a5';
      alertBox.textContent = errorMsg;
    } else {
      alertBox.style.display = 'none';
    }

    modal.style.display = 'flex';
    input.focus();
  }

  window.showStudioAuthModal = showAuthModal;

  // 6. Topbar Button & Status Check
  let authBtnEl = null;

  function updateTopbarBadge(isAuthenticated) {
    if (!authBtnEl) return;
    if (isAuthenticated) {
      authBtnEl.style.color = '#10b981';
      authBtnEl.title = 'API Token Configured (Click to change)';
    } else {
      authBtnEl.style.color = '#f59e0b';
      authBtnEl.title = 'API Token Required (Click to enter token)';
    }
  }

  function setupAuthUi() {
    const topbarActions = document.querySelector('.topbar-actions');
    if (!topbarActions) return;

    authBtnEl = document.createElement('button');
    authBtnEl.id = 'studioAuthTopbarBtn';
    authBtnEl.type = 'button';
    authBtnEl.className = 'icon-btn';
    authBtnEl.title = 'API Authentication';
    authBtnEl.innerHTML = `
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;">
        <path d="M21 2l-2 2m-1-1l-3 3m2-2l-3 3m-4 1a7 7 0 1 0 0 14 7 7 0 0 0 7-7v-3l-4-4z"></path>
      </svg>
    `;
    authBtnEl.style.cursor = 'pointer';

    authBtnEl.addEventListener('click', () => {
      showAuthModal();
    });

    topbarActions.insertBefore(authBtnEl, topbarActions.firstChild);

    // Check server auth status
    originalFetch('/api/auth/status', {
      headers: {
        'Authorization': 'Bearer ' + getApiToken(),
        'x-api-token': getApiToken()
      }
    })
      .then(res => res.json())
      .then(data => {
        if (data.authRequired) {
          updateTopbarBadge(data.authenticated);
          if (!data.authenticated && !getApiToken()) {
            showAuthModal('This server requires an API token to access.');
          }
        } else {
          // Auth disabled on server; hide or style neutral
          authBtnEl.style.opacity = '0.5';
          authBtnEl.title = 'API Authentication: Disabled on server';
        }
      })
      .catch(() => {});
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupAuthUi);
  } else {
    setupAuthUi();
  }
})();
