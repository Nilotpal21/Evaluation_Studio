/**
 * OpenTelemetry SDK Initialization
 *
 * MUST be imported as the very first module in index.ts (after dotenv)
 * so that OTEL can monkey-patch HTTP/Express before they are loaded.
 *
 * Configures:
 * - NodeTracerProvider with BatchSpanProcessor → OTLP gRPC exporter
 * - OTLP Log exporter for log correlation
 * - OTLP Metric exporter
 * - Auto-instrumentations (HTTP, Express)
 * - Resource attributes (service.name, service.version, deployment.environment)
 * - Graceful shutdown on SIGTERM
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
const SERVICE_NAME = process.env.OTEL_SERVICE_NAME ?? 'agent-platform';
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
      process.stderr.write(
        `OTEL shutdown error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  };

  process.on('SIGTERM', shutdownOtel);
  process.on('SIGINT', shutdownOtel);
}

export { sdk };
