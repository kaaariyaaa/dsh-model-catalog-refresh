/**
 * The four-hour refresh schedule, factored away from the plugin so its timer
 * shape is testable without waiting four hours.
 *
 * @module dsh-model-catalog-refresh/scheduler
 */
/** Minimal timer handle; browser and Node handles both expose `unref` or not. */
export interface SchedulerTimerHandle {
    /** Let the process exit while this timer is pending, when the runtime supports it. */
    unref?(): void;
}
/** Timer functions the scheduler uses. */
export interface SchedulerTimers {
    setTimeout(callback: () => void, delayMs: number): SchedulerTimerHandle;
    setInterval(callback: () => void, delayMs: number): SchedulerTimerHandle;
    clearTimeout(handle: SchedulerTimerHandle): void;
    clearInterval(handle: SchedulerTimerHandle): void;
}
/** Timer implementation used in production. */
export declare const systemTimers: SchedulerTimers;
/** A started or startable schedule. */
export interface RefreshScheduler {
    /** Start one post-startup run and the periodic interval. Idempotent. */
    start(): void;
    /** Cancel every pending timer. */
    stop(): void;
}
/**
 * Create the refresh schedule.
 * @param onStartup - work to run once, in a zero-delay turn after start.
 * @param onScheduled - work to run every `intervalMs`.
 * @param intervalMs - periodic interval.
 * @param timers - injectable timer implementation.
 * @returns an idempotent scheduler with explicit cancellation.
 */
export declare function createRefreshScheduler(onStartup: () => void, onScheduled: () => void, intervalMs: number, timers?: SchedulerTimers): RefreshScheduler;
//# sourceMappingURL=scheduler.d.ts.map