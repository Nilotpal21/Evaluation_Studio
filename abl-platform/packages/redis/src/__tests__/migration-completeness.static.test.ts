/**
 * INT-13 + INT-14 + INT-15 + INT-16 + INT-17 + INT-18 — Migration Completeness (static guards).
 *
 * Static checks against the entire `apps/` and `packages/` tree:
 *
 *   INT-14: no production code calls `.keys(pattern)` on a Redis-shaped
 *   receiver. Top-level KEYS returns partial results in Redis Cluster
 *   (silent data loss) — every consumer must use `scanKeys()` from
 *   `@agent-platform/redis` instead.
 *
 *   INT-13: no production code calls `.duplicate(...)` on a Redis-shaped
 *   receiver. ioredis Cluster does not expose `.duplicate()` — every
 *   consumer must use `createSubscriber(handle)` or `createBullMQPair(handle)`
 *   from `@agent-platform/redis` instead. `handle.duplicate(...)` on a
 *   `RedisConnectionHandle` is allowed (the helper is cluster-aware).
 *
 *   INT-15: no production code outside `packages/redis/src/` instantiates
 *   `new Redis(...)` directly. In cluster mode this bypasses cluster
 *   routing entirely — use `createRedisConnection()` instead.
 *
 *   INT-16: no production code calls `.scan()` on a Redis-shaped receiver.
 *   In cluster mode `client.scan(cursor)` only scans a single node —
 *   use `scanKeys()` from `@agent-platform/redis` instead.
 *
 *   INT-17: no production code outside `packages/redis/src/` calls
 *   `resolveBullMQConnectionFromEnv()`. It returns `null` in cluster
 *   mode, silently disabling all BullMQ queues — use
 *   `createBullMQPair(handle)` instead.
 *
 * ESLint catches the common cases at edit time; these tests are the
 * authoritative backstop in CI.
 *
 * Receiver pattern observed in the 10 production sites that this rule guards:
 *   - `redis.keys(p)`         — local var named `redis`
 *   - `client.keys(p)`        — local var named `client`
 *   - `redisClient.keys(p)`   — local var named `redisClient`
 *   - `this.redis.keys(p)`    — instance field `redis`
 *   - `this.client.keys(p)`   — instance field `client`
 *   - `this.redisClient.keys(p)` — instance field `redisClient`
 *
 * Excluded scopes:
 *   - `__tests__/` — tests intentionally exercise mocked redis behaviour.
 *   - `packages/redis/src/` — the helpers themselves implement SCAN against
 *     `.scan()` and don't violate the rule, but defining ground-truth here
 *     keeps the regex from chasing its own tail.
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../../..');

describe('INT-14 — no top-level KEYS in production code', () => {
  it('no production .ts file calls .keys(pattern) on a redis-shaped receiver', () => {
    let stdout = '';
    try {
      stdout = execSync(
        `grep -rEn '(redis|redisClient|client)\\.keys\\(' apps packages --include='*.ts' \
          | grep -v __tests__ \
          | grep -v 'packages/redis/src/' \
          || true`,
        { cwd: REPO_ROOT, encoding: 'utf8' },
      );
    } catch (err) {
      // grep exits non-zero when no matches found; with `|| true` upstream this
      // shouldn't happen, but guard against unexpected errors anyway.
      stdout = (err as { stdout?: string }).stdout ?? '';
    }
    const offenders = stdout
      .split('\n')
      .filter((line) => line.trim().length > 0)
      // Filter out comments — only flag actual call sites.
      .filter((line) => !/^[^:]+:\d+:\s*(?:\/\/|\*|\/\*)/.test(line))
      // Filter out type definitions (`keys(pattern: string): Promise<...>`).
      .filter((line) => !/keys\(\s*pattern\s*:/.test(line))
      // Filter out string literals containing `.keys(` (e.g., error messages).
      .filter((line) => !/['"`][^'"`]*\.keys\(/.test(line));

    expect(offenders, 'Top-level KEYS call sites found:\n' + offenders.join('\n')).toEqual([]);
  }, 30_000);
});

describe('INT-13 — no .duplicate() on a redis-shaped receiver in production code', () => {
  it('no production .ts file calls .duplicate() on redis|client|redisClient|subscriber', () => {
    let stdout = '';
    try {
      stdout = execSync(
        `grep -rEn '(^|[^a-zA-Z0-9_])(redis|redisClient|client|subscriber)\\.duplicate\\(' apps packages --include='*.ts' \
          | grep -v __tests__ \
          | grep -v 'packages/redis/src/' \
          || true`,
        { cwd: REPO_ROOT, encoding: 'utf8' },
      );
    } catch (err) {
      stdout = (err as { stdout?: string }).stdout ?? '';
    }
    const offenders = stdout
      .split('\n')
      .filter((line) => line.trim().length > 0)
      // Filter out single-line comments and block comment continuations.
      .filter((line) => !/^[^:]+:\d+:\s*(?:\/\/|\*|\/\*)/.test(line))
      // Filter out string literals containing `.duplicate(` (error messages, doc strings).
      .filter((line) => !/['"`][^'"`]*\.duplicate\(/.test(line))
      // Filter out type/interface declarations like `duplicate(opts?): RedisClient`.
      .filter((line) => !/duplicate\(\s*[a-zA-Z_]+\s*[?:]/.test(line))
      // Filter out lines explicitly opted out via eslint-disable.
      .filter((line) => !/eslint-disable[^:]*no-restricted-syntax/.test(line))
      // Filter the lines IMMEDIATELY following an eslint-disable-next-line directive.
      // Pattern: any line whose preceding line in the same file ends with the disable.
      // Implementation: look up the file at the cited line number and check line N-1.
      .filter((line) => {
        const m = /^([^:]+):(\d+):/.exec(line);
        if (!m) return true;
        const [, file, lineStr] = m;
        const lineNum = parseInt(lineStr, 10);
        if (lineNum <= 1) return true;
        try {
          const content = execSync(`sed -n '${lineNum - 1}p' "${file}"`, {
            cwd: REPO_ROOT,
            encoding: 'utf8',
          });
          if (/eslint-disable-next-line[^:]*no-restricted-syntax/.test(content)) return false;
        } catch {
          /* ignore */
        }
        return true;
      });

    expect(
      offenders,
      '.duplicate() on redis-shaped receiver found:\n' + offenders.join('\n'),
    ).toEqual([]);
  }, 30_000);
});

