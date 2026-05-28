/**
 * Vitest setup for component tests
 */
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// Suppress ECONNREFUSED unhandled rejections from happy-dom's internal fetch
// lifecycle (connecting to localhost during env init/teardown). These are
// harmless artifacts of the test environment, not real application errors.
// Without this, Node.js v18+ sets process.exitCode=1 when they fire after
// tests complete, causing the force-exit below to exit with code 1.
process.on('unhandledRejection', (reason) => {
  if (
    reason instanceof Error &&
    reason.message.includes('ECONNREFUSED') &&
    (reason.message.includes('::1') || reason.message.includes('127.0.0.1'))
  ) {
    return; // suppress known happy-dom lifecycle errors
  }
  throw reason;
});

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

const defaultFetch = vi.fn(async (input: RequestInfo | URL) => {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  throw new Error(`Unexpected fetch call in test environment: ${url}. Stub fetch in this test.`);
});

const nativeFetch = globalThis.fetch;
Object.defineProperty(globalThis, '__nativeFetch', {
  value: nativeFetch,
  writable: false,
  configurable: false,
  enumerable: false,
});

function installDefaultFetchMock(): void {
  // Skip fetch mocking for node environment (E2E tests need real fetch)
  if (typeof window === 'undefined' && typeof document === 'undefined') {
    return;
  }

  Object.defineProperty(globalThis, 'fetch', {
    value: defaultFetch,
    writable: true,
    configurable: true,
  });

  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'fetch', {
      value: defaultFetch,
      writable: true,
      configurable: true,
    });
  }
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

installDefaultFetchMock();

// Auto cleanup after each test
afterEach(() => {
  vi.useRealTimers();
  clearTrackedTimers();
  defaultFetch.mockClear();
  installDefaultFetchMock();
  cleanup();
});

// Mock next/navigation
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/',
}));

// Mock next-intl — load real English translations so tests match English text
const { allMessages, getNestedValue, formatICU } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('path');
  const root = path.resolve(__dirname, '..', '..', '..', '..');
  const studioMessages = JSON.parse(
    fs.readFileSync(path.join(root, 'packages/i18n/locales/en/studio.json'), 'utf-8'),
  );
  const platformMessages = JSON.parse(
    fs.readFileSync(path.join(root, 'packages/i18n/locales/en/platform.json'), 'utf-8'),
  );
  const marketplaceMessages = JSON.parse(
    fs.readFileSync(path.join(root, 'packages/i18n/locales/en/marketplace.json'), 'utf-8'),
  );
  const allMessages: Record<string, any> = {
    ...studioMessages,
    platform: platformMessages,
    marketplace: marketplaceMessages,
  };

  function getNestedValue(obj: any, keyPath: string): any {
    const parts = keyPath.split('.');
    let current = obj;
    for (const part of parts) {
      if (current == null || typeof current !== 'object') return undefined;
      current = current[part];
    }
    return current;
  }

  /**
   * Simple ICU MessageFormat plural handler.
   * Handles: {varName, plural, one {# text} other {# text}}
   */
  function formatICU(template: string, params: Record<string, any>): string {
    // First handle simple {key} replacements
    let result = template.replace(/\{(\w+)\}/g, (match, k) => {
      return params[k] !== undefined ? String(params[k]) : match;
    });

    // Handle {key, plural, one {...} other {...}} patterns
    result = result.replace(
      /\{(\w+),\s*plural,\s*((?:(?:zero|one|two|few|many|other|=\d+)\s*\{[^}]*\}\s*)+)\}/g,
      (_match, varName, branches) => {
        const count = Number(params[varName] ?? 0);
        const branchMap: Record<string, string> = {};
        const branchRegex = /(zero|one|two|few|many|other|=\d+)\s*\{([^}]*)\}/g;
        let m;
        while ((m = branchRegex.exec(branches)) !== null) {
          branchMap[m[1]] = m[2];
        }
        // Check exact match first (=0, =1, etc.)
        const exactKey = `=${count}`;
        let selected = branchMap[exactKey];
        if (selected === undefined) {
          // Simple English plural rules
          selected =
            count === 1
              ? (branchMap['one'] ?? branchMap['other'] ?? '')
              : (branchMap['other'] ?? '');
        }
        return selected.replace(/#/g, String(count));
      },
    );

    return result;
  }

  return { allMessages, getNestedValue, formatICU };
});

