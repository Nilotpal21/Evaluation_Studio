/**
 * Git-workspace capture helpers.
 *
 * Small git-shelling helpers extracted verbatim from `pipeline-engine.ts`.
 * Each takes the workspace directory as an argument instead of reading
 * `this.config.workDir`, so they can run without an engine instance.
 *
 *   - `captureSliceDiffStat(files, workDir)` — `git diff --stat HEAD -- <files>`
 *     for up to 50 scoped files; returns trimmed stdout, or '' on empty input
 *     or error (logs to stderr on error).
 *   - `captureHeadSha(workDir)` — `git rev-parse HEAD`; returns the trimmed
 *     SHA or `undefined` on failure.
 *   - `captureSliceDiff(files, workDir)` — SHA-256 of `git diff HEAD -- <files>`
 *     (up to 50 files); used for resume-detection of already-applied
 *     implementation output. Returns '' on empty input/diff or error (logs to
 *     stderr on error).
 *   - `captureBlockingWorkspaceChanges(workDir)` — classifies currently changed
 *     workspace paths via `partitionDeterministicOutOfScopeWorkspacePaths` and
 *     returns the `blockingFiles` array, or `['unknown']` on failure.
 *   - `captureReplayPostProofCommits(workDir, baselineCommitSha)` —
 *     `git log --format=%H%x09%s <baseline>..HEAD`; parses each line into
 *     `{ sha, subject }`, drops empties, returns `[]` on any error.
 *
 * No engine state, no I/O beyond the wrapped git commands. Behavior unchanged.
 */
import {
  listChangedWorkspacePaths,
  partitionDeterministicOutOfScopeWorkspacePaths,
} from '../workspace-status.js';
import { dedupeStrings } from './text-utils.js';

export async function captureSliceDiffStat(files: string[], workDir: string): Promise<string> {
  const sliceFiles = dedupeStrings(files);
  if (sliceFiles.length === 0) return '';

  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync(
      'git',
      ['diff', '--stat', 'HEAD', '--', ...sliceFiles.slice(0, 50)],
      {
        cwd: workDir,
        maxBuffer: 1024 * 1024,
      },
    );
    return stdout.trim();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[helix] captureSliceDiffStat failed: ${msg}\n`);
    return '';
  }
}

export async function captureHeadSha(workDir: string): Promise<string | undefined> {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: workDir,
    });
    const sha = stdout.trim();
    return sha || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Capture a SHA-256 hash of the git diff for the given files.
 * Used to detect whether implementation output is already in the working tree on resume.
 */
export async function captureSliceDiff(files: string[], workDir: string): Promise<string> {
  const sliceFiles = dedupeStrings(files);
  if (sliceFiles.length === 0) return '';

  try {
    const { createHash } = await import('node:crypto');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync(
      'git',
      ['diff', 'HEAD', '--', ...sliceFiles.slice(0, 50)],
      {
        cwd: workDir,
        maxBuffer: 1024 * 1024,
      },
    );
    if (!stdout) {
      return '';
    }
    return createHash('sha256').update(stdout).digest('hex');
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[helix] captureSliceDiff failed: ${msg}\n`);
    return '';
  }
}

export async function captureBlockingWorkspaceChanges(workDir: string): Promise<string[]> {
  try {
    const changedWorkspacePaths = await listChangedWorkspacePaths(workDir);
    return partitionDeterministicOutOfScopeWorkspacePaths(changedWorkspacePaths).blockingFiles;
  } catch {
    return ['unknown'];
  }
}

export async function captureReplayPostProofCommits(
  workDir: string,
  baselineCommitSha: string,
): Promise<Array<{ sha: string; subject: string }>> {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync(
      'git',
      ['log', '--format=%H%x09%s', `${baselineCommitSha}..HEAD`],
      {
        cwd: workDir,
        maxBuffer: 1024 * 1024,
      },
    );

    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [sha, ...subjectParts] = line.split('\t');
        return {
          sha: sha?.trim() ?? '',
          subject: subjectParts.join('\t').trim(),
        };
      })
      .filter((entry) => entry.sha.length > 0 && entry.subject.length > 0);
  } catch {
    return [];
  }
}
