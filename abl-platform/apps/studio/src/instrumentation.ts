/**
 * Next.js Instrumentation Hook
 *
 * Called once when the Next.js server starts. Keep startup work here light so
 * Studio can become ready before optional backends (for example MongoDB) finish
 * connecting; DB-backed routes call ensureDb() lazily when they actually need it.
 *
 * @see https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

export async function register() {
  // Only run on the server (not in edge runtime)
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Load configuration before initializing Redis (config is lazy-loaded)
    const { loadConfig } = await import('@/config');
    await loadConfig();

    // Initialize Redis client (non-blocking — falls back gracefully if unavailable)
    const { initializeRedis } = await import('@/lib/redis-client');
    await initializeRedis();
  }
}