vi.mock('next-intl', () => ({
  useTranslations: (namespace?: string) => {
    const nsObj = namespace ? (getNestedValue(allMessages, namespace) ?? {}) : allMessages;
    const resolve = (key: string): string | undefined => {
      if (typeof nsObj === 'object' && nsObj !== null) {
        const val = getNestedValue(nsObj, key);
        return typeof val === 'string' ? val : undefined;
      }
      return undefined;
    };
    const t = (key: string, params?: Record<string, any>) => {
      const val = resolve(key);
      if (val === undefined) {
        if (params?.defaultValue) return String(params.defaultValue);
        if (params?.defaultMessage) return String(params.defaultMessage);
        return namespace ? `${namespace}.${key}` : key;
      }
      if (params) {
        return formatICU(val, params);
      }
      return val;
    };
    t.rich = (key: string, params?: Record<string, any>) => t(key, params);
    t.raw = (key: string) => {
      const val = resolve(key);
      return val !== undefined ? val : namespace ? `${namespace}.${key}` : key;
    };
    t.markup = (key: string, params?: Record<string, any>) => t(key, params);
    t.has = (key: string) => resolve(key) !== undefined;
    return t;
  },
  useLocale: () => 'en',
  useMessages: () => allMessages,
  useNow: () => new Date(),
  useTimeZone: () => 'UTC',
  useFormatter: () => ({
    number: (v: number) => String(v),
    dateTime: (v: Date) => v.toISOString(),
    relativeTime: (v: Date) => v.toISOString(),
  }),
  NextIntlClientProvider: ({ children }: any) => children,
}));

// Mock next-intl/server — for server components that use getTranslations, getLocale, etc.
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace?: string) => {
    const nsObj = namespace ? (getNestedValue(allMessages, namespace) ?? {}) : allMessages;
    const resolve = (key: string): string | undefined => {
      if (typeof nsObj === 'object' && nsObj !== null) {
        const val = getNestedValue(nsObj, key);
        return typeof val === 'string' ? val : undefined;
      }
      return undefined;
    };
    const t = (key: string, params?: Record<string, any>) => {
      const val = resolve(key);
      if (val === undefined) {
        if (params?.defaultValue) return String(params.defaultValue);
        if (params?.defaultMessage) return String(params.defaultMessage);
        return namespace ? `${namespace}.${key}` : key;
      }
      if (params) {
        return formatICU(val, params);
      }
      return val;
    };
    t.rich = (key: string, params?: Record<string, any>) => t(key, params);
    t.raw = (key: string) => {
      const val = resolve(key);
      return val !== undefined ? val : namespace ? `${namespace}.${key}` : key;
    };
    t.markup = (key: string, params?: Record<string, any>) => t(key, params);
    t.has = (key: string) => resolve(key) !== undefined;
    return t;
  },
  getLocale: async () => 'en',
  getMessages: async () => allMessages,
  getRequestConfig: (fn: any) => fn,
}));

// Mock localStorage/sessionStorage for Zustand persist middleware
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
Object.defineProperty(globalThis, 'sessionStorage', { value: createMockStorage(), writable: true });

// Mock next/dynamic
vi.mock('next/dynamic', () => ({
  default: (loader: () => Promise<any>) => {
    // Return a simple component that renders nothing
    const DynamicComponent = (props: any) => null;
    DynamicComponent.displayName = 'DynamicComponent';
    return DynamicComponent;
  },
}));

// Mock framer-motion
vi.mock('framer-motion', () => ({
  motion: new Proxy(
    {},
    {
      get: (_target, prop) => {
        // Return a forwardRef component for each HTML element
        const Component = ({ children, ...props }: any) => {
          const {
            initial,
            animate,
            exit,
            transition,
            variants,
            whileHover,
            whileTap,
            layout,
            layoutId,
            ...htmlProps
          } = props;
          const tag = String(prop);
          if (tag === 'div') return <div {...htmlProps}>{children}</div>;
          if (tag === 'span') return <span {...htmlProps}>{children}</span>;
          if (tag === 'button') return <button {...htmlProps}>{children}</button>;
          if (tag === 'nav') return <nav {...htmlProps}>{children}</nav>;
          if (tag === 'aside') return <aside {...htmlProps}>{children}</aside>;
          return <div {...htmlProps}>{children}</div>;
        };
        Component.displayName = `motion.${String(prop)}`;
        return Component;
      },
    },
  ),
  AnimatePresence: ({ children }: any) => children,
  useMotionValue: () => ({ set: vi.fn(), get: () => 0 }),
  useTransform: () => ({ set: vi.fn(), get: () => 0 }),
}));

