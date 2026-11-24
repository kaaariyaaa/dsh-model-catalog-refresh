/**
 * The four-hour refresh schedule, factored away from the plugin so its timer
 * shape is testable without waiting four hours.
 *
 * @module dsh-model-catalog-refresh/scheduler
 */
/** Timer implementation used in production. */
export const systemTimers = {
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    setInterval: (callback, delayMs) => setInterval(callback, delayMs),
    clearTimeout: (handle) => { clearTimeout(handle); },
    clearInterval: (handle) => { clearInterval(handle); },
};
/**
 * Create the refresh schedule.
 * @param onStartup - work to run once, in a zero-delay turn after start.
 * @param onScheduled - work to run every `intervalMs`.
 * @param intervalMs - periodic interval.
 * @param timers - injectable timer implementation.
 * @returns an idempotent scheduler with explicit cancellation.
 */
export function createRefreshScheduler(onStartup, onScheduled, intervalMs, timers = systemTimers) {
    let started = false;
    let initial;
    let periodic;
    return {
        start() {
            if (started)
                return;
            started = true;
            initial = timers.setTimeout(() => {
                initial = undefined;
                onStartup();
            }, 0);
            periodic = timers.setInterval(onScheduled, intervalMs);
            initial.unref?.();
            periodic.unref?.();
        },
        stop() {
            if (initial !== undefined) {
                timers.clearTimeout(initial);
                initial = undefined;
            }
            if (periodic !== undefined) {
                timers.clearInterval(periodic);
                periodic = undefined;
            }
            started = false;
        },
    };
}
//# sourceMappingURL=scheduler.js.map