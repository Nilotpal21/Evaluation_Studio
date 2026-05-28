/**
 * Contract Auth Profile Validator
 *
 * Deploy-time preflight check that validates all auth profiles required by
 * module dependency contracts exist in the consumer project. Fails closed:
 * any missing profile or DB error blocks the deployment build.
 *
 * LLD Task 2.6 — GAP-004 closure
 */

import { createLogger } from '@abl/compiler/platform';
import type { ModuleReleaseContract } from '@agent-platform/database/models';
import { normalizeAuthProfileReference } from '@agent-platform/project-io';
import { findAuthProfileMetadataByName } from '../auth-profile-resolver.js';

const log = createLogger('contract-auth-validator');

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ContractAuthProfileIssue {
  profileName: string;
  referencedBy: string; // dependency alias
  status: 'missing' | 'type_mismatch' | 'unresolved_template';
  expectedType?: string;
  actualType?: string;
}

export interface ContractAuthProfileValidationResult {
  success: boolean;
  issues: ContractAuthProfileIssue[];
}

export interface ContractAuthProfileValidationContext {
  environment?: string | null;
  userId?: string;
}

export interface ContractAuthProfileCheck {
  name: string;
  alias: string;
  expectedType?: string;
  lookupUserId?: string;
}

// ─── Validator ──────────────────────────────────────────────────────────────

/**
 * Validate that all auth profiles required by module dependency contracts
 * exist in the consumer project (or at tenant level).
 *
 * For each dependency's `contractSnapshot.requiredAuthProfiles`, queries
 * the AuthProfile collection. Collects ALL issues before returning.
 *
 * **Fail closed**: if any DB error occurs during validation, returns
 * `{ success: false }` with a logged warning.
 */
export async function validateContractAuthProfiles(
  tenantId: string,
  projectId: string,
  dependencies: Array<{ alias: string; contractSnapshot: ModuleReleaseContract }>,
  context: ContractAuthProfileValidationContext = {},
): Promise<ContractAuthProfileValidationResult> {
  // Collect all required auth profiles across all dependencies
  const profileChecks: ContractAuthProfileCheck[] = [];

  for (const dep of dependencies) {
    const required = dep.contractSnapshot?.requiredAuthProfiles;
    if (!required || required.length === 0) continue;

    for (const profile of required) {
      const normalizedName = normalizeAuthProfileReference(profile.name);
      if (!normalizedName) {
        continue;
      }

      profileChecks.push({
        name: normalizedName,
        alias: dep.alias,
        expectedType: profile.authType,
      });
    }
  }

  // Fast path: no auth profiles required
  if (profileChecks.length === 0) {
    return { success: true, issues: [] };
  }

  return validateAuthProfileChecks(tenantId, projectId, profileChecks, context);
}

export async function validateAuthProfileChecks(
  tenantId: string,
  projectId: string,
  profileChecks: ContractAuthProfileCheck[],
  context: ContractAuthProfileValidationContext = {},
): Promise<ContractAuthProfileValidationResult> {
  const issues: ContractAuthProfileIssue[] = [];

  if (profileChecks.length === 0) {
    return { success: true, issues: [] };
  }

  try {
    for (const check of profileChecks) {
      const normalizedName = normalizeAuthProfileReference(check.name);
      if (!normalizedName) {
        if (check.name.includes('{{')) {
          issues.push({
            profileName: check.name,
            referencedBy: check.alias,
            status: 'unresolved_template',
            ...(check.expectedType ? { expectedType: check.expectedType } : {}),
          });
        }
        continue;
      }

      const found = await findAuthProfileMetadataByName(
        normalizedName,
        tenantId,
        context.environment ?? undefined,
        projectId,
        check.lookupUserId ?? context.userId,
      );

      if (!found) {
        issues.push({
          profileName: normalizedName,
          referencedBy: check.alias,
          status: 'missing',
          ...(check.expectedType ? { expectedType: check.expectedType } : {}),
        });
        continue;
      }

      // Type mismatch check (only if the contract specifies an expected type)
      if (check.expectedType) {
        const actualType = found.authType;
        if (actualType && actualType !== check.expectedType) {
          issues.push({
            profileName: normalizedName,
            referencedBy: check.alias,
            status: 'type_mismatch',
            expectedType: check.expectedType,
            actualType,
          });
        }
      }
    }

    return {
      success: issues.length === 0,
      issues,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn('Auth profile preflight failed due to DB error — failing closed', {
      tenantId,
      projectId,
      profileCount: profileChecks.length,
      error: message,
    });

    // Fail closed: treat DB errors as validation failure
    return {
      success: false,
      issues: [
        {
          profileName: 'unknown',
          referencedBy: 'system',
          status: 'missing',
        },
      ],
    };
  }
}
