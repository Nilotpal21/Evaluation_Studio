/**
 * Kafka SASL/SSL auth resolution from environment variables.
 *
 * Spread the result of `resolveKafkaAuth()` into a KafkaJS `new Kafka({...})`
 * config so every client picks up auth uniformly.
 *
 * Toggle is explicit — KAFKA_AUTH_ENABLED must be "true" to activate SASL.
 * Credentials being present alone is not enough; the flag is required so that
 * accidental secret mounts or copy-paste errors cannot silently enable auth.
 *
 * Env vars:
 *   KAFKA_AUTH_ENABLED     "true" to activate SASL (required to enable auth)
 *   KAFKA_SASL_MECHANISM   plain | scram-sha-256 | scram-sha-512  (default: plain)
 *   KAFKA_SASL_USERNAME    SASL username  (required when KAFKA_AUTH_ENABLED=true)
 *   KAFKA_SASL_PASSWORD    SASL password  (required when KAFKA_AUTH_ENABLED=true)
 *   KAFKA_SSL_ENABLED      "true" to enable TLS (independent of SASL)
 */

export type KafkaSaslMechanism = 'plain' | 'scram-sha-256' | 'scram-sha-512';

/**
 * Discriminated union matching KafkaJS's `SASLOptions` shape so the value
 * spreads cleanly into a `new Kafka({...})` config without needing kafkajs
 * as a dependency of @agent-platform/config.
 */
export type KafkaSaslConfig =
  | { mechanism: 'plain'; username: string; password: string }
  | { mechanism: 'scram-sha-256'; username: string; password: string }
  | { mechanism: 'scram-sha-512'; username: string; password: string };

export interface KafkaAuthConfig {
  sasl?: KafkaSaslConfig;
  ssl?: boolean;
}

const VALID_MECHANISMS: readonly KafkaSaslMechanism[] = ['plain', 'scram-sha-256', 'scram-sha-512'];

function isKafkaSaslMechanism(value: string): value is KafkaSaslMechanism {
  return (VALID_MECHANISMS as readonly string[]).includes(value);
}

function buildSaslConfig(
  mechanism: KafkaSaslMechanism,
  username: string,
  password: string,
): KafkaSaslConfig {
  // Switch lets TS narrow `mechanism` to a literal so each variant of the
  // discriminated union constructs cleanly.
  switch (mechanism) {
    case 'plain':
      return { mechanism: 'plain', username, password };
    case 'scram-sha-256':
      return { mechanism: 'scram-sha-256', username, password };
    case 'scram-sha-512':
      return { mechanism: 'scram-sha-512', username, password };
  }
}

export function resolveKafkaAuth(): KafkaAuthConfig {
  const sslEnabled = process.env.KAFKA_SSL_ENABLED === 'true';

  if (process.env.KAFKA_AUTH_ENABLED !== 'true') {
    return sslEnabled ? { ssl: true } : {};
  }

  const username = process.env.KAFKA_SASL_USERNAME;
  const password = process.env.KAFKA_SASL_PASSWORD;
  if (!username || !password) {
    throw new Error(
      'KAFKA_AUTH_ENABLED is true but KAFKA_SASL_USERNAME or KAFKA_SASL_PASSWORD is not set',
    );
  }

  const mechanism = (process.env.KAFKA_SASL_MECHANISM ?? 'plain').toLowerCase();
  if (!isKafkaSaslMechanism(mechanism)) {
    throw new Error(
      `Invalid KAFKA_SASL_MECHANISM "${mechanism}". Must be one of: ${VALID_MECHANISMS.join(', ')}`,
    );
  }

  const config: KafkaAuthConfig = {
    sasl: buildSaslConfig(mechanism, username, password),
  };
  if (sslEnabled) config.ssl = true;
  return config;
}
