// Browser stub for Node.js crypto module.
// Prevents crypto-browserify (which uses eval/vm-browserify) from being bundled
// into client chunks, which would violate the production CSP script-src policy.
//
// These stubs are only reached if server-only code is accidentally pulled into
// client bundles via barrel imports. They throw at runtime to catch misuse early.

function notAvailable(name: string): never {
  throw new Error(`crypto.${name}() is not available in the browser`);
}

export function createHash() {
  return notAvailable('createHash');
}
export function createHmac() {
  return notAvailable('createHmac');
}
export function randomBytes() {
  return notAvailable('randomBytes');
}
export function randomUUID(): string {
  // Web Crypto API is available in all modern browsers
  return globalThis.crypto.randomUUID();
}
export function pbkdf2() {
  return notAvailable('pbkdf2');
}
export function pbkdf2Sync() {
  return notAvailable('pbkdf2Sync');
}

export default {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  pbkdf2,
  pbkdf2Sync,
};
