/**
 * Test-only stub for optional peer dependencies (`kerberos`,
 * `@node-saml/node-saml`).
 *
 * @agent-platform/auth-enterprise loads these modules via try/catch
 * dynamic imports at runtime; in environments where the optional
 * packages are not installed it falls back to stub credentials. Vite's
 * static analyzer does not understand the try/catch, so it fails to
 * resolve the bare specifier even though the runtime path is fine.
 * Aliasing the specifier to this empty stub during tests lets vitest
 * load files that transitively import auth-enterprise without changing
 * production behavior.
 */

export {};
