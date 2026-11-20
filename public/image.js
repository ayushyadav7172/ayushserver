(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const SUPPORTED_EXTS = /\.(jpe?g|png|webp|avif|tif|tiff)$/i;
  const MAX_DIMENSION = 20000;

  const ICONS = {
    folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>',
    image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>'
  };

  const state = {
    paths: [],
    info: new Map(),
    activePath: null,
    activeTool: 'convert',
    compressMode: 'percent',
    resizeMode: 'dimensions',
    actualTotal: null,
    busy: false
  };

  const explorer = {
    mode: 'multi',
    selected: [],
    items: [],
    currentDir: '',
    parentDir: null,
    allowedRoots: [],
    onConfirm: null
  };

  function baseName(filePath) {
    const normalized = String(filePath || '').replace(/\/+$/, '');
    const index = normalized.lastIndexOf('/');
    return index >= 0 ? normalized.slice(index + 1) : normalized;
  }

  function extOf(filePath) {
    const match = String(filePath || '').match(/\.([A-Za-z0-9]+)$/);
    return match ? match[1].toUpperCase() : 'IMG';
  }

  function normalizeInputPath(value) {
    let raw = String(value || '').trim();
    if (/^file:\/\//i.test(raw)) raw = raw.replace(/^file:\/\//i, '');
    return raw;
  }

  function isImagePath(filePath) {
    return SUPPORTED_EXTS.test(normalizeInputPath(filePath));
  }

  function imageUrl(filePath, download) {
    const raw = `/api/image/preview?path=${encodeURIComponent(filePath)}${download ? '&download=1' : ''}`;
    return window.appendStudioToken ? window.appendStudioToken(raw) : raw;
  }

  function formatBytes(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value < 0) return '—';
    if (value === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
    const size = value / Math.pow(1024, index);
    const rounded = index === 0 || size >= 100 ? Math.round(size) : Math.round(size * 10) / 10;
    return `${rounded} ${units[index]}`;
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
    }, 4200);
    setTimeout(() => toast.remove(), 4600);
  }

  function setBusy(button, busy, label) {
    if (!button) return;
    if (busy) {
      if (!button.dataset.idleText) button.dataset.idleText = button.textContent;
      button.disabled = true;
      button.textContent = label || 'Working…';
    } else {
      button.disabled = false;
      if (button.dataset.idleText) button.textContent = button.dataset.idleText;
    }
  }

  function getOrCreateSessionId() {
    let sid = null;
    try {
      sid = localStorage.getItem('ffstudio_session_id');
      if (!sid) {
        sid = 'sess_' + Date.now() + '_' + Math.random().toString(36).substring(2, 10);
        localStorage.setItem('ffstudio_session_id', sid);
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
      data = { error: raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 220) };
    }

    if (!response.ok || data.success === false) {
      throw new Error(data.error || `Request failed (${response.status})`);
    }
    return data;
  }

  function selectedInfos() {
    return state.paths
      .map((filePath) => state.info.get(filePath))
      .filter((info) => info && info.success && Number(info.size) > 0);
  }

  function knownOriginalTotal() {
    return state.paths.reduce((sum, filePath) => {
      const info = state.info.get(filePath);
      return sum + (info && Number(info.size) > 0 ? Number(info.size) : 0);
    }, 0);
  }

  function targetBytesFromInputs() {
    const amount = Number($('compressTargetValue').value);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const unit = $('compressTargetUnit').value === 'MB' ? 1024 * 1024 : 1024;
    return Math.round(amount * unit);
  }

  function estimateConversion(info, format, quality) {
    const sourceFormat = String(info.format || '').toLowerCase();
    const qualityFactor = Math.pow(Math.max(1, Math.min(100, quality)) / 85, 1.7);
    if (format === 'png') {
      if (sourceFormat === 'png') return info.size * 0.92;
      return info.size * 1.35;
    }
    if (format === 'jpeg') {
      if (sourceFormat === 'jpeg') return info.size * qualityFactor;
      return info.size * 0.68 * qualityFactor;
    }
    if (format === 'webp') return info.size * 0.56 * qualityFactor;
    if (format === 'avif') return info.size * 0.44 * qualityFactor;
    return info.size;
  }

  function computeEstimatedBytes() {
    const infos = selectedInfos();
    if (infos.length === 0) return null;

    if (state.activeTool === 'convert') {
      const format = $('convertFormat').value;
      const quality = Number($('convertQuality').value) || 85;
      return infos.reduce((sum, info) => sum + estimateConversion(info, format, quality), 0);
    }

    if (state.activeTool === 'compress') {
      if (state.compressMode === 'percent') {
        const percent = Number($('compressPercent').value) || 50;
        return infos.reduce((sum, info) => sum + info.size * (percent / 100), 0);
      }
      const targetBytes = targetBytesFromInputs();
      if (!targetBytes) return null;
      return infos.reduce((sum, info) => sum + Math.min(targetBytes, info.size), 0);
    }

    if (state.activeTool === 'resize') {
      if (state.resizeMode === 'percent') {
        const factor = (Number($('resizePercent').value) || 50) / 100;
        return infos.reduce((sum, info) => sum + info.size * factor * factor, 0);
      }
      const width = Number($('resizeWidth').value) || 0;
      const height = Number($('resizeHeight').value) || 0;
      if (!width && !height) return null;
      return infos.reduce((sum, info) => {
        if (!info.width || !info.height) return sum;
        let ratio = 1;
        if (width && height) ratio = Math.min(1, width / info.width, height / info.height);
        else if (width) ratio = Math.min(1, width / info.width);
        else ratio = Math.min(1, height / info.height);
        return sum + info.size * ratio * ratio;
      }, 0);
    }

    return null;
  }

  function syncSizeStrip() {
    const originalTotal = knownOriginalTotal();
    $('originalSizeValue').textContent = originalTotal > 0 ? formatBytes(originalTotal) : '—';

    const formats = Array.from(new Set(state.paths.map(extOf)));
    $('sourceFormatValue').textContent = formats.length === 0
      ? '—'
      : (formats.length === 1 ? formats[0] : `${formats.length} formats`);

    const estimate = computeEstimatedBytes();
    $('estimatedSizeValue').textContent = estimate ? `~${formatBytes(estimate)}` : '—';

    const actualValue = $('actualSizeValue');
    actualValue.textContent = state.actualTotal === null ? '—' : formatBytes(state.actualTotal);
    actualValue.classList.toggle('is-success', state.actualTotal !== null);
  }

  function setHint(id, text, warning) {
    const element = $(id);
    if (!element) return;
    element.textContent = text;
    element.classList.toggle('hint-warning', Boolean(warning));
  }

  function refreshEstimate(resetActual) {
    if (resetActual) state.actualTotal = null;
    syncSizeStrip();

    if (state.paths.length === 0) {
      setHint('convertEstimateHint', 'Select images to see an estimate.');
      setHint('compressEstimateHint', 'Select images to see an estimate.');
      setHint('resizeEstimateHint', 'Select images to see an estimate.');
      return;
    }

    const estimate = computeEstimatedBytes();
    const count = state.paths.length;
    const noun = `${count} image${count === 1 ? '' : 's'}`;

    if (state.activeTool === 'convert') {
      setHint(
        'convertEstimateHint',
        estimate
          ? `Estimated output ≈ ${formatBytes(estimate)} for ${noun}. Format conversion runs entirely on-device.`
          : 'Waiting for image details…'
      );
    }

    if (state.activeTool === 'compress') {
      if (state.compressMode === 'percent') {
        setHint(
          'compressEstimateHint',
          estimate
            ? `Estimated total ≈ ${formatBytes(estimate)} · ${$('compressPercentValue').textContent} of the original size.`
            : 'Waiting for image details…'
        );
      } else {
        const targetBytes = targetBytesFromInputs();
        setHint(
          'compressEstimateHint',
          targetBytes && estimate
            ? `Estimated total ≈ ${formatBytes(estimate)} · capped near ${formatBytes(targetBytes)} per image.`
            : 'Enter a valid target size to see an estimate.',
          !targetBytes
        );
      }
    }

    if (state.activeTool === 'resize') {
      if (state.resizeMode === 'percent') {
        setHint(
          'resizeEstimateHint',
          estimate
            ? `Estimated output ≈ ${formatBytes(estimate)} · ${$('resizePercentValue').textContent} scale.`
            : 'Waiting for image details…'
        );
      } else {
        const hasSize = $('resizeWidth').value.trim() || $('resizeHeight').value.trim();
        setHint(
          'resizeEstimateHint',
          hasSize && estimate
            ? `Estimated output ≈ ${formatBytes(estimate)} · aspect ratio preserved.`
            : 'Enter a width or height to see an estimate.',
          !hasSize
        );
      }
    }
  }

  function previewPathFor(filePath) {
    const info = state.info.get(filePath);
    return info && info.serverPath ? info.serverPath : filePath;
  }

  function setPreviewEmptyText(text) {
    const empty = $('imagePreviewEmpty');
    const label = empty ? empty.querySelector('span') : null;
    if (label) label.textContent = text;
  }

  function renderPreview() {
    const img = $('imagePreviewImg');
    const empty = $('imagePreviewEmpty');
    const name = $('imagePreviewName');
    const meta = $('imagePreviewMeta');

    if (!state.activePath) {
      img.style.display = 'none';
      img.removeAttribute('src');
      img.onerror = null;
      empty.style.display = 'flex';
      setPreviewEmptyText('Your preview appears here');
      name.textContent = 'No image selected';
      meta.textContent = 'JPG · PNG · WebP · AVIF · TIFF';
      return;
    }

    const info = state.info.get(state.activePath) || {};
    name.textContent = baseName(state.activePath);

    if (info.pending) {
      img.style.display = 'none';
      img.removeAttribute('src');
      empty.style.display = 'flex';
      setPreviewEmptyText('Loading preview…');
      meta.textContent = 'Reading image details';
      return;
    }

    if (!info.success) {
      img.style.display = 'none';
      img.removeAttribute('src');
      empty.style.display = 'flex';
      setPreviewEmptyText('Preview unavailable');
      meta.textContent = info.error || 'This file could not be read.';
      return;
    }

    const parts = [extOf(state.activePath)];
    if (info.width && info.height) parts.push(`${info.width} × ${info.height}px`);
    if (info.sizeFormatted) parts.push(info.sizeFormatted);
    if (info.hasExif) parts.push('EXIF present');
    meta.textContent = parts.join(' · ');

    img.onerror = () => {
      img.style.display = 'none';
      empty.style.display = 'flex';
      setPreviewEmptyText('Preview not available in this browser');
    };
    img.onload = () => {
      img.style.display = 'block';
      empty.style.display = 'none';
    };
    img.src = imageUrl(previewPathFor(state.activePath));
  }

  function renderQueue() {
    const list = $('imageList');
    list.innerHTML = '';

    $('imageCountBadge').textContent = `${state.paths.length} image${state.paths.length === 1 ? '' : 's'}`;

    if (state.paths.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'file-stack-empty';
      empty.textContent = 'No images selected yet. Browse phone storage or paste an absolute path.';
      list.appendChild(empty);
      renderPreview();
      refreshEstimate(false);
      return;
    }

    state.paths.forEach((filePath, index) => {
      const info = state.info.get(filePath) || {};
      const row = document.createElement('div');
      row.className = 'file-row image-file-row';
      if (filePath === state.activePath) row.classList.add('active');
      if (!info.pending && info.success === false) row.classList.add('is-invalid');

      const order = document.createElement('span');
      order.className = 'file-order-badge';
      order.textContent = String(index + 1);

      const thumb = document.createElement('span');
      thumb.className = 'image-file-thumb';
      if (info.success === false) {
        thumb.textContent = extOf(filePath);
      } else {
        const img = document.createElement('img');
        img.alt = '';
        img.loading = 'lazy';
        img.onerror = () => {
          img.remove();
          thumb.textContent = extOf(filePath);
        };
        img.src = imageUrl(previewPathFor(filePath));
        thumb.appendChild(img);
      }

      const infoBox = document.createElement('div');
      infoBox.className = 'image-file-info';

      const name = document.createElement('strong');
      name.textContent = baseName(filePath);

      const pathCode = document.createElement('code');
      pathCode.textContent = filePath;

      const metaRow = document.createElement('div');
      metaRow.className = 'image-file-meta';

      const extPill = document.createElement('span');
      extPill.className = 'meta-pill-sm';
      extPill.textContent = extOf(filePath);
      metaRow.appendChild(extPill);

      if (info.pending) {
        const pending = document.createElement('span');
        pending.className = 'hint';
        pending.textContent = 'Reading…';
        metaRow.appendChild(pending);
      } else if (info.success) {
        if (info.width && info.height) {
          const dims = document.createElement('span');
          dims.className = 'meta-pill-sm';
          dims.textContent = `${info.width}×${info.height}`;
          metaRow.appendChild(dims);
        }
        if (info.sizeFormatted) {
          const size = document.createElement('span');
          size.className = 'hint';
          size.textContent = info.sizeFormatted;
          metaRow.appendChild(size);
        }
        if (info.hasExif) {
          const exif = document.createElement('span');
          exif.className = 'meta-pill-sm';
          exif.textContent = 'EXIF';
          metaRow.appendChild(exif);
        }
      } else {
        const error = document.createElement('span');
        error.className = 'image-file-error';
        error.textContent = info.error || 'Unreadable image';
        metaRow.appendChild(error);
      }

      infoBox.append(name, pathCode, metaRow);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'file-mini-btn danger';
      remove.textContent = '×';
      remove.title = 'Remove from queue';
      remove.addEventListener('click', (event) => {
        event.stopPropagation();
        removePath(filePath);
      });

      row.append(order, thumb, infoBox, remove);
      row.addEventListener('click', () => {
        state.activePath = filePath;
        renderQueue();
      });
      list.appendChild(row);
    });

    renderPreview();
    refreshEstimate(false);
  }

  function removePath(filePath) {
    const index = state.paths.indexOf(filePath);
    if (index < 0) return;
    state.paths.splice(index, 1);
    state.info.delete(filePath);
    if (state.activePath === filePath) {
      state.activePath = state.paths[Math.min(index, state.paths.length - 1)] || null;
    }
    state.actualTotal = null;
    renderQueue();
  }

  function clearAll() {
    state.paths = [];
    state.info.clear();
    state.activePath = null;
    state.actualTotal = null;
    renderQueue();
    hideResult();
  }

  function addPaths(rawPaths) {
    const added = [];
    let skipped = 0;

    rawPaths.forEach((raw) => {
      const filePath = normalizeInputPath(raw);
      if (!filePath || !filePath.startsWith('/') || !isImagePath(filePath)) {
        skipped++;
        return;
      }
      if (state.paths.includes(filePath)) return;
      state.paths.push(filePath);
      state.info.set(filePath, { pending: true });
      added.push(filePath);
    });

    if (added.length > 0) {
      if (!state.activePath) state.activePath = added[0];
      state.actualTotal = null;
      renderQueue();
      inspectPaths(added);
      showToast(`Added ${added.length} image${added.length === 1 ? '' : 's'}.`, 'success');
    }

    if (skipped > 0) {
      showToast(`${skipped} file${skipped === 1 ? ' was' : 's were'} skipped. Use JPG, PNG, WebP, AVIF, or TIFF.`, 'warning');
    }
  }

  async function inspectPaths(paths) {
    if (!paths.length) return;
    paths.forEach((filePath) => {
      const current = state.info.get(filePath) || {};
      state.info.set(filePath, { ...current, pending: true });
    });
    renderQueue();

    try {
      const data = await postJson('/api/image/inspect', { paths });
      const results = Array.isArray(data.results) ? data.results : [];
      let failures = 0;
      let firstError = '';

      results.forEach((result, index) => {
        const requestedPath = paths[index] || result.path;
        if (result.success) {
          state.info.set(requestedPath, {
            ...result,
            success: true,
            pending: false,
            serverPath: result.path
          });
        } else {
          failures++;
          if (!firstError) firstError = result.error || 'Could not read this image.';
          state.info.set(requestedPath, {
            ...(state.info.get(requestedPath) || {}),
            success: false,
            pending: false,
            error: result.error || 'Could not read this image.'
          });
        }
      });

      paths.forEach((filePath) => {
        const info = state.info.get(filePath);
        if (info && info.pending) {
          failures++;
          if (!firstError) firstError = 'Could not read this image.';
          state.info.set(filePath, { ...info, pending: false, success: false, error: 'Could not read this image.' });
        }
      });

      renderQueue();
      if (failures > 0) {
        showToast(
          failures === 1 ? firstError : `${failures} images could not be read. ${firstError}`,
          'error'
        );
      }
    } catch (err) {
      paths.forEach((filePath) => {
        state.info.set(filePath, {
          ...(state.info.get(filePath) || {}),
          pending: false,
          success: false,
          error: err.message
        });
      });
      renderQueue();
      showToast(err.message, 'error');
    }
  }

  function addPathFromInput() {
    const raw = normalizeInputPath($('imagePathInput').value);
    if (!raw) {
      showToast('Enter an absolute image path first.', 'warning');
      return;
    }
    if (!raw.startsWith('/')) {
      showToast('Use an absolute path such as /sdcard/DCIM/Camera/photo.jpg.', 'warning');
      return;
    }
    if (!isImagePath(raw)) {
      showToast('That file is not a supported image (JPG, PNG, WebP, AVIF, TIFF).', 'warning');
      return;
    }
    addPaths([raw]);
    $('imagePathInput').value = '';
  }

  function hideResult() {
    const container = $('imageResult');
    if (!container) return;
    container.style.display = 'none';
    container.innerHTML = '';
    container.classList.remove('is-error');
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

  function makePill(text, className) {
    const pill = document.createElement('span');
    pill.className = className || 'meta-pill-sm';
    pill.textContent = text;
    return pill;
  }

  function renderRunningResult(count) {
    const shell = resultShell($('imageResult'), {
      badge: 'Processing',
      meta: 'sharp is working locally on this device'
    });
    const status = document.createElement('div');
    status.className = 'image-run-status';
    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    const label = document.createElement('span');
    label.textContent = `Processing ${count} image${count === 1 ? '' : 's'}…`;
    status.append(spinner, label);
    shell.body.appendChild(status);
  }

  function resultRow(result) {
    const row = document.createElement('div');
    row.className = 'image-result-row';

    if (!result.success) {
      row.classList.add('is-error');

      const thumb = document.createElement('span');
      thumb.className = 'image-result-thumb';
      thumb.textContent = extOf(result.inputPath);

      const info = document.createElement('div');
      info.className = 'image-result-info';
      const name = document.createElement('strong');
      name.textContent = result.inputFileName || baseName(result.inputPath);
      const pathCode = document.createElement('code');
      pathCode.textContent = result.inputPath || '';
      const error = document.createElement('div');
      error.className = 'image-file-error';
      error.style.whiteSpace = 'normal';
      error.textContent = result.error || 'Image processing failed.';
      info.append(name, pathCode, error);
      row.append(thumb, info);
      return row;
    }

    const thumb = document.createElement('span');
    thumb.className = 'image-result-thumb';
    thumb.textContent = extOf(result.outputPath) || 'IMG';
    if (result.previewUrl) {
      const img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.onerror = () => {
        img.remove();
        thumb.textContent = extOf(result.outputPath) || 'IMG';
      };
      img.src = result.previewUrl;
      thumb.appendChild(img);
    }

    const info = document.createElement('div');
    info.className = 'image-result-info';
    const name = document.createElement('strong');
    name.textContent = result.outputFileName || baseName(result.outputPath);
    const pathCode = document.createElement('code');
    pathCode.textContent = result.outputPath || '';
    info.append(name, pathCode);

    const stats = document.createElement('div');
    stats.className = 'image-result-stats';
    stats.appendChild(makePill(`${result.originalSizeFormatted} → ${result.sizeFormatted}`));

    const saved = Number(result.savedPercent) || 0;
    if (saved > 0) {
      stats.appendChild(makePill(`${saved}% smaller`, 'meta-pill-sm is-good'));
    } else if (saved < 0) {
      stats.appendChild(makePill(`${Math.abs(saved)}% larger`, 'meta-pill-sm is-worse'));
    } else {
      stats.appendChild(makePill('Same size'));
    }

    if (result.width && result.height) {
      stats.appendChild(makePill(`${result.width}×${result.height}`));
    }
    if (result.formatLabel) {
      stats.appendChild(makePill(result.formatLabel));
    }
    if (result.operation && result.operation.startsWith('compress')) {
      stats.appendChild(makePill(`${result.attempts} attempt${result.attempts === 1 ? '' : 's'}`));
    }
    if (result.stripMetadata) {
      stats.appendChild(makePill('EXIF removed'));
    }
    info.appendChild(stats);

    if (result.note) {
      const note = document.createElement('p');
      note.className = 'image-result-note';
      if (result.targetMet === false) note.classList.add('is-warning');
      note.textContent = result.note;
      info.appendChild(note);
    }

    const actions = document.createElement('div');
    actions.className = 'image-result-actions';

    const save = document.createElement('a');
    save.className = 'btn btn-download-prominent';
    save.href = result.downloadUrl;
    save.setAttribute('download', result.outputFileName || '');
    save.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>Download Result';
    actions.appendChild(save);

    const preview = document.createElement('a');
    preview.className = 'btn btn-ghost';
    preview.href = result.previewUrl;
    preview.target = '_blank';
    preview.rel = 'noopener';
    preview.textContent = 'Preview';
    actions.appendChild(preview);

    row.append(thumb, info, actions);
    return row;
  }

  function renderResults(data) {
    const results = Array.isArray(data.results) ? data.results : [];
    const successCount = results.filter((item) => item.success).length;
    const failed = results.length - successCount;
    const allFailed = successCount === 0 && failed > 0;

    let badge = 'Complete';
    if (allFailed) badge = 'Failed';
    else if (failed > 0) badge = 'Completed with errors';

    const shell = resultShell($('imageResult'), {
      badge,
      meta: data.message || `${successCount} image${successCount === 1 ? '' : 's'} processed.`,
      error: allFailed
    });

    if (successCount > 0) {
      if (isImageRemoteMode()) {
        const expiresAt = data.expiresAt || (Date.now() + 30 * 60 * 1000);
        data.expiresAt = expiresAt;
        try {
          localStorage.setItem('ffstudio_image_last_result', JSON.stringify({
            data,
            expiresAt
          }));
        } catch (e) {}

        const timerBox = document.createElement('div');
        timerBox.className = 'countdown-timer-box';
        shell.body.appendChild(timerBox);
        const outTimer = new AutoCleanupTimer(timerBox, 'ffstudio_image_output_timer');
        outTimer.start(expiresAt, 'Output file(s) will be deleted in');
      } else {
        try {
          localStorage.removeItem('ffstudio_image_output_timer');
          localStorage.removeItem('ffstudio_image_last_result');
        } catch (e) {}
        const localNotice = document.createElement('div');
        localNotice.className = 'banner banner-success';
        localNotice.style.fontSize = '12px';
        localNotice.style.padding = '8px 12px';
        localNotice.style.marginBottom = '12px';
        localNotice.textContent = 'Saved directly to device storage';
        shell.body.appendChild(localNotice);
      }
    }

    const summary = data.summary || {};
    if (successCount > 0) {
      const strip = document.createElement('div');
      strip.className = 'image-summary-strip';
      strip.appendChild(makePill(`${summary.totalOriginalSizeFormatted || '—'} → ${summary.totalOutputSizeFormatted || '—'}`));

      const savedPercent = Number(summary.savedPercent) || 0;
      if (savedPercent > 0) strip.appendChild(makePill(`${savedPercent}% total savings`, 'meta-pill-sm is-good'));
      else if (savedPercent < 0) strip.appendChild(makePill(`${Math.abs(savedPercent)}% total increase`, 'meta-pill-sm is-worse'));

      strip.appendChild(makePill(`${successCount} processed`));
      if (failed > 0) strip.appendChild(makePill(`${failed} failed`));
      shell.body.appendChild(strip);
    }

    const list = document.createElement('div');
    list.className = 'image-result-list';
    results.forEach((result) => list.appendChild(resultRow(result)));
    shell.body.appendChild(list);

    const container = $('imageResult');
    if (container && typeof container.scrollIntoView === 'function') {
      container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  function renderErrorResult(message) {
    const shell = resultShell($('imageResult'), {
      badge: 'Failed',
      meta: 'Nothing was written.',
      error: true
    });
    const banner = document.createElement('div');
    banner.className = 'banner banner-warning';
    banner.style.marginBottom = '0';
    banner.textContent = message;
    shell.body.appendChild(banner);
  }

  function buildPayload() {
    if (state.paths.length === 0) {
      throw new Error('Select at least one image first.');
    }

    const payload = {
      inputPaths: state.paths.slice(),
      outputDir: '',
      isRemoteUpload: isImageRemoteMode()
    };

    if (state.activeTool === 'convert') {
      const quality = Number($('convertQuality').value);
      if (!Number.isFinite(quality) || quality < 1 || quality > 100) {
        throw new Error('Quality must be between 1 and 100.');
      }
      payload.operation = 'convert';
      payload.format = $('convertFormat').value;
      payload.quality = quality;
      payload.stripMetadata = $('convertStripExif').checked;
      payload.outputDir = $('convertOutDir').value.trim();
      return payload;
    }

    if (state.activeTool === 'compress') {
      payload.stripMetadata = $('compressStripExif').checked;
      payload.outputDir = $('compressOutDir').value.trim();
      if (state.compressMode === 'percent') {
        const percent = Number($('compressPercent').value);
        if (!Number.isFinite(percent) || percent < 1 || percent > 100) {
          throw new Error('Percent must be between 1 and 100.');
        }
        payload.operation = 'compress-percent';
        payload.percent = percent;
      } else {
        const targetBytes = targetBytesFromInputs();
        if (!targetBytes) {
          throw new Error('Enter a valid target size such as "500 KB" or "2 MB".');
        }
        payload.operation = 'compress-target';
        payload.targetSize = `${$('compressTargetValue').value} ${$('compressTargetUnit').value}`;
      }
      return payload;
    }

    payload.operation = 'resize';
    payload.stripMetadata = $('resizeStripExif').checked;
    payload.outputDir = $('resizeOutDir').value.trim();

    if (state.resizeMode === 'percent') {
      const percent = Number($('resizePercent').value);
      if (!Number.isFinite(percent) || percent < 1 || percent > 100) {
        throw new Error('Resize percentage must be between 1 and 100.');
      }
      payload.resize = { mode: 'percent', percent };
    } else {
      const rawWidth = $('resizeWidth').value.trim();
      const rawHeight = $('resizeHeight').value.trim();
      if (!rawWidth && !rawHeight) {
        throw new Error('Enter a width, a height, or both.');
      }
      const parseDimension = (raw, label) => {
        if (!raw) return null;
        const value = Number(raw);
        if (!Number.isInteger(value) || value < 1 || value > MAX_DIMENSION) {
          throw new Error(`${label} must be a whole number between 1 and ${MAX_DIMENSION}.`);
        }
        return value;
      };
      payload.resize = {
        mode: 'dimensions',
        width: parseDimension(rawWidth, 'Width'),
        height: parseDimension(rawHeight, 'Height')
      };
    }
    return payload;
  }

  function runButtonForTool() {
    if (state.activeTool === 'compress') return $('btnCompressRun');
    if (state.activeTool === 'resize') return $('btnResizeRun');
    return $('btnConvertRun');
  }

  async function runCurrentOperation() {
    if (state.busy) return;
    const button = runButtonForTool();
    const busyLabels = { convert: 'Converting…', compress: 'Compressing…', resize: 'Resizing…' };

    try {
      const payload = buildPayload();
      state.busy = true;
      state.actualTotal = null;
      syncSizeStrip();
      renderRunningResult(payload.inputPaths.length);
      setBusy(button, true, busyLabels[state.activeTool] || 'Working…');

      const data = await postJson('/api/image/process', payload);
      const results = Array.isArray(data.results) ? data.results : [];
      const failures = results.filter((item) => !item.success);

      if (data.summary && Number.isFinite(Number(data.summary.totalOutputSize))) {
        state.actualTotal = Number(data.summary.totalOutputSize);
      }

      renderResults(data);
      syncSizeStrip();

      if (failures.length === 0) {
        showToast(data.message || 'Images processed.', 'success');
      } else {
        showToast(data.message || 'Finished with errors.', data.processed > 0 ? 'warning' : 'error');
        showToast(failures[0].error || 'One or more images failed.', 'error');
      }
    } catch (err) {
      renderErrorResult(err.message);
      showToast(err.message, 'error');
    } finally {
      setBusy(button, false);
      state.busy = false;
    }
  }

  function switchTool(tool) {
    const panel = $('panel-' + tool);
    if (!panel) return;

    state.activeTool = tool;
    document.querySelectorAll('.content-panel').forEach((section) => {
      section.classList.toggle('active', section === panel);
    });
    document.querySelectorAll('#imageToolNav .nav-item').forEach((button) => {
      button.classList.toggle('active', button.dataset.tool === tool);
    });

    $('imageToolNav').classList.remove('open');
    refreshEstimate(false);

    try {
      history.replaceState(null, '', '#' + tool);
    } catch (err) {}
  }

  function setCompressMode(mode, resetActual) {
    state.compressMode = mode === 'target' ? 'target' : 'percent';
    document.querySelectorAll('#compressMode .segmented-btn').forEach((button) => {
      button.classList.toggle('active', button.dataset.mode === state.compressMode);
    });
    $('compressPercentGroup').style.display = state.compressMode === 'percent' ? 'block' : 'none';
    $('compressTargetGroup').style.display = state.compressMode === 'target' ? 'block' : 'none';
    refreshEstimate(Boolean(resetActual));
  }

  function setResizeMode(mode, resetActual) {
    state.resizeMode = mode === 'percent' ? 'percent' : 'dimensions';
    document.querySelectorAll('#resizeMode .segmented-btn').forEach((button) => {
      button.classList.toggle('active', button.dataset.mode === state.resizeMode);
    });
    $('resizeDimensionsGroup').style.display = state.resizeMode === 'dimensions' ? 'grid' : 'none';
    $('resizePercentGroup').style.display = state.resizeMode === 'percent' ? 'block' : 'none';
    refreshEstimate(Boolean(resetActual));
  }

  function updateConvertQualityUI() {
    const format = $('convertFormat').value;
    const field = $('convertQualityField');
    const isPng = format === 'png';
    field.style.display = isPng ? 'none' : 'block';
    $('convertQuality').disabled = isPng;
    $('convertQualityValue').textContent = String($('convertQuality').value);
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

  function bindSelection() {
    $('btnImageBrowse').addEventListener('click', () => openExplorer());
    $('btnImageAddPath').addEventListener('click', addPathFromInput);
    $('btnImageClear').addEventListener('click', clearAll);
    $('imagePathInput').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') addPathFromInput();
    });
  }

  function bindConvert() {
    $('convertFormat').addEventListener('change', () => {
      updateConvertQualityUI();
      refreshEstimate(true);
    });
    $('convertQuality').addEventListener('input', () => {
      $('convertQualityValue').textContent = String($('convertQuality').value);
      refreshEstimate(true);
    });
    $('btnConvertRun').addEventListener('click', runCurrentOperation);
  }

  function bindCompress() {
    document.querySelectorAll('#compressMode .segmented-btn').forEach((button) => {
      button.addEventListener('click', () => setCompressMode(button.dataset.mode, true));
    });

    $('compressPercent').addEventListener('input', () => {
      $('compressPercentValue').textContent = `${$('compressPercent').value}%`;
      refreshEstimate(true);
    });

    $('compressTargetValue').addEventListener('input', () => refreshEstimate(true));
    $('compressTargetUnit').addEventListener('change', () => refreshEstimate(true));

    document.querySelectorAll('.image-target-presets .mini-shortcut').forEach((button) => {
      button.addEventListener('click', () => {
        $('compressTargetValue').value = button.dataset.target || '500';
        $('compressTargetUnit').value = button.dataset.unit || 'KB';
        refreshEstimate(true);
      });
    });

    $('btnCompressRun').addEventListener('click', runCurrentOperation);
  }

  function bindResize() {
    document.querySelectorAll('#resizeMode .segmented-btn').forEach((button) => {
      button.addEventListener('click', () => setResizeMode(button.dataset.mode, true));
    });

    $('resizeWidth').addEventListener('input', () => refreshEstimate(true));
    $('resizeHeight').addEventListener('input', () => refreshEstimate(true));

    $('resizePercent').addEventListener('input', () => {
      $('resizePercentValue').textContent = `${$('resizePercent').value}%`;
      refreshEstimate(true);
    });

    $('btnResizeRun').addEventListener('click', runCurrentOperation);
  }

  function openExplorer() {
    explorer.selected = [];
    $('imageExplorerTitle').textContent = 'Select images';
    $('imageExplorerModal').style.display = 'flex';
    $('imageExplorerError').style.display = 'none';
    $('imageExplorerList').innerHTML = '';
    $('imageExplorerSearch').value = '';
    $('btnImageExplorerClearSearch').style.display = 'none';
    $('imageExplorerHint').textContent = 'Tap image files to select them.';
    $('btnImageExplorerConfirm').style.display = 'inline-flex';
    $('btnImageExplorerConfirm').disabled = true;
    $('btnImageExplorerConfirm').textContent = 'Use selected';
    loadDirectory(explorer.currentDir || '/sdcard');
  }

  function closeExplorer() {
    $('imageExplorerModal').style.display = 'none';
    explorer.onConfirm = null;
  }

  async function loadDirectory(dirPath) {
    const loading = $('imageExplorerLoading');
    const errorBanner = $('imageExplorerError');
    const list = $('imageExplorerList');

    loading.style.display = 'flex';
    errorBanner.style.display = 'none';
    list.innerHTML = '';

    try {
      const response = await fetch(`/api/browse?dir=${encodeURIComponent(dirPath)}&kind=image-studio`);
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

      $('btnImageExplorerUp').disabled = !explorer.parentDir;
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
    const container = $('imageExplorerBreadcrumbs');
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
    span.innerHTML = kind === 'folder' ? ICONS.folder : ICONS.image;
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
    if (index >= 0) {
      explorer.selected.splice(index, 1);
    } else {
      explorer.selected.push(item);
    }
    renderExplorerList();
  }

  function updateExplorerFooter() {
    const confirm = $('btnImageExplorerConfirm');
    const hint = $('imageExplorerHint');
    const count = explorer.selected.length;

    confirm.disabled = count === 0;
    confirm.textContent = count > 0 ? `Use ${count} image${count === 1 ? '' : 's'}` : 'Use selected';
    hint.textContent = count > 0
      ? `${count} image${count === 1 ? '' : 's'} selected. Tap again to remove.`
      : 'Tap image files to select them.';
  }

  function renderExplorerList() {
    const list = $('imageExplorerList');
    const query = $('imageExplorerSearch').value.trim().toLowerCase();
    list.innerHTML = '';

    const items = explorer.items.filter((item) => !query || item.name.toLowerCase().includes(query));

    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'file-stack-empty';
      empty.textContent = query ? 'No matching files in this folder.' : 'This folder has no matching images.';
      list.appendChild(empty);
      updateExplorerFooter();
      return;
    }

    items.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'explorer-row';

      const left = document.createElement('div');
      left.className = 'explorer-left';

      const icon = explorerIcon(item.isDirectory ? 'folder' : 'image');
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
        } else {
          selectExplorerItem(item);
        }
      });

      list.appendChild(row);
    });

    updateExplorerFooter();
  }

  function confirmExplorerSelection() {
    if (explorer.selected.length === 0) return;
    const paths = explorer.selected.map((item) => item.path);
    closeExplorer();
    addPaths(paths);
  }

  function bindExplorer() {
    $('btnImageExplorerClose').addEventListener('click', closeExplorer);
    $('btnImageExplorerCancel').addEventListener('click', closeExplorer);
    $('btnImageExplorerConfirm').addEventListener('click', confirmExplorerSelection);
    $('btnImageExplorerRefresh').addEventListener('click', () => loadDirectory(explorer.currentDir || '/sdcard'));
    $('btnImageExplorerUp').addEventListener('click', () => {
      if (explorer.parentDir) loadDirectory(explorer.parentDir);
    });

    $('imageExplorerModal').addEventListener('click', (event) => {
      if (event.target === $('imageExplorerModal')) closeExplorer();
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && $('imageExplorerModal').style.display !== 'none') {
        closeExplorer();
      }
    });

    document.querySelectorAll('#imageExplorerModal .mini-shortcut').forEach((button) => {
      button.addEventListener('click', () => loadDirectory(button.dataset.path));
    });

    $('imageExplorerSearch').addEventListener('input', () => {
      const query = $('imageExplorerSearch').value.trim();
      $('btnImageExplorerClearSearch').style.display = query ? 'block' : 'none';
      renderExplorerList();
    });

    $('btnImageExplorerClearSearch').addEventListener('click', () => {
      $('imageExplorerSearch').value = '';
      $('btnImageExplorerClearSearch').style.display = 'none';
      renderExplorerList();
      $('imageExplorerSearch').focus();
    });
  }

  function bindNavigation() {
    document.querySelectorAll('#imageToolNav .nav-item').forEach((button) => {
      button.addEventListener('click', () => switchTool(button.dataset.tool));
    });

    $('btnMobileMenu').addEventListener('click', () => {
      $('imageToolNav').classList.toggle('open');
    });

    window.addEventListener('hashchange', () => {
      const tool = window.location.hash.replace('#', '').trim();
      if (['convert', 'compress', 'resize'].includes(tool) && tool !== state.activeTool) {
        switchTool(tool);
      }
    });

    const hashTool = window.location.hash.replace('#', '').trim();
    if (['convert', 'compress', 'resize'].includes(hashTool)) {
      switchTool(hashTool);
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
      this.expiresAt = Number(expiresAt);
      this.label = label;
      if (this.storageKey) {
        try {
          localStorage.setItem(this.storageKey, JSON.stringify({
            expiresAt: this.expiresAt,
            label: this.label
          }));
        } catch (e) {}
      }
      this.tick();
      this.interval = setInterval(() => this.tick(), 1000);
    }

    recover() {
      if (!this.storageKey) return false;
      try {
        const raw = localStorage.getItem(this.storageKey);
        if (!raw) return false;
        const data = JSON.parse(raw);
        if (data && data.expiresAt) {
          if (Number(data.expiresAt) > Date.now()) {
            this.start(data.expiresAt, data.label || 'File will be deleted in');
            return true;
          } else {
            this.showExpired();
            if (typeof this.onExpire === 'function') this.onExpire();
          }
        }
      } catch (e) {}
      return false;
    }

    showExpired() {
      if (!this.element) return;
      this.stop();
      this.element.style.display = 'inline-flex';
      this.element.className = 'countdown-timer-box is-expired';
      this.element.innerHTML = '⚠️ <span>File expired (deleted)</span>';
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
        if (this.storageKey) {
          try { localStorage.removeItem(this.storageKey); } catch (e) {}
        }
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
        try { localStorage.removeItem(this.storageKey); } catch (e) {}
      }
    }
  }

  function isImageRemoteMode() {
    return Boolean($('btnImageModeRemote') && $('btnImageModeRemote').classList.contains('active'));
  }

  let imageUploadCountdownTimer = null;

  function bindStorageModeAndUpload() {
    function ensureImageUploadTimer() {
      if (!imageUploadCountdownTimer) {
        imageUploadCountdownTimer = new AutoCleanupTimer('imageUploadTimer', 'ffstudio_image_upload_timer', () => {
          showToast('Uploaded images expired (30-minute limit).', 'warning');
          state.paths = [];
          state.info.clear();
          state.activePath = null;
          renderQueue();
        });
      }
      return imageUploadCountdownTimer;
    }

    function setMode(mode) {
      if (state.busy) {
        showToast('Cannot switch storage modes while an operation is in progress.', 'warning');
        return;
      }
      if (mode === 'remote') {
        $('btnImageModeLocal')?.classList.remove('active');
        $('btnImageModeRemote')?.classList.add('active');
        if ($('imageLocalSection')) $('imageLocalSection').style.display = 'none';
        if ($('imageRemoteSection')) $('imageRemoteSection').style.display = 'block';
        localStorage.setItem('ffstudio_image_mode', 'remote');
        ensureImageUploadTimer().recover();
      } else {
        $('btnImageModeRemote')?.classList.remove('active');
        $('btnImageModeLocal')?.classList.add('active');
        if ($('imageRemoteSection')) $('imageRemoteSection').style.display = 'none';
        if ($('imageLocalSection')) $('imageLocalSection').style.display = 'block';
        localStorage.setItem('ffstudio_image_mode', 'local');
        if (imageUploadCountdownTimer) {
          imageUploadCountdownTimer.clear();
          imageUploadCountdownTimer = null;
        }
        try {
          localStorage.removeItem('ffstudio_image_output_timer');
        } catch (e) {}
      }
      // Reset active queues and paths to prevent cross-mode accidental processing
      state.paths = [];
      state.info.clear();
      state.activePath = null;
      renderQueue();
      if ($('imagePathInput')) $('imagePathInput').value = '';
      if ($('imageFileInput')) $('imageFileInput').value = '';
    }

    $('btnImageModeLocal')?.addEventListener('click', () => setMode('local'));
    $('btnImageModeRemote')?.addEventListener('click', () => setMode('remote'));

    // Manual Reset Session
    $('btnClearImageSession')?.addEventListener('click', () => {
      if (state.busy) {
        showToast('Cannot reset session while an operation is running.', 'warning');
        return;
      }
      if (confirm('Reset your remote image session? This clears cached results and active selections.')) {
        try {
          localStorage.removeItem('ffstudio_image_last_result');
          localStorage.removeItem('ffstudio_image_upload_timer');
          localStorage.removeItem('ffstudio_image_output_timer');
          localStorage.removeItem('ffstudio_session_id');
        } catch (e) {}
        state.paths = [];
        state.info.clear();
        state.activePath = null;
        renderQueue();
        if (imageUploadCountdownTimer) {
          imageUploadCountdownTimer.clear();
          imageUploadCountdownTimer = null;
        }
        const res = $('imageResult');
        if (res) res.innerHTML = '';
        showToast('Image session reset successfully.', 'info');
      }
    });

    const savedMode = localStorage.getItem('ffstudio_image_mode') || 'local';
    setMode(savedMode);

    function uploadImages(files) {
      if (state.busy) {
        showToast('Server is busy processing another operation.', 'warning');
        return;
      }
      if (!files || files.length === 0) return;
      const fileList = Array.from(files);
      const valid = fileList.filter(f => SUPPORTED_EXTS.test(f.name));
      if (valid.length === 0) {
        showToast('Please select supported image formats (JPG, PNG, WebP, AVIF, TIFF).', 'warning');
        return;
      }
      if (valid.length < fileList.length) {
        showToast(`Skipped ${fileList.length - valid.length} invalid file(s). Only images are supported.`, 'warning');
      }

      const progressWrap = $('imageUploadProgress');
      const progressBar = $('imageUploadProgressBar');
      const progressText = $('imageUploadProgressText');
      const speedText = $('imageUploadSpeedText');

      if (progressWrap) progressWrap.style.display = 'block';
      if (progressBar) progressBar.style.width = '0%';
      if (progressText) progressText.textContent = `Uploading ${valid.length} image${valid.length === 1 ? '' : 's'} (0%)...`;

      const formData = new FormData();
      valid.forEach(f => formData.append('files', f));

      const xhr = new XMLHttpRequest();
      const startTime = Date.now();

      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          const percent = Math.min(100, Math.round((e.loaded / e.total) * 100));
          if (progressBar) progressBar.style.width = `${percent}%`;
          const elapsed = (Date.now() - startTime) / 1000;
          const speed = elapsed > 0 ? (e.loaded / elapsed) : 0;
          if (progressText) progressText.textContent = `Uploading ${valid.length} images (${percent}%)...`;
          if (speedText) speedText.textContent = `${(speed / (1024 * 1024)).toFixed(1)} MB/s`;
        }
      });

      xhr.addEventListener('load', async () => {
        if (progressWrap) progressWrap.style.display = 'none';
        try {
          const data = JSON.parse(xhr.responseText);
          if (xhr.status >= 200 && xhr.status < 300 && data.success) {
            showToast(`Uploaded ${data.files.length} image${data.files.length === 1 ? '' : 's'}.`, 'success');
            if (data.files && data.files[0] && data.files[0].expiresAt) {
              imageUploadCountdownTimer.start(data.files[0].expiresAt, 'Files will be deleted in');
            }
            const newPaths = data.files.map(f => f.path);
            let addedCount = 0;
            newPaths.forEach(p => {
              if (!state.paths.includes(p)) {
                state.paths.push(p);
                addedCount++;
              }
            });
            if (addedCount > 0) {
              if (!state.activePath || !state.paths.includes(state.activePath)) {
                state.activePath = newPaths[0] || state.paths[0];
              }
              renderQueue();
              inspectPaths(newPaths);
            }
          } else {
            showToast(data.error || 'Upload failed.', 'error');
          }
        } catch (err) {
          showToast('Error parsing server response: ' + err.message, 'error');
        }
      });

      xhr.addEventListener('error', () => {
        if (progressWrap) progressWrap.style.display = 'none';
        showToast('Network error during upload.', 'error');
      });

      xhr.open('POST', '/api/upload');
      xhr.setRequestHeader('X-Session-ID', getOrCreateSessionId());
      xhr.send(formData);
    }

    const dropzone = $('imageDropzone');
    if (dropzone) {
      ['dragenter', 'dragover'].forEach(name => {
        dropzone.addEventListener(name, (e) => {
          e.preventDefault();
          e.stopPropagation();
          dropzone.classList.add('dragover');
        });
      });
      ['dragleave', 'dragend', 'drop'].forEach(name => {
        dropzone.addEventListener(name, (e) => {
          e.preventDefault();
          e.stopPropagation();
          dropzone.classList.remove('dragover');
        });
      });
      dropzone.addEventListener('drop', (e) => {
        const dt = e.dataTransfer;
        if (dt && dt.files && dt.files.length > 0) {
          uploadImages(dt.files);
        }
      });
    }

    const input = $('imageFileInput');
    if (input) {
      input.addEventListener('change', () => {
        if (input.files && input.files.length > 0) {
          uploadImages(input.files);
          input.value = '';
        }
      });
    }
  }

  function recoverImageLastResult() {
    try {
      if (!isImageRemoteMode()) return;
      const raw = localStorage.getItem('ffstudio_image_last_result');
      if (!raw) return;
      const item = JSON.parse(raw);
      if (item && item.expiresAt > Date.now() && item.data) {
        item.data.expiresAt = item.expiresAt;
        renderResults(item.data);
      }
    } catch (e) {}
  }

  bindTheme();
  bindNavigation();
  bindStorageModeAndUpload();
  bindSelection();
  bindConvert();
  bindCompress();
  bindResize();
  bindExplorer();
  updateConvertQualityUI();
  setCompressMode('percent', false);
  setResizeMode('dimensions', false);
  renderQueue();
  recoverImageLastResult();
  if (window.location.hash === '#compress') switchTool('compress');
  if (window.location.hash === '#resize') switchTool('resize');
})();
