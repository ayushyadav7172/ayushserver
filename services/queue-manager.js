'use strict';

const EventEmitter = require('events');
const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { jobManager, parseTimeToSeconds, formatTime, calculateEtaSeconds } = require('./job-manager');
const { databaseManager } = require('../database/database');
let wakeLockManager = null;
try {
  wakeLockManager = require('../wake-lock').wakeLockManager;
} catch (e) {}

const DEFAULT_MAX_CONCURRENCY = parseInt(process.env.MAX_CONCURRENT_FFMPEG_JOBS, 10) || 1;
const DEFAULT_MAX_QUEUE_SIZE = parseInt(process.env.MAX_QUEUE_SIZE, 10) || 50;
const JOB_INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

class QueueManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.db = options.db || databaseManager;
    this.jobManager = options.jobManager || jobManager;

    if (options.maxConcurrency !== undefined) {
      this.maxConcurrency = options.maxConcurrency;
    } else {
      let persisted = null;
      try { persisted = this.db.getSetting('max_concurrency'); } catch (e) {}
      this.maxConcurrency = (persisted && typeof persisted === 'number' && persisted >= 1)
        ? persisted
        : DEFAULT_MAX_CONCURRENCY;
    }
    this.maxQueueSize = options.maxQueueSize || DEFAULT_MAX_QUEUE_SIZE;
    this.queue = []; // Array of queued job IDs
    this.activeJobs = new Map(); // jobId -> { job, process, watchdog, startedAt, settled }
    this.isShuttingDown = false;
    this.executor = options.executor || null;
  }

  setConcurrency(newLimit) {
    const limit = parseInt(newLimit, 10);
    if (isNaN(limit) || limit < 1 || limit > 10) {
      throw new Error('Concurrency limit must be an integer between 1 and 10');
    }
    this.maxConcurrency = limit;
    this.db.setSetting('max_concurrency', limit);
    this._processNext();
    return this.maxConcurrency;
  }

  setExecutor(executorFn) {
    this.executor = executorFn;
    return this;
  }

  getConcurrency() {
    return this.maxConcurrency;
  }

  enqueue(jobData) {
    if (this.isShuttingDown) {
      const err = new Error('Server is shutting down. New jobs cannot be accepted.');
      err.status = 503;
      throw err;
    }

    if (this.queue.length >= this.maxQueueSize) {
      const err = new Error(`Queue is full (maximum ${this.maxQueueSize} queued jobs). Please wait for current jobs to complete.`);
      err.status = 429;
      throw err;
    }

    // Create and persist job in jobManager
    jobData.status = 'queued';
    const job = this.jobManager.createJob(jobData);
    this.queue.push(job.id);
    this.emit('job:enqueued', job);

    console.log(`[QueueManager] Job ${job.id} enqueued (queue length: ${this.queue.length}, active: ${this.activeJobs.size}/${this.maxConcurrency})`);

    // Process immediately if concurrency slot is free
    this._processNext();

    return job;
  }

  _processNext() {
    if (this.isShuttingDown) return;
    if (this.activeJobs.size >= this.maxConcurrency) return;
    if (this.queue.length === 0) return;

    const nextJobId = this.queue.shift();
    const job = this.jobManager.getJob(nextJobId);
    if (!job) {
      return this._processNext();
    }

    if (job.status === 'cancelled') {
      console.log(`[QueueManager] Skipping cancelled job ${job.id}`);
      return this._processNext();
    }

    this._startJob(job);
  }

  _startJob(job) {
    job.status = 'processing';
    job.startedAt = Date.now();
    this.jobManager.updateJob(job.id, {
      status: 'processing',
      startedAt: job.startedAt,
      progress: 0
    });

    this.emit('job:started', job);

    if (typeof this.executor === 'function') {
      const jobContext = {
        job,
        process: null,
        watchdog: null,
        startedAt: Date.now(),
        settled: false
      };
      this.activeJobs.set(job.id, jobContext);
      this.executor(job).then((res) => {
        jobContext.settled = true;
        const finalStatus = (res && res.status) ? res.status : 'completed';
        const completedAt = (res && res.completedAt) ? res.completedAt : Date.now();
        const durationMs = (res && res.durationMs) ? res.durationMs : (completedAt - (job.startedAt || completedAt));
        this.jobManager.updateJob(job.id, {
          status: finalStatus,
          progress: finalStatus === 'completed' ? 100 : (res?.progress?.percent || 0),
          completedAt,
          durationMs,
          outputFile: res?.outputFile || job.outputFile || null,
          error: res?.error || null
        });
        this.db.recordAnalyticsEvent({
          jobId: job.id,
          type: job.type || 'media',
          operation: job.operation || 'process',
          status: finalStatus,
          bytesProcessed: res?.outputFile?.size || 0,
          durationMs
        });
        this._cleanupJobAfterSettled(job.id);
      }).catch((err) => {
        jobContext.settled = true;
        const completedAt = Date.now();
        const durationMs = completedAt - (job.startedAt || completedAt);
        this.jobManager.updateJob(job.id, {
          status: 'failed',
          error: err.message,
          completedAt,
          durationMs
        });
        this.db.recordAnalyticsEvent({
          jobId: job.id,
          type: job.type || 'media',
          operation: job.operation || 'process',
          status: 'failed',
          durationMs
        });
        this._cleanupJobAfterSettled(job.id);
      });
      return;
    }

    let ffmpegProc;
    const workingDir = job.workingDir || (job.inputPaths && job.inputPaths[0] && fs.existsSync(job.inputPaths[0])
      ? path.dirname(job.inputPaths[0])
      : process.cwd());

    const executable = job.executable || 'ffmpeg';
    const execArgs = Array.isArray(job.execArgs) ? job.execArgs : [];

    console.log(`[QueueManager] Starting job ${job.id}: ${executable} in ${workingDir}`);

    const jobContext = {
      job,
      process: null,
      watchdog: null,
      wakeLock: wakeLockManager ? wakeLockManager.acquire(`FFmpeg: ${job.name || job.id}`) : null,
      startedAt: Date.now(),
      settled: false
    };

    const clearWatchdog = () => {
      if (jobContext.watchdog) {
        clearTimeout(jobContext.watchdog);
        jobContext.watchdog = null;
      }
    };

    const armWatchdog = () => {
      clearWatchdog();
      jobContext.watchdog = setTimeout(() => {
        if (jobContext.settled) return;
        if (ffmpegProc && !ffmpegProc.killed) {
          console.warn(`[QueueManager Watchdog] Job ${job.id} produced no output for ${Math.round(JOB_INACTIVITY_TIMEOUT_MS / 60000)}m - terminating.`);
          job.timedOut = true;
          try { ffmpegProc.kill('SIGKILL'); } catch (e) {}
        }
      }, JOB_INACTIVITY_TIMEOUT_MS);
      if (jobContext.watchdog && typeof jobContext.watchdog.unref === 'function') {
        jobContext.watchdog.unref();
      }
    };

    try {
      ffmpegProc = spawn(executable, execArgs, {
        shell: false,
        cwd: workingDir
      });
      jobContext.process = ffmpegProc;
      this.activeJobs.set(job.id, jobContext);
    } catch (spawnErr) {
      console.error(`[QueueManager] Failed to spawn ${executable} for job ${job.id}:`, spawnErr);
      jobContext.settled = true;
      this.jobManager.updateJob(job.id, {
        status: 'failed',
        error: spawnErr.message,
        completedAt: Date.now()
      });
      this.emit('job:failed', { job, error: spawnErr });
      this._cleanupJobAfterSettled(job.id);
      return;
    }

    armWatchdog();
    let rawStderr = '';
    let stderrBuffer = '';

    if (ffmpegProc.stdout) {
      ffmpegProc.stdout.on('data', (chunk) => {
        armWatchdog();
        const text = chunk.toString();
        rawStderr += text;
        this.jobManager.appendLog(job.id, text);
      });
    }

    if (ffmpegProc.stderr) {
      ffmpegProc.stderr.on('data', (chunk) => {
        armWatchdog();
        const text = chunk.toString();
        rawStderr += text;
        stderrBuffer += text;
        this.jobManager.appendLog(job.id, text);

        // Fallback duration parsing if not present
        if (!job.totalDurationSec || job.totalDurationSec <= 0) {
          const durMatch = stderrBuffer.match(/Duration:\s*(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/i);
          if (durMatch && durMatch[1]) {
            const durSec = parseTimeToSeconds(durMatch[1]);
            if (durSec > 0) {
              job.totalDurationSec = durSec;
              job.totalDuration = formatTime(durSec);
              this.jobManager.updateJob(job.id, {
                totalDurationSec: durSec,
                totalDuration: job.totalDuration
              });
            }
          }
        }

        // Progress parsing
        const timeMatches = [...stderrBuffer.matchAll(/time=\s*(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/g)];
        const speedMatches = [...stderrBuffer.matchAll(/speed=\s*(\d+(?:\.\d+)?x|N\/A)/gi)];

        if (timeMatches.length > 0) {
          const lastTime = timeMatches[timeMatches.length - 1][1];
          const curSec = parseTimeToSeconds(lastTime);
          const formattedCurTime = formatTime(curSec);

          let curSpeed = job.speed || 'N/A';
          if (speedMatches.length > 0) {
            curSpeed = speedMatches[speedMatches.length - 1][1].trim();
          }

          let progressPercent = 0;
          if (job.totalDurationSec > 0) {
            progressPercent = Math.min(99, Math.max(0, Math.round((curSec / job.totalDurationSec) * 100)));
          }

          const elapsedSec = (Date.now() - job.startedAt) / 1000;
          const etaSec = calculateEtaSeconds(job.totalDurationSec, curSec, curSpeed, progressPercent, elapsedSec);
          const etaFormatted = etaSec !== null ? formatTime(etaSec) : null;

          job.currentTime = formattedCurTime;
          job.speed = curSpeed;
          job.progress.percent = progressPercent;
          job.progress.time = formattedCurTime;
          job.progress.speed = curSpeed;
          job.progress.eta = etaFormatted;
          job.progress.etaSeconds = etaSec;

          this.jobManager.updateJob(job.id, {
            progress: progressPercent,
            currentTime: formattedCurTime,
            speed: curSpeed
          });

          this.emit('job:progress', {
            jobId: job.id,
            progress: progressPercent,
            currentTime: formattedCurTime,
            totalDuration: job.totalDuration,
            speed: curSpeed,
            eta: etaFormatted,
            etaSeconds: etaSec,
            job
          });
        }

        if (stderrBuffer.length > 4000) {
          stderrBuffer = stderrBuffer.slice(-2000);
        }
        if (rawStderr.length > 200000) {
          rawStderr = rawStderr.slice(-100000);
        }
      });
    }

    ffmpegProc.on('error', (err) => {
      if (jobContext.settled) return;
      jobContext.settled = true;
      clearWatchdog();

      console.error(`[QueueManager] Process error on job ${job.id}:`, err);
      job.completedAt = Date.now();
      job.durationMs = job.completedAt - job.startedAt;
      job.error = err.message;
      job.status = 'failed';

      // Clean up partial output
      if (job.outputPath && fs.existsSync(job.outputPath)) {
        try { fs.unlinkSync(job.outputPath); } catch (e) {}
      }

      this.jobManager.updateJob(job.id, {
        status: 'failed',
        error: err.message,
        completedAt: job.completedAt,
        durationMs: job.durationMs
      });

      this.db.recordAnalyticsEvent({
        jobId: job.id,
        type: job.type || 'media',
        operation: job.operation || 'process',
        status: 'failed',
        durationMs: job.durationMs
      });

      this.emit('job:failed', { jobId: job.id, job, error: err });
      this._cleanupJobAfterSettled(job.id);
    });

    ffmpegProc.on('close', async (code) => {
      if (jobContext.settled) return;
      jobContext.settled = true;
      clearWatchdog();

      job.completedAt = Date.now();
      job.durationMs = job.completedAt - job.startedAt;
      job.exitCode = code;

      if (job.status === 'cancelled') {
        this.jobManager.updateJob(job.id, {
          completedAt: job.completedAt,
          durationMs: job.durationMs,
          exitCode: code
        });
        this.emit('job:cancelled', { jobId: job.id, job });
        this._cleanupJobAfterSettled(job.id);
        return;
      }

      const fileExists = Boolean(job.outputPath && fs.existsSync(job.outputPath));

      if (code === 0 && (fileExists || (job.isCustom && !job.outputPath))) {
        job.status = 'completed';
        job.progress.percent = 100;
        job.currentTime = job.totalDuration;

        let processedBytes = 0;
        if (fileExists) {
          try {
            const stat = fs.statSync(job.outputPath);
            processedBytes = stat.size;
            job.outputFile = {
              filename: path.basename(job.outputPath),
              path: job.outputPath,
              isDirectPath: true,
              size: stat.size,
              previewUrl: `/api/stream-file?path=${encodeURIComponent(job.outputPath)}`,
              downloadUrl: `/api/download/${encodeURIComponent(path.basename(job.outputPath))}?path=${encodeURIComponent(job.outputPath)}`
            };
          } catch (e) {}
        }

        this.jobManager.updateJob(job.id, {
          status: 'completed',
          progress: 100,
          currentTime: job.totalDuration,
          completedAt: job.completedAt,
          durationMs: job.durationMs,
          exitCode: 0,
          outputFile: job.outputFile
        });

        this.db.recordAnalyticsEvent({
          jobId: job.id,
          type: job.type || 'media',
          operation: job.operation || 'process',
          status: 'completed',
          bytesProcessed: processedBytes,
          durationMs: job.durationMs
        });

        console.log(`[QueueManager] Job ${job.id} completed successfully in ${(job.durationMs / 1000).toFixed(1)}s`);
        this.emit('job:completed', { jobId: job.id, job });
      } else {
        job.status = 'failed';
        job.stderr = rawStderr.slice(-4000);

        if (job.timedOut) {
          job.error = `FFmpeg produced no output for ${Math.round(JOB_INACTIVITY_TIMEOUT_MS / 60000)} minutes and timed out.`;
        } else {
          job.error = `FFmpeg process exited with code ${code}`;
        }

        // Clean up partial output file on error
        if (job.outputPath && fs.existsSync(job.outputPath)) {
          try {
            fs.unlinkSync(job.outputPath);
            console.log(`[QueueManager] Cleaned up partial output for failed job ${job.id}`);
          } catch (e) {}
        }

        this.jobManager.updateJob(job.id, {
          status: 'failed',
          error: job.error,
          completedAt: job.completedAt,
          durationMs: job.durationMs,
          exitCode: code
        });

        this.db.recordAnalyticsEvent({
          jobId: job.id,
          type: job.type || 'media',
          operation: job.operation || 'process',
          status: 'failed',
          durationMs: job.durationMs
        });

        console.warn(`[QueueManager] Job ${job.id} failed with exit code ${code}: ${job.error}`);
        this.emit('job:failed', { jobId: job.id, job, error: new Error(job.error) });
      }

      this._cleanupJobAfterSettled(job.id);
    });
  }

  _cleanupJobAfterSettled(jobId) {
    const ctx = this.activeJobs.get(jobId);
    if (ctx) {
      if (ctx.watchdog) {
        clearTimeout(ctx.watchdog);
        ctx.watchdog = null;
      }
      if (ctx.wakeLock) {
        try { ctx.wakeLock.release(); } catch (e) {}
      }
    }
    this.activeJobs.delete(jobId);
    // Process next queued job
    setImmediate(() => this._processNext());
  }

  cancelJob(jobId, sessionId = null) {
    const job = this.jobManager.getJob(jobId);
    if (!job) {
      return { success: false, message: 'Job not found' };
    }

    if (sessionId && job.sessionId && job.sessionId !== sessionId) {
      const err = new Error('Unauthorized: You cannot cancel a job belonging to another session.');
      err.status = 403;
      throw err;
    }

    // 1. If currently in waiting queue
    const queueIdx = this.queue.indexOf(job.id);
    if (queueIdx !== -1) {
      this.queue.splice(queueIdx, 1);
      job.status = 'cancelled';
      job.completedAt = Date.now();
      job.error = 'Cancelled while waiting in queue';
      this.jobManager.updateJob(job.id, {
        status: 'cancelled',
        error: job.error,
        completedAt: job.completedAt
      });
      this.emit('job:cancelled', { jobId: job.id, job });
      return { success: true, message: 'Job removed from queue and cancelled', job };
    }

    // 2. If actively processing
    const context = this.activeJobs.get(job.id);
    if (context) {
      job.status = 'cancelled';
      job.completedAt = Date.now();
      job.error = 'Conversion cancelled by user';

      if (context.process) {
        try {
          const pid = context.process.pid;
          console.log(`[QueueManager] Killing active FFmpeg process (PID ${pid}) for job ${job.id}`);
          context.process.kill('SIGTERM');
          setTimeout(() => {
            if (context.process && !context.process.killed) {
              try { context.process.kill('SIGKILL'); } catch (e) {}
            }
          }, 500);

          if (pid) {
            try {
              exec(`kill -9 ${pid} 2>/dev/null; pkill -9 -P ${pid} 2>/dev/null`, () => {});
            } catch (e) {}
          }
        } catch (e) {
          console.warn('[QueueManager] Error terminating process:', e.message);
        }
      }

      // Clean up partial output file
      if (job.outputPath && fs.existsSync(job.outputPath)) {
        try { fs.unlinkSync(job.outputPath); } catch (e) {}
      }

      this.jobManager.updateJob(job.id, {
        status: 'cancelled',
        error: job.error,
        completedAt: job.completedAt
      });

      this.emit('job:cancelled', { jobId: job.id, job });
      this._cleanupJobAfterSettled(job.id);
      return { success: true, message: 'Active job cancelled successfully', job };
    }

    return { success: true, message: 'Job was not active or already finished', job };
  }

  getStatus() {
    const active = [];
    for (const [id, ctx] of this.activeJobs.entries()) {
      active.push({
        id,
        name: ctx.job.name,
        operation: ctx.job.operation,
        progress: ctx.job.progress ? ctx.job.progress.percent : 0,
        currentTime: ctx.job.currentTime,
        speed: ctx.job.speed,
        startedAt: ctx.startedAt
      });
    }

    return {
      maxConcurrency: this.maxConcurrency,
      activeCount: this.activeJobs.size,
      queuedCount: this.queue.length,
      queue: [...this.queue],
      activeJobs: active
    };
  }

  shutdown() {
    console.log('[QueueManager] Graceful shutdown initiated...');
    this.isShuttingDown = true;
    this.queue = [];

    for (const [id, ctx] of this.activeJobs.entries()) {
      try {
        if (ctx.watchdog) {
          clearTimeout(ctx.watchdog);
          ctx.watchdog = null;
        }
        if (ctx.wakeLock) {
          try { ctx.wakeLock.release(); } catch (e) {}
        }
        if (ctx.process && !ctx.process.killed) {
          console.log(`[QueueManager] Terminating active job ${id} (PID ${ctx.process.pid})`);
          ctx.process.kill('SIGTERM');
        }
      } catch (e) {}
    }
  }
}

const defaultQueueManager = new QueueManager();

module.exports = {
  QueueManager,
  queueManager: defaultQueueManager
};
