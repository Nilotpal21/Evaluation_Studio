/**
 * Debounce utility for async form handlers.
 *
 * Prevents rapid duplicate API calls when users click form buttons
 * multiple times before SWR dedup kicks in.
 *
 * Framework-agnostic — no React dependency.
 */

/**
 * Wraps an async function so that rapid successive calls are debounced.
 *
 * - **Trailing mode** (default): The function fires after `delayMs` of inactivity.
 *   Rapid calls reset the timer; only the last call in a burst actually executes.
 * - **Leading mode** (`options.leading: true`): The first call fires immediately,
 *   then subsequent calls within the delay window are dropped. After the delay
 *   elapses with no new calls, the next call will fire immediately again.
 *
 * The returned function also exposes a `cancel()` method to clear any pending
 * invocation and a `pending` getter to check if a call is scheduled.
 *
 * @param fn - The async function to debounce.
 * @param delayMs - Debounce delay in milliseconds.
 * @param options - Optional configuration.
 * @param options.leading - If true, fire on the leading edge instead of trailing.
 * @returns A debounced wrapper with `.cancel()` and `.pending` attached.
 */
export function debounceAsync<T extends (...args: any[]) => Promise<any>>(
  fn: T,
  delayMs: number,
  options?: { leading?: boolean },
): DebouncedFunction<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let leadingFired = false;

  const debounced = (...args: Parameters<T>): void => {
    if (options?.leading) {
      // Leading mode: fire immediately on the first call, then ignore
      // subsequent calls until the delay elapses with no new calls.
      if (!leadingFired) {
        leadingFired = true;
        fn(...args);
      }
      // Reset the cooldown timer on every call
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        leadingFired = false;
        timer = null;
      }, delayMs);
      return;
    }

    // Trailing mode (default): reset timer on every call, fire after delay.
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      fn(...args);
      timer = null;
    }, delayMs);
  };

  debounced.cancel = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    leadingFired = false;
  };

  Object.defineProperty(debounced, 'pending', {
    get: () => timer !== null,
    enumerable: true,
  });

  return debounced as DebouncedFunction<T>;
}

/** The shape of the debounced wrapper returned by `debounceAsync`. */
export interface DebouncedFunction<T extends (...args: any[]) => Promise<any>> {
  (...args: Parameters<T>): void;
  /** Cancel any pending (trailing) invocation and reset leading state. */
  cancel(): void;
  /** Whether a timer is currently active (pending trailing call or leading cooldown). */
  readonly pending: boolean;
}
