/**
 * PM2 Ecosystem Configuration for ABL Platform
 *
 * Usage:
 *   pm2 start ecosystem.config.js                  — install + build + start all (dev)
 *   pm2 start ecosystem.config.js --env production  — install + build + start all (prod)
 *   pm2 start ecosystem.config.js --only abl-runtime — single app
 *
 * Skipping setup:
 *   SKIP_SETUP=1 pm2 start ecosystem.config.js     — skip install/build, just start
 *
 * Development mode uses tsx (live TypeScript) and next dev (HMR).
 * Production mode uses pre-built dist/ artifacts and next start.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const isDev = (process.env.NODE_ENV || 'development') !== 'production';

// =============================================================================
// AUTO-SETUP: install + build before PM2 starts any apps
// =============================================================================
if (!process.env.SKIP_SETUP) {
  console.log('\n========== ABL Platform Setup ==========\n');

  // 1. Create logs directory
  const logsDir = path.join(ROOT, 'logs');
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
    console.log('[setup] Created logs/ directory');
  }

  // 2. Install dependencies
  console.log('[setup] Running pnpm install...');
  try {
    execSync('pnpm install --frozen-lockfile', { stdio: 'inherit', cwd: ROOT });
  } catch {
    // frozen-lockfile can fail if lockfile is outdated, fall back to regular install
    console.log('[setup] Lockfile outdated, running pnpm install...');
    execSync('pnpm install', { stdio: 'inherit', cwd: ROOT });
  }

  // 3. Build all packages (required for production mode and compiled packages)
  if (!isDev) {
    console.log('[setup] Running pnpm build...');
    execSync('pnpm build', { stdio: 'inherit', cwd: ROOT });
  } else {
    // In dev mode, still build packages (not apps) since tsx only covers apps
    console.log('[setup] Building packages for dev mode...');
    execSync('pnpm build', { stdio: 'inherit', cwd: ROOT });
  }

  console.log('\n========== Setup Complete ==========\n');
}

// =============================================================================
// SERVICE REGISTRY — all apps and their config
// =============================================================================

/**
 * Express/Node services (run via tsx in dev, dist/index.js in prod)
 */
const nodeServices = [
  {
    name: 'abl-runtime',
    dir: 'apps/runtime',
    port: 3112,
    mem: '1G',
    killTimeout: 15000,
    devHost: '0.0.0.0',
  },
  {
    name: 'abl-template-store',
    dir: 'apps/template-store',
    port: 3115,
    mem: '512M',
    killTimeout: 15000,
  },
  { name: 'abl-search-ai', dir: 'apps/search-ai', port: 3005, mem: '1G', killTimeout: 15000 },
  {
    name: 'abl-search-ai-runtime',
    dir: 'apps/search-ai-runtime',
    port: 3004,
    mem: '1G',
    killTimeout: 15000,
  },
  {
    name: 'abl-multimodal',
    dir: 'apps/multimodal-service',
    port: 3006,
    mem: '1G',
    killTimeout: 15000,
  },
];

/**
 * Next.js services (run via next dev/start)
 */
const nextServices = [
  {
    name: 'abl-studio',
    dir: 'apps/studio',
    port: 5173,
    mem: '512M',
    devArgs: 'dev --webpack -p 5173',
  },
  {
    name: 'abl-admin',
    dir: 'apps/admin',
    port: 3003,
    mem: '512M',
    devArgs: 'dev --webpack -p 3003',
  },
  { name: 'abl-docs-internal', dir: 'apps/docs-internal', port: 3007, mem: '256M' },
];

// =============================================================================
// APP GENERATORS
// =============================================================================

function makeNodeApp({ name, dir, port, mem, killTimeout, devHost }) {
  return {
    name,
    script: isDev ? 'src/index.ts' : 'dist/index.js',
    interpreter: isDev ? path.join(ROOT, 'node_modules/.bin/tsx') : 'node',
    cwd: path.join(ROOT, dir),

    node_args: isDev ? undefined : '--enable-source-maps',
    instances: 1,
    exec_mode: 'fork',
    autorestart: !isDev,
    watch: false,
    max_memory_restart: mem,

    kill_timeout: killTimeout,
    listen_timeout: isDev ? 30000 : 10000,

    out_file: path.join(ROOT, `logs/${name.replace('abl-', '')}-out.log`),
    error_file: path.join(ROOT, `logs/${name.replace('abl-', '')}-error.log`),
    log_date_format: 'YYYY-MM-DD HH:mm:ss.SSS Z',
    merge_logs: true,

    env_development: {
      NODE_ENV: 'development',
      PORT: port,
      HOST: devHost || 'localhost',
      LOG_LEVEL: 'debug',
      DOTENV_CONFIG_PATH: path.join(ROOT, '.env'),
    },
    env_production: {
      NODE_ENV: 'production',
      PORT: port,
      HOST: '0.0.0.0',
      LOG_LEVEL: 'info',
      DOTENV_CONFIG_PATH: path.join(ROOT, '.env'),
    },
  };
}

function makeNextApp({ name, dir, port, mem, devArgs }) {
  return {
    name,
    script: 'node_modules/next/dist/bin/next',
    args: isDev ? (devArgs ?? `dev -p ${port}`) : `start -p ${port}`,
    cwd: path.join(ROOT, dir),

    instances: 1,
    exec_mode: 'fork',
    autorestart: !isDev,
    watch: false,
    max_memory_restart: mem,
    kill_timeout: 5000,

    out_file: path.join(ROOT, `logs/${name.replace('abl-', '')}-out.log`),
    error_file: path.join(ROOT, `logs/${name.replace('abl-', '')}-error.log`),
    log_date_format: 'YYYY-MM-DD HH:mm:ss.SSS Z',
    merge_logs: true,

    env_development: {
      NODE_ENV: 'development',
      PORT: port,
    },
    env_production: {
      NODE_ENV: 'production',
      PORT: port,
      HOSTNAME: '0.0.0.0',
    },
  };
}

// =============================================================================
// EXPORT
// =============================================================================

module.exports = {
  apps: [...nodeServices.map(makeNodeApp), ...nextServices.map(makeNextApp)],
};
