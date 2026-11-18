const { exec, execSync } = require('child_process');

/**
 * WakeLockManager
 * Manages Android CPU wake-lock (termux-wake-lock / termux-wake-unlock) on Termux.
 * 
 * Features:
 * - On-demand acquisition: Only holds wake-lock when heavy background tasks (FFmpeg, qpdf, sharp) run.
 * - Reference counting: Tracks multiple concurrent tasks and only releases when all tasks finish.
 * - Serialized command execution: Prevents race conditions where unlock could finish before lock.
 * - Guaranteed cleanup in finally: Never leaves the CPU lock stuck on task errors or rejections.
 * - Exit safety handlers: Synchronously executes termux-wake-unlock on SIGINT, SIGTERM, or exit.
 * - Auto-cleanup for stale locks: Safely clears locks held longer than 30 minutes.
 */
class WakeLockManager {
  constructor() {
    this.activeTasks = new Map(); // id -> { id, tag, acquiredAt }
    this.nextTaskId = 1;
    this.isSystemLockHeld = false;
    this._queue = Promise.resolve();
    this._setupProcessCleanup();
  }

  /**
   * Acquire a wake-lock for a specific task.
   * Returns a handle with an idempotent release() function.
   * @param {string} tag - Human-readable label for the task (e.g., 'FFmpeg: convert', 'PDF: merge')
   * @returns {{ id: string, tag: string, release: () => boolean }}
   */
  acquire(tag = 'Heavy Task') {
    const id = `task_${Date.now()}_${this.nextTaskId++}`;
    const taskInfo = { id, tag, acquiredAt: Date.now() };
    this.activeTasks.set(id, taskInfo);

    console.log(`[Wake Lock] Acquired wake-lock for "${tag}". Active heavy tasks: ${this.activeTasks.size}`);
    this._syncSystemState();

    let released = false;
    return {
      id,
      tag,
      release: () => {
        if (!released) {
          released = true;
          return this.release(id);
        }
        return false;
      }
    };
  }

  /**
   * Release a task's wake-lock by task id.
   * Idempotent and safe against double-release.
   * @param {string} id - The task ID returned by acquire()
   * @returns {boolean} Whether a lock was actually released
   */
  release(id) {
    if (!this.activeTasks.has(id)) {
      return false;
    }
    const taskInfo = this.activeTasks.get(id);
    this.activeTasks.delete(id);
    const durationMs = Date.now() - taskInfo.acquiredAt;
    console.log(`[Wake Lock] Released wake-lock for "${taskInfo.tag}" (elapsed: ${durationMs}ms). Active heavy tasks: ${this.activeTasks.size}`);
    this._syncSystemState();
    return true;
  }

  /**
   * Helper to execute a synchronous or asynchronous task with guaranteed wake-lock lifecycle.
   * Releasing is always performed in a finally block so the lock is never stuck on errors.
   * @template T
   * @param {string} tag - Human-readable task label
   * @param {() => Promise<T>|T} fn - The task function to execute
   * @returns {Promise<T>}
   */
  async withWakeLock(tag, fn) {
    const lock = this.acquire(tag);
    try {
      return await fn();
    } finally {
      lock.release();
    }
  }

  /**
   * Synchronize the system wake-lock state with the current number of active tasks.
   * Serialized sequentially through a Promise chain to avoid out-of-order execution.
   */
  _syncSystemState() {
    const shouldBeLocked = this.activeTasks.size > 0;
    if (shouldBeLocked === this.isSystemLockHeld) {
      return;
    }

    this.isSystemLockHeld = shouldBeLocked;
    const cmd = shouldBeLocked ? 'termux-wake-lock' : 'termux-wake-unlock';

    this._queue = this._queue
      .then(() => {
        return new Promise((resolve) => {
          exec(cmd, (err) => {
            if (err) {
              // Log notice if termux-wake-lock/unlock is unavailable or failed
              console.warn(`[Wake Lock] Notice: "${cmd}" notice:`, err.message);
            } else {
              console.log(`[Wake Lock] Successfully executed "${cmd}". System state: ${shouldBeLocked ? 'CPU locked awake' : 'CPU sleep allowed'}.`);
            }
            resolve();
          });
        });
      })
      .catch((err) => {
        console.warn('[Wake Lock] Queue execution warning:', err.message);
      });
  }

  /**
   * Synchronous cleanup for process termination (SIGINT, SIGTERM, exit).
   * Ensures termux-wake-unlock is immediately dispatched so Android does not drain battery.
   */
  forceReleaseSync() {
    try {
      if (this.activeTasks.size > 0 || this.isSystemLockHeld) {
        this.activeTasks.clear();
        this.isSystemLockHeld = false;
        execSync('termux-wake-unlock', { stdio: 'ignore', timeout: 2000 });
        console.log('[Wake Lock] Exit cleanup: executed termux-wake-unlock.');
      }
    } catch (e) {
      // Command may not be present or already unlocked
    }
  }

  /**
   * Cleanup any locks running longer than maxAgeMs (default 30 min) to prevent stuck locks.
   * @param {number} maxAgeMs
   */
  cleanupStaleLocks(maxAgeMs = 30 * 60 * 1000) {
    const now = Date.now();
    let releasedAny = false;
    for (const [id, task] of this.activeTasks.entries()) {
      if (now - task.acquiredAt > maxAgeMs) {
        console.warn(`[Wake Lock] Auto-releasing stale wake-lock for "${task.tag}" (exceeded ${Math.round(maxAgeMs / 60000)}m)`);
        this.activeTasks.delete(id);
        releasedAny = true;
      }
    }
    if (releasedAny) {
      this._syncSystemState();
    }
  }

  /**
   * Register system signal and exit handlers for automatic cleanup on shutdown.
   */
  _setupProcessCleanup() {
    const onSignal = () => {
      this.forceReleaseSync();
      process.exit(0);
    };

    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    process.once('exit', () => {
      this.forceReleaseSync();
    });
  }
}

const wakeLockManager = new WakeLockManager();

module.exports = {
  WakeLockManager,
  wakeLockManager
};
