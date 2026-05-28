# Hook Enforcement Quality Gate Audit

**Date**: 2026-03-25
**Auditor**: Phase Auditor
**Scope**: Full audit of PreToolUse hook batch (13 hooks: 10 new/fixed + 3 infrastructure fixes)
**Artifact**: `.claude/settings.json`, `.claude/hooks/*.sh`, `CLAUDE.md` Key Rules section

---

## VERDICT: NEEDS_REVISION

3 CRITICAL findings, 5 HIGH findings, 6 MEDIUM findings, 2 LOW findings.

---

## 1. Hook Protocol Correctness

### CRITICAL

**[HK-01] `prettier-before-commit.sh` swallows errors, defeating its own purpose**

- Location: `.claude/hooks/prettier-before-commit.sh` line 27
- Issue: `npx prettier --write 2>/dev/null` suppresses all stderr. If prettier fails (e.g., unparseable syntax in a staged file), the error is hidden and the hook exits 0, allowing the commit to proceed with unformatted files. Lint-staged then runs `prettier --check`, fails, and triggers the stash/restore cycle that **silently reverts uncommitted edits** -- the exact data loss scenario this hook was designed to prevent.
- Fix: Remove `2>/dev/null` or at minimum capture the exit code and block the commit if prettier fails:
  ```bash
  if ! echo "$STAGED_FILES" | xargs npx prettier --write; then
    echo "BLOCKED: prettier --write failed on staged files. Fix syntax errors first."
    exit 2
  fi
  ```

**[HK-02] `package-deletion-guard.sh` has bypass via `rm -Rf` (capital R) and `rm -r -f` (separate flags)**

- Location: `.claude/hooks/package-deletion-guard.sh` line 25
- Issue: The regex `(-[a-zA-Z]*r[a-zA-Z]*\s+)+` requires lowercase `r` inside a single flag group. Tested and confirmed:
  - `rm -rf packages/foo` -- BLOCKED (correct)
  - `rm -Rf packages/foo` -- NOT BLOCKED (capital R variant)
  - `rm -r -f packages/foo` -- NOT BLOCKED (separate flags)
  - `rm --recursive packages/foo` -- NOT BLOCKED (long flag)
  - `find packages/foo -exec rm {} +` -- NOT BLOCKED (find+exec bypass)
- Fix: The regex should be case-insensitive (`-i` flag on grep) and also match `--recursive`:
  ```bash
  if echo "$COMMAND" | grep -iqE '(rm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+|--recursive\s+)+(\.\/)?((packages|apps)\/[a-zA-Z])|git\s+rm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+|--recursive\s+)*(\.\/)?((packages|apps)\/[a-zA-Z]))'; then
  ```
  Also handle separate flags pattern: `rm -r -f` (match `(-\w+\s+)*` before the path).

**[HK-03] `stale-mock-warn.sh` exits 2 (BLOCK) but its name and CLAUDE.md describe it as a "warning"**

- Location: `.claude/hooks/stale-mock-warn.sh` line 153
- Issue: Exit code 2 is a hard block. The hook's filename is `stale-mock-warn.sh`, its CLAUDE.md entry says "warns when signature edits have corresponding test files", and its output says "WARNING:". But exit 2 means the agent cannot proceed with a source file edit until it also edits test files -- which may require reading the test file first. This turns every signature change into a mandatory two-step operation even when the agent plans to update tests immediately after.
- Impact: This could cause friction where the agent is forced to update test files before it even finishes the source edit, potentially in the wrong order (test first, then source = stale tests anyway).
- Fix: Either (a) change to exit 0 to make it a genuine warning (consistent with name/docs), or (b) rename to `stale-mock-guard.sh` and update CLAUDE.md to say "blocks" instead of "warns". Option (a) is recommended since the agent may legitimately need to finish the source edit before updating tests.

### HIGH

**[HK-04] `swallowed-catch-lint.sh` only detects single-line `.catch(() => {})` patterns**

