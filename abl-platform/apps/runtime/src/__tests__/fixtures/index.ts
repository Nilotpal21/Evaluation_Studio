import { readFileSync } from 'fs';
import { join } from 'path';

const fixtureDir = new URL('.', import.meta.url).pathname;
const cache = new Map<string, string>();

export function loadFixture(name: string): string {
  if (cache.has(name)) return cache.get(name)!;
  const content = readFileSync(join(fixtureDir, `${name}.abl`), 'utf-8');
  cache.set(name, content);
  return content;
}

export function loadFixturePair(name: string): [string, string] {
  const content = loadFixture(name);
  const parts = content.split(/\n---\n/);
  if (parts.length !== 2) {
    throw new Error(
      `Fixture '${name}' expected 2 DSL blocks separated by ---, found ${parts.length}`,
    );
  }
  return [parts[0].trim(), parts[1].trim()];
}
