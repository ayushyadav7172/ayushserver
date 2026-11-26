'use strict';

(function () {
  const loadingSection = document.getElementById('loadingSection');
  const registerSection = document.getElementById('registerSection');
  const loginSection = document.getElementById('loginSection');
  const authAlert = document.getElementById('authAlert');

  const registerForm = document.getElementById('registerForm');
  const regUsername = document.getElementById('regUsername');
  const regPassword = document.getElementById('regPassword');
  const regConfirmPassword = document.getElementById('regConfirmPassword');
  const btnRegisterSubmit = document.getElementById('btnRegisterSubmit');

  const loginForm = document.getElementById('loginForm');
  const loginUsername = document.getElementById('loginUsername');
  const loginPassword = document.getElementById('loginPassword');
  const btnLoginSubmit = document.getElementById('btnLoginSubmit');

  const btnGuestFromReg = document.getElementById('btnGuestFromReg');
  const btnGuestFromLogin = document.getElementById('btnGuestFromLogin');

  function showAlert(message, type = 'error') {
    if (!authAlert) return;
    authAlert.className = `auth-alert show auth-alert-${type}`;
    authAlert.textContent = message;
    authAlert.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function hideAlert() {
    if (!authAlert) return;
    authAlert.className = 'auth-alert';
    authAlert.textContent = '';
  }

  function getRedirectUrl() {
    const params = new URLSearchParams(window.location.search);
    const redirectParam = params.get('redirect');
    if (redirectParam && redirectParam.startsWith('/') && !redirectParam.startsWith('//')) {
      return redirectParam;
    }
    const stored = sessionStorage.getItem('redirectAfterLogin');
    if (stored && stored.startsWith('/') && !stored.startsWith('//')) {
      sessionStorage.removeItem('redirectAfterLogin');
      return stored;
    }
    return '/';
  }

  function handleUrlParams() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('expired') === '1') {
      showAlert('Your session expired after 1 hour of inactivity. Please log in again.', 'warning');
    } else if (params.get('logout') === '1') {
      showAlert('You have been logged out successfully.', 'success');
    } else if (params.get('denied') === '1') {
      showAlert('Access denied: Admin credentials required to access that section.', 'warning');
    }
  }

  async function checkAuthStatus() {
    try {
      handleUrlParams();
      const res = await fetch('/api/auth/status', { credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));

      loadingSection.style.display = 'none';

      // If user is already an admin, redirect
      if (data.authenticated && data.user && data.user.role === 'admin') {
        showAlert('Already logged in as admin. Redirecting…', 'info');
        setTimeout(() => {
          window.location.replace(getRedirectUrl());
        }, 300);
        return;
      }

      if (!data.hasAdmin) {
        // Initial setup mode: no admin exists yet
        registerSection.style.display = 'block';
        loginSection.style.display = 'none';
        regUsername.focus();
      } else {
        // Normal mode: admin exists, show login form only
        registerSection.style.display = 'none';
        loginSection.style.display = 'block';
        loginUsername.focus();
      }
    } catch (err) {
      loadingSection.style.display = 'none';
      showAlert('Failed to connect to authentication server: ' + err.message, 'error');
      loginSection.style.display = 'block';
    }
  }

  // Handle Admin Registration (Initial Setup)
  if (registerForm) {
    registerForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      hideAlert();

      const username = regUsername.value.trim();
      const password = regPassword.value;
      const confirmPassword = regConfirmPassword.value;

      if (!username || username.length < 3) {
        showAlert('Username must be at least 3 characters long.', 'error');
        regUsername.focus();
        return;
      }

      if (!password || password.length < 6) {
        showAlert('Password must be at least 6 characters long.', 'error');
        regPassword.focus();
        return;
      }

      if (password !== confirmPassword) {
        showAlert('Passwords do not match. Please re-enter.', 'error');
        regConfirmPassword.focus();
        return;
      }

      btnRegisterSubmit.disabled = true;
      btnRegisterSubmit.innerHTML = '<span class="spinner-sm"></span> Creating account…';

      try {
        const res = await fetch('/api/auth/register-admin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ username, password })
        });
        const data = await res.json().catch(() => ({}));

        if (!res.ok || !data.success) {
          throw new Error(data.error || 'Failed to create admin account.');
        }

        showAlert('Admin account created! Logging you in…', 'success');
        setTimeout(() => {
          window.location.replace(getRedirectUrl());
        }, 500);
      } catch (err) {
        showAlert(err.message, 'error');
        btnRegisterSubmit.disabled = false;
        btnRegisterSubmit.innerHTML = '<span>Register & Log In as Admin</span>';
      }
    });
  }

  // Handle Admin Login
  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      hideAlert();

      const username = loginUsername.value.trim();
      const password = loginPassword.value;

      if (!username || !password) {
        showAlert('Please enter both username and password.', 'error');
        return;
      }

      btnLoginSubmit.disabled = true;
      btnLoginSubmit.innerHTML = '<span class="spinner-sm"></span> Signing in…';

      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ username, password })
        });
        const data = await res.json().catch(() => ({}));

        if (!res.ok || !data.success) {
          throw new Error(data.error || 'Invalid credentials.');
        }

        showAlert('Login successful! Redirecting…', 'success');
        setTimeout(() => {
          window.location.replace(getRedirectUrl());
        }, 400);
      } catch (err) {
        showAlert(err.message, 'error');
        btnLoginSubmit.disabled = false;
        btnLoginSubmit.innerHTML = '<span>Sign In as Admin</span>';
      }
    });
  }

  // Handle Continue as Guest
  async function handleGuestLogin(btn) {
    hideAlert();
    const originalContent = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-sm"></span> Continuing as Guest…';

    try {
      const res = await fetch('/api/auth/guest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin'
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to start guest session.');
      }

      showAlert('Guest session started. Redirecting…', 'info');
      setTimeout(() => {
        window.location.replace(getRedirectUrl());
      }, 400);
    } catch (err) {
      showAlert(err.message, 'error');
      btn.disabled = false;
      btn.innerHTML = originalContent;
    }
  }

  if (btnGuestFromReg) {
    btnGuestFromReg.addEventListener('click', () => handleGuestLogin(btnGuestFromReg));
  }
  if (btnGuestFromLogin) {
    btnGuestFromLogin.addEventListener('click', () => handleGuestLogin(btnGuestFromLogin));
  }

  // Start initialization
  checkAuthStatus();
})();
