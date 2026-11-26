(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const mergePaths = [];
  const imagePaths = [];
  let rotateAngle = 90;

  const explorer = {
    kind: 'pdf',
    mode: 'single',
    selected: [],
    items: [],
    currentDir: '',
    parentDir: null,
    allowedRoots: [],
    onConfirm: null
  };

  const ICONS = {
    folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>',
    pdf: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><path d="M9 13h6M9 17h4"></path></svg>',
    image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>'
  };

  function isPdfPath(filePath) {
    const s = String(filePath || '').trim().replace(/^['"]|['"]$/g, '');
    return /\.pdf$/i.test(s);
  }

  function isImagePath(filePath) {
    const s = String(filePath || '').trim().replace(/^['"]|['"]$/g, '');
    return /\.(jpe?g|png)$/i.test(s);
  }

  function baseName(filePath) {
    const normalized = String(filePath || '').replace(/\/+$/, '');
    const index = normalized.lastIndexOf('/');
    return index >= 0 ? normalized.slice(index + 1) : normalized;
  }

  function fileUrl(filePath, download) {
    return `/api/pdf/download?path=${encodeURIComponent(filePath)}${download ? '&download=1' : ''}`;
  }

  function showToast(message, type) {
    const container = $('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type || 'info'}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.transition = 'opacity 0.25s ease, transform 0.25s ease';
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(4px)';
    }, 4000);
    setTimeout(() => toast.remove(), 4400);
  }

  function hideResult(element) {
    if (!element) return;
    element.style.display = 'none';
    element.innerHTML = '';
    element.classList.remove('is-error');
  }

  function setBusy(button, busy, label) {
    if (!button) return;
    if (busy) {
      if (!button.dataset.idleText) button.dataset.idleText = button.textContent;
      button.disabled = true;
      button.textContent = label || 'Working…';
    } else {
      button.disabled = false;
      if (button.dataset.idleText) {
        button.textContent = button.dataset.idleText;
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

  async function postJson(url, payload) {
    const sessionId = getOrCreateSessionId();
    const finalPayload = { ...(payload || {}), sessionId };
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-ID': sessionId
      },
      body: JSON.stringify(finalPayload)
    });

    const raw = await response.text();
    let data = {};
    try {
      data = JSON.parse(raw);
    } catch (err) {
      data = { error: raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) };
    }

    if (!response.ok || data.success === false) {
      const err = new Error(data.error || `Request failed (${response.status})`);
      err.status = response.status;
      err.busy = Boolean(data.busy || response.status === 409);
      err.data = data;
      throw err;
    }

    return data;
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const copied = document.execCommand('copy');
      area.remove();
      return copied;
    } catch (err) {
      return false;
    }
  }

  class AutoCleanupTimer {
    constructor(element, storageKey, onExpire) {
      this.element = typeof element === 'string' ? $(element) : element;
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
        try { sessionStorage.removeItem(this.storageKey); } catch (e) {}
      }
    }

    recover() {
      if (!this.storageKey) return false;
      try {
        const raw = sessionStorage.getItem(this.storageKey);
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
        try { sessionStorage.removeItem(this.storageKey); } catch (e) {}
      }
    }
  }

  function isPdfRemoteMode() {
    return Boolean($('btnPdfModeRemote') && $('btnPdfModeRemote').classList.contains('active'));
  }

  function setPdfStorageMode(mode) {
    if (mode === 'local' && window.currentUser && window.currentUser.role === 'guest') {
      showToast('Local phone storage is locked in Guest mode. Please sign in as Admin.', 'warning');
      return;
    }
    const isRemote = mode === 'remote';
    if (isRemote) {
      $('btnPdfModeLocal')?.classList.remove('active');
      $('btnPdfModeRemote')?.classList.add('active');
      localStorage.setItem('ffstudio_pdf_mode', 'remote');
      initPdfUploadTimers();
      Object.values(pdfTimers).forEach((timer) => timer.recover());
    } else {
      $('btnPdfModeRemote')?.classList.remove('active');
      $('btnPdfModeLocal')?.classList.add('active');
      localStorage.setItem('ffstudio_pdf_mode', 'local');
      Object.values(pdfTimers).forEach((timer) => timer.clear());
      for (const k of Object.keys(pdfTimers)) {
        delete pdfTimers[k];
      }
    }
    document.querySelectorAll('.pdf-local-only').forEach((el) => {
      el.style.display = isRemote ? 'none' : '';
    });
    document.querySelectorAll('.pdf-remote-only').forEach((el) => {
      el.style.display = isRemote ? 'block' : 'none';
    });

    const notice = $('pdfSessionNotice');
    if (notice) notice.style.display = isRemote ? 'flex' : 'none';

    // Reset inputs and dropzones on mode change to prevent accidental wrong-mode processing
    const inputIds = ['unlockPath', 'mergePathInput', 'compressPath', 'splitPath', 'rotatePath', 'imagePathInput', 'toImagesPath'];
    inputIds.forEach(id => {
      const el = $(id);
      if (el) el.value = '';
    });
    mergePaths.length = 0;
    renderMergeList();
    imagePaths.length = 0;
    renderImageList();
  }

  const pdfTimers = {};

  function savePdfLastResult(panelId, data) {
    try {
      const expiresAt = data.expiresAt || (Date.now() + 30 * 60 * 1000);
      data.expiresAt = expiresAt;
      sessionStorage.setItem('ffstudio_pdf_last_result', JSON.stringify({
        panelId,
        data,
        expiresAt
      }));
    } catch (e) {}
  }

  function recoverPdfLastResult() {
    try {
      const raw = sessionStorage.getItem('ffstudio_pdf_last_result');
      if (!raw) return;
      const item = JSON.parse(raw);
      if (item && item.expiresAt > Date.now() && item.panelId && item.data) {
        const container = $(item.panelId);
        if (container) {
          item.data.expiresAt = item.expiresAt;
          renderResult(container, item.data);
        }
      } else {
        sessionStorage.removeItem('ffstudio_pdf_last_result');
      }
    } catch (e) {}
  }

  function uploadPdfFiles(files, targetKey, dropzone) {
    const fileList = Array.from(files || []);
    const isImageTarget = targetKey === 'images' || targetKey === 'imagePaths';
    const valid = fileList.filter((f) => {
      return isImageTarget ? isImagePath(f.name) : isPdfPath(f.name);
    });

    if (valid.length === 0) {
      showToast(isImageTarget ? 'Please select valid JPG or PNG images.' : 'Please select valid PDF files.', 'warning');
      return;
    }

    if (valid.length < fileList.length) {
      showToast(`${fileList.length - valid.length} invalid file(s) were skipped.`, 'warning');
    }

    const titleEl = dropzone.querySelector('.dropzone-title');
    const originalTitle = titleEl ? titleEl.textContent : '';
    if (titleEl) titleEl.textContent = `Uploading ${valid.length} file${valid.length === 1 ? '' : 's'} (0%)...`;

    const formData = new FormData();
    valid.forEach((f) => formData.append('files', f));

    const xhr = new XMLHttpRequest();
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && titleEl) {
        const percent = Math.min(100, Math.round((e.loaded / e.total) * 100));
        titleEl.textContent = `Uploading ${valid.length} file${valid.length === 1 ? '' : 's'} (${percent}%)...`;
      }
    });

    xhr.addEventListener('load', () => {
      if (titleEl) titleEl.textContent = originalTitle;
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300 && data.success) {
          showToast(`Uploaded ${data.files.length} file${data.files.length === 1 ? '' : 's'}.`, 'success');
          const expiresAt = data.files[0]?.expiresAt || (Date.now() + 30 * 60 * 1000);

          if (targetKey === 'merge' || targetKey === 'mergePaths') {
            addMergePaths(data.files.map((f) => f.path));
            pdfTimers.merge?.start(expiresAt, 'Uploaded PDFs will be deleted in');
          } else if (targetKey === 'images' || targetKey === 'imagePaths') {
            addImagePaths(data.files.map((f) => f.path));
            pdfTimers.images?.start(expiresAt, 'Uploaded images will be deleted in');
          } else {
            const input = $(targetKey);
            if (input) {
              input.value = data.files[0].path;
            }
            let timerKey = 'unlock';
            if (targetKey === 'compressPath') timerKey = 'compress';
            else if (targetKey === 'splitPath') timerKey = 'split';
            else if (targetKey === 'rotatePath') timerKey = 'rotate';
            else if (targetKey === 'toImagesPath') timerKey = 'toimages';

            pdfTimers[timerKey]?.start(expiresAt, 'File will be deleted in');
          }
        } else {
          showToast(data.error || 'Upload failed.', 'error');
        }
      } catch (err) {
        showToast('Upload error: ' + err.message, 'error');
      }
    });

    xhr.addEventListener('error', () => {
      if (titleEl) titleEl.textContent = originalTitle;
      showToast('Upload network error.', 'error');
    });

    xhr.open('POST', '/api/upload');
    xhr.setRequestHeader('X-Session-ID', getOrCreateSessionId());
    xhr.send(formData);
  }

  function initPdfUploadTimers() {
    if (!pdfTimers.unlock) {
      pdfTimers.unlock = new AutoCleanupTimer('unlockUploadTimer', 'ffstudio_pdf_timer_unlock', () => {
        const el = $('unlockPath');
        if (el) el.value = '';
      });
    }
    if (!pdfTimers.merge) {
      pdfTimers.merge = new AutoCleanupTimer('mergeUploadTimer', 'ffstudio_pdf_timer_merge', () => {
        mergePaths.length = 0;
        renderMergeList();
      });
    }
    if (!pdfTimers.compress) {
      pdfTimers.compress = new AutoCleanupTimer('compressUploadTimer', 'ffstudio_pdf_timer_compress', () => {
        const el = $('compressPath');
        if (el) el.value = '';
      });
    }
    if (!pdfTimers.split) {
      pdfTimers.split = new AutoCleanupTimer('splitUploadTimer', 'ffstudio_pdf_timer_split', () => {
        const el = $('splitPath');
        if (el) el.value = '';
      });
    }
    if (!pdfTimers.rotate) {
      pdfTimers.rotate = new AutoCleanupTimer('rotateUploadTimer', 'ffstudio_pdf_timer_rotate', () => {
        const el = $('rotatePath');
        if (el) el.value = '';
      });
    }
    if (!pdfTimers.images) {
      pdfTimers.images = new AutoCleanupTimer('imagesUploadTimer', 'ffstudio_pdf_timer_images', () => {
        imagePaths.length = 0;
        renderImageList();
      });
    }
    if (!pdfTimers.toimages) {
      pdfTimers.toimages = new AutoCleanupTimer('toImagesUploadTimer', 'ffstudio_pdf_timer_toimages', () => {
        const el = $('toImagesPath');
        if (el) el.value = '';
      });
    }
  }

  function initPdfStorageModeAndUploads() {
    $('btnPdfModeLocal')?.addEventListener('click', () => setPdfStorageMode('local'));
    $('btnPdfModeRemote')?.addEventListener('click', () => setPdfStorageMode('remote'));

    const savedMode = localStorage.getItem('ffstudio_pdf_mode') || 'local';
    setPdfStorageMode(savedMode);

    $('btnClearPdfSession')?.addEventListener('click', () => {
      if (confirm('Reset your remote PDF session? This will clear active selections and stored result sessions.')) {
        try {
          sessionStorage.removeItem('ffstudio_pdf_last_result');
          sessionStorage.removeItem('ffstudio_pdf_timer_unlock');
          sessionStorage.removeItem('ffstudio_pdf_timer_merge');
          sessionStorage.removeItem('ffstudio_pdf_timer_compress');
          sessionStorage.removeItem('ffstudio_pdf_timer_split');
          sessionStorage.removeItem('ffstudio_pdf_timer_rotate');
          sessionStorage.removeItem('ffstudio_pdf_timer_images');
          sessionStorage.removeItem('ffstudio_pdf_timer_toimages');
          sessionStorage.removeItem('ffstudio_session_id');
        } catch (e) {}
        Object.values(pdfTimers).forEach((t) => t.clear());
        const inputIds = ['unlockPath', 'mergePathInput', 'compressPath', 'splitPath', 'rotatePath', 'imagePathInput', 'toImagesPath'];
        inputIds.forEach((id) => {
          const el = $(id);
          if (el) el.value = '';
        });
        mergePaths.length = 0;
        renderMergeList();
        imagePaths.length = 0;
        renderImageList();
        document.querySelectorAll('.pdf-result').forEach((el) => {
          el.innerHTML = '';
          el.style.display = 'none';
        });
        showToast('PDF session reset successfully.', 'info');
      }
    });

    document.querySelectorAll('.upload-dropzone').forEach((dropzone) => {
      const fileInput = dropzone.querySelector('.pdf-remote-input');
      const targetInput = dropzone.dataset.targetInput || dropzone.dataset.targetQueue;

      dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.classList.add('dragover');
      });
      dropzone.addEventListener('dragleave', (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
      });
      dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
        if (e.dataTransfer && e.dataTransfer.files) {
          uploadPdfFiles(e.dataTransfer.files, targetInput, dropzone);
        }
      });
      if (fileInput) {
        fileInput.addEventListener('change', () => {
          if (fileInput.files && fileInput.files.length > 0) {
            uploadPdfFiles(fileInput.files, targetInput, dropzone);
            fileInput.value = '';
          }
        });
      }
    });
  }

  function resultShell(container, options) {
    container.innerHTML = '';
    container.style.display = 'block';
    container.classList.toggle('is-error', Boolean(options.error));

    const head = document.createElement('div');
    head.className = 'pdf-result-head';

    const badge = document.createElement('span');
    badge.className = 'pdf-result-badge';
    const dot = document.createElement('span');
    dot.className = 'sys-dot';
    badge.append(dot, document.createTextNode(options.badge || 'Complete'));

    const meta = document.createElement('span');
    meta.className = 'result-meta';
    meta.textContent = options.meta || '';

    head.append(badge, meta);

    const body = document.createElement('div');
    body.className = 'pdf-result-body';

    container.append(head, body);
    return { body, meta };
  }

  function resultPathBox(label, value) {
    const box = document.createElement('div');
    box.className = 'pdf-result-path';
    const labelEl = document.createElement('span');
    labelEl.className = 'pdf-result-path-label';
    labelEl.textContent = label;
    const code = document.createElement('code');
    code.textContent = value;
    box.append(labelEl, code);
    return box;
  }

  function resultActions() {
    const row = document.createElement('div');
    row.className = 'pdf-result-actions';
    return row;
  }

  function makeButton(label, className) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className || 'btn btn-secondary';
    button.textContent = label;
    return button;
  }

  function makeLink(label, href, className, downloadName) {
    const link = document.createElement('a');
    link.className = className || 'btn btn-secondary';
    link.href = href;
    link.textContent = label;
    if (downloadName) {
      link.setAttribute('download', downloadName);
    } else {
      link.target = '_blank';
      link.rel = 'noopener';
    }
    return link;
  }

  function renderResult(container, data) {
    const message = data.message || 'Operation completed successfully.';
    const shell = resultShell(container, { badge: 'Complete', meta: message });

    const outputPath = data.outputPath || data.outputDir;
    if (outputPath) {
      shell.body.appendChild(resultPathBox(data.files ? 'Output folder' : 'Saved to', outputPath));
    }

    if (Array.isArray(data.files) && data.files.length > 0) {
      if (isPdfRemoteMode()) {
        const timerBox = document.createElement('div');
        timerBox.className = 'countdown-timer-box';
        timerBox.style.marginBottom = '12px';
        shell.body.appendChild(timerBox);
        const expiresAt = Date.now() + 30 * 60 * 1000;
        const outTimer = new AutoCleanupTimer(timerBox, 'ffstudio_pdf_output_toimages');
        outTimer.start(expiresAt, 'Exported files will be deleted in');
      } else {
        const localNotice = document.createElement('div');
        localNotice.className = 'banner banner-success';
        localNotice.style.fontSize = '12px';
        localNotice.style.padding = '8px 12px';
        localNotice.style.marginBottom = '12px';
        localNotice.textContent = 'Saved directly to device storage';
        shell.body.appendChild(localNotice);
      }

      const firstExt = data.files[0] && /\.png$/i.test(data.files[0].name || data.files[0].path || '') ? 'PNG' : 'JPG';
      const imgLabel = (data.format && String(data.format).toUpperCase()) || firstExt;
      const note = document.createElement('p');
      note.className = 'pdf-result-note';
      note.textContent = `${data.files.length} ${imgLabel} file${data.files.length === 1 ? '' : 's'} created. Tap a preview to open it, or save it directly.`;
      shell.body.appendChild(note);

      const grid = document.createElement('div');
      grid.className = 'pdf-result-grid';

      data.files.forEach((file) => {
        const card = document.createElement('div');
        card.className = 'pdf-image-card';

        const thumbLink = document.createElement('a');
        thumbLink.className = 'pdf-image-card-thumb';
        thumbLink.href = file.previewUrl || fileUrl(file.path, false);
        thumbLink.target = '_blank';
        thumbLink.rel = 'noopener';

        const img = document.createElement('img');
        img.src = thumbLink.href;
        img.alt = file.name || 'PDF page';
        img.loading = 'lazy';
        thumbLink.appendChild(img);

        const foot = document.createElement('div');
        foot.className = 'pdf-image-card-foot';
        const name = document.createElement('span');
        name.textContent = file.name || baseName(file.path);
        const save = document.createElement('a');
        save.className = isPdfRemoteMode() ? 'btn-download-prominent' : 'pdf-image-card-save';
        if (isPdfRemoteMode()) {
          save.style.cssText = 'padding:4px 10px;font-size:12px;display:inline-flex;align-items:center;';
        }
        save.href = file.downloadUrl || fileUrl(file.path, true);
        save.setAttribute('download', file.name || '');
        save.textContent = 'Save';

        foot.append(name, save);
        card.append(thumbLink, foot);
        grid.appendChild(card);
      });

      shell.body.appendChild(grid);
    } else if (data.downloadUrl) {
      if (isPdfRemoteMode()) {
        const timerBox = document.createElement('div');
        timerBox.className = 'countdown-timer-box';
        timerBox.style.marginBottom = '12px';
        shell.body.appendChild(timerBox);
        const expiresAt = data.expiresAt || (Date.now() + 30 * 60 * 1000);
        data.expiresAt = expiresAt;
        const outTimer = new AutoCleanupTimer(timerBox, 'ffstudio_pdf_output_' + (container.id || 'single'));
        outTimer.start(expiresAt, 'Output file will be deleted in');
      } else {
        const localNotice = document.createElement('div');
        localNotice.className = 'banner banner-success';
        localNotice.style.fontSize = '12px';
        localNotice.style.padding = '8px 12px';
        localNotice.style.marginBottom = '12px';
        localNotice.textContent = 'Saved directly to device storage';
        shell.body.appendChild(localNotice);
      }

      const actions = resultActions();
      const dlBtnClass = isPdfRemoteMode() ? 'btn btn-primary btn-download-prominent' : 'btn btn-primary';
      const dlBtnLabel = isPdfRemoteMode() ? 'Download Result' : 'Download file';
      actions.appendChild(makeLink(dlBtnLabel, data.downloadUrl, dlBtnClass, data.fileName || ''));
      if (data.previewUrl) {
        actions.appendChild(makeLink(data.fileName && /\.pdf$/i.test(data.fileName) ? 'Open PDF' : 'Preview', data.previewUrl, 'btn btn-secondary'));
      }
      const copy = makeButton('Copy path', 'btn btn-ghost');
      copy.addEventListener('click', async () => {
        const copied = await copyText(outputPath || '');
        showToast(copied ? 'Path copied.' : 'Could not copy the path.', copied ? 'success' : 'error');
      });
      actions.appendChild(copy);
      shell.body.appendChild(actions);

      const details = [];
      if (data.fileName) details.push(data.fileName);
      if (data.originalSizeFormatted && data.sizeFormatted) {
        const saved = data.didShrink ? ` · ${data.savedPercent}% smaller` : '';
        details.push(`${data.originalSizeFormatted} → ${data.sizeFormatted}${saved}`);
      } else if (data.sizeFormatted) {
        details.push(data.sizeFormatted);
      }
      if (data.pageRange) details.push(`Pages ${data.pageRange}`);
      if (data.pageCount) details.push(`${data.pageCount} page${data.pageCount === 1 ? '' : 's'}`);
      if (data.sourceCount) details.push(`${data.sourceCount} source${data.sourceCount === 1 ? '' : 's'}`);
      if (data.angle) details.push(`${data.angle}° rotation`);
      if (data.engine) details.push(`Engine: ${data.engine}`);
      if (details.length > 0) {
        const detail = document.createElement('p');
        detail.className = 'pdf-result-note';
        detail.textContent = details.join(' · ');
        shell.body.appendChild(detail);
      }
      if (data.note) {
        const note = document.createElement('p');
        note.className = 'pdf-result-note';
        note.textContent = data.note;
        shell.body.appendChild(note);
      }
    }
  }

  function renderError(container, message) {
    if (!container) return;
    const shell = resultShell(container, { badge: 'Failed', meta: 'Nothing was written.', error: true });
    const note = document.createElement('div');
    note.className = 'banner banner-warning';
    note.style.marginBottom = '0';
    note.textContent = message;
    shell.body.appendChild(note);
  }

  function readSinglePath(inputId, kind, label) {
    let value = $(inputId).value.trim().replace(/^['"]|['"]$/g, '');
    if (!value) {
      throw new Error(`Choose a ${label} first.`);
    }
    if (kind === 'pdf' && !isPdfPath(value)) {
      throw new Error('The selected file must be a PDF.');
    }
    if (kind === 'image' && !isImagePath(value)) {
      throw new Error('The selected file must be a JPG or PNG image.');
    }
    return value;
  }

  function renderPathList(container, badge, paths, kind, emptyText, onChange) {
    container.innerHTML = '';

    if (paths.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'file-stack-empty';
      empty.textContent = emptyText;
      container.appendChild(empty);
    }

    if (kind === 'pdf') {
      const clearBtn = $('btnMergeClearAll');
      if (clearBtn) clearBtn.style.display = paths.length > 0 ? 'inline-flex' : 'none';
    } else if (kind === 'image') {
      const clearBtn = $('btnImageClearAll');
      if (clearBtn) clearBtn.style.display = paths.length > 0 ? 'inline-flex' : 'none';
    }

    paths.forEach((filePath, index) => {
      const row = document.createElement('div');
      row.className = 'file-row';

      const order = document.createElement('span');
      order.className = 'file-order-badge';
      order.textContent = String(index + 1);

      const thumb = document.createElement('span');
      thumb.className = 'file-thumb';
      if (kind === 'image') {
        const img = document.createElement('img');
        img.alt = '';
        img.loading = 'lazy';
        img.onerror = () => {
          img.remove();
          thumb.textContent = 'IMG';
        };
        img.src = fileUrl(filePath, false);
        thumb.appendChild(img);
      } else {
        thumb.textContent = 'PDF';
      }

      const info = document.createElement('div');
      info.className = 'file-info';
      const name = document.createElement('strong');
      name.textContent = baseName(filePath);
      const pathCode = document.createElement('code');
      pathCode.textContent = filePath;
      info.append(name, pathCode);

      const actions = document.createElement('div');
      actions.className = 'file-row-actions';

      const up = document.createElement('button');
      up.type = 'button';
      up.className = 'file-mini-btn';
      up.textContent = '↑';
      up.title = 'Move up';
      up.disabled = index === 0;
      up.addEventListener('click', () => {
        if (index === 0) return;
        [paths[index - 1], paths[index]] = [paths[index], paths[index - 1]];
        onChange();
      });

      const down = document.createElement('button');
      down.type = 'button';
      down.className = 'file-mini-btn';
      down.textContent = '↓';
      down.title = 'Move down';
      down.disabled = index === paths.length - 1;
      down.addEventListener('click', () => {
        if (index >= paths.length - 1) return;
        [paths[index + 1], paths[index]] = [paths[index], paths[index + 1]];
        onChange();
      });

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'file-mini-btn danger';
      remove.textContent = '×';
      remove.title = 'Remove';
      remove.addEventListener('click', () => {
        paths.splice(index, 1);
        onChange();
      });

      actions.append(up, down, remove);
      row.append(order, thumb, info, actions);
      container.appendChild(row);
    });

    const noun = kind === 'image' ? 'image' : 'file';
    badge.textContent = `${paths.length} ${noun}${paths.length === 1 ? '' : 's'}`;
  }

  function renderMergeList() {
    renderPathList(
      $('mergeList'),
      $('mergeCountBadge'),
      mergePaths,
      'pdf',
      'No PDFs selected yet. Add at least two files.',
      renderMergeList
    );
  }

  function renderImageList() {
    renderPathList(
      $('imageList'),
      $('imageCountBadge'),
      imagePaths,
      'image',
      'No images selected yet. Add at least one JPG or PNG.',
      renderImageList
    );
  }

  function addMergePaths(paths) {
    let added = 0;
    let skipped = 0;
    let duplicate = 0;
    paths.forEach((rawPath) => {
      let filePath = String(rawPath || '').trim().replace(/^['"]|['"]$/g, '');
      if (!filePath || !isPdfPath(filePath)) {
        skipped++;
        return;
      }
      if (mergePaths.includes(filePath)) {
        duplicate++;
        return;
      }
      mergePaths.push(filePath);
      added++;
    });
    renderMergeList();
    if (added > 0) showToast(`Added ${added} PDF${added === 1 ? '' : 's'}.`, 'success');
    if (duplicate > 0 && added === 0) showToast('This PDF is already in the list.', 'info');
    if (skipped > 0) showToast(`${skipped} non-PDF file${skipped === 1 ? ' was' : 's were'} skipped.`, 'warning');
  }

  function addImagePaths(paths) {
    let added = 0;
    let skipped = 0;
    let duplicate = 0;
    paths.forEach((rawPath) => {
      let filePath = String(rawPath || '').trim().replace(/^['"]|['"]$/g, '');
      if (!filePath || !isImagePath(filePath)) {
        skipped++;
        return;
      }
      if (imagePaths.includes(filePath)) {
        duplicate++;
        return;
      }
      imagePaths.push(filePath);
      added++;
    });
    renderImageList();
    if (added > 0) showToast(`Added ${added} image${added === 1 ? '' : 's'}.`, 'success');
    if (duplicate > 0 && added === 0) showToast('This image is already in the list.', 'info');
    if (skipped > 0) showToast(`${skipped} file${skipped === 1 ? ' was' : 's were'} skipped. Only JPG/PNG is supported.`, 'warning');
  }

  function addPathFromInput(inputId, kind) {
    let value = $(inputId).value.trim().replace(/^['"]|['"]$/g, '');
    if (!value) {
      showToast('Enter an absolute file path first.', 'warning');
      return;
    }
    if (kind === 'pdf') {
      addMergePaths([value]);
      if (isPdfPath(value)) $(inputId).value = '';
    } else {
      addImagePaths([value]);
      if (isImagePath(value)) $(inputId).value = '';
    }
  }

  function openExplorer(options) {
    explorer.kind = options.kind;
    explorer.mode = options.mode;
    explorer.selected = [];
    explorer.onConfirm = options.onConfirm;

    $('pdfExplorerTitle').textContent = options.title || 'Select a file';
    $('pdfExplorerModal').style.display = 'flex';
    $('pdfExplorerError').style.display = 'none';
    $('pdfExplorerList').innerHTML = '';
    $('pdfExplorerSearch').value = '';
    $('btnPdfExplorerClearSearch').style.display = 'none';
    $('pdfExplorerHint').textContent = options.mode === 'multi'
      ? 'Tap files to select them. They will be added in the order shown.'
      : 'Tap a file to select it, then confirm.';
    $('btnPdfExplorerConfirm').style.display = 'inline-flex';
    $('btnPdfExplorerConfirm').disabled = true;
    $('btnPdfExplorerConfirm').textContent = options.mode === 'multi' ? 'Use selected' : 'Select file';

    loadDirectory(explorer.currentDir || '/sdcard');
  }

  function closeExplorer() {
    $('pdfExplorerModal').style.display = 'none';
    explorer.onConfirm = null;
  }

  async function loadDirectory(dirPath) {
    const loading = $('pdfExplorerLoading');
    const errorBanner = $('pdfExplorerError');
    const list = $('pdfExplorerList');

    loading.style.display = 'flex';
    errorBanner.style.display = 'none';
    list.innerHTML = '';

    try {
      const response = await fetch(`/api/browse?dir=${encodeURIComponent(dirPath)}&kind=${encodeURIComponent(explorer.kind)}`);
      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Could not read this folder.');
      }

      explorer.currentDir = data.currentDir;
      explorer.parentDir = data.parentDir || null;
      explorer.allowedRoots = Array.isArray(data.allowedRoots) ? data.allowedRoots : [];
      explorer.items = Array.isArray(data.items) ? data.items : [];

      loading.style.display = 'none';

      if (data.error) {
        errorBanner.style.display = 'block';
        errorBanner.textContent = data.error;
      }

      $('btnPdfExplorerUp').disabled = !explorer.parentDir;
      renderExplorerBreadcrumbs(explorer.currentDir);
      renderExplorerList();
    } catch (err) {
      loading.style.display = 'none';
      errorBanner.style.display = 'block';
      errorBanner.textContent = err.message;
      showToast(err.message, 'error');
    }
  }

  function renderExplorerBreadcrumbs(currentPath) {
    const container = $('pdfExplorerBreadcrumbs');
    container.innerHTML = '';

    const normalized = String(currentPath || '/').replace(/\/+/g, '/');
    const parts = normalized.split('/').filter(Boolean);

    const root = document.createElement('span');
    root.className = parts.length === 0 ? 'crumb active' : 'crumb';
    root.textContent = '/';
    root.addEventListener('click', () => {
      loadDirectory(explorer.allowedRoots[0] || '/sdcard');
    });
    container.appendChild(root);

    let accumulated = '';
    parts.forEach((part, index) => {
      accumulated += '/' + part;

      const separator = document.createElement('span');
      separator.className = 'crumb-sep';
      separator.textContent = '/';
      container.appendChild(separator);

      const crumb = document.createElement('span');
      crumb.className = index === parts.length - 1 ? 'crumb active' : 'crumb';
      crumb.textContent = part;
      if (index !== parts.length - 1) {
        crumb.addEventListener('click', () => loadDirectory(accumulated));
      }
      container.appendChild(crumb);
    });
  }

  function explorerIcon(kind) {
    const span = document.createElement('span');
    span.className = 'explorer-item-icon';
    span.style.display = 'inline-flex';
    span.style.width = '18px';
    span.style.height = '18px';
    span.innerHTML = kind === 'folder' ? ICONS.folder : (kind === 'image' ? ICONS.image : ICONS.pdf);
    const svg = span.querySelector('svg');
    if (svg) {
      svg.style.width = '18px';
      svg.style.height = '18px';
    }
    return span;
  }

  function explorerSelectionIndex(filePath) {
    return explorer.selected.findIndex((item) => item.path === filePath);
  }

  function selectExplorerItem(item) {
    const index = explorerSelectionIndex(item.path);

    if (explorer.mode === 'single') {
      explorer.selected = [item];
    } else if (index >= 0) {
      explorer.selected.splice(index, 1);
    } else {
      explorer.selected.push(item);
    }

    renderExplorerList();
  }

  function updateExplorerFooter() {
    const confirm = $('btnPdfExplorerConfirm');
    const hint = $('pdfExplorerHint');
    const count = explorer.selected.length;
    const noun = explorer.kind === 'image' ? 'image' : 'PDF';

    confirm.disabled = count === 0;
    if (explorer.mode === 'multi') {
      confirm.textContent = count > 0 ? `Use ${count} file${count === 1 ? '' : 's'}` : 'Use selected';
      hint.textContent = count > 0
        ? `${count} file${count === 1 ? '' : 's'} selected. Tap again to remove.`
        : `Tap ${noun} files to select them.`;
    } else {
      confirm.textContent = 'Select file';
      hint.textContent = count > 0
        ? `Selected: ${baseName(explorer.selected[0].path)}`
        : `Tap a ${noun} file to select it.`;
    }
  }

  function renderExplorerList() {
    const list = $('pdfExplorerList');
    const query = $('pdfExplorerSearch').value.trim().toLowerCase();
    list.innerHTML = '';

    const items = explorer.items.filter((item) => !query || item.name.toLowerCase().includes(query));

    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'file-stack-empty';
      empty.textContent = query ? 'No matching files in this folder.' : 'This folder has no matching files.';
      list.appendChild(empty);
      updateExplorerFooter();
      return;
    }

    items.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'explorer-row';

      const left = document.createElement('div');
      left.className = 'explorer-left';

      const icon = explorerIcon(item.isDirectory ? 'folder' : (item.fileKind || explorer.kind));
      const name = document.createElement('span');
      name.className = 'explorer-item-name';
      name.textContent = item.name;
      left.append(icon, name);

      const right = document.createElement('div');
      right.className = 'explorer-right';

      if (!item.isDirectory) {
        if (item.ext) {
          const ext = document.createElement('span');
          ext.className = 'meta-pill-sm';
          ext.textContent = item.ext;
          right.appendChild(ext);
        }
        if (item.sizeFormatted) {
          const size = document.createElement('span');
          size.textContent = item.sizeFormatted;
          right.appendChild(size);
        }

        const selectedIndex = explorerSelectionIndex(item.path);
        if (selectedIndex >= 0) {
          row.classList.add('selected');
          const order = document.createElement('span');
          order.className = 'explorer-order';
          order.textContent = String(selectedIndex + 1);
          right.appendChild(order);
        }
      } else {
        const arrow = document.createElement('span');
        arrow.textContent = '›';
        right.appendChild(arrow);
      }

      row.append(left, right);
      row.addEventListener('click', () => {
        if (item.isDirectory) {
          loadDirectory(item.path);
        } else if (explorer.mode === 'single') {
          explorer.selected = [item];
          confirmExplorerSelection();
        } else {
          selectExplorerItem(item);
        }
      });

      row.addEventListener('dblclick', () => {
        if (!item.isDirectory && explorer.mode === 'multi') {
          if (explorerSelectionIndex(item.path) < 0) {
            explorer.selected.push(item);
          }
          confirmExplorerSelection();
        }
      });

      list.appendChild(row);
    });

    updateExplorerFooter();
  }

  function confirmExplorerSelection() {
    if (explorer.selected.length === 0) return;
    const paths = explorer.selected.map((item) => item.path);
    const callback = explorer.onConfirm;
    closeExplorer();
    if (callback) callback(paths);
  }

  function switchTool(tool) {
    const panel = $('panel-' + tool);
    if (!panel) return;

    document.querySelectorAll('.content-panel').forEach((section) => {
      section.classList.toggle('active', section === panel);
    });

    document.querySelectorAll('#pdfToolNav .nav-item').forEach((button) => {
      button.classList.toggle('active', button.dataset.tool === tool);
    });

    $('pdfToolNav').classList.remove('open');

    try {
      history.replaceState(null, '', '#' + tool.trim());
    } catch (err) {}
  }

  let pdfQueuePollTimer = null;

  function renderPdfQueueResult(container, queueInfo, onCancel) {
    if (!container) return;
    const shell = resultShell(container, { badge: 'In Queue', meta: 'Waiting for active tasks to complete' });
    const status = document.createElement('div');
    status.style.display = 'flex';
    status.style.flexDirection = 'column';
    status.style.alignItems = 'flex-start';
    status.style.gap = '10px';
    status.style.padding = '14px 16px';

    const rowTop = document.createElement('div');
    rowTop.style.display = 'flex';
    rowTop.style.alignItems = 'center';
    rowTop.style.gap = '10px';

    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    const label = document.createElement('strong');
    label.id = 'pdfQueueTitle';
    const pos = queueInfo.queuePosition || 1;
    label.textContent = `Aapki file Queue me hai (Aage ${pos} file baaki hai)`;
    rowTop.append(spinner, label);

    const desc = document.createElement('div');
    desc.id = 'pdfQueueDesc';
    desc.style.fontSize = '13px';
    desc.style.color = 'var(--text-muted, #94a3b8)';
    desc.textContent = `Server abhi ${queueInfo.activeJobName || 'doosra task'} process kar raha hai. Jaise hi complete hoga, automatically start hoga!`;

    const countdownRow = document.createElement('div');
    countdownRow.style.display = 'flex';
    countdownRow.style.alignItems = 'center';
    countdownRow.style.gap = '12px';
    countdownRow.style.fontSize = '12px';

    const cdText = document.createElement('span');
    cdText.id = 'pdfQueueCountdown';
    cdText.style.color = 'var(--accent, #38bdf8)';
    cdText.textContent = 'Live checking status in 3s...';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn btn-ghost btn-sm';
    cancelBtn.style.padding = '4px 10px';
    cancelBtn.style.fontSize = '12px';
    cancelBtn.style.color = '#ef4444';
    cancelBtn.textContent = 'Cancel Queue';
    cancelBtn.onclick = onCancel;

    countdownRow.append(cdText, cancelBtn);
    status.append(rowTop, desc, countdownRow);
    shell.body.appendChild(status);
  }

  async function runPdfActionWithQueue(result, button, busyLabel, executeFn) {
    try {
      hideResult(result);
      setBusy(button, true, busyLabel);
      await executeFn();
    } catch (err) {
      if (err.busy) {
        startPdfAutoQueue(result, button, busyLabel, err.data || {}, executeFn);
        return;
      }
      renderError(result, err.message);
      showToast(err.message, 'error');
      setBusy(button, false);
    }
  }

  function startPdfAutoQueue(result, button, busyLabel, busyData, executeFn) {
    if (pdfQueuePollTimer) clearInterval(pdfQueuePollTimer);
    let secondsLeft = 3;
    let cancelled = false;

    setBusy(button, true, 'In Queue…');

    const stopQueue = () => {
      cancelled = true;
      if (pdfQueuePollTimer) {
        clearInterval(pdfQueuePollTimer);
        pdfQueuePollTimer = null;
      }
      document.removeEventListener('visibilitychange', onVisibilityChange);
      setBusy(button, false);
      showToast('Queue wait cancelled.', 'warning');
      renderError(result, 'Queue wait cancelled by user.');
    };

    const executeTask = async () => {
      if (cancelled) return;
      if (pdfQueuePollTimer) {
        clearInterval(pdfQueuePollTimer);
        pdfQueuePollTimer = null;
      }
      document.removeEventListener('visibilitychange', onVisibilityChange);
      showToast('Aapka number aa gaya! Starting PDF operation...', 'success');
      setBusy(button, true, busyLabel);

      try {
        await executeFn();
      } catch (execErr) {
        if (execErr.busy) {
          startPdfAutoQueue(result, button, busyLabel, execErr.data || {}, executeFn);
          return;
        }
        renderError(result, execErr.message);
        showToast(execErr.message, 'error');
      } finally {
        setBusy(button, false);
      }
    };

    const checkQueueNow = async () => {
      if (cancelled) return;
      try {
        const res = await fetch('/api/queue/status');
        if (!res.ok) return;
        const qStatus = await res.json();
        if (cancelled) return;

        if (qStatus.isIdle) {
          await executeTask();
        } else {
          const titleEl = $('pdfQueueTitle');
          const descEl = $('pdfQueueDesc');
          const pos = (qStatus.queuedCount || 0) + (qStatus.locks?.media ? 1 : 0);
          if (titleEl) titleEl.textContent = `Aapki file Queue me hai (Aage ${pos || 1} file baaki hai)`;
          if (descEl && qStatus.activeJobInfo) descEl.textContent = `Server abhi ${qStatus.activeJobInfo} process kar raha hai. Jaise hi complete hoga, automatically start hoga!`;
        }
      } catch (pollErr) {
        console.warn('[PDF Queue Poll] error:', pollErr.message);
      }
    };

    const onVisibilityChange = () => {
      if (!document.hidden && !cancelled) {
        checkQueueNow();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    renderPdfQueueResult(result, {
      queuePosition: busyData.queuePosition || 1,
      activeJobName: busyData.activeJobName || 'video task'
    }, stopQueue);

    pdfQueuePollTimer = setInterval(async () => {
      if (cancelled) return;
      secondsLeft--;
      const cdEl = $('pdfQueueCountdown');
      if (cdEl) cdEl.textContent = `Live checking in ${secondsLeft}s...`;

      if (secondsLeft <= 0) {
        secondsLeft = 3;
        await checkQueueNow();
      }
    }, 1000);
  }

  async function runUnlock() {
    const button = $('btnUnlockRun');
    const result = $('unlockResult');
    try {
      const inputPath = readSinglePath('unlockPath', 'pdf', 'PDF file');
      await runPdfActionWithQueue(result, button, 'Removing password…', async () => {
        const data = await postJson('/api/pdf/unlock', {
          inputPath,
          password: $('unlockPassword').value,
          outputDir: $('unlockOutDir').value.trim(),
          isRemoteUpload: isPdfRemoteMode()
        });
        renderResult(result, data);
        savePdfLastResult(result.id, data);
        showToast(data.message || 'Password removed.', 'success');
        setBusy(button, false);
      });
    } catch (err) {
      renderError(result, err.message);
      showToast(err.message, 'error');
      setBusy(button, false);
    }
  }

  async function runMerge() {
    const button = $('btnMergeRun');
    const result = $('mergeResult');
    try {
      if (mergePaths.length < 2) {
        throw new Error('Add at least two PDF files to merge.');
      }
      await runPdfActionWithQueue(result, button, 'Merging…', async () => {
        const data = await postJson('/api/pdf/merge', {
          inputPaths: mergePaths.slice(),
          outputDir: $('mergeOutDir').value.trim(),
          isRemoteUpload: isPdfRemoteMode()
        });
        renderResult(result, data);
        savePdfLastResult(result.id, data);
        showToast(data.message || 'PDFs merged.', 'success');
        setBusy(button, false);
      });
    } catch (err) {
      renderError(result, err.message);
      showToast(err.message, 'error');
      setBusy(button, false);
    }
  }

  async function runCompress() {
    const button = $('btnCompressRun');
    const result = $('compressResult');
    try {
      const inputPath = readSinglePath('compressPath', 'pdf', 'PDF file');
      await runPdfActionWithQueue(result, button, 'Compressing…', async () => {
        const data = await postJson('/api/pdf/compress', {
          inputPath,
          level: $('compressLevel').value,
          outputDir: $('compressOutDir').value.trim(),
          isRemoteUpload: isPdfRemoteMode()
        });
        renderResult(result, data);
        savePdfLastResult(result.id, data);
        showToast(data.message || 'PDF compressed.', 'success');
        setBusy(button, false);
      });
    } catch (err) {
      renderError(result, err.message);
      showToast(err.message, 'error');
      setBusy(button, false);
    }
  }

  async function runSplit() {
    const button = $('btnSplitRun');
    const result = $('splitResult');
    try {
      const inputPath = readSinglePath('splitPath', 'pdf', 'PDF file');
      const pages = $('splitPages').value.trim();
      if (!pages) {
        throw new Error('Enter a page range such as 1-5, 8, 10-12.');
      }
      await runPdfActionWithQueue(result, button, 'Extracting…', async () => {
        const data = await postJson('/api/pdf/split', {
          inputPath,
          pages,
          outputDir: $('splitOutDir').value.trim(),
          isRemoteUpload: isPdfRemoteMode()
        });
        renderResult(result, data);
        savePdfLastResult(result.id, data);
        showToast(data.message || 'Pages extracted.', 'success');
        setBusy(button, false);
      });
    } catch (err) {
      renderError(result, err.message);
      showToast(err.message, 'error');
      setBusy(button, false);
    }
  }

  async function runRotate() {
    const button = $('btnRotateRun');
    const result = $('rotateResult');
    try {
      const inputPath = readSinglePath('rotatePath', 'pdf', 'PDF file');
      await runPdfActionWithQueue(result, button, 'Rotating…', async () => {
        const data = await postJson('/api/pdf/rotate', {
          inputPath,
          angle: rotateAngle,
          outputDir: $('rotateOutDir').value.trim(),
          isRemoteUpload: isPdfRemoteMode()
        });
        renderResult(result, data);
        savePdfLastResult(result.id, data);
        showToast(data.message || 'PDF rotated.', 'success');
        setBusy(button, false);
      });
    } catch (err) {
      renderError(result, err.message);
      showToast(err.message, 'error');
      setBusy(button, false);
    }
  }

  async function runImagesToPdf() {
    const button = $('btnImagesRun');
    const result = $('imagesResult');
    try {
      if (imagePaths.length < 1) {
        throw new Error('Add at least one JPG or PNG image.');
      }
      await runPdfActionWithQueue(result, button, 'Creating PDF…', async () => {
        const data = await postJson('/api/pdf/images-to-pdf', {
          imagePaths: imagePaths.slice(),
          outputDir: $('imageOutDir').value.trim(),
          isRemoteUpload: isPdfRemoteMode()
        });
        renderResult(result, data);
        savePdfLastResult(result.id, data);
        showToast(data.message || 'PDF created.', 'success');
        setBusy(button, false);
      });
    } catch (err) {
      renderError(result, err.message);
      showToast(err.message, 'error');
      setBusy(button, false);
    }
  }

  async function runPdfToImages() {
    const button = $('btnToImagesRun');
    const result = $('toImagesResult');
    try {
      const inputPath = readSinglePath('toImagesPath', 'pdf', 'PDF file');
      await runPdfActionWithQueue(result, button, 'Exporting pages…', async () => {
        const data = await postJson('/api/pdf/pdf-to-images', {
          inputPath,
          outputDir: $('toImagesOutDir').value.trim(),
          dpi: $('toImagesDpi').value,
          firstPage: $('toImagesFirst').value.trim() || undefined,
          lastPage: $('toImagesLast').value.trim() || undefined,
          isRemoteUpload: isPdfRemoteMode()
        });
        renderResult(result, data);
        savePdfLastResult(result.id, data);
        showToast(data.message || 'Pages exported.', 'success');
        setBusy(button, false);
      });
    } catch (err) {
      renderError(result, err.message);
      showToast(err.message, 'error');
      setBusy(button, false);
    }
  }

  function bindTheme() {
    const toggle = $('themeToggle');
    const root = document.documentElement;
    if (!toggle) return;
    toggle.addEventListener('click', () => {
      const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try {
        localStorage.setItem('ffstudio-theme', next);
      } catch (err) {}
    });
  }

  function bindNavigation() {
    document.querySelectorAll('#pdfToolNav .nav-item').forEach((button) => {
      button.addEventListener('click', () => switchTool(button.dataset.tool));
    });

    $('btnMobileMenu').addEventListener('click', () => {
      $('pdfToolNav').classList.toggle('open');
    });

    const hashTool = window.location.hash.replace('#', '').trim();
    if (['unlock', 'merge', 'split', 'rotate', 'compress', 'images', 'toimages'].includes(hashTool)) {
      switchTool(hashTool);
    }
  }

  function bindUnlock() {
    $('btnUnlockBrowse').addEventListener('click', () => {
      openExplorer({
        kind: 'pdf',
        mode: 'single',
        title: 'Select a protected PDF',
        onConfirm: (paths) => {
          $('unlockPath').value = paths[0] || '';
        }
      });
    });

    $('btnUnlockClear').addEventListener('click', () => {
      $('unlockPath').value = '';
      $('unlockPassword').value = '';
      hideResult($('unlockResult'));
    });

    $('unlockPath').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') runUnlock();
    });

    $('btnUnlockRun').addEventListener('click', runUnlock);
  }

  function bindMerge() {
    $('btnMergeBrowse').addEventListener('click', () => {
      openExplorer({
        kind: 'pdf',
        mode: 'multi',
        title: 'Select PDFs to merge',
        onConfirm: (paths) => addMergePaths(paths)
      });
    });

    $('btnMergeAddPath').addEventListener('click', () => addPathFromInput('mergePathInput', 'pdf'));
    $('mergePathInput').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') addPathFromInput('mergePathInput', 'pdf');
    });

    $('btnMergeRun').addEventListener('click', runMerge);
    $('btnMergeClearAll')?.addEventListener('click', () => {
      mergePaths.length = 0;
      renderMergeList();
      showToast('Merge list cleared.', 'info');
    });
    renderMergeList();
  }

  function bindCompress() {
    $('btnCompressBrowse').addEventListener('click', () => {
      openExplorer({
        kind: 'pdf',
        mode: 'single',
        title: 'Select a PDF to compress',
        onConfirm: (paths) => {
          $('compressPath').value = paths[0] || '';
        }
      });
    });

    $('btnCompressClear').addEventListener('click', () => {
      $('compressPath').value = '';
      hideResult($('compressResult'));
    });

    $('compressPath').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') runCompress();
    });

    $('btnCompressRun').addEventListener('click', runCompress);
  }

  function bindSplit() {
    $('btnSplitBrowse').addEventListener('click', () => {
      openExplorer({
        kind: 'pdf',
        mode: 'single',
        title: 'Select a PDF to split',
        onConfirm: (paths) => {
          $('splitPath').value = paths[0] || '';
        }
      });
    });

    $('btnSplitClear').addEventListener('click', () => {
      $('splitPath').value = '';
      $('splitPages').value = '';
      hideResult($('splitResult'));
    });

    document.querySelectorAll('[data-split-range]').forEach((button) => {
      button.addEventListener('click', () => {
        $('splitPages').value = button.dataset.splitRange || '';
        $('splitPages').focus();
      });
    });

    $('splitPath').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') runSplit();
    });

    $('splitPages').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') runSplit();
    });

    $('btnSplitRun').addEventListener('click', runSplit);
  }

  function setRotateAngle(angle) {
    rotateAngle = angle;
    document.querySelectorAll('#rotateOptions .rotate-option').forEach((button) => {
      const active = Number(button.dataset.angle) === angle;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function bindRotate() {
    $('btnRotateBrowse').addEventListener('click', () => {
      openExplorer({
        kind: 'pdf',
        mode: 'single',
        title: 'Select a PDF to rotate',
        onConfirm: (paths) => {
          $('rotatePath').value = paths[0] || '';
        }
      });
    });

    $('btnRotateClear').addEventListener('click', () => {
      $('rotatePath').value = '';
      hideResult($('rotateResult'));
    });

    document.querySelectorAll('#rotateOptions .rotate-option').forEach((button) => {
      button.addEventListener('click', () => setRotateAngle(Number(button.dataset.angle) || 90));
    });

    $('rotatePath').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') runRotate();
    });

    $('btnRotateRun').addEventListener('click', runRotate);
    setRotateAngle(90);
  }

  async function loadPdfCapabilities() {
    const hint = $('compressEngineHint');
    if (!hint) return;
    try {
      const response = await fetch('/api/pdf/capabilities');
      if (!response.ok) return;
      const data = await response.json();
      if (!data.success || !data.tools) return;

      hint.classList.remove('hint-warning');
      if (!data.tools.qpdf) {
        hint.classList.add('hint-warning');
        hint.textContent = data.tools.ghostscript
          ? 'qpdf is not installed. Ghostscript will handle compression. Run: pkg install qpdf'
          : 'qpdf and Ghostscript are missing. Run: pkg install qpdf ghostscript';
      } else if (!data.tools.ghostscript) {
        hint.classList.add('hint-warning');
        hint.textContent = 'Ghostscript is not installed. qpdf lossless optimization will still run. For stronger compression run: pkg install ghostscript';
      } else {
        hint.textContent = 'qpdf and Ghostscript are available. The smaller of the two outputs is kept automatically.';
      }
    } catch (err) {}
  }

  function bindImages() {
    $('btnImageBrowse').addEventListener('click', () => {
      openExplorer({
        kind: 'image',
        mode: 'multi',
        title: 'Select JPG or PNG images',
        onConfirm: (paths) => addImagePaths(paths)
      });
    });

    $('btnImageAddPath').addEventListener('click', () => addPathFromInput('imagePathInput', 'image'));
    $('imagePathInput').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') addPathFromInput('imagePathInput', 'image');
    });

    $('btnImagesRun').addEventListener('click', runImagesToPdf);
    $('btnImageClearAll')?.addEventListener('click', () => {
      imagePaths.length = 0;
      renderImageList();
      showToast('Image list cleared.', 'info');
    });
    renderImageList();
  }

  function bindPdfToImages() {
    $('btnToImagesBrowse').addEventListener('click', () => {
      openExplorer({
        kind: 'pdf',
        mode: 'single',
        title: 'Select a PDF to export',
        onConfirm: (paths) => {
          $('toImagesPath').value = paths[0] || '';
        }
      });
    });

    $('btnToImagesClear').addEventListener('click', () => {
      $('toImagesPath').value = '';
      $('toImagesFirst').value = '';
      $('toImagesLast').value = '';
      hideResult($('toImagesResult'));
    });

    $('toImagesPath').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') runPdfToImages();
    });

    $('btnToImagesRun').addEventListener('click', runPdfToImages);
  }

  function bindExplorer() {
    $('btnPdfExplorerClose').addEventListener('click', closeExplorer);
    $('btnPdfExplorerCancel').addEventListener('click', closeExplorer);
    $('btnPdfExplorerConfirm').addEventListener('click', confirmExplorerSelection);
    $('btnPdfExplorerRefresh').addEventListener('click', () => loadDirectory(explorer.currentDir || '/sdcard'));
    $('btnPdfExplorerUp').addEventListener('click', () => {
      if (explorer.parentDir) loadDirectory(explorer.parentDir);
    });

    $('pdfExplorerModal').addEventListener('click', (event) => {
      if (event.target === $('pdfExplorerModal')) closeExplorer();
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && $('pdfExplorerModal').style.display !== 'none') {
        closeExplorer();
      }
    });

    document.querySelectorAll('#pdfExplorerModal .mini-shortcut').forEach((button) => {
      button.addEventListener('click', () => loadDirectory(button.dataset.path));
    });

    $('pdfExplorerSearch').addEventListener('input', () => {
      const query = $('pdfExplorerSearch').value.trim();
      $('btnPdfExplorerClearSearch').style.display = query ? 'block' : 'none';
      renderExplorerList();
    });

    $('btnPdfExplorerClearSearch').addEventListener('click', () => {
      $('pdfExplorerSearch').value = '';
      $('btnPdfExplorerClearSearch').style.display = 'none';
      renderExplorerList();
      $('pdfExplorerSearch').focus();
    });
  }

  bindTheme();
  bindNavigation();
  bindUnlock();
  bindMerge();
  bindCompress();
  bindSplit();
  bindRotate();
  bindImages();
  bindPdfToImages();
  bindExplorer();
  initPdfStorageModeAndUploads();
  recoverPdfLastResult();
  loadPdfCapabilities();
})();
