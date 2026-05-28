import type {
  AuditEvent,
  AuditPolicyResolver,
  AuditRoutingDecision,
} from '@abl/compiler/platform/stores/audit-pipeline.js';

const DEFAULT_SHARED_AUDIT_TOPIC = 'abl.audit.shared.v1';
const DEFAULT_KMS_AUDIT_TOPIC = 'abl.audit.kms.v1';
const DEFAULT_PII_AUDIT_TOPIC = 'abl.audit.pii.v1';
const DEFAULT_CONNECTOR_AUDIT_TOPIC = 'abl.audit.connector.v1';
const DEFAULT_CRAWL_AUDIT_TOPIC = 'abl.audit.crawl.v1';
const DEFAULT_ARCH_AUDIT_TOPIC = 'abl.audit.arch.v1';
const DEFAULT_OMNICHANNEL_AUDIT_TOPIC = 'abl.audit.omnichannel.v1';

export interface RuntimeAuditTopicConfig {
  shared: string;
  kms: string;
  pii: string;
  connector: string;
  crawl: string;
  arch: string;
  arch_payload: string;
  omnichannel: string;
}

export function resolveRuntimeAuditTopicsFromEnv(
  env: Record<string, string | undefined> = process.env,
): RuntimeAuditTopicConfig {
  return {
    shared: env.AUDIT_KAFKA_SHARED_TOPIC?.trim() || DEFAULT_SHARED_AUDIT_TOPIC,
    kms: env.AUDIT_KAFKA_KMS_TOPIC?.trim() || DEFAULT_KMS_AUDIT_TOPIC,
    pii: env.AUDIT_KAFKA_PII_TOPIC?.trim() || DEFAULT_PII_AUDIT_TOPIC,
    connector: env.AUDIT_KAFKA_CONNECTOR_TOPIC?.trim() || DEFAULT_CONNECTOR_AUDIT_TOPIC,
    crawl: env.AUDIT_KAFKA_CRAWL_TOPIC?.trim() || DEFAULT_CRAWL_AUDIT_TOPIC,
    arch: env.AUDIT_KAFKA_ARCH_TOPIC?.trim() || DEFAULT_ARCH_AUDIT_TOPIC,
    arch_payload:
      env.AUDIT_KAFKA_ARCH_PAYLOAD_TOPIC?.trim() ||
      env.AUDIT_KAFKA_ARCH_TOPIC?.trim() ||
      DEFAULT_ARCH_AUDIT_TOPIC,
    omnichannel: env.AUDIT_KAFKA_OMNICHANNEL_TOPIC?.trim() || DEFAULT_OMNICHANNEL_AUDIT_TOPIC,
  };
}

export class RuntimeAuditPolicyResolver implements AuditPolicyResolver {
  constructor(private readonly topics: RuntimeAuditTopicConfig) {}

  resolve(event: AuditEvent): AuditRoutingDecision {
    switch (event.stream) {
      case 'shared':
        return {
          stream: 'shared',
          topic: this.topics.shared,
          table: 'abl_platform.audit_events',
        };
      case 'kms':
        return {
          stream: 'kms',
          topic: this.topics.kms,
          table: 'abl_platform.kms_audit_log',
        };
      case 'pii':
        return {
          stream: 'pii',
          topic: this.topics.pii,
          table: 'abl_platform.pii_audit_log',
        };
      case 'connector':
        return {
          stream: 'connector',
          topic: this.topics.connector,
          table: 'abl_platform.connector_audit_log',
        };
      case 'crawl':
        return {
          stream: 'crawl',
          topic: this.topics.crawl,
          table: 'abl_platform.crawl_audit_events',
        };
      case 'arch':
        return {
          stream: 'arch',
          topic: this.topics.arch,
          table: 'abl_platform.arch_audit_log',
        };
      case 'arch_payload':
        return {
          stream: 'arch_payload',
          topic: this.topics.arch_payload,
          table: 'abl_platform.arch_audit_payloads',
        };
      case 'omnichannel':
        return {
          stream: 'omnichannel',
          topic: this.topics.omnichannel,
          table: 'abl_platform.omnichannel_audit_log',
        };
    }
  }
}

export function createRuntimeAuditPolicyResolver(
  env: Record<string, string | undefined> = process.env,
): RuntimeAuditPolicyResolver {
  return new RuntimeAuditPolicyResolver(resolveRuntimeAuditTopicsFromEnv(env));
}