- Location: `.claude/hooks/swallowed-catch-lint.sh` lines 47-50
- Issue: The regex only matches when the entire `.catch(() => {})` is on a single line. Tested and confirmed these patterns evade detection:
  - Multiline empty body: `.catch((err) => {\n  \n})` -- NOT DETECTED
  - Comment-only body: `.catch((err) => { /* ignore */ })` -- NOT DETECTED
  - `try { } catch(e) { }` with empty body -- NOT DETECTED (different pattern, but same anti-pattern)
- The multiline gap is the most concerning since agents sometimes format code across lines.
- Fix: For the comment-only body case, strip comments before checking. For multiline, this is inherently hard with line-by-line grep but could be improved with a pattern that uses `-P` (PCRE) or processes the content as a single string.

**[HK-05] `console-log-lint.sh` false-positives on client-side packages (`packages/web-sdk/`, `packages/admin-ui/`, `packages/design-tokens/`)**

- Location: `.claude/hooks/console-log-lint.sh` lines 47-53
- Issue: The hook skips `apps/studio/` but treats ALL `packages/*` as server-side code. Client-side packages like `packages/web-sdk/` (browser SDK), `packages/admin-ui/` (React component library), and `packages/design-tokens/` (CSS/design tokens) would be incorrectly blocked from using `console.log`. A browser SDK legitimately needs console output for debugging.
- Fix: Add exclusions for known client-side packages:
  ```bash
  if echo "$FILE_PATH" | grep -qE 'packages/(web-sdk|admin-ui|design-tokens)/'; then
    exit 0
  fi
  ```

**[HK-06] `custom-auth-lint.sh` does not detect `jose` library (alternative JWT library already in use)**

- Location: `.claude/hooks/custom-auth-lint.sh` lines 52, 63
- Issue: The hook blocks `jsonwebtoken` imports and `jwt.verify()` calls but does not detect `jose` library usage (`jwtVerify`, `import from 'jose'`). The admin app at `apps/admin/src/lib/with-admin-route.ts` already uses `jose` for JWT verification outside the shared-auth package. If the intent is to centralize ALL JWT verification, `jose` should also be detected. If admin has a legitimate exception, that path should be explicitly allowed.
- Fix: Either (a) add `jose` detection patterns and add `apps/admin/src/lib/with-admin-route.ts` to the allow list, or (b) document that only `jsonwebtoken` is blocked and `jose` is permitted. Current state is inconsistent with the stated goal of "centralized auth only."

**[HK-07] `sync-io-lint.sh` will block legitimate sync I/O in production code**

- Location: `.claude/hooks/sync-io-lint.sh` lines 28-31
- Issue: The hook skips `/scripts/` and `/cli/` but does not skip startup/config loading code that legitimately uses sync I/O. Confirmed files that would be blocked:
  - `packages/eventstore/src/resilience/filesystem-wal.ts` -- Write-ahead log using sync I/O for durability (intentional)
  - `packages/pipeline-engine/src/pipeline/trigger-registry.ts` -- Likely startup config
  - `packages/redis/src/connection.ts` -- Connection setup
- Fix: Add a comment-based opt-out pattern (e.g., `// sync-io-allowed`) or add path exclusions for known legitimate cases. Alternatively, only block `readFileSync`/`writeFileSync` in route handlers and middleware, not in infrastructure packages.

**[HK-08] `empty-response-lint.sh` only checks `routes/`, `handlers/`, `controllers/` directories**

- Location: `.claude/hooks/empty-response-lint.sh` lines 34-37
- Issue: Route handler code may live outside these canonical directories. The hook also does not check `services/` or files with `router` in the name. Additionally, `return {}` is sometimes a legitimate pattern in non-route code (e.g., returning an empty options object). The narrow path filter makes this acceptable for false positive prevention, but reduces coverage.
- Severity modulated because the narrow filter prevents false positives, which is the right tradeoff.

### MEDIUM

**[HK-09] `prettier-before-commit.sh` has a side-effect design concern**

- Location: `.claude/hooks/prettier-before-commit.sh` lines 27-28
- Issue: PreToolUse hooks are conventionally validation-only (read, check, approve/block). This hook mutates the filesystem (`prettier --write`) and git staging area (`git add`) before the commit command runs. While this is intentional (backstop for lint-staged), it means the hook has invisible side effects that could surprise other hooks running in the same batch. If the typecheck hook runs BEFORE prettier, it may type-check unformatted code. If it runs AFTER, it's fine. The ordering in `settings.json` shows prettier (line 134) runs before typecheck (line 138), which is correct.
- Recommendation: Add a comment in `settings.json` documenting that prettier MUST be registered before typecheck in the Bash matcher array.

