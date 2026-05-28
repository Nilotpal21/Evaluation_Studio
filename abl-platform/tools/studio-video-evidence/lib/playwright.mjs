import { pathToFileURL } from 'node:url';
import { PLAYWRIGHT_ENTRY } from './constants.mjs';

let playwrightModulePromise = null;

export async function loadPlaywright() {
  if (!playwrightModulePromise) {
    playwrightModulePromise = import(pathToFileURL(PLAYWRIGHT_ENTRY).href);
  }
  return playwrightModulePromise;
}
