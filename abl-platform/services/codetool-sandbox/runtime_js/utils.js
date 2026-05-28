const { MemoryManager } = require('./memory_manager');

// Read configuration from environment variables
const ALLOW_CUSTOM_AGENTS = process.env.ALLOW_CUSTOM_AGENTS === 'true';

/**
 * Create proxy-aware wrappers for HTTP modules
 * These wrappers ensure all user HTTP calls go through the proxy (if configured)
 * while allowing MemoryManager to bypass the proxy for internal calls
 *
 * ALLOW_CUSTOM_AGENTS controls whether users can create custom agents/proxies:
 * - false (default): Block custom agents to enforce proxy usage
 * - true: Allow users to create custom agents (bypass proxy)
 */
function createProxyWrappers() {
  // Require modules AFTER global-agent bootstrap to ensure they use proxy
  const http = require('http');
  const https = require('https');
  const axios = require('axios');
  const nodeFetch = require('node-fetch');

  // Create agents with keepAlive: false for all executions (only if blocking is enabled)
  // These agents will still use global-agent proxy (global-agent intercepts at module level)
  const httpAgentNoKeepAlive = new http.Agent({ keepAlive: false });
  const httpsAgentNoKeepAlive = new https.Agent({ keepAlive: false });

  // Create axios proxy that enforces proxy usage and blocks custom agents (if ALLOW_CUSTOM_AGENTS=false)
  const createAxiosProxy = (targetAxios) => {
    return new Proxy(targetAxios, {
      get: (target, prop) => {
        // Block access to Agent-related properties (only if ALLOW_CUSTOM_AGENTS=false)
        if (prop === 'defaults') {
          if (!ALLOW_CUSTOM_AGENTS) {
            const defaults = target.defaults;
            return new Proxy(defaults, {
              get: (defaultsTarget, defaultsProp) => {
                if (defaultsProp === 'httpAgent' || defaultsProp === 'httpsAgent') {
                  throw new Error('Access to axios.defaults.httpAgent/httpsAgent is not allowed');
                }
                if (defaultsProp === 'proxy') {
                  throw new Error('Access to axios.defaults.proxy is not allowed');
                }
                return defaultsTarget[defaultsProp];
              },
              set: (defaultsTarget, defaultsProp, value) => {
                if (defaultsProp === 'httpAgent' || defaultsProp === 'httpsAgent') {
                  throw new Error('Setting axios.defaults.httpAgent/httpsAgent is not allowed');
                }
                if (defaultsProp === 'proxy') {
                  throw new Error('Setting axios.defaults.proxy is not allowed');
                }
                defaultsTarget[defaultsProp] = value;
                return true;
              },
            });
          }
          return target.defaults;
        }
        if (prop === 'create') {
          if (!ALLOW_CUSTOM_AGENTS) {
            return (...args) => {
              const config = args[0] || {};
              const { httpAgent, httpsAgent, proxy, ...cleanConfig } = config;
              if (httpAgent || httpsAgent || proxy) {
                throw new Error(
                  'Creating axios instances with custom httpAgent/httpsAgent/proxy is not allowed',
                );
              }
              return target.create(cleanConfig);
            };
          }
          return target.create.bind(target);
        }
        if (
          prop === 'request' ||
          prop === 'get' ||
          prop === 'post' ||
          prop === 'put' ||
          prop === 'delete' ||
          prop === 'patch'
        ) {
          return async (...args) => {
            let config;
            if (prop === 'request') {
              config = args[0] || {};
            } else if (
              prop === 'get' ||
              prop === 'delete' ||
              prop === 'head' ||
              prop === 'options'
            ) {
              config = args[1] || {};
            } else {
              config = args[2] || {};
            }

            // Block agent/proxy configurations (only if ALLOW_CUSTOM_AGENTS=false)
            if (
              !ALLOW_CUSTOM_AGENTS &&
              config &&
              (config.httpAgent || config.httpsAgent || config.proxy)
            ) {
              throw new Error(
                'Passing httpAgent/httpsAgent/proxy in axios request config is not allowed',
              );
            }

            // Set keepAlive: false agents (only if blocking custom agents)
            if (!ALLOW_CUSTOM_AGENTS && config) {
              const { httpAgent, httpsAgent, proxy, ...cleanConfig } = config;
              cleanConfig.httpAgent = httpAgentNoKeepAlive;
              cleanConfig.httpsAgent = httpsAgentNoKeepAlive;

              // Reconstruct args with clean config
              const cleanArgs = [];
              if (prop === 'request') {
                cleanArgs.push(cleanConfig);
              } else if (
                prop === 'get' ||
                prop === 'delete' ||
                prop === 'head' ||
                prop === 'options'
              ) {
                cleanArgs.push(args[0]); // URL
                cleanArgs.push(cleanConfig);
              } else {
                cleanArgs.push(args[0]); // URL
                cleanArgs.push(args[1]); // data
                cleanArgs.push(cleanConfig);
              }

              return target[prop](...cleanArgs);
            }

            return target[prop](...args);
          };
        }
        return target[prop];
      },
    });
  };

  // Create fetch proxy
  // node-fetch v2 automatically respects HTTP_PROXY/HTTPS_PROXY/NO_PROXY environment variables
  // We just need to block custom agents if ALLOW_CUSTOM_AGENTS=false
  const createFetchProxy = () => {
    return async (...args) => {
      const url = args[0];
      const options = args[1] || {};

      // Block proxy and agent configurations (only if ALLOW_CUSTOM_AGENTS=false)
      if (
        !ALLOW_CUSTOM_AGENTS &&
        (options.proxy || options.agent || options.httpsAgent || options.httpAgent)
      ) {
        throw new Error(
          'Passing proxy, agent, httpAgent, or httpsAgent in fetch options is not allowed',
        );
      }

      // node-fetch v2 automatically uses HTTP_PROXY/HTTPS_PROXY environment variables
      // Just pass through to node-fetch - it will handle the proxy
      return nodeFetch(...args);
    };
  };

  // Create http/https proxy (blocks Agent access if ALLOW_CUSTOM_AGENTS=false)
  const httpProxy = (protocol) => {
    return new Proxy(protocol, {
      get: (target, prop) => {
        // Block access to Agent constructor (only if ALLOW_CUSTOM_AGENTS=false)
        if (!ALLOW_CUSTOM_AGENTS && prop === 'Agent') {
          throw new Error('Access to http.Agent/https.Agent constructor is not allowed');
        }
        // Block access to globalAgent (only if ALLOW_CUSTOM_AGENTS=false)
        if (!ALLOW_CUSTOM_AGENTS && prop === 'globalAgent') {
          throw new Error('Access to http.globalAgent/https.globalAgent is not allowed');
        }
        if (prop === 'request' || prop === 'get') {
          return (...args) => {
            // Block custom agents in options (only if ALLOW_CUSTOM_AGENTS=false)
            const options = args[1] || args[0];
            if (
              !ALLOW_CUSTOM_AGENTS &&
              options &&
              typeof options === 'object' &&
              (options.agent || options.createConnection)
            ) {
              throw new Error(
                'Passing agent or createConnection in http/https request options is not allowed',
              );
            }

            // Use default agents which will be intercepted by global-agent
            return target[prop](...args);
          };
        }
        return target[prop];
      },
    });
  };

  return {
    fetch: createFetchProxy(),
    http: httpProxy(http),
    https: httpProxy(https),
    axios: createAxiosProxy(axios),
  };
}

