// Empty module — browser-side stub for Node.js-only modules (fs, path).
// Turbopack requires named exports to match the imported module's API.
// WARNING: These stubs return dummy values. If code depends on correct
// fs/path behavior in the browser, it will silently produce wrong results.

// path module stubs
export function resolve(...args: string[]): string {
  return args.join('/');
}
export function dirname(p: string): string {
  return p;
}
export function join(...args: string[]): string {
  return args.join('/');
}
export function basename(p: string): string {
  return p;
}
export function extname(p: string): string {
  return '';
}
export const sep = '/';

// fs module stubs
export function readFileSync(): string {
  return '';
}
export function existsSync(): boolean {
  return false;
}
export function readdirSync(): string[] {
  return [];
}
export const promises = {
  readFile: async () => '',
  readdir: async () => [],
  stat: async () => ({}),
};

export default {};