**[HK-10] `exported-symbol-guard.sh` uses `grep -rl` which scans the entire codebase on every Edit**

- Location: `.claude/hooks/exported-symbol-guard.sh` lines 113-117
- Issue: For every removed export symbol, the hook runs `grep -rl` across all of `apps/` and `packages/`. In a large monorepo, this could add noticeable latency (1-3 seconds per symbol) to every Edit operation on TypeScript files. With multiple removed symbols, this compounds.
- Recommendation: Consider caching or limiting the search scope to the package where the file lives plus known consumers. Or accept the latency as the cost of safety.

**[HK-11] `stale-mock-warn.sh` uses `find` command which may be slow on large codebases**

- Location: `.claude/hooks/stale-mock-warn.sh` line 128
- Issue: The hook runs `find ... -name "${BASENAME}*.test.ts"` which scans the `__tests__` directory tree. In practice this is scoped to a single package's test directory so it should be fast, but `find` on macOS can be slow on large directories.
- Recommendation: Minor concern, no action needed unless latency is observed.

**[HK-12] `console-log-lint.sh` skips all files matching `__tests__` or `.test.ts` but not `.e2e.ts` or `.integration.ts`**

- Location: `.claude/hooks/console-log-lint.sh` line 37
- Issue: If E2E or integration test files are named with `.e2e.ts` or `.integration.ts` suffixes instead of `.test.ts`, they would not be skipped and `console.log` would be blocked. This is a minor concern since the convention in this project appears to use `.test.ts` for all test types.
- Recommendation: Add `.e2e.ts` and `.integration.ts` to the exclusion pattern for completeness.

**[HK-13] `package-deletion-guard.sh` does not validate tool_name**

- Location: `.claude/hooks/package-deletion-guard.sh` lines 13-14
- Issue: The hook extracts `.tool_input.command` without first checking that `tool_name` is `Bash`. Since it's registered on the `Bash` matcher this is not a real problem (it will only fire for Bash tool calls), but for consistency with other hooks it should validate the tool name.
- Recommendation: Add `TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')` and verify it equals "Bash" for defense-in-depth.

**[HK-14] `design-token-lint.sh` exits 0 even on violations (warning only)**

- Location: `.claude/hooks/design-token-lint.sh` line 77
- Issue: The hook prints a warning but exits 0, meaning violations are never blocked. This is explicitly documented in a comment ("Warning only -- exit 0 so it doesn't block") but not reflected in the CLAUDE.md description which says "A PreToolUse hook warns on violations" (correct). This is fine as-is, but should be documented that the hook is advisory-only.
- No action needed, included for completeness.

### LOW

**[HK-15] Multiple hooks extract `file_path` with redundant conditional logic**

- Location: `console-log-lint.sh` lines 19-24, `empty-response-lint.sh` lines 20-25
- Issue: Both hooks have `if [ "$TOOL" = "Write" ]; then FILE_PATH=...; elif [ "$TOOL" = "Edit" ]; then FILE_PATH=...` but both paths extract the same `jq` expression `.tool_input.file_path`. This is functionally correct but needlessly verbose. Other hooks like `custom-auth-lint.sh` correctly use a single extraction.
- Recommendation: Simplify to a single `FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')`.

**[HK-16] Hook output messages are inconsistent in format**

- Issue: Some hooks use `echo ""` for blank lines and structured multi-line output (`console-log-lint.sh`, `custom-auth-lint.sh`), while others use single-line messages (`package-deletion-guard.sh`). Some prefix with "BLOCKED:" while others just describe the violation. This is cosmetic but affects readability.
- Recommendation: Standardize on a format like: `BLOCKED: <summary>` followed by details and a `See CLAUDE.md` reference.

---

## 2. False Positive Risk Assessment