/**
 * Create a strict allowlist-based require wrapper.
 * Blocks ALL modules not explicitly allowlisted, including node: prefixed variants.
 * Replaces the vulnerable require.cache poisoning approach.
 */
function createSafeRequire(originalRequire, proxyWrappers) {
  const ALLOWED_MODULES = new Set([
    'axios',
    'http',
    'https',
    'node-fetch',
    'buffer',
    'url',
    'querystring',
    'string_decoder',
    'events',
    'util',
    'stream',
    'zlib',
    'punycode',
    'path',
  ]);

  const safeRequire = function safeRequire(moduleName) {
    // Strip node: prefix — require('node:fs') should be treated as require('fs')
    const normalized =
      typeof moduleName === 'string' && moduleName.startsWith('node:')
        ? moduleName.slice(5)
        : moduleName;

    if (!ALLOWED_MODULES.has(normalized)) {
      throw new Error(
        `Module '${moduleName}' is not permitted in the sandbox. ` +
          `Allowed modules: ${[...ALLOWED_MODULES].join(', ')}`,
      );
    }

    // If proxy is configured, return proxy-wrapped versions for HTTP modules
    if (proxyWrappers) {
      if (normalized === 'axios') return proxyWrappers.axios;
      if (normalized === 'http') return proxyWrappers.http;
      if (normalized === 'https') return proxyWrappers.https;
      if (normalized === 'node-fetch') return proxyWrappers.fetch;
    }

    return originalRequire(normalized);
  };

  // Block require helper properties that could leak module system info
  Object.defineProperty(safeRequire, 'resolve', {
    get() {
      throw new Error('require.resolve is not permitted in the sandbox');
    },
  });
  Object.defineProperty(safeRequire, 'cache', {
    get() {
      throw new Error('require.cache is not permitted in the sandbox');
    },
  });
  Object.defineProperty(safeRequire, 'extensions', {
    get() {
      throw new Error('require.extensions is not permitted in the sandbox');
    },
  });
  Object.defineProperty(safeRequire, 'main', {
    get() {
      throw new Error('require.main is not permitted in the sandbox');
    },
  });

  return safeRequire;
}

