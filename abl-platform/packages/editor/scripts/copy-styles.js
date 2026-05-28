/**
 * Copy CSS styles to dist folder after build
 */

import { copyFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcPath = join(__dirname, '../src/styles.css');
const distPath = join(__dirname, '../dist/styles.css');

// Ensure dist directory exists
const distDir = dirname(distPath);
if (!existsSync(distDir)) {
  mkdirSync(distDir, { recursive: true });
}

// Copy the file
copyFileSync(srcPath, distPath);
console.log('Copied styles.css to dist/');
