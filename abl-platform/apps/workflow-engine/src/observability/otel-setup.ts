/**
 * OpenTelemetry SDK setup for Workflow Engine.
 *
 * MUST be imported FIRST in the entry point (before any other module)
 * so OTel can monkey-patch HTTP/Express/MongoDB/Redis instrumentations.
 *
 * Reference: apps/runtime/src/observability/otel-setup.ts
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-grpc';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';

// ---------------------------------------------------------------------------
// Configuration from environment
// Note: This file MUST read process.env directly because it runs before
// the async config loader initializes (OTEL needs to monkey-patch HTTP/Express
// before they are imported). This is an intentional exception to the
// centralized config system.
// ---------------------------------------------------------------------------

const OTEL_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4317';
const SERVICE_NAME = process.env.OTEL_SERVICE_NAME ?? 'workflow-engine';
const SERVICE_VERSION = process.env.OTEL_SERVICE_VERSION ?? '1.0.0';
const DEPLOYMENT_ENV = process.env.NODE_ENV ?? 'development';
const OTEL_DEBUG = process.env.OTEL_DEBUG === 'true';

// ---------------------------------------------------------------------------
// OTEL_ENABLED gate
// Default: enabled (backward compat). Only `OTEL_ENABLED=false` disables.
// ---------------------------------------------------------------------------

const OTEL_DISABLED = process.env.OTEL_ENABLED === 'false';

let sdk: NodeSDK | undefined;

if (!OTEL_DISABLED) {
  // ---------------------------------------------------------------------------
  // Diagnostics (only in debug mode)
  // ---------------------------------------------------------------------------

  if (OTEL_DEBUG) {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);
  }

  // ---------------------------------------------------------------------------
  // Resource
  // ---------------------------------------------------------------------------

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: SERVICE_NAME,
    'service.version': SERVICE_VERSION,
    'deployment.environment': DEPLOYMENT_ENV,
  });

  // ---------------------------------------------------------------------------
  // Exporters
  // ---------------------------------------------------------------------------

  const traceExporter = new OTLPTraceExporter({ url: OTEL_ENDPOINT });
  const logExporter = new OTLPLogExporter({ url: OTEL_ENDPOINT });
  const metricExporter = new OTLPMetricExporter({ url: OTEL_ENDPOINT });

  // ---------------------------------------------------------------------------
  // SDK
  // ---------------------------------------------------------------------------

  sdk = new NodeSDK({
    resource,
    traceExporter,
    logRecordProcessor: new BatchLogRecordProcessor(logExporter),
    metricReader: new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: 15_000,
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // Disable fs instrumentation (too noisy)
        '@opentelemetry/instrumentation-fs': { enabled: false },
        // Enable HTTP & Express
        '@opentelemetry/instrumentation-http': { enabled: true },
        '@opentelemetry/instrumentation-express': { enabled: true },
        // Enable MongoDB & Redis (workflow engine uses both)
        '@opentelemetry/instrumentation-mongodb': { enabled: true },
        '@opentelemetry/instrumentation-ioredis': { enabled: true },
      }),
    ],
  });

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------

  sdk.start();

  // ---------------------------------------------------------------------------
  // Graceful Shutdown
  // ---------------------------------------------------------------------------

  const shutdownOtel = async () => {
    try {
      await sdk?.shutdown();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      diag.error(`OTEL shutdown error: ${message}`);
    }
  };

  process.on('SIGTERM', shutdownOtel);
  process.on('SIGINT', shutdownOtel);
}
