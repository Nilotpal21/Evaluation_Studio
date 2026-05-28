/**
 * Bootstrap entrypoint for the pipeline engine.
 *
 * Sets MONGODB_URL before any module that triggers the database barrel's
 * auto-connect is loaded. ESM hoists static imports so env vars set in
 * module body run AFTER dependencies evaluate. This bootstrap uses a
 * dynamic import to guarantee the env var is set first.
 */
if (!process.env.MONGODB_URL) {
  throw new Error(
    'MONGODB_URL environment variable is required. Set it before starting the pipeline engine.',
  );
}

if (!process.env.ENCRYPTION_MASTER_KEY) {
  throw new Error(
    'ENCRYPTION_MASTER_KEY environment variable is required. Set it before starting the pipeline engine.',
  );
}

await import('./server.js');
