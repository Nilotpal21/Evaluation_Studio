import type { GovernanceStatusData } from './governance-status.service.js';
import type { IGovernancePolicy } from '@agent-platform/database';

export interface FrameworkControl {
  controlId: string;
  requirement: string;
  status: 'PASS' | 'FAIL' | 'WARN' | 'NOT_EVALUATED';
  evidence: string;
}

export interface FrameworkEvalParams {
  status: GovernanceStatusData;
  overrideCount: number;
  enabledPolicies: IGovernancePolicy[];
  versionCount: number;
  hasAuditEvents: boolean;
}

function getPipelineStatus(
  status: GovernanceStatusData,
  pipelineType: string,
): 'PASS' | 'FAIL' | 'WARN' | 'NOT_EVALUATED' {
  for (const agent of status.agents) {
    for (const rule of agent.rules) {
      if (rule.pipelineType === pipelineType) {
        if (rule.status === 'FAIL') return 'FAIL';
        if (rule.status === 'PASS') return 'PASS';
      }
    }
  }
  return 'NOT_EVALUATED';
}

export function evaluateSOC2Controls(params: FrameworkEvalParams): FrameworkControl[] {
  const { status, enabledPolicies, versionCount } = params;

  const guardrailStatus = getPipelineStatus(status, 'guardrail_analysis');
  const driftStatus = getPipelineStatus(status, 'drift_detection');
  const anomalyStatus = getPipelineStatus(status, 'anomaly_detection');

  return [
    {
      controlId: 'CC9.1',
      requirement: 'Risk mitigation activities are performed',
      status: enabledPolicies.length > 0 ? 'PASS' : 'FAIL',
      evidence:
        enabledPolicies.length > 0
          ? `${enabledPolicies.length} governance policy(s) active`
          : 'No governance policies enabled',
    },
    {
      controlId: 'CC6.1',
      requirement: 'Logical and physical access controls are implemented',
      status: guardrailStatus === 'NOT_EVALUATED' ? 'NOT_EVALUATED' : guardrailStatus,
      evidence:
        guardrailStatus === 'NOT_EVALUATED'
          ? 'No guardrail analysis rules configured'
          : `Guardrail analysis: ${guardrailStatus}`,
    },
    {
      controlId: 'CC7.1',
      requirement: 'System performance is monitored',
      status: driftStatus === 'NOT_EVALUATED' ? 'NOT_EVALUATED' : driftStatus,
      evidence:
        driftStatus === 'NOT_EVALUATED'
          ? 'No drift detection rules configured'
          : `Drift detection: ${driftStatus}`,
    },
    {
      controlId: 'CC7.2',
      requirement: 'Anomalies and incidents are identified',
      status: anomalyStatus === 'NOT_EVALUATED' ? 'NOT_EVALUATED' : anomalyStatus,
      evidence:
        anomalyStatus === 'NOT_EVALUATED'
          ? 'No anomaly detection rules configured'
          : `Anomaly detection: ${anomalyStatus}`,
    },
    {
      controlId: 'CC8.1',
      requirement: 'Changes are authorized and documented',
      status: versionCount > 0 ? 'PASS' : 'WARN',
      evidence:
        versionCount > 0
          ? `${versionCount} policy version snapshot(s) recorded`
          : 'No policy version history yet',
    },
  ];
}

export function evaluateGDPRControls(params: FrameworkEvalParams): FrameworkControl[] {
  const { status, overrideCount, hasAuditEvents } = params;

  const qualityStatus = getPipelineStatus(status, 'quality_evaluation');
  const guardrailStatus = getPipelineStatus(status, 'guardrail_analysis');

  return [
    {
      controlId: 'Art.5',
      requirement: 'Personal data processed lawfully and accurately',
      status: qualityStatus === 'NOT_EVALUATED' ? 'NOT_EVALUATED' : qualityStatus,
      evidence:
        qualityStatus === 'NOT_EVALUATED'
          ? 'No quality evaluation rules configured'
          : `Quality evaluation: ${qualityStatus}`,
    },
    {
      controlId: 'Art.22',
      requirement: 'Human oversight of automated decisions',
      status: overrideCount > 0 ? 'PASS' : 'WARN',
      evidence:
        overrideCount > 0
          ? `${overrideCount} human override(s) recorded in period`
          : 'No human overrides recorded — consider reviewing FAIL events',
    },
    {
      controlId: 'Art.25',
      requirement: 'Data protection by design and by default',
      status: guardrailStatus === 'NOT_EVALUATED' ? 'NOT_EVALUATED' : guardrailStatus,
      evidence:
        guardrailStatus === 'NOT_EVALUATED'
          ? 'No guardrail analysis rules configured'
          : `Guardrail analysis: ${guardrailStatus}`,
    },
    {
      controlId: 'Art.30',
      requirement: 'Records of processing activities maintained',
      status: hasAuditEvents ? 'PASS' : 'WARN',
      evidence: hasAuditEvents ? 'Audit trail events present' : 'No audit events in period',
    },
    {
      controlId: 'Art.13',
      requirement: 'Transparency — information provided to data subjects',
      status: 'PASS',
      evidence: 'Governance status endpoint accessible',
    },
  ];
}

