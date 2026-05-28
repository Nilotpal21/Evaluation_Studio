import type { DomainContextInput } from './types';

export function buildScaffoldWorkerDomainInput(
  domainContext: DomainContextInput,
): DomainContextInput {
  return {
    domain: domainContext.domain,
    channels: domainContext.channels,
    ...(typeof domainContext.language === 'string' ? { language: domainContext.language } : {}),
    compliance: domainContext.compliance,
    integrations: domainContext.integrations,
    tone: domainContext.tone,
    ...(typeof domainContext.blueprintSummary === 'string'
      ? { blueprintSummary: domainContext.blueprintSummary }
      : {}),
    ...(domainContext.universalRules ? { universalRules: domainContext.universalRules } : {}),
    ...(domainContext.channelRules ? { channelRules: domainContext.channelRules } : {}),
    ...(domainContext.sourceToolFixtures
      ? { sourceToolFixtures: domainContext.sourceToolFixtures }
      : {}),
    ...(domainContext.sharedMemoryVariables
      ? { sharedMemoryVariables: domainContext.sharedMemoryVariables }
      : {}),
    ...(domainContext.sourceTools ? { sourceTools: domainContext.sourceTools } : {}),
    ...(domainContext.consentPolicies ? { consentPolicies: domainContext.consentPolicies } : {}),
  };
}