// Mock window.matchMedia when a DOM-like window exists
if (typeof window !== 'undefined') {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    value: vi.fn(),
    writable: true,
    configurable: true,
  });

  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('prefers-color-scheme: dark'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

class ResizeObserverMock {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

class IntersectionObserverMock {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

Object.defineProperty(globalThis, 'ResizeObserver', {
  value: ResizeObserverMock,
  writable: true,
  configurable: true,
});

Object.defineProperty(globalThis, 'IntersectionObserver', {
  value: IntersectionObserverMock,
  writable: true,
  configurable: true,
});

// Mock clipboard (configurable so user-event can redefine it) when navigator exists
if (typeof navigator !== 'undefined') {
  Object.defineProperty(navigator, 'clipboard', {
    value: {
      writeText: vi.fn().mockResolvedValue(undefined),
      readText: vi.fn().mockResolvedValue(''),
      read: vi.fn().mockResolvedValue([]),
      write: vi.fn().mockResolvedValue(undefined),
    },
    writable: true,
    configurable: true,
  });
}

// Mock lucide-react with a synchronous Proxy — every PascalCase property
// returns a lightweight SVG stub with data-testid="icon-{name}".
// This avoids vi.importActual() which fails silently under happy-dom forks pool.
vi.mock('lucide-react', () => {
  const iconCache = new Map<string, React.FC<any>>();

  // Match real lucide-react's toKebabCase: "AlertTriangle" → "alert-triangle"
  function toKebabCase(str: string): string {
    return str
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .toLowerCase()
      .trim();
  }

  function getStubIcon(name: string): React.FC<any> {
    let icon = iconCache.get(name);
    if (!icon) {
      const testId = `icon-${name.toLowerCase()}`;
      const kebab = toKebabCase(name);
      icon = ({ className, ...rest }: Record<string, unknown>) => (
        <svg
          data-testid={testId}
          className={['lucide', `lucide-${kebab}`, className].filter(Boolean).join(' ')}
          {...rest}
        >
          <title>{name}</title>
        </svg>
      );
      (icon as any).displayName = name;
      iconCache.set(name, icon);
    }
    return icon;
  }

  const handler: ProxyHandler<Record<string, unknown>> = {
    get(target, prop) {
      // Check target first for pre-populated icons
      if (prop in target) {
        return target[prop as keyof typeof target];
      }
      if (prop === '__esModule') return true;
      if (prop === 'default') return new Proxy(target, handler);
      if (typeof prop === 'symbol') return undefined;
      const name = String(prop);
      // PascalCase names are icon components
      if (/^[A-Z]/.test(name)) return getStubIcon(name);
      // createLucideIcon helper — return a factory that produces stubs
      if (name === 'createLucideIcon') {
        return (iconName: string) => getStubIcon(iconName);
      }
      return undefined;
    },
    has(_target, prop) {
      // Tell vitest/ESM that any PascalCase export exists
      if (typeof prop === 'string' && /^[A-Z]/.test(prop)) return true;
      if (prop === '__esModule' || prop === 'default' || prop === 'createLucideIcon') return true;
      return false;
    },
    ownKeys(target) {
      // Return pre-populated keys plus standard exports
      return ['__esModule', 'default', 'createLucideIcon', ...Object.keys(target)];
    },
    getOwnPropertyDescriptor(target, prop) {
      if (prop === '__esModule' || prop === 'default' || prop === 'createLucideIcon') {
        return { configurable: true, enumerable: true, value: undefined };
      }
      if (typeof prop === 'string' && prop in target) {
        return {
          configurable: true,
          enumerable: true,
          writable: true,
          value: target[prop as keyof typeof target],
        };
      }
      // For PascalCase names (icons), report them as existing
      if (typeof prop === 'string' && /^[A-Z]/.test(prop)) {
        return { configurable: true, enumerable: true, writable: true, value: undefined };
      }
      return undefined;
    },
  };

  // Pre-populate icons that need to be statically available for vitest
  const baseObject = {
    Pin: getStubIcon('Pin'),
  };

  return new Proxy(baseObject, handler);
});

// Mock server-only — Next.js package that prevents server code from running in client bundles
// In tests, we want it to be a no-op since we're not actually running in a browser
vi.mock('server-only', () => ({}));
