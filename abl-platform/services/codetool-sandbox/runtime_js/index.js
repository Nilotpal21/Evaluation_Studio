#!/usr/bin/env node
/**
 * Main script for executing user code with KoreRuntime
 * This script is called by the execute_script.js endpoint
 */

// Bootstrap global-agent for proxy support if PROXY_GLOBAL_NATIVE is enabled
const PROXY_GLOBAL_NATIVE = process.env.PROXY_GLOBAL_NATIVE === 'true';

if (
  PROXY_GLOBAL_NATIVE &&
  (process.env.GLOBAL_AGENT_HTTP_PROXY || process.env.GLOBAL_AGENT_HTTPS_PROXY)
) {
  try {
    const { bootstrap } = require('global-agent');
    // Set force flag to respect custom agents (if any)
    process.env.GLOBAL_AGENT_NO_PROXY = process.env.GLOBAL_AGENT_NO_PROXY;
    process.env.GLOBAL_AGENT_FORCE_GLOBAL_AGENT = process.env.GLOBAL_AGENT_FORCE_GLOBAL_AGENT;
    bootstrap();
    console.log('[Runtime] Global proxy initialized successfully');
  } catch (error) {
    // If global-agent is not available, continue without proxy
    // This is a non-fatal error - code tools will work but without proxy
    if (process.stderr && typeof process.stderr.write === 'function') {
      process.stderr.write(
        `[Runtime] Failed to initialize global proxy: ${error.message || 'Unknown error'}\n`,
      );
    }
  }
} else {
  console.log('[Runtime] Proxy NOT initialized. Reason:');
}

const { MemoryManager } = require('./memory_manager');
const { executeJavaScriptWrapper } = require('./utils');

class KoreRuntime {
  /**
   * Runtime class for executing JavaScript scripts with memory and logging capabilities
   */

  constructor(memory = null, logger = null, script = null) {
    /**
     * Initialize KoreRuntime with optional memory, logger, and script parameters
     *
     * Args:
     *     memory: Memory manager instance (optional)
     *     logger: Logger instance (optional)
     *     script: JavaScript script to execute (optional)
     */
    this.memory = memory;
    this.logger = logger || this._createDefaultLogger();
    this.script = script;
  }

  _createDefaultLogger() {
    /**
     * Create a default logger if none provided
     */
    return {
      info: (msg) => console.log(`INFO: ${msg}`),
      error: (msg) => console.error(`ERROR: ${msg}`),
      debug: (msg) => console.log(`DEBUG: ${msg}`),
      warning: (msg) => console.warn(`WARNING: ${msg}`),
    };
  }

  static async execute(script, memory = null, logger = null, args = null, envParams = null) {
    /**
     * Static method to execute a JavaScript script with memory and logger
     *
     * Args:
     *     script (string): The JavaScript script to execute
     *     memory: Memory manager instance (optional)
     *     logger: Logger instance (optional)
     *     args (object): Arguments to be passed to the script (optional)
     *     envParams (object): Environment parameters to be passed to the script (optional)
     *
     * Returns:
     *     object: Execution result containing response, logs, and error information
     */
    const runtime = new KoreRuntime(memory, logger, script);
    return await runtime._executeScript(args || {}, envParams || {});
  }

  async _executeScript(args, envParams) {
    /**
     * Internal method to execute the stored script using the wrapper
     *
     * Args:
     *     args (object): Arguments to be passed to the script
     *     envParams (object): Environment parameters to be passed to the script
     *
     * Returns:
     *     object: Execution result containing response, logs, and error information
     */
    if (!this.script) {
      return {
        error: 'No script provided for execution',
        logs: [],
        response: null,
      };
    }

    return await executeJavaScriptWrapper(this.script, this.memory, this.logger, args, envParams);
  }
}

async function main() {
  /**
   * Main function to execute user code with proper context
   */
  try {
    // Get the user script from command line arguments
    if (process.argv.length < 4) {
      throw new Error('Missing required arguments: script and context');
    }

    const userScript = process.argv[2];
    const contextJson = process.argv[3];

    let authorization = '';
    let executionMode = null;
    let mockMemoryData = {};

    // Parse execution context
    const contextData = JSON.parse(contextJson);
    authorization = contextData.authorization || '';
    executionMode = contextData.executionMode || null;
    mockMemoryData = contextData.mockMemoryData || {};
    const args = contextData.args || {};
    const envParams = contextData.envParams || {};
    const baseUrl = contextData.base_url || '';
    // Configure logging
    const logger = {
      info: (msg) => console.log(`INFO: ${msg}`),
      error: (msg) => console.error(`ERROR: ${msg}`),
      debug: (msg) => console.log(`DEBUG: ${msg}`),
      warning: (msg) => console.warn(`WARNING: ${msg}`),
    };

    let memory = null;

    try {
      // Initialize memory manager
      memory = new MemoryManager(authorization, executionMode, mockMemoryData, baseUrl);

      // Execute using KoreRuntime with args passed separately
      const result = await KoreRuntime.execute(userScript, memory, logger, args, envParams);
      // Output the result as JSON
      console.log(JSON.stringify(result));
    } catch (executionError) {
      // Handle execution errors and output as JSON
      const errorResult = {
        error: `[Error] ${executionError.message}`,
        logs: [],
        response: null,
      };
      console.log(JSON.stringify(errorResult));
    }
  } catch (error) {
    // Handle any errors and output as JSON
    const errorResult = {
      error: `[Error] ${error.message}`,
      logs: [],
      response: null,
    };
    console.log(JSON.stringify(errorResult));
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Unhandled error:', error);
    process.exit(1);
  });
}

module.exports = { KoreRuntime };
