import { Tenant } from '@agent-platform/database/models';
import {
  assertDefaultSyntheticRetentionIsShorter,
  normalizeEvalKnownSource,
  resolveEvalConversationTtlDays,
  resolveEvalRetentionContract,
  resolveEvalScoreTtlDays,
  type EvalKnownSource,
  type EvalRetentionContract,
  type TenantSettingsWithEvalRetention,
} from '@agent-platform/database';

export interface ResolvedEvalRunRetention {
  knownSource: EvalKnownSource;
  contract: EvalRetentionContract;
  evalConversationTtlDays: number;
  evalScoreTtlDays: number;
}

export async function resolveEvalRunRetention(
  tenantId: string,
  knownSourceValue: unknown,
): Promise<ResolvedEvalRunRetention> {
  assertDefaultSyntheticRetentionIsShorter();

  const tenant = await Tenant.findOne({ _id: tenantId }).select('settings').lean();
  const contract = resolveEvalRetentionContract(
    (tenant?.settings ?? null) as TenantSettingsWithEvalRetention | null,
  );
  const knownSource = normalizeEvalKnownSource(knownSourceValue);

  return {
    knownSource,
    contract,
    evalConversationTtlDays: resolveEvalConversationTtlDays(contract, knownSource),
    evalScoreTtlDays: resolveEvalScoreTtlDays(contract, knownSource),
  };
}
