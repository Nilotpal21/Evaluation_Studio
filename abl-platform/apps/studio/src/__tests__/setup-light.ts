/**
 * Lightweight setup for pure-logic unit tests.
 *
 * These tests do NOT need happy-dom, React Testing Library, lucide-react mocks,
 * framer-motion mocks, or next-intl translation loading.  Running them under
 * environment: 'node' with this minimal setup avoids ~500 lines of per-file
 * initialisation cost and eliminates the happy-dom open-handle leak that forces
 * the triple force-exit watchdog in the full setup.
 */
import { vi } from 'vitest';
import { afterEach } from 'vitest';

const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const realClearTimeout = globalThis.clearTimeout.bind(globalThis);
const realSetInterval = globalThis.setInterval.bind(globalThis);
const realClearInterval = globalThis.clearInterval.bind(globalThis);

const activeTimeouts = new Set<ReturnType<typeof setTimeout>>();
const activeIntervals = new Set<ReturnType<typeof setInterval>>();

function runTimerHandler(handler: TimerHandler, args: unknown[]): void {
  if (typeof handler === 'function') {
    handler(...args);
    return;
  }

  Function(handler)();
}

function trackedSetTimeout(handler: TimerHandler, timeout?: number, ...args: unknown[]) {
  let timerId: ReturnType<typeof setTimeout>;
  timerId = realSetTimeout(() => {
    activeTimeouts.delete(timerId);
    runTimerHandler(handler, args);
  }, timeout);
  activeTimeouts.add(timerId);
  return timerId;
}

function trackedClearTimeout(timerId?: ReturnType<typeof setTimeout>): void {
  if (timerId !== undefined) {
    activeTimeouts.delete(timerId);
    realClearTimeout(timerId);
  }
}

function trackedSetInterval(handler: TimerHandler, timeout?: number, ...args: unknown[]) {
  const timerId = realSetInterval(() => runTimerHandler(handler, args), timeout);
  activeIntervals.add(timerId);
  return timerId;
}

function trackedClearInterval(timerId?: ReturnType<typeof setInterval>): void {
  if (timerId !== undefined) {
    activeIntervals.delete(timerId);
    realClearInterval(timerId);
  }
}

Object.defineProperty(globalThis, 'setTimeout', {
  value: trackedSetTimeout,
  writable: true,
  configurable: true,
});
Object.defineProperty(globalThis, 'clearTimeout', {
  value: trackedClearTimeout,
  writable: true,
  configurable: true,
});
Object.defineProperty(globalThis, 'setInterval', {
  value: trackedSetInterval,
  writable: true,
  configurable: true,
});
Object.defineProperty(globalThis, 'clearInterval', {
  value: trackedClearInterval,
  writable: true,
  configurable: true,
});

// Save the native fetch before overwriting so e2e tests can restore it via
// (globalThis as any).__nativeFetch — the mock is writable/configurable, so
// tests that need real HTTP can do: vi.stubGlobal('fetch', __nativeFetch).
const nativeFetch = globalThis.fetch;
Object.defineProperty(globalThis, '__nativeFetch', {
  value: nativeFetch,
  writable: false,
  configurable: false,
  enumerable: false,
});

const defaultFetch = vi.fn(async (input: RequestInfo | URL) => {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  throw new Error(`Unexpected fetch call in test environment: ${url}. Stub fetch in this test.`);
});

function installDefaultFetchMock(): void {
  Object.defineProperty(globalThis, 'fetch', {
    value: defaultFetch,
    writable: true,
    configurable: true,
  });
}

function clearTrackedTimers(): void {
  for (const timerId of activeTimeouts) {
    realClearTimeout(timerId);
  }
  activeTimeouts.clear();

  for (const timerId of activeIntervals) {
    realClearInterval(timerId);
  }
  activeIntervals.clear();
}

// Mock server-only — Next.js package that prevents server code from running in client bundles
vi.mock('server-only', () => ({}));

// Mock localStorage/sessionStorage for Zustand persist middleware (used by store tests)
const createMockStorage = (): Storage => {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    get length() {
      return store.size;
    },
    key: (index: number) => [...store.keys()][index] ?? null,
  };
};

Object.defineProperty(globalThis, 'localStorage', { value: createMockStorage(), writable: true });
Object.defineProperty(globalThis, 'sessionStorage', {
  value: createMockStorage(),
  writable: true,
});

installDefaultFetchMock();

afterEach(() => {
  vi.useRealTimers();
  clearTrackedTimers();
  defaultFetch.mockClear();
  // Don't reinstall defaultFetch - tests that stub fetch (via vi.stubGlobal)
  // should keep their own mocks. The initial installDefaultFetchMock() at
  // module load provides the default for tests that don't mock fetch.
});
