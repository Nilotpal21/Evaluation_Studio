/**
 * Config Sealer
 *
 * Deep-freezes config objects to prevent accidental mutation.
 * In dev mode, wraps with a Proxy for informative error messages.
 */

/**
 * Recursively deep-freeze an object.
 */
export function deepFreeze<T extends object>(obj: T): Readonly<T> {
  const propNames = Object.getOwnPropertyNames(obj) as (keyof T)[];

  for (const name of propNames) {
    const value = obj[name];
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      deepFreeze(value as object);
    }
  }

  return Object.freeze(obj);
}

/**
 * Seal a config object. In development, uses a Proxy that throws
 * descriptive errors on mutation. In production, uses deep-freeze.
 */
export function sealConfig<T extends object>(config: T, isDev: boolean = false): Readonly<T> {
  // Always clone to avoid mutating the original
  const cloned = structuredClone(config);

  if (!isDev) {
    return deepFreeze(cloned);
  }

  // Dev mode: wrap with Proxy for better error messages.
  // Don't freeze — the Proxy itself prevents mutation and gives
  // descriptive error messages. Freezing + Proxy causes invariant
  // violations when the get trap returns wrapped objects.
  return createReadOnlyProxy(cloned) as Readonly<T>;
}

function createReadOnlyProxy<T extends object>(obj: T): T {
  return new Proxy(obj, {
    set(_target, prop) {
      throw new Error(
        `[Config] Cannot modify config property "${String(prop)}". ` +
          `Configuration is sealed. Use reloadConfig() to update values.`,
      );
    },
    deleteProperty(_target, prop) {
      throw new Error(
        `[Config] Cannot delete config property "${String(prop)}". ` + `Configuration is sealed.`,
      );
    },
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return createReadOnlyProxy(value as object);
      }
      return value;
    },
  });
}