| Hook                         | False Positive Risk | Details                                                                          |
| ---------------------------- | ------------------- | -------------------------------------------------------------------------------- |
| `console-log-lint.sh`        | **HIGH**            | Blocks `console.log` in client-side packages (web-sdk, admin-ui). See HK-05.     |
| `sync-io-lint.sh`            | **HIGH**            | Blocks legitimate sync I/O in eventstore WAL, pipeline-engine. See HK-07.        |
| `swallowed-catch-lint.sh`    | LOW                 | Correctly skips tests. Only matches exact `.catch(() => {})` pattern.            |
| `empty-response-lint.sh`     | LOW                 | Narrow path filter (routes/handlers/controllers only) prevents FPs.              |
| `custom-auth-lint.sh`        | LOW                 | Correctly allows shared-auth and test files.                                     |
| `package-deletion-guard.sh`  | LOW                 | Only triggers on `rm -rf` variants of packages/apps dirs.                        |
| `stale-mock-warn.sh`         | MEDIUM              | Could block edits where agent plans to update tests in the next step. See HK-03. |
| `exported-symbol-guard.sh`   | LOW                 | Checks actual importers before blocking. Well-designed.                          |
| `design-token-lint.sh`       | LOW                 | Warning only (exit 0). Explicit allow-list for special files.                    |
| `prettier-before-commit.sh`  | LOW                 | Only runs on `git commit` commands.                                              |
| `typecheck-before-commit.sh` | LOW                 | Only runs on `git commit` commands.                                              |

---

## 3. False Negative Risk Assessment

| Hook                        | False Negative Risk | Bypass Vectors                                                                               |
| --------------------------- | ------------------- | -------------------------------------------------------------------------------------------- |
| `package-deletion-guard.sh` | **HIGH**            | `rm -Rf`, `rm -r -f`, `rm --recursive`, `find -exec rm`. See HK-02.                          |
| `custom-auth-lint.sh`       | **HIGH**            | `jose` library (already used in admin app), other JWT libs. See HK-06.                       |
| `swallowed-catch-lint.sh`   | **HIGH**            | Multiline empty catch, comment-only catch body. See HK-04.                                   |
| `console-log-lint.sh`       | LOW                 | Comment-line detection works. Block-comment `/* console.log() */` correctly ignored.         |
| `empty-response-lint.sh`    | MEDIUM              | Route handlers outside routes/handlers/controllers dirs. See HK-08.                          |
| `sync-io-lint.sh`           | LOW                 | Comprehensive list of sync API names.                                                        |
| `exported-symbol-guard.sh`  | LOW                 | Re-exports and barrel files could theoretically confuse it, but grep-based search is robust. |
| `stale-mock-warn.sh`        | MEDIUM              | Only fires on Edit, not Write (full file rewrites skip it).                                  |
| `design-token-lint.sh`      | LOW                 | Warning only, so false negatives don't block.                                                |

---

## 4. settings.json Completeness

### Registration Audit

All 26 `.sh` files in `.claude/hooks/` are registered in `settings.json`. No orphan hooks.

