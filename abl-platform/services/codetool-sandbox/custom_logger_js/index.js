const { trace, context } = require('@opentelemetry/api');
const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node');
const { BatchSpanProcessor } = require('@opentelemetry/sdk-trace-base');
const { ConsoleSpanExporter } = require('@opentelemetry/sdk-trace-base');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { Resource } = require('@opentelemetry/resources');
const os = require('os');
const uuid = require('uuid');
const { getLogContext } = require('./context');

class KoreLogger {
  constructor() {
    this.logDestination = 'stdout';
    this.otelEndpoint = process.env.OTEL_ENDPOINT || null;
    this.tracer = null;
    this.logContextKeys = [
      'traceparent',
      'account_id',
      'run_id',
      'custom_script_id',
      'deployment_id',
      'source',
      'source_type',
      'tool_id',
      'tool_run_id',
      'function_name',
    ];
  }

  setupOpenTelemetry(otelConfig) {
    const { service_name, pod_id, environment, endpoint } = otelConfig;

    this.logDestination = 'otel';
    this.otelEndpoint = endpoint;

    const provider = new NodeTracerProvider({
      resource: new Resource({
        'service.name': service_name || 'LOG_SOURCE',
        'service.instance.id': pod_id || 'POD_ID',
        'deployment.environment': environment || 'GALE_ENV',
      }),
    });

    let exporter;
    if (environment === 'rnd-gale.kore.ai') {
      exporter = new ConsoleSpanExporter();
    } else {
      exporter = new OTLPTraceExporter({ url: this.otelEndpoint });
    }

    provider.addSpanProcessor(new BatchSpanProcessor(exporter));
    provider.register();

    this.tracer = trace.getTracer('korelogger');
  }

  log(message, logLevel, stackTrace = null) {
    const logEntry = {
      logLevel: logLevel,
      meta: {
        log_pid: process.pid,
        log_id: `cse-${uuid.v4()}`,
        stack_trace: stackTrace,
      },
      unixtimestamp: Date.now(),
      timestamp: new Date().toISOString(),
    };

    let stdout = true;
    if (this.logDestination === 'otel' && this.tracer !== null) {
      const contextData = getLogContext();
      if (contextData.getValue('debug') === false) {
        stdout = false;
        // Start a span for this log event
        const span = this.tracer.startSpan(`custom_script_logs`, undefined, context.active());
        // Add context attributes
        this.logContextKeys.forEach((key) => {
          span.setAttribute(key, contextData.getValue(key));
        });

        // Add log attributes to the span
        span.setAttribute('log_message', message);
        span.setAttribute('log_level', logLevel);
        span.setAttribute('log_trace_id', contextData.traceparent || '');
        Object.entries(logEntry.meta).forEach(([key, value]) => {
          if (value !== null) {
            span.setAttribute(String(key), String(value));
          }
        });
        span.end();
      }
    }

    return stdout;
  }

  debug(message) {
    const stdout = this.log(message, 'Debug');
    if (stdout) {
      console.log(`DEBUG :: ${message}`);
    }
  }

  info(message) {
    const stdout = this.log(message, 'Info');
    if (stdout) {
      console.log(`INFO :: ${message}`);
    }
  }

  warning(message) {
    const stdout = this.log(message, 'Warning');
    if (stdout) {
      console.log(`WARNING :: ${message}`);
    }
  }

  error(message, stackTrace = null) {
    const stdout = this.log(message, 'Error', stackTrace);
    if (stdout) {
      console.log(`ERROR :: ${message}`);
    }
  }

  stdout(message) {
    const _ = this.log(message, 'Stdout');
  }

  stderr(message) {
    const _ = this.log(message, 'Stderr');
  }
}

module.exports = new KoreLogger();
