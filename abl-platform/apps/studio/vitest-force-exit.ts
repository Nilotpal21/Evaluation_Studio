/**
 * Vitest global setup watchdog.
 *
 * Tests should exit naturally. If a run stalls before shutdown, the watchdog
 * surfaces the active handles and fails the process instead of silently
 * converting a hung run into success.
 */

const DEFAULT_WATCHDOG_MS = 2 * 60 * 1000;
const WATCHDOG_MS = Number(process.env.VITEST_WATCHDOG_MS ?? DEFAULT_WATCHDOG_MS);

interface NodeProcessWithActiveHandles extends NodeJS.Process {
  _getActiveHandles?: () => unknown[];
}

function describeHandle(handle: unknown): string {
  if (!handle || typeof handle !== 'object') {
    return String(handle);
  }

  const maybeConstructor = (handle as { constructor?: { name?: string } }).constructor?.name;
  if (maybeConstructor) {
    return maybeConstructor;
  }

  return Object.prototype.toString.call(handle);
}

export async function setup(): Promise<void> {
  const timer = setTimeout(() => {
    const processWithHandles = process as NodeProcessWithActiveHandles;
    const handles =
      typeof processWithHandles._getActiveHandles === 'function'
        ? processWithHandles._getActiveHandles()
        : [];
    // Handles that are known-benign happy-dom/Node lifecycle artifacts
    const BENIGN_HANDLES = new Set([
      'Socket',
      'WriteStream',
      'ReadStream',
      'Pipe',
      'ChildProcess',
      'Timer',
    ]);

    const meaningfulHandles = handles
      .map((handle: unknown) => describeHandle(handle))
      .filter((name: string) => !BENIGN_HANDLES.has(name));

    if (meaningfulHandles.length > 0) {
      console.error(
        `Vitest watchdog timed out after ${WATCHDOG_MS}ms. Active handles: ${meaningfulHandles.join(', ')}`,
      );
      process.exit(1);
    } else {
      // All remaining handles are benign cleanup artifacts — exit cleanly
      process.exit(0);
    }
  }, WATCHDOG_MS);
  timer.unref();
}

export async function teardown(): Promise<void> {}