| Hook File                     | Registered | Matcher                    | Correct Matcher |
| ----------------------------- | ---------- | -------------------------- | --------------- |
| `zod-id-lint.sh`              | Yes        | Write\|Edit                | Correct         |
| `mongoose-hmr-guard.sh`       | Yes        | Write\|Edit                | Correct         |
| `findbyid-lint.sh`            | Yes        | Write\|Edit                | Correct         |
| `websocket-in-render.sh`      | Yes        | Write\|Edit                | Correct         |
| `unbounded-collections.sh`    | Yes        | Write\|Edit                | Correct         |
| `project-isolation-lint.sh`   | Yes        | Write\|Edit                | Correct         |
| `user-isolation-lint.sh`      | Yes        | Write\|Edit                | Correct         |
| `lean-on-encrypted-models.sh` | Yes        | Write\|Edit                | Correct         |
| `cache-key-completeness.sh`   | Yes        | Write\|Edit                | Correct         |
| `unsafe-error-cast-lint.sh`   | Yes        | Write\|Edit                | Correct         |
| `role-case-lint.sh`           | Yes        | Write\|Edit                | Correct         |
| `e2e-test-quality-lint.sh`    | Yes        | Write\|Edit                | Correct         |
| `exported-symbol-guard.sh`    | Yes        | Write\|Edit                | Correct         |
| `console-log-lint.sh`         | Yes        | Write\|Edit                | Correct         |
| `swallowed-catch-lint.sh`     | Yes        | Write\|Edit                | Correct         |
| `sync-io-lint.sh`             | Yes        | Write\|Edit                | Correct         |
| `empty-response-lint.sh`      | Yes        | Write\|Edit                | Correct         |
| `custom-auth-lint.sh`         | Yes        | Write\|Edit                | Correct         |
| `stale-mock-warn.sh`          | Yes        | Write\|Edit                | Correct         |
| `design-token-lint.sh`        | Yes        | Write\|Edit                | Correct         |
| `dockerfile-copy-check.sh`    | Yes        | Write                      | Correct         |
| `prettier-before-commit.sh`   | Yes        | Bash                       | Correct         |
| `typecheck-before-commit.sh`  | Yes        | Bash                       | Correct         |
| `package-deletion-guard.sh`   | Yes        | Bash                       | Correct         |
| `sdlc-gate-check.sh`          | Yes        | Agent                      | Correct         |
| `verify-implementer.sh`       | Yes        | SubagentStop (implementer) | Correct         |

No duplicate registrations found. No missing hooks.

---

## 5. CLAUDE.md Consistency

### Rules WITH hook enforcement (correctly documented)

| CLAUDE.md Rule                | Hook                         | Documented in CLAUDE.md | Hook behavior matches docs                                |
| ----------------------------- | ---------------------------- | ----------------------- | --------------------------------------------------------- |
| No console.log in server code | `console-log-lint.sh`        | Yes (line 59)           | Yes -- "blocks"                                           |
| No swallowed catches          | `swallowed-catch-lint.sh`    | Yes (line 60)           | Yes -- "blocks"                                           |
| No sync I/O                   | `sync-io-lint.sh`            | Yes (line 62)           | Yes -- "blocks"                                           |
| Zod ID validation             | `zod-id-lint.sh`             | Yes (line 65)           | Yes -- "blocks"                                           |
| Structured error responses    | `empty-response-lint.sh`     | Yes (line 69)           | Yes -- "blocks"                                           |
| Project isolation             | `project-isolation-lint.sh`  | Yes (line 70)           | Yes -- "warns"                                            |
| User isolation                | `user-isolation-lint.sh`     | Yes (line 71)           | Yes -- "warns"                                            |
| E2E test quality              | `e2e-test-quality-lint.sh`   | Yes (line 75)           | Yes -- "blocks"                                           |
| Export removal guard          | `exported-symbol-guard.sh`   | Yes (line 76)           | Yes -- "blocks"                                           |
| Centralized auth only         | `custom-auth-lint.sh`        | Yes (line 77)           | Yes -- "blocks"                                           |
| No package/app deletion       | `package-deletion-guard.sh`  | Yes (line 78)           | Yes -- "blocks"                                           |
| Stale mock warning            | `stale-mock-warn.sh`         | Yes (line 79)           | **MISMATCH** -- docs say "warns" but hook blocks (exit 2) |
| Design token enforcement      | `design-token-lint.sh`       | Yes (line 80)           | Yes -- "warns" (exit 0)                                   |
| Prettier before commit        | `prettier-before-commit.sh`  | Yes (line 11)           | Yes -- side-effect hook                                   |
| Typecheck before commit       | `typecheck-before-commit.sh` | Yes (line 53)           | Yes -- "blocks"                                           |

### Rules WITHOUT hook enforcement (no hook, but rule exists)

| CLAUDE.md Rule                                     | Has Hook                          | Comment                       |
| -------------------------------------------------- | --------------------------------- | ----------------------------- |
| `err instanceof Error ? err.message : String(err)` | Yes (`unsafe-error-cast-lint.sh`) | Covered                       |
| No `any` where structured types exist              | No                                | Not easily enforced via regex |
| No inline magic numbers                            | No                                | Not easily enforced via regex |
| Express route ordering                             | No                                | Would require AST analysis    |
| Dockerfile package.json sync                       | Yes (`dockerfile-copy-check.sh`)  | Covered                       |
| Unused imports                                     | No                                | Documented as aspirational    |

