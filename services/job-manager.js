'use strict';

const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');
const { databaseManager } = require('../database/database');

function parseTimeToSeconds(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return 0;
  const parts = timeStr.trim().split(':');
  if (parts.length === 3) {
    const hours = parseFloat(parts[0]) || 0;
    const mins = parseFloat(parts[1]) || 0;
    const secs = parseFloat(parts[2]) || 0;
    return (hours * 3600) + (mins * 60) + secs;
  }
  if (parts.length === 2) {
    const mins = parseFloat(parts[0]) || 0;
    const secs = parseFloat(parts[1]) || 0;
    return (mins * 60) + secs;
  }
  return parseFloat(timeStr) || 0;
}

function formatTime(totalSeconds) {
  const sec = Math.max(0, Math.floor(totalSeconds || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return [
    String(h).padStart(2, '0'),
    String(m).padStart(2, '0'),
    String(s).padStart(2, '0')
  ].join(':');
}

function calculateEtaSeconds(totalSec, currentSec, speedStr, percent, elapsedSec) {
  if (speedStr && speedStr !== 'N/A') {
    const speedNum = parseFloat(speedStr.replace('x', ''));
    if (speedNum > 0 && totalSec > currentSec) {
      return Math.round((totalSec - currentSec) / speedNum);
    }
  }
  if (percent > 0 && elapsedSec > 0) {
    const rate = percent / elapsedSec; // % per second
    if (rate > 0) {
      const remainingPercent = 100 - percent;
      return Math.round(remainingPercent / rate);
    }
  }
  return null;
}

class JobManager extends EventEmitter {
  constructor(db = databaseManager) {
    super();
    this.db = db;
    this.memoryJobs = new Map();
  }

  createJob(jobData) {
    const id = jobData.id || `job_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const now = Date.now();

    const job = {
      id,
      jobId: id,
      sessionId: jobData.sessionId || null,
      name: jobData.name || `Job ${id}`,
      filename: jobData.filename || (jobData.filePath ? path.basename(jobData.filePath) : ''),
      type: jobData.type || 'media',
      operation: jobData.operation || 'process',
      status: jobData.status || 'queued',
      progress: {
        percent: 0,
        time: '00:00:00',
        speed: '0x',
        fps: 0,
        eta: null,
        etaSeconds: null
      },
      currentTime: '00:00:00',
      totalDuration: jobData.totalDuration || '00:00:00',
      totalDurationSec: jobData.totalDurationSec || jobData.expectedDuration || 0,
      expectedDuration: jobData.expectedDuration || jobData.totalDurationSec || 0,
      speed: '0x',
      filePath: jobData.filePath || (Array.isArray(jobData.inputPaths) ? jobData.inputPaths[0] : ''),
      inputPaths: Array.isArray(jobData.inputPaths) ? jobData.inputPaths : (jobData.filePath ? [jobData.filePath] : []),
      outputPath: jobData.outputPath || '',
      commandString: jobData.commandString || '',
      options: jobData.options || {},
      meta: jobData.meta || null,
      outputFile: null,
      error: null,
      exitCode: null,
      createdAt: jobData.createdAt || now,
      startedAt: null,
      completedAt: null,
      durationMs: null,
      isRemoteUpload: Boolean(jobData.isRemoteUpload),
      isDirectPath: true,
      isCustom: Boolean(jobData.isCustom),
      isHardwareAccel: Boolean(jobData.isHardwareAccel),
      logs: [],
      stderr: '',
      executable: jobData.executable || 'ffmpeg',
      execArgs: jobData.execArgs || jobData.ffmpegArgs || [],
      workingDir: jobData.workingDir || process.cwd()
    };

    this.memoryJobs.set(id, job);
    this.db.saveJob(job);
    this.emit('job:created', job);
    return job;
  }

  getJob(id) {
    if (!id) return null;
    const strId = String(id);
    let job = this.memoryJobs.get(strId);
    if (!job) {
      job = this.db.getJob(strId);
      if (job) {
        job.logs = [];
        this.memoryJobs.set(strId, job);
      }
    }
    return job || null;
  }

  updateJob(id, updates) {
    const job = this.getJob(id);
    if (!job) return null;

    const { progress, ...rest } = updates || {};
    Object.assign(job, rest);

    // Synchronize progress object without clobbering existing fields
    if (typeof progress === 'number') {
      if (!job.progress || typeof job.progress !== 'object') {
        job.progress = { percent: progress };
      } else {
        job.progress.percent = progress;
      }
    } else if (progress && typeof progress === 'object') {
      job.progress = { ...(typeof job.progress === 'object' ? job.progress : {}), ...progress };
    }

    if (updates.currentTime) {
      if (!job.progress) job.progress = {};
      job.progress.time = updates.currentTime;
    }

    if (updates.speed) {
      if (!job.progress) job.progress = {};
      job.progress.speed = updates.speed;
    }

    // Persist to DB
    this.db.saveJob(job);
    this.emit('job:updated', job);
    return job;
  }

  appendLog(id, chunk) {
    const job = this.getJob(id);
    if (!job || !chunk) return;

    const text = String(chunk);
    job.logs.push(text);
    if (job.logs.length > 500) {
      job.logs.shift();
    }

    // Append to SQLite logs
    this.db.appendJobLog(id, text);
    this.emit('job:log', { id, chunk: text });
  }

  getLogs(id) {
    const job = this.getJob(id);
    if (!job) return '';
    if (job.logs && job.logs.length > 0) {
      return job.logs.join('');
    }
    return this.db.getJobLogs(id);
  }

  deleteJob(id, sessionId = null) {
    const job = this.getJob(id);
    if (!job) return false;
    if (job.sessionId && job.sessionId !== sessionId) {
      const err = new Error('Unauthorized');
      err.status = 403;
      throw err;
    }

    this.memoryJobs.delete(String(id));
    this.db.deleteJob(String(id));
    this.emit('job:deleted', id);
    return true;
  }

  clearJobs(sessionId = null, options = {}) {
    if (sessionId) {
      for (const [id, job] of this.memoryJobs.entries()) {
        if (job.sessionId === sessionId) {
          this.memoryJobs.delete(id);
        }
      }
      return this.db.clearJobs(sessionId);
    }
    if (options.onlyUnscoped) {
      for (const [id, job] of this.memoryJobs.entries()) {
        if (!job.sessionId) {
          this.memoryJobs.delete(id);
        }
      }
      return this.db.clearJobs(null, { onlyUnscoped: true });
    }
    this.memoryJobs.clear();
    return this.db.clearJobs();
  }

  getAllJobs(options = {}) {
    return this.db.getJobs(options);
  }

  recoverInterruptedJobs() {
    console.log('[JobManager] Checking for unfinished or interrupted jobs from previous run...');
    const recovered = this.db.markInterruptedJobs();
    if (recovered.length > 0) {
      console.log(`[JobManager] Marked ${recovered.length} unfinished job(s) as interrupted.`);
      for (const j of recovered) {
        this.memoryJobs.delete(j.id);
      }
    }
    return recovered;
  }
}

const defaultJobManager = new JobManager();

module.exports = {
  JobManager,
  jobManager: defaultJobManager,
  parseTimeToSeconds,
  formatTime,
  calculateEtaSeconds
};