export function evaluateEUAIActControls(params: FrameworkEvalParams): FrameworkControl[] {
  const { status, overrideCount, enabledPolicies, hasAuditEvents } = params;

  const qualityStatus = getPipelineStatus(status, 'quality_evaluation');
  const hallucinationStatus = getPipelineStatus(status, 'hallucination_detection');

  let accuracyStatus: 'PASS' | 'FAIL' | 'NOT_EVALUATED';
  if (qualityStatus === 'NOT_EVALUATED' && hallucinationStatus === 'NOT_EVALUATED') {
    accuracyStatus = 'NOT_EVALUATED';
  } else if (qualityStatus === 'FAIL' || hallucinationStatus === 'FAIL') {
    accuracyStatus = 'FAIL';
  } else {
    accuracyStatus = 'PASS';
  }

  const failAgentsWithNoOverride =
    status.agents.filter((a) => a.overallStatus === 'FAIL').length > 0 && overrideCount === 0;

  return [
    {
      controlId: 'Art.9',
      requirement: 'Risk management system established',
      status: enabledPolicies.length > 0 ? 'PASS' : 'FAIL',
      evidence:
        enabledPolicies.length > 0
          ? `${enabledPolicies.length} active governance policy(s)`
          : 'No governance policies enabled',
    },
    {
      controlId: 'Art.11',
      requirement: 'Record-keeping requirements met',
      status: 'PASS',
      evidence: 'Governance compliance report available',
    },
    {
      controlId: 'Art.12',
      requirement: 'Transparency and provision of information',
      status: hasAuditEvents ? 'PASS' : 'WARN',
      evidence: hasAuditEvents ? 'Audit trail complete' : 'No audit events recorded in period',
    },
    {
      controlId: 'Art.13',
      requirement: 'Obligations of providers of high-risk AI systems',
      status: 'PASS',
      evidence: 'Governance status endpoint accessible',
    },
    {
      controlId: 'Art.14',
      requirement: 'Human oversight measures implemented',
      status: failAgentsWithNoOverride ? 'WARN' : overrideCount > 0 ? 'PASS' : 'WARN',
      evidence:
        overrideCount > 0
          ? `${overrideCount} override(s) recorded`
          : failAgentsWithNoOverride
            ? 'FAIL events present without human review'
            : 'No FAIL events in period',
    },
    {
      controlId: 'Art.15',
      requirement: 'Accuracy, robustness and cybersecurity requirements',
      status: accuracyStatus,
      evidence:
        accuracyStatus === 'NOT_EVALUATED'
          ? 'No quality or hallucination rules configured'
          : `Quality: ${qualityStatus}, Hallucination: ${hallucinationStatus}`,
    },
  ];
}

export interface GovernanceFrameworksData {
  frameworks: Array<{
    id: 'SOC2' | 'GDPR' | 'EU_AI_ACT';
    label: string;
    controls: FrameworkControl[];
  }>;
}

export function evaluateAll(params: FrameworkEvalParams): GovernanceFrameworksData {
  return {
    frameworks: [
      {
        id: 'SOC2',
        label: 'SOC 2 Type II',
        controls: evaluateSOC2Controls(params),
      },
      {
        id: 'GDPR',
        label: 'GDPR',
        controls: evaluateGDPRControls(params),
      },
      {
        id: 'EU_AI_ACT',
        label: 'EU AI Act',
        controls: evaluateEUAIActControls(params),
      },
    ],
  };
}
