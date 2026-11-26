'use strict';

/**
 * Shared Authentication & Role-Based Access Control (RBAC) Client Guard
 * - Verifies session status on page load.
 * - Enforces 1-hour auto-logout and 401 redirect.
 * - Locks "Local Storage (Server)" for guest users across Media, Image, and PDF studios.
 * - Injects Topbar User Badge and Logout button.
 */
(function () {
  // Inject auth-specific styles
  const style = document.createElement('style');
  style.id = 'auth-guard-styles';
  style.textContent = `
    .auth-user-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      font-weight: 600;
      padding: 4px 10px;
      border-radius: 20px;
      line-height: 1.2;
    }
    .auth-user-badge.admin {
      background: rgba(59, 130, 246, 0.15);
      border: 1px solid rgba(59, 130, 246, 0.35);
      color: #60a5fa;
    }
    .auth-user-badge.guest {
      background: rgba(245, 158, 11, 0.15);
      border: 1px solid rgba(245, 158, 11, 0.35);
      color: #fbbf24;
    }
    .btn-logout {
      font-size: 12px;
      font-weight: 600;
      padding: 5px 12px;
      border-radius: 8px;
      border: 1px solid var(--border-color, rgba(255, 255, 255, 0.15));
      background: rgba(255, 255, 255, 0.05);
      color: inherit;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .btn-logout:hover {
      background: rgba(239, 68, 68, 0.15);
      border-color: rgba(239, 68, 68, 0.35);
      color: #f87171;
    }
    .mode-btn-locked {
      opacity: 0.6 !important;
      cursor: not-allowed !important;
      position: relative;
      background: rgba(255, 255, 255, 0.02) !important;
    }
    .mode-btn-locked:hover {
      border-color: rgba(239, 68, 68, 0.4) !important;
    }
    .auth-lock-banner {
      background: rgba(245, 158, 11, 0.1);
      border: 1px solid rgba(245, 158, 11, 0.3);
      color: #fbbf24;
      padding: 10px 14px;
      border-radius: 8px;
      font-size: 13px;
      margin-bottom: 14px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
  `;
  document.head.appendChild(style);

  let logoutTimer = null;

  function scheduleAutoLogout(expiresAt) {
    if (logoutTimer) clearTimeout(logoutTimer);
    if (!expiresAt) return;

    const remainingMs = Math.max(0, expiresAt - Date.now());
    console.log(`[Auth] Session expires in ${Math.round(remainingMs / 1000)}s`);

    logoutTimer = setTimeout(() => {
      alert('Your session has expired after 1 hour of inactivity. Please log in again.');
      window.location.href = '/login?expired=1';
    }, remainingMs);
  }

  // Intercept global fetch for 401 Unauthorized responses
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    if (response.status === 401 && !window.location.pathname.startsWith('/login')) {
      console.warn('[Auth] Received 401 Unauthorized from backend. Redirecting to login.');
      window.location.href = '/login?expired=1';
    }
    return response;
  };

  async function performLogout() {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    } catch (e) {}
    window.location.href = '/login?logout=1';
  }

  function injectTopbarUser(user) {
    const topbarActions = document.querySelector('.topbar-actions');
    if (!topbarActions) return;

    // Avoid duplicate injection
    if (document.getElementById('authBadgeContainer')) return;

    const container = document.createElement('div');
    container.id = 'authBadgeContainer';
    container.style.display = 'inline-flex';
    container.style.alignItems = 'center';
    container.style.gap = '8px';

    const badge = document.createElement('span');
    badge.className = `auth-user-badge ${user.role}`;
    badge.innerHTML = user.role === 'admin'
      ? `🛡️ Admin (${escapeHtml(user.username)})`
      : '👤 Guest';
    badge.title = user.role === 'admin'
      ? 'Administrator - Full Server & Storage Access'
      : 'Guest User - Remote Upload Mode Only';

    const btnLogout = document.createElement('button');
    btnLogout.id = 'btnTopLogout';
    btnLogout.className = 'btn-logout';
    btnLogout.type = 'button';
    btnLogout.textContent = user.role === 'admin' ? 'Logout' : 'Sign In';
    btnLogout.title = user.role === 'admin' ? 'End admin session' : 'Sign in as administrator';
    btnLogout.addEventListener('click', performLogout);

    container.appendChild(badge);
    container.appendChild(btnLogout);

    // Insert as first element in topbar-actions
    topbarActions.insertBefore(container, topbarActions.firstChild);
  }

  function lockLocalStorageForGuests() {
    // 1. Media Studio Lock
    const btnMediaLocal = document.getElementById('btnMediaModeLocal');
    const btnMediaRemote = document.getElementById('btnMediaModeRemote');
    const mediaLocalSection = document.getElementById('mediaLocalSection');
    const mediaRemoteSection = document.getElementById('mediaRemoteSection');

    if (btnMediaLocal) {
      btnMediaLocal.disabled = true;
      btnMediaLocal.classList.add('mode-btn-locked');
      btnMediaLocal.innerHTML = '<span>🔒 Local Storage (Admin Only)</span>';
      btnMediaLocal.title = 'Locked: Local server storage browsing is only available to Admin.';
      btnMediaLocal.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        alert('Local phone storage is locked in Guest mode. Please sign in with Admin credentials to access /sdcard.');
      });

      // Switch to Remote Upload mode automatically
      if (btnMediaRemote) {
        btnMediaRemote.click();
      } else {
        if (mediaLocalSection) mediaLocalSection.style.display = 'none';
        if (mediaRemoteSection) mediaRemoteSection.style.display = 'block';
      }

      // Hide storage setup banner
      const storageNoticeBanner = document.getElementById('storageNoticeBanner');
      if (storageNoticeBanner) storageNoticeBanner.style.display = 'none';
    }

    // 2. Image Studio Lock
    const btnImageLocal = document.getElementById('btnImageModeLocal');
    const btnImageRemote = document.getElementById('btnImageModeRemote');
    const imageLocalSection = document.getElementById('imageLocalSection');
    const imageRemoteSection = document.getElementById('imageRemoteSection');

    if (btnImageLocal) {
      btnImageLocal.disabled = true;
      btnImageLocal.classList.add('mode-btn-locked');
      btnImageLocal.innerHTML = '<span>🔒 Local Storage (Admin Only)</span>';
      btnImageLocal.title = 'Locked: Local server storage browsing is only available to Admin.';
      btnImageLocal.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        alert('Local phone storage is locked in Guest mode. Please sign in with Admin credentials.');
      });

      if (btnImageRemote) {
        btnImageRemote.click();
      } else {
        if (imageLocalSection) imageLocalSection.style.display = 'none';
        if (imageRemoteSection) imageRemoteSection.style.display = 'block';
      }
    }

    // 3. PDF Studio Lock
    const btnPdfLocal = document.getElementById('btnPdfModeLocal');
    const btnPdfRemote = document.getElementById('btnPdfModeRemote');
    const pdfLocalSection = document.getElementById('pdfLocalSection');
    const pdfRemoteSection = document.getElementById('pdfRemoteSection');

    if (btnPdfLocal) {
      btnPdfLocal.disabled = true;
      btnPdfLocal.classList.add('mode-btn-locked');
      btnPdfLocal.innerHTML = '<span>🔒 Local Storage (Admin Only)</span>';
      btnPdfLocal.title = 'Locked: Local server storage browsing is only available to Admin.';
      btnPdfLocal.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        alert('Local phone storage is locked in Guest mode. Please sign in with Admin credentials.');
      });

      if (btnPdfRemote) {
        btnPdfRemote.click();
      } else {
        if (pdfLocalSection) pdfLocalSection.style.display = 'none';
        if (pdfRemoteSection) pdfRemoteSection.style.display = 'block';
      }
    }

    // 4. Dashboard Lock: Guests cannot access Dashboard
    const pathname = window.location.pathname;
    if (pathname === '/dashboard' || pathname === '/dashboard/' || pathname === '/dashboard.html') {
      alert('Access Denied: The live diagnostics dashboard is restricted to Admin users.');
      window.location.replace('/?denied=1');
    }
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  async function initAuthGuard() {
    // Skip auth guard on login page itself
    if (window.location.pathname.startsWith('/login')) {
      return;
    }

    try {
      const res = await fetch('/api/auth/status', { credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));

      // If server has no admin yet, redirect to login page for first-time registration
      if (!data.hasAdmin) {
        sessionStorage.setItem('redirectAfterLogin', window.location.pathname + window.location.search);
        window.location.replace('/login');
        return;
      }

      // If not authenticated (neither admin nor guest)
      if (!data.authenticated) {
        sessionStorage.setItem('redirectAfterLogin', window.location.pathname + window.location.search);
        window.location.replace('/login');
        return;
      }

      // Authenticated! Store globally
      window.currentUser = data.user;
      window.authExpiresAt = data.expiresAt;

      // Inject topbar user badge & logout
      injectTopbarUser(data.user);

      // Schedule 1-hour auto-logout
      if (data.expiresAt) {
        scheduleAutoLogout(data.expiresAt);
      }

      // If user is a Guest, lock all local storage options
      if (data.user.role === 'guest') {
        lockLocalStorageForGuests();
      }
    } catch (err) {
      console.error('[Auth Guard] Status check error:', err);
    }
  }

  // Run on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAuthGuard);
  } else {
    initAuthGuard();
  }
})();
