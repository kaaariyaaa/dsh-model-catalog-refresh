/**
 * The four-hour refresh schedule, factored away from the plugin so its timer
 * shape is testable without waiting four hours.
 *
 * @module dsh-model-catalog-refresh/scheduler
 */

/** Minimal timer handle; browser and Node handles both expose `unref` or not. */
export interface SchedulerTimerHandle {
  /** Let the process exit while this timer is pending, when the runtime supports it. */
  unref?(): void
}

/** Timer functions the scheduler uses. */
export interface SchedulerTimers {
  setTimeout(callback: () => void, delayMs: number): SchedulerTimerHandle
  setInterval(callback: () => void, delayMs: number): SchedulerTimerHandle
  clearTimeout(handle: SchedulerTimerHandle): void
  clearInterval(handle: SchedulerTimerHandle): void
}

/** Timer implementation used in production. */
export const systemTimers: SchedulerTimers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  setInterval: (callback, delayMs) => setInterval(callback, delayMs),
  clearTimeout: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>) },
  clearInterval: (handle) => { clearInterval(handle as ReturnType<typeof setInterval>) },
}

/** A started or startable schedule. */
export interface RefreshScheduler {
  /** Start one post-startup run and the periodic interval. Idempotent. */
  start(): void
  /** Cancel every pending timer. */
  stop(): void
}

/**
 * Create the refresh schedule.
 * @param onStartup - work to run once, in a zero-delay turn after start.
 * @param onScheduled - work to run every `intervalMs`.
 * @param intervalMs - periodic interval.
 * @param timers - injectable timer implementation.
 * @returns an idempotent scheduler with explicit cancellation.
 */
export function createRefreshScheduler(
  onStartup: () => void,
  onScheduled: () => void,
  intervalMs: number,
  timers: SchedulerTimers = systemTimers,
): RefreshScheduler {
  let started = false
  let initial: SchedulerTimerHandle | undefined
  let periodic: SchedulerTimerHandle | undefined
  return {
    start() {
      if (started) return
      started = true
      initial = timers.setTimeout(() => {
        initial = undefined
        onStartup()
      }, 0)
      periodic = timers.setInterval(onScheduled, intervalMs)
      initial.unref?.()
      periodic.unref?.()
    },
    stop() {
      if (initial !== undefined) {
        timers.clearTimeout(initial)
        initial = undefined
      }
      if (periodic !== undefined) {
        timers.clearInterval(periodic)
        periodic = undefined
      }
      started = false
    },
  }
}