### Hooks WITHOUT CLAUDE.md documentation

| Hook                          | Has CLAUDE.md rule                                                 |
| ----------------------------- | ------------------------------------------------------------------ |
| `mongoose-hmr-guard.sh`       | Not in Key Rules section                                           |
| `findbyid-lint.sh`            | Not in Key Rules section (referenced elsewhere in Core Invariants) |
| `websocket-in-render.sh`      | Not in Key Rules section                                           |
| `unbounded-collections.sh`    | Not in Key Rules section                                           |
| `lean-on-encrypted-models.sh` | Not in Key Rules section                                           |
| `cache-key-completeness.sh`   | Not in Key Rules section                                           |
| `role-case-lint.sh`           | Not in Key Rules section                                           |

These 7 hooks predate this batch and are outside audit scope, but noted for completeness. They should eventually have Key Rules entries to maintain the CLAUDE.md-to-hook correspondence.

---

## 6. Cross-Hook Interactions

### Ordering Dependencies

1. **`prettier-before-commit.sh` MUST run before `typecheck-before-commit.sh`** in the Bash matcher array. Currently: prettier is at line 134, typecheck at line 138. This is correct. If reordered, tsc would type-check pre-formatted code (likely still passes, but principle matters).

2. **`stale-mock-warn.sh` interacts with `exported-symbol-guard.sh`**: If you rename/remove an exported function AND the test has stale mocks, both hooks would fire on the same edit. This is additive (both provide useful warnings) and not conflicting.

3. **No conflicting hooks detected.** All Write|Edit hooks run independently and check orthogonal concerns.

### Performance Concern

The Write|Edit matcher has **20 hooks** registered. Each fires on every Write or Edit tool call. Most hooks exit early (within 1-2 `case` checks), but `exported-symbol-guard.sh` runs `grep -rl` across the codebase for each removed symbol. Combined latency estimate for a typical Edit to a `.ts` file in `packages/`:

- ~18 hooks exit within 1-5ms (fast case/grep checks)
- `exported-symbol-guard.sh`: 200-2000ms if symbols are removed
- `stale-mock-warn.sh`: 50-500ms if signatures change (runs `find`)
- Total: typically <100ms, worst case 2-3 seconds

This is acceptable but should be monitored as more hooks are added.

---

## Summary of Required Actions

### CRITICAL (must fix)

1. **[HK-01]** `prettier-before-commit.sh`: Remove `2>/dev/null` and handle prettier failures properly
2. **[HK-02]** `package-deletion-guard.sh`: Fix regex to catch `rm -Rf`, `rm -r -f`, `rm --recursive`
3. **[HK-03]** `stale-mock-warn.sh`: Change exit 2 to exit 0 (or rename to `-guard.sh` and update CLAUDE.md)

### HIGH (should fix)

4. **[HK-04]** `swallowed-catch-lint.sh`: Improve multiline and comment-only body detection
5. **[HK-05]** `console-log-lint.sh`: Exclude client-side packages (web-sdk, admin-ui, design-tokens)
6. **[HK-06]** `custom-auth-lint.sh`: Decide on `jose` library policy and enforce consistently
7. **[HK-07]** `sync-io-lint.sh`: Add exclusions for legitimate sync I/O (WAL, startup config)
8. **[HK-08]** `empty-response-lint.sh`: Document the narrow scope as intentional, or expand

### MEDIUM (recommended)

9. **[HK-09]** Document prettier-before-typecheck ordering dependency in settings.json
10. **[HK-10]** Acknowledge exported-symbol-guard latency as acceptable
11. **[HK-12]** Add `.e2e.ts`/`.integration.ts` exclusions to console-log-lint
12. **[HK-13]** Add tool_name validation to package-deletion-guard for defense-in-depth
13. **[HK-14]** design-token-lint exit 0 is correctly advisory (no action)
14. **[HK-11]** stale-mock-warn find latency is acceptable (no action)

### LOW (optional)

15. **[HK-15]** Simplify redundant file_path extraction in console-log-lint and empty-response-lint
16. **[HK-16]** Standardize hook output message format