describe('INT-15 — no direct ioredis clients outside packages/redis', () => {
  it('no production .ts file imports or instantiates ioredis directly (use createRedisConnection instead)', () => {
    // First pass: catch `new Redis(` and `new IORedis(` constructor calls
    let stdout = '';
    try {
      stdout = execSync(
        `grep -rEn '\\bnew (Redis|IORedis)\\(' apps packages --include='*.ts' \
          | grep -v __tests__ \
          | grep -v 'packages/redis/src/' \
          | grep -v 'node_modules' \
          | grep -v '/dist/' \
          | grep -v '\\.next/' \
          || true`,
        { cwd: REPO_ROOT, encoding: 'utf8' },
      );
    } catch (err) {
      stdout = (err as { stdout?: string }).stdout ?? '';
    }

    // Second pass: catch cast-then-construct patterns like `new (IORedis as any)(opts)`
    // or `new (Redis as any)(opts)`
    let stdout2 = '';
    try {
      stdout2 = execSync(
        `grep -rEn 'new \\(IORedis|new \\(Redis|new (RedisConstructor|RedisCtor|IORedisConstructor|IORedisCtor)\\(' apps packages --include='*.ts' \
          | grep -v __tests__ \
          | grep -v 'packages/redis/src/' \
          | grep -v 'node_modules' \
          | grep -v '/dist/' \
          | grep -v '\\.next/' \
          || true`,
        { cwd: REPO_ROOT, encoding: 'utf8' },
      );
    } catch (err) {
      stdout2 = (err as { stdout?: string }).stdout ?? '';
    }

    // Third pass: direct imports are forbidden too. Dynamic imports can hide
    // constructor aliases from the `new Redis(...)` checks above.
    let stdout3 = '';
    try {
      stdout3 = execSync(
        `grep -rEn "from ['\\"]ioredis['\\"]|require\\(['\\"]ioredis['\\"]\\)|import\\(['\\"]ioredis['\\"]\\)" apps packages --include='*.ts' \
          | grep -v __tests__ \
          | grep -v 'packages/redis/src/' \
          | grep -v 'node_modules' \
          | grep -v '/dist/' \
          | grep -v '\\.next/' \
          || true`,
        { cwd: REPO_ROOT, encoding: 'utf8' },
      );
    } catch (err) {
      stdout3 = (err as { stdout?: string }).stdout ?? '';
    }
    stdout = stdout + '\n' + stdout2 + '\n' + stdout3;

    const offenders = stdout
      .split('\n')
      .filter((line) => line.trim().length > 0)
      // Filter out single-line comments, block comment continuations, and JSDoc lines
      .filter((line) => !/^[^:]+:\d+:\s*(?:\/\/|\*|\/\*)/.test(line))
      .filter(
        (line) =>
          /new\s*(?:\((?:Redis|IORedis)\b|(?:Redis|IORedis)\s*\()/.test(line) ||
          /new\s+(?:RedisConstructor|RedisCtor|IORedisConstructor|IORedisCtor)\s*\(/.test(line) ||
          /from ['"]ioredis['"]|require\(['"]ioredis['"]\)|import\(['"]ioredis['"]\)/.test(line),
      );

    expect(
      offenders,
      'Direct ioredis imports or constructor calls found:\n' + offenders.join('\n'),
    ).toEqual([]);
  }, 30_000);
});

describe('INT-16 — no direct .scan() on a redis-shaped receiver', () => {
  it('no production .ts file calls .scan() on redis|client|redisClient (use scanKeys() instead)', () => {
    let stdout = '';
    try {
      stdout = execSync(
        `grep -rEn '(redis|redisClient|client)\\.scan\\(' apps packages --include='*.ts' \
          | grep -v __tests__ \
          | grep -v 'packages/redis/src/' \
          | grep -v 'node_modules' \
          | grep -v '/dist/' \
          || true`,
        { cwd: REPO_ROOT, encoding: 'utf8' },
      );
    } catch (err) {
      stdout = (err as { stdout?: string }).stdout ?? '';
    }
    const offenders = stdout
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .filter((line) => !/^[^:]+:\d+:\s*(?:\/\/|\*|\/\*)/.test(line))
      .filter((line) => !/['"`][^'"`]*\.scan\(/.test(line));

    expect(
      offenders,
      'Direct .scan() on redis-shaped receiver found:\n' + offenders.join('\n'),
    ).toEqual([]);
  }, 30_000);
});

describe('INT-18 — no hardcoded BullMQ prefix strings outside packages/redis', () => {
  it('no production .ts file uses a hardcoded prefix: string instead of BULLMQ_CLUSTER_SAFE_PREFIX', () => {
    // Catches `prefix: '{bull}'`, `prefix: 'bull'`, and template-literal equivalents.
    // The only allowed pattern is `prefix: BULLMQ_CLUSTER_SAFE_PREFIX` (or
    // `prefix: BULLMQ_LEGACY_PREFIX` if deliberately opting into standalone-only).
    let stdout = '';
    try {
      stdout = execSync(
        `grep -rEn "prefix:\\s*['\\"]\\.?\\{?bull\\}?['\\"']" apps packages --include='*.ts' \
          | grep -v __tests__ \
          | grep -v 'packages/redis/src/' \
          | grep -v 'node_modules' \
          | grep -v '/dist/' \
          | grep -v '\\.next/' \
          || true`,
        { cwd: REPO_ROOT, encoding: 'utf8' },
      );
    } catch (err) {
      stdout = (err as { stdout?: string }).stdout ?? '';
    }
    const offenders = stdout
      .split('\n')
      .filter((line) => line.trim().length > 0)
      // Filter out comments
      .filter((line) => !/^[^:]+:\d+:\s*(?:\/\/|\*|\/\*)/.test(line))
      // Filter out string literals inside error messages or doc strings
      .filter((line) => !/['"`][^'"`]*prefix:/.test(line));

    expect(
      offenders,
      'Hardcoded BullMQ prefix strings found — use BULLMQ_CLUSTER_SAFE_PREFIX from @agent-platform/redis:\n' +
        offenders.join('\n'),
    ).toEqual([]);
  }, 30_000);
});

describe('INT-17 — no resolveBullMQConnectionFromEnv outside packages/redis', () => {
  it('no app code calls resolveBullMQConnectionFromEnv (use createBullMQPair(handle) for cluster support)', () => {
    let stdout = '';
    try {
      stdout = execSync(
        `grep -rEn 'resolveBullMQConnectionFromEnv' apps packages --include='*.ts' \
          | grep -v __tests__ \
          | grep -v 'packages/redis/src/' \
          | grep -v 'node_modules' \
          | grep -v '/dist/' \
          || true`,
        { cwd: REPO_ROOT, encoding: 'utf8' },
      );
    } catch (err) {
      stdout = (err as { stdout?: string }).stdout ?? '';
    }
    const offenders = stdout
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .filter((line) => !/^[^:]+:\d+:\s*(?:\/\/|\*|\/\*)/.test(line))
      .filter((line) => !/['"`][^'"`]*resolveBullMQConnectionFromEnv/.test(line));

    expect(
      offenders,
      'resolveBullMQConnectionFromEnv usage found:\n' + offenders.join('\n'),
    ).toEqual([]);
  }, 30_000);
});
