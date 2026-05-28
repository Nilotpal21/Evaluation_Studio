/**
 * Promise wrapper with timeout + guaranteed timer cleanup.
 *
 * Local helper for the security package. Existing platform implementations
 * (transfer-session-store, file-store-service) leak the timer because they
 * never call clearTimeout on the success path; this version uses .finally()
 * so the timer cannot outlive the wrapped promise. See LLD §1.3 D-4.
 */

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label}: timeout after ${ms}ms`));
    }, ms);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