async function executeJavaScriptWrapper(userCode, memory, logger, args, envParams) {
  /**
   * JavaScript execution wrapper that handles user code execution with proper error handling.
   * Similar to the lambda execution template with enhanced security and logging.
   *
   * Args:
   *     userCode (string): The user's JavaScript code to execute
   *     memory: Memory manager instance
   *     logger: Logger instance
   *     args (object): Arguments to be passed to the script
   *     envParams (object): Environment parameters to be passed to the script
   *
   * Returns:
   *     object: Object containing result, logs, and error information
   */
  const logs = [];
  let __ENV__ = {};
  if (typeof envParams === 'string') {
    try {
      __ENV__ = JSON.parse(envParams);
    } catch (e) {
      __ENV__ = {};
    }
  } else {
    __ENV__ = envParams || {};
  }

  // Set __ENV__ to global so it's accessible in the execution context
  global.__ENV__ = __ENV__;
  // Store original console methods and override them for log capture
  const originalConsoleMethods = {};
  ['log', 'warn', 'error', 'info', 'debug'].forEach((level) => {
    originalConsoleMethods[level] = console[level];
    console[level] = (...args) => {
      const prefix = '[' + level.toUpperCase() + '] ';
      const formattedMessage =
        prefix +
        args.map((arg) => (typeof arg === 'object' ? JSON.stringify(arg) : String(arg))).join(' ');
      logs.push(formattedMessage);
      // Also call the original method to prevent output from going to stdout
      originalConsoleMethods[level](...args);
    };
  });

  try {
    const result = await (async function () {
      // Make memory available globally
      global.memory = memory;
      const env = typeof global.__ENV__ !== 'undefined' && global.__ENV__ ? global.__ENV__ : {};
      global.env = env;
      global.$env = env;

      // Create proxy-aware HTTP wrappers if proxy is configured
      let proxyWrappers = null;
      if (process.env.GLOBAL_AGENT_HTTP_PROXY || process.env.GLOBAL_AGENT_HTTPS_PROXY) {
        try {
          proxyWrappers = createProxyWrappers();
        } catch (error) {
          console.error('[Runtime] Failed to create proxy wrappers:', error.message);
        }
      }

      // Security: Create strict allowlist-based require
      const safeRequire = createSafeRequire(require, proxyWrappers);

      // Save original Function constructor before overriding
      const OrigFunction = Function;

      // Neutralize dangerous process properties with defineProperty (delete may silently fail)
      for (const prop of ['binding', 'dlopen', '_linkedBinding', 'mainModule']) {
        try {
          Object.defineProperty(process, prop, {
            get() {
              throw new Error(`process.${prop} is not permitted in the sandbox`);
            },
            configurable: false,
          });
        } catch {
          // Fallback: try delete
          try {
            delete process[prop];
          } catch {}
        }
      }

      // Clear argv to prevent leaking authorization tokens (process.argv[3] contains context JSON)
      process.argv = [];
      process.env = {};
      // Freeze process to prevent re-assignment of neutralized properties
      Object.freeze(process);

      // Block Function constructor re-entry
      Object.defineProperty(Function.prototype, 'constructor', {
        get() {
          throw new Error('Function constructor is not permitted in the sandbox');
        },
        configurable: false,
      });

      // Block AsyncFunction, GeneratorFunction, AsyncGeneratorFunction constructors
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      const GeneratorFunction = Object.getPrototypeOf(function* () {}).constructor;
      const AsyncGeneratorFunction = Object.getPrototypeOf(async function* () {}).constructor;
      for (const FnType of [AsyncFunction, GeneratorFunction, AsyncGeneratorFunction]) {
        Object.defineProperty(FnType.prototype, 'constructor', {
          get() {
            throw new Error('Function constructor is not permitted in the sandbox');
          },
          configurable: false,
        });
      }

      // Remove module system access from global scope
      delete global.module;
      delete global.exports;

      // Block eval
      global.eval = undefined;

      global.require = safeRequire;
      global.Buffer = Buffer;
      global.console = console;

      // Make HTTP modules available globally (via safe require)
      global.fetch = safeRequire('node-fetch');
      global.axios = safeRequire('axios');
      global.http = safeRequire('http');
      global.https = safeRequire('https');

      // Make arguments available globally
      if (args && typeof args === 'object') {
        Object.keys(args).forEach((key) => {
          global[key] = args[key];
        });
      }

      // Create a function wrapper for the user code to handle return statements
      const userFunction = new OrigFunction(
        'require',
        'Buffer',
        'console',
        `
               return (async function() {
                   ${userCode}
               })();
           `,
      );

      const functionResult = await userFunction(safeRequire, Buffer, console);

      return functionResult;
    })();

    // Restore original console methods
    Object.keys(originalConsoleMethods).forEach((level) => {
      console[level] = originalConsoleMethods[level];
    });

    return {
      response: result === undefined ? null : result,
      logs: logs,
    };
  } catch (error) {
    // Restore original console methods
    Object.keys(originalConsoleMethods).forEach((level) => {
      console[level] = originalConsoleMethods[level];
    });

    return {
      error: '[Error] ' + error.message,
      logs: logs,
    };
  }
}

module.exports = {
  executeJavaScriptWrapper,
};
