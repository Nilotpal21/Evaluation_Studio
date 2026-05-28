import { vi } from 'vitest';

const nativeFetch = globalThis.fetch;

if (nativeFetch) {
  Object.defineProperty(globalThis, '__nativeFetch', {
    value: nativeFetch,
    writable: false,
    configurable: false,
    enumerable: false,
  });
}

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

// Allow server-only modules to load in route/unit tests outside Next.js server runtime.
vi.mock('server-only', () => ({}));
