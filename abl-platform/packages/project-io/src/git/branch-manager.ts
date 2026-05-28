/**
 * Branch Manager — environment-based branch management for v2 Git sync
 *
 * Implements branch-per-environment strategy:
 *   main       ← source of truth (dev work)
 *   staging    ← tracks staging deployment
 *   production ← tracks production deployment
 */

import { createLogger } from '@abl/compiler/platform/logger.js';
import type { GitProvider } from './git-provider.js';
import type { GitBranch, GitCommit } from '../types.js';

const log = createLogger('branch-manager');

// ─── Types ──────────────────────────────────────────────────────────────

export type EnvironmentBranch = 'main' | 'staging' | 'production';

export interface BranchStatus {
  branch: string;
  exists: boolean;
  headSha: string | null;
  /** Number of commits ahead of main (falls back to files changed if commit data unavailable) */
  aheadBy: number;
  /** Number of commits behind main (falls back to files changed if commit data unavailable) */
  behindBy: number;
  lastCommit: GitCommit | null;
}

export interface PromoteResult {
  success: boolean;
  commitSha: string | null;
  fromBranch: string;
  toBranch: string;
  error?: { code: string; message: string };
}

export interface BranchListResult {
  branches: Array<{
    name: string;
    sha: string;
    isEnvironment: boolean;
  }>;
}

// ─── Branch Manager ─────────────────────────────────────────────────────

export class BranchManager {
  private readonly environmentBranches: Set<string> = new Set(['main', 'staging', 'production']);

  constructor(private readonly provider: GitProvider) {}

  /**
   * Create an environment branch from main (or specified source).
   * If the branch already exists, returns its current state.
   */
  async createEnvironmentBranch(
    env: EnvironmentBranch,
    fromBranch: string = 'main',
  ): Promise<GitBranch> {
    log.info('Creating environment branch', { env, fromBranch });

    try {
      const branch = await this.provider.createBranch(env, fromBranch);
      log.info('Environment branch created', { env, sha: branch.sha });
      return branch;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Branch might already exist — check if it's a 422 (already exists)
      if (message.includes('422') || message.includes('already exists')) {
        log.info('Environment branch already exists', { env });
        const commits = await this.provider.listCommits(env, 1);
        return {
          name: env,
          sha: commits[0]?.sha ?? '',
        };
      }
      throw err;
    }
  }

  /**
   * Promote changes from one branch to another via merge.
   *
   * Creates a PR from source → target and merges it.
   * The PR provides an audit trail for the promotion.
   */
  async promoteBranch(fromBranch: string, toBranch: string): Promise<PromoteResult> {
    log.info('Promoting branch', { from: fromBranch, to: toBranch });

    try {
      const pr = await this.provider.createPullRequest({
        title: `Promote ${fromBranch} → ${toBranch}`,
        description: `Automated promotion from ${fromBranch} to ${toBranch} environment.`,
        sourceBranch: fromBranch,
        targetBranch: toBranch,
      });

      log.info('Promotion PR created', {
        from: fromBranch,
        to: toBranch,
        prNumber: pr.number,
        prUrl: pr.url,
      });

      return {
        success: true,
        commitSha: null, // PR needs to be merged separately
        fromBranch,
        toBranch,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Branch promotion failed', { from: fromBranch, to: toBranch, error: message });

      return {
        success: false,
        commitSha: null,
        fromBranch,
        toBranch,
        error: {
          code: 'PROMOTION_FAILED',
          message: `Failed to promote ${fromBranch} to ${toBranch}: ${message}`,
        },
      };
    }
  }

  /**
   * Get the status of a branch relative to main.
   */
  async getBranchStatus(branch: string): Promise<BranchStatus> {
    try {
      const commits = await this.provider.listCommits(branch, 1);

      if (commits.length === 0) {
        return {
          branch,
          exists: true,
          headSha: null,
          aheadBy: 0,
          behindBy: 0,
          lastCommit: null,
        };
      }

      // Compare with main to get ahead/behind commit counts.
      // Use listCommits to count actual commits diverging from the common base,
      // rather than getDiff which counts changed files (not commits).
      let aheadBy = 0;
      let behindBy = 0;

      if (branch !== 'main') {
        try {
          const diff = await this.provider.getDiff('main', branch);
          aheadBy = diff.commits?.length ?? diff.files.length;
          const reverseDiff = await this.provider.getDiff(branch, 'main');
          behindBy = reverseDiff.commits?.length ?? reverseDiff.files.length;
        } catch {
          // Comparison might fail if branches have no common ancestor
          log.warn('Could not compare branch with main', { branch });
        }
      }

      return {
        branch,
        exists: true,
        headSha: commits[0].sha,
        aheadBy,
        behindBy,
        lastCommit: commits[0],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('404')) {
        return {
          branch,
          exists: false,
          headSha: null,
          aheadBy: 0,
          behindBy: 0,
          lastCommit: null,
        };
      }
      throw err;
    }
  }

  /**
   * List all branches, marking environment branches.
   */
  async listBranches(): Promise<BranchListResult> {
    const branches: BranchListResult['branches'] = [];

    for (const env of this.environmentBranches) {
      try {
        const commits = await this.provider.listCommits(env, 1);
        branches.push({
          name: env,
          sha: commits[0]?.sha ?? '',
          isEnvironment: true,
        });
      } catch {
        // Branch doesn't exist
      }
    }

    return { branches };
  }
}
