/**
 * Lambda Handler Templates
 *
 * String constants embedded into Lambda ZIP bundles by the Lambda sandbox runner.
 * These templates define how user code is executed inside the Lambda container.
 *
 * Ported from AgenticAI lambda.constants.ts with key adaptations:
 * - Memory API URL read from event payload (not hardcoded)
 * - Access token read from event payload (not Lambda client context)
 * - Response field uses `response` (not `result`) for gVisor pod format parity
 * - Code read from event.code (not from deployed files)
 * - User code executed via new Function() (Node.js) or exec() (Python), not eval()
 *
 * No runtime dependencies — pure string constants.
 */

// ---------------------------------------------------------------------------
// Node.js Memory Manager — deployed as memory_manager.js alongside handler
// ---------------------------------------------------------------------------

export const NODEJS_MEMORY_MANAGER_FILENAME = 'memory_manager.js';

export const NODEJS_MEMORY_MANAGER_TEMPLATE = `
const axios = require('axios');

class MemoryManager {
    constructor(authorization, executionMode = "execute", mockMemoryData = {}) {
        this.authorization = "bearer " + authorization;
        this.baseUrl = global.__memoryApiBaseUrl || '';
        this.axios = axios;

        // Configure execution mode and mock data
        this.executionMode = executionMode;
        this.mockMemoryData = mockMemoryData || {};

        // Configure axios instance (only needed for real API calls)
        if (this.executionMode !== 'simulate') {
            this.axiosInstance = this.axios.create({
                baseURL: this.baseUrl,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': this.authorization
                },
                timeout: 30000 // 30 seconds timeout
            });
        }
    }

    async makeRequest(body) {
        // If in simulate mode, use mock data instead of API calls
        if (this.executionMode === 'simulate') {
            return this.handleMockRequest(body);
        }

        // Otherwise, make real API call
        try {
            const response = await this.axiosInstance.post('/api/v1/memory', body);
            return response.data;
        } catch (error) {
            console.error('Memory API request failed:', error.message);
            if (error.response) {
                throw new Error(\`Memory API error: \${error.response.status} - \${JSON.stringify(error.response.data)}\`);
            } else if (error.request) {
                throw new Error('Memory API request failed: No response received');
            } else {
                throw new Error(\`Memory API request failed: \${error.message}\`);
            }
        }
    }

    handleMockRequest(body) {
        const { action, memoryStoreName, payload, projections, key, patchMode, upsert, searchType, query, filters, options } = body;
        const storageKey = key ? \`\${memoryStoreName}_\${key}\` : memoryStoreName;

        switch (action) {
            case 'set':
                this.mockMemoryData[storageKey] = payload.content;
                return {
                    success: true,
                    message: \`Content set successfully for \${storageKey}\`,
                    data: payload.content
                };

            case 'update': {
                const existingContent = this.mockMemoryData[storageKey];
                if (existingContent === undefined) {
                    if (upsert) {
                        this.mockMemoryData[storageKey] = payload.content;
                        return {
                            success: true,
                            message: \`Content created successfully for \${storageKey}\`,
                            data: payload.content
                        };
                    } else {
                        return {
                            success: false,
                            message: \`No content found for \${storageKey}\`,
                            data: null
                        };
                    }
                }
                let updatedContent;
                if (patchMode === 'overwrite') {
                    updatedContent = payload.content;
                } else {
                    if (typeof existingContent === 'object' && typeof payload.content === 'object') {
                        updatedContent = { ...existingContent, ...payload.content };
                    } else {
                        updatedContent = payload.content;
                    }
                }
                this.mockMemoryData[storageKey] = updatedContent;
                return {
                    success: true,
                    message: \`Content updated successfully for \${storageKey}\`,
                    data: updatedContent
                };
            }

            case 'get': {
                const content = this.mockMemoryData[storageKey];
                if (content === undefined) {
                    return {
                        success: false,
                        message: \`No content found for \${storageKey}\`,
                        data: null
                    };
                }
                let result = content;
                if (projections && Object.keys(projections).length > 0) {
                    if (typeof content === 'object' && content !== null) {
                        result = {};
                        Object.keys(projections).forEach(projKey => {
                            if (Object.prototype.hasOwnProperty.call(content, projKey)) {
                                result[projKey] = content[projKey];
                            }
                        });
                    }
                }
                return {
                    success: true,
                    message: \`Content retrieved successfully for \${storageKey}\`,
                    data: result
                };
            }

            case 'delete': {
                const existed = Object.prototype.hasOwnProperty.call(this.mockMemoryData, storageKey);
                delete this.mockMemoryData[storageKey];
                return {
                    success: true,
                    message: \`Content deleted successfully for \${storageKey}\`,
                    data: { existed }
                };
            }

            case 'search': {
                const results = [];
                const searchQuery = query ? query.toLowerCase() : '';

                for (const [storeKey, storeContent] of Object.entries(this.mockMemoryData)) {
                    if (!storeKey.startsWith(memoryStoreName)) {
                        continue;
                    }

                    let matches = false;

                    if (filters && Object.keys(filters).length > 0) {
                        matches = this._matchesFilters(storeContent, filters);
                        if (!matches) continue;
                    }

                    if (searchQuery) {
                        if (searchType === 'keyword') {
                            matches = this._keywordSearch(storeContent, searchQuery, options && options.exactMatch);
                        } else {
                            matches = this._semanticSearch(storeContent, searchQuery);
                        }
                    } else {
                        matches = true;
                    }

                    if (matches) {
                        results.push({
                            key: storeKey,
                            content: storeContent,
                            score: 1.0
                        });
                    }
                }

                const topK = (options && options.topK) || 10;
                const limitedResults = results.slice(0, topK);

                return {
                    success: true,
                    message: \`Search completed for \${memoryStoreName}\`,
                    data: {
                        results: limitedResults,
                        total: results.length
                    }
                };
            }

            default:
                throw new Error(\`[MOCK] Unsupported action: \${action}\`);
        }
    }

    _matchesFilters(content, filters) {
        for (const [filterPath, filterValue] of Object.entries(filters)) {
            const actualValue = this._getNestedValue(content, filterPath);
            if (actualValue !== filterValue) {
                return false;
            }
        }
        return true;
    }

    _getNestedValue(obj, path) {
        return path.split('.').reduce((current, key) => current && current[key], obj);
    }

    _keywordSearch(content, query, exactMatch) {
        const contentStr = JSON.stringify(content).toLowerCase();
        return contentStr.includes(query);
    }

    _semanticSearch(content, query) {
        const contentStr = JSON.stringify(content).toLowerCase();
        return contentStr.includes(query);
    }

    async set_content(memoryStoreName, content) {
        try {
            const body = {
                action: 'set',
                memoryStoreName: memoryStoreName,
                payload: { content: content }
            };
            return await this.makeRequest(body);
        } catch (error) {
            console.error('Error setting memory content:', error.message);
            throw error;
        }
    }

    async get_content(memoryStoreName, projections = {}) {
        try {
            const body = {
                action: 'get',
                memoryStoreName: memoryStoreName,
                projections: projections
            };
            return await this.makeRequest(body);
        } catch (error) {
            console.error('Error getting memory content:', error.message);
            throw error;
        }
    }

    async delete_content(memoryStoreName) {
        try {
            const body = {
                action: 'delete',
                memoryStoreName: memoryStoreName
            };
            return await this.makeRequest(body);
        } catch (error) {
            console.error('Error deleting memory content:', error.message);
            throw error;
        }
    }

    async set(memoryStoreName, key, content) {
        try {
            const body = {
                action: 'set',
                memoryStoreName: memoryStoreName,
                key: key,
                payload: { content: content }
            };
            return await this.makeRequest(body);
        } catch (error) {
            console.error('Error setting memory with key:', error.message);
            throw error;
        }
    }

    async update(memoryStoreName, key, patch, patchMode = 'merge', upsert = false) {
        try {
            const body = {
                action: 'update',
                memoryStoreName: memoryStoreName,
                key: key,
                patchMode: patchMode,
                upsert: upsert,
                payload: { content: patch }
            };
            return await this.makeRequest(body);
        } catch (error) {
            console.error('Error updating memory:', error.message);
            throw error;
        }
    }

    async get(memoryStoreName, key, projections = {}) {
        try {
            const body = {
                action: 'get',
                memoryStoreName: memoryStoreName,
                key: key,
                projections: projections
            };
            return await this.makeRequest(body);
        } catch (error) {
            console.error('Error getting memory with key:', error.message);
            throw error;
        }
    }

    async delete(memoryStoreName, key) {
        try {
            const body = {
                action: 'delete',
                memoryStoreName: memoryStoreName,
                key: key
            };
            return await this.makeRequest(body);
        } catch (error) {
            console.error('Error deleting memory with key:', error.message);
            throw error;
        }
    }

    async search(memoryStoreName, query = '', filters = {}, options = {}) {
        try {
            const body = {
                action: 'search',
                memoryStoreName: memoryStoreName,
                query: query,
                filters: filters,
                options: options
            };
            return await this.makeRequest(body);
        } catch (error) {
            console.error('Error searching memory:', error.message);
            throw error;
        }
    }
}

module.exports = { MemoryManager };
`.trim();

// ---------------------------------------------------------------------------
// Node.js Lambda Handler — deployed as index.js
// ---------------------------------------------------------------------------

export const NODEJS_RUNNER_HANDLER_TEMPLATE = `
const { MemoryManager } = require('./memory_manager');

/**
 * Lambda handler for executing user sandbox code.
 *
 * Payload shape:
 * {
 *   ping?: true,                          // health-check probe
 *   runtime: 'javascript',
 *   code: string,                          // user code to execute
 *   params: Record<string, unknown>,       // tool parameters
 *   functionName: string,                  // function to invoke
 *   context: {
 *     accessToken: string,
 *     executionMode: 'simulate' | 'execute',
 *     mockMemoryData?: Record<string, unknown>,
 *     blockDangerousModules?: boolean,
 *     memoryApiBaseUrl?: string,
 *   }
 * }
 *
 * Response shape (matches gVisor pod format):
 * { statusCode: 200|500, body: JSON.stringify({ response, logs, error }) }
 */
exports.handler = async (event) => {
    // ---- Health-check (ping) ------------------------------------------------
    if (event && event.ping === true) {
        return { statusCode: 200, body: JSON.stringify({ pong: true }) };
    }

    // ---- Extract payload fields ---------------------------------------------
    const code = event.code || '';
    const params = event.params || {};
    const functionName = event.functionName || 'main';
    const ctx = event.context || {};
    const accessToken = ctx.accessToken || '';
    const executionMode = ctx.executionMode || 'execute';
    const mockMemoryData = ctx.mockMemoryData || {};
    const blockDangerousModules = ctx.blockDangerousModules !== false; // default true
    const memoryApiBaseUrl = ctx.memoryApiBaseUrl || '';

    // ---- Set up globals for memory_manager.js -------------------------------
    global.__accessToken = accessToken;
    global.__memoryApiBaseUrl = memoryApiBaseUrl;
    global.memory = new MemoryManager(accessToken, executionMode, mockMemoryData);

    // ---- Console capture ----------------------------------------------------
    const logs = [];
    const originalConsole = {};
    ['log', 'warn', 'error', 'info', 'debug'].forEach(level => {
        originalConsole[level] = console[level];
        console[level] = (...args) => {
            const prefix = '[' + level.toUpperCase() + '] ';
            const formatted = prefix + args.map(arg =>
                typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
            ).join(' ');
            logs.push(formatted);
        };
    });

    // ---- Restore console helper ---------------------------------------------
    function restoreConsole() {
        Object.keys(originalConsole).forEach(level => {
            console[level] = originalConsole[level];
        });
    }

    try {
        // ---- Block fs module if requested -----------------------------------
        if (blockDangerousModules) {
            require.cache[require.resolve('fs')] = {
                id: 'fs',
                filename: 'fs',
                loaded: true,
                exports: new Proxy({}, {
                    get() {
                        throw new Error('The fs module is blocked for security reasons');
                    }
                })
            };
        }

        // ---- Build the wrapper function body --------------------------------
        // The user code is wrapped so that \`memory\`, \`params\`, and \`env\` are in scope.
        const wrappedCode = [
            '"use strict";',
            'const memory = global.memory;',
            'const env = params;',   // alias for convenience
            code,
            '',
            '// Invoke the target function',
            'if (typeof ' + functionName + ' === "function") {',
            '  return ' + functionName + '(params);',
            '} else {',
            '  throw new Error("Function \\\\"' + functionName + '\\\\" is not defined in user code");',
            '}',
        ].join('\\n');

        // ---- Execute via new Function (NOT eval) ----------------------------
        const executor = new Function('params', 'memory', 'require', wrappedCode);
        const safeRequire = blockDangerousModules
            ? (mod) => {
                const blocked = ['fs', 'child_process', 'cluster', 'dgram', 'dns',
                    'net', 'tls', 'vm', 'worker_threads', 'perf_hooks'];
                if (blocked.includes(mod)) {
                    throw new Error(\`Module "\${mod}" is blocked for security reasons\`);
                }
                return require(mod);
              }
            : require;

        const result = await Promise.resolve(executor(params, global.memory, safeRequire));

        restoreConsole();

        return {
            statusCode: 200,
            body: JSON.stringify({
                response: typeof result === 'object' ? JSON.stringify(result) : result,
                logs: logs,
                error: ''
            })
        };
    } catch (error) {
        restoreConsole();
        return {
            statusCode: 500,
            body: JSON.stringify({
                response: null,
                logs: logs,
                error: '[Error] ' + (error.message || String(error))
            })
        };
    }
};
`.trim();

// ---------------------------------------------------------------------------
// Python Lambda Handler — deployed as lambda_function.py
// ---------------------------------------------------------------------------

export const PYTHON_RUNNER_HANDLER_TEMPLATE = `
import json
import sys
import logging
import io
import textwrap
import ast

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Mock Memory Manager (simulate mode)
# ---------------------------------------------------------------------------
class MockMemoryManager:
    """Mock memory manager for testing without API calls."""

    def __init__(self, mock_memory_data=None):
        self.mock_memory_data = mock_memory_data or {}

    def _build_storage_key(self, memory_store_name, key=None):
        return f"{memory_store_name}_{key}" if key else memory_store_name

    def _matches_filters(self, content, filters):
        for filter_path, filter_value in filters.items():
            actual_value = self._get_nested_value(content, filter_path)
            if actual_value != filter_value:
                return False
        return True

    def _get_nested_value(self, obj, path):
        keys = path.split(".")
        current = obj
        for key in keys:
            if isinstance(current, dict) and key in current:
                current = current[key]
            else:
                return None
        return current

    def _keyword_search(self, content, query, exact_match):
        content_str = json.dumps(content).lower()
        return query in content_str

    def _semantic_search(self, content, query):
        content_str = json.dumps(content).lower()
        return query in content_str

    def set_content(self, memory_store_name, content):
        self.mock_memory_data[memory_store_name] = content
        return {
            "success": True,
            "message": f"Content set successfully for {memory_store_name}",
            "data": content,
        }

    def set(self, memory_store_name, key, content):
        storage_key = self._build_storage_key(memory_store_name, key)
        self.mock_memory_data[storage_key] = content
        return {
            "success": True,
            "message": f"Content set successfully for {storage_key}",
            "data": content,
        }

    def update(self, memory_store_name, key, patch, patchMode="merge", upsert=False):
        storage_key = self._build_storage_key(memory_store_name, key)
        existing_content = self.mock_memory_data.get(storage_key)

        if existing_content is None:
            if upsert:
                self.mock_memory_data[storage_key] = patch
                return {
                    "success": True,
                    "message": f"Content created successfully for {storage_key}",
                    "data": patch,
                }
            else:
                return {
                    "success": False,
                    "message": f"No content found for {storage_key}",
                    "data": None,
                }

        if patchMode == "overwrite":
            updated_content = patch
        else:
            if isinstance(existing_content, dict) and isinstance(patch, dict):
                updated_content = {**existing_content, **patch}
            else:
                updated_content = patch

        self.mock_memory_data[storage_key] = updated_content
        return {
            "success": True,
            "message": f"Content updated successfully for {storage_key}",
            "data": updated_content,
        }

    def get_content(self, memory_store_name, projections=None):
        if memory_store_name not in self.mock_memory_data:
            return {
                "success": False,
                "message": f"No content found for {memory_store_name}",
                "data": None,
            }

        content = self.mock_memory_data[memory_store_name]
        result = content
        if projections and isinstance(projections, dict) and len(projections) > 0:
            if isinstance(content, dict):
                result = {}
                for key in projections.keys():
                    if key in content:
                        result[key] = content[key]

        return {
            "success": True,
            "message": f"Content retrieved successfully for {memory_store_name}",
            "data": result,
        }

    def get(self, memory_store_name, key, projections=None):
        storage_key = self._build_storage_key(memory_store_name, key)
        if storage_key not in self.mock_memory_data:
            return {
                "success": False,
                "message": f"No content found for {storage_key}",
                "data": None,
            }

        content = self.mock_memory_data[storage_key]
        result = content
        if projections and isinstance(projections, dict) and len(projections) > 0:
            if isinstance(content, dict):
                result = {}
                for proj_key in projections.keys():
                    if proj_key in content:
                        result[proj_key] = content[proj_key]

        return {
            "success": True,
            "message": f"Content retrieved successfully for {storage_key}",
            "data": result,
        }

    def delete_content(self, memory_store_name):
        existed = memory_store_name in self.mock_memory_data
        if existed:
            del self.mock_memory_data[memory_store_name]
        return {
            "success": True,
            "message": f"Content deleted successfully for {memory_store_name}",
            "data": {"existed": existed},
        }

    def delete(self, memory_store_name, key):
        storage_key = self._build_storage_key(memory_store_name, key)
        existed = storage_key in self.mock_memory_data
        if existed:
            del self.mock_memory_data[storage_key]
        return {
            "success": True,
            "message": f"Content deleted successfully for {storage_key}",
            "data": {"existed": existed},
        }

    def search(self, memory_store_name, query="", filters=None, options=None):
        results = []
        search_query = query.lower() if query else ""
        filters = filters or {}
        options = options or {}
        search_type = "keyword" if search_query and search_query.strip() else "semantic"

        for store_key, store_content in self.mock_memory_data.items():
            if not store_key.startswith(memory_store_name):
                continue

            matches = False

            if filters:
                matches = self._matches_filters(store_content, filters)
                if not matches:
                    continue

            if search_query:
                if search_type == "keyword":
                    matches = self._keyword_search(
                        store_content, search_query, options.get("exactMatch", False)
                    )
                else:
                    matches = self._semantic_search(store_content, search_query)
            else:
                matches = True

            if matches:
                results.append(
                    {"key": store_key, "content": store_content, "score": 1.0}
                )

        top_k = options.get("topK", 10)
        limited_results = results[:top_k]

        return {
            "success": True,
            "message": f"Search completed for {memory_store_name}",
            "data": {"results": limited_results, "total": len(results)},
        }


# ---------------------------------------------------------------------------
# Real Memory Manager (urllib-based HTTP client)
# ---------------------------------------------------------------------------
class MemoryManager:
    """Real memory manager that calls the platform Memory API via urllib."""

    def __init__(self, access_token, base_url):
        self.access_token = access_token
        self.base_url = base_url.rstrip("/") if base_url else ""

    def _make_request(self, body):
        import urllib.request
        import urllib.error

        url = self.base_url + "/api/v1/memory"
        data = json.dumps(body).encode("utf-8")
        headers = {
            "Content-Type": "application/json",
            "Authorization": "bearer " + self.access_token,
        }
        req = urllib.request.Request(url, data=data, headers=headers, method="POST")

        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            body_text = e.read().decode("utf-8", errors="replace") if e.fp else ""
            raise RuntimeError(
                f"Memory API error: {e.code} - {body_text}"
            ) from e
        except urllib.error.URLError as e:
            raise RuntimeError(
                f"Memory API request failed: {e.reason}"
            ) from e

    def set_content(self, memory_store_name, content):
        return self._make_request(
            {
                "action": "set",
                "memoryStoreName": memory_store_name,
                "payload": {"content": content},
            }
        )

    def get_content(self, memory_store_name, projections=None):
        body = {"action": "get", "memoryStoreName": memory_store_name}
        if projections:
            body["projections"] = projections
        return self._make_request(body)

    def delete_content(self, memory_store_name):
        return self._make_request(
            {"action": "delete", "memoryStoreName": memory_store_name}
        )

    def set(self, memory_store_name, key, content):
        return self._make_request(
            {
                "action": "set",
                "memoryStoreName": memory_store_name,
                "key": key,
                "payload": {"content": content},
            }
        )

    def update(self, memory_store_name, key, patch, patchMode="merge", upsert=False):
        return self._make_request(
            {
                "action": "update",
                "memoryStoreName": memory_store_name,
                "key": key,
                "patchMode": patchMode,
                "upsert": upsert,
                "payload": {"content": patch},
            }
        )

    def get(self, memory_store_name, key, projections=None):
        body = {
            "action": "get",
            "memoryStoreName": memory_store_name,
            "key": key,
        }
        if projections:
            body["projections"] = projections
        return self._make_request(body)

    def delete(self, memory_store_name, key):
        return self._make_request(
            {
                "action": "delete",
                "memoryStoreName": memory_store_name,
                "key": key,
            }
        )

    def search(self, memory_store_name, query="", filters=None, options=None):
        body = {
            "action": "search",
            "memoryStoreName": memory_store_name,
            "query": query,
        }
        if filters:
            body["filters"] = filters
        if options:
            body["options"] = options
        return self._make_request(body)


# ---------------------------------------------------------------------------
# AST Security Validator
# ---------------------------------------------------------------------------

# SECURITY: Import denylist — dangerous root modules are blocked
_BLOCKED_IMPORT_ROOTS = {
    # System/process and escape primitives
    "os", "sys", "subprocess", "importlib", "imp", "runpy", "builtins",
    # Concurrency/process control
    "threading", "multiprocessing", "asyncio", "concurrent",
    # Binary/native code and serialization / code loading
    "ctypes", "pickle", "marshal", "py_compile",
    # TTY/PTY and low-level file/process control
    "pty", "termios", "tty", "fcntl", "resource",
    # Network / remote access modules
    "socket", "ssl", "http", "ftplib", "smtplib", "telnetlib", "xmlrpc",
    # Introspection that can surface already-loaded modules/objects
    "gc", "inspect", "types", "importlib_metadata",
}

_BLOCKED_DIRECT_CALL_NAMES = {
    "eval", "exec", "open", "compile", "__import__",
    "globals", "locals", "vars", "dir",
    "getattr", "setattr", "delattr", "hasattr",
}

_BLOCKED_ATTRIBUTE_NAMES = {
    "__builtins__", "__globals__", "__code__", "__closure__", "__dict__",
    "__class__", "__bases__", "__subclasses__", "__mro__",
    "__import__", "__loader__", "__spec__",
}

_BLACKLISTED_MODULE_METHODS = {
    ("pandas", "eval"),
    ("pd", "eval"),
    ("numpy", "eval"),
    ("np", "eval"),
}
_BLACKLISTED_METHOD_NAMES = {"eval", "query"}


def _get_import_root(name):
    if name is None or not isinstance(name, str):
        return None
    stripped = name.strip()
    return stripped.split(".")[0] if stripped else None


def _is_blocked_import(name):
    root = _get_import_root(name)
    return root in _BLOCKED_IMPORT_ROOTS if root else False


def _validate_user_code(code_str, block_enabled):
    if not block_enabled:
        return

    dedented = textwrap.dedent(code_str or "")
    wrapped = "def __user_function__():\\n" + textwrap.indent(dedented, "    ")
    tree = ast.parse(wrapped)

    for node in ast.walk(tree):
        # Block imports for dangerous roots
        if isinstance(node, ast.Import):
            for alias in node.names:
                if _is_blocked_import(alias.name):
                    raise ValueError(
                        f"Import of module '{alias.name}' is blocked for security reasons"
                    )
        elif isinstance(node, ast.ImportFrom):
            if node.module is not None and _is_blocked_import(node.module):
                raise ValueError(
                    f"Import of module '{node.module}' is blocked for security reasons"
                )

        # Block direct reference to __builtins__
        if isinstance(node, ast.Name) and node.id == "__builtins__":
            raise ValueError("Access to '__builtins__' is not allowed")

        # Block dangerous attribute names
        if isinstance(node, ast.Attribute) and node.attr in _BLOCKED_ATTRIBUTE_NAMES:
            raise ValueError(f"Access to attribute '{node.attr}' is not allowed")

        # Block dangerous calls
        if isinstance(node, ast.Call):
            if isinstance(node.func, ast.Name) and node.func.id in _BLOCKED_DIRECT_CALL_NAMES:
                raise ValueError(
                    f"Restricted function '{node.func.id}' is not allowed"
                )

            if isinstance(node.func, ast.Attribute):
                if node.func.attr in _BLACKLISTED_METHOD_NAMES:
                    raise ValueError(
                        f"Method '{node.func.attr}()' is not allowed - "
                        "it can execute arbitrary code and bypass security restrictions"
                    )

                if isinstance(node.func.value, ast.Name):
                    module_name = node.func.value.id
                    method_name = node.func.attr
                    if (module_name, method_name) in _BLACKLISTED_MODULE_METHODS:
                        raise ValueError(
                            f"Restricted function '{module_name}.{method_name}' is not allowed - "
                            "it can be used to bypass security restrictions"
                        )

            # Block getattr(x, "eval") / getattr(x, "__import__") patterns
            if (
                isinstance(node.func, ast.Name)
                and node.func.id == "getattr"
                and len(node.args) >= 2
            ):
                second = node.args[1]
                attr_name = None
                if isinstance(second, ast.Constant) and isinstance(second.value, str):
                    attr_name = second.value
                elif isinstance(second, ast.Str):
                    attr_name = second.s
                if attr_name is not None and attr_name in _BLOCKED_DIRECT_CALL_NAMES:
                    raise ValueError(
                        f"Restricted getattr access to '{attr_name}' is not allowed"
                    )


# ---------------------------------------------------------------------------
# Env proxy for attribute-style access
# ---------------------------------------------------------------------------
class EnvProxy:
    def __init__(self, data):
        self._data = data if isinstance(data, dict) else {}

    def __getattr__(self, name):
        if isinstance(name, str) and name in self._data:
            return self._data[name]
        raise AttributeError(name)

    def __getitem__(self, key):
        return self._data[key]

    def get(self, key, default=None):
        return self._data.get(key, default)

    def items(self):
        return self._data.items()

    def to_dict(self):
        return dict(self._data)


# ---------------------------------------------------------------------------
# Lambda Handler
# ---------------------------------------------------------------------------
def lambda_handler(event, context):
    """
    Lambda handler for executing user sandbox code.

    Payload shape:
    {
        "ping": true,                            # optional health-check
        "runtime": "python",
        "code": "...",                            # user code string
        "params": {...},                          # tool parameters
        "functionName": "main",                   # function to invoke
        "context": {
            "accessToken": "...",
            "executionMode": "simulate" | "execute",
            "mockMemoryData": {...},
            "blockDangerousModules": true,
            "memoryApiBaseUrl": "https://..."
        }
    }

    Response shape (matches gVisor pod format):
    { "statusCode": 200|500, "body": json({ "response", "logs", "error" }) }
    """

    # ---- Health-check (ping) ------------------------------------------------
    if isinstance(event, dict) and event.get("ping") is True:
        return {"statusCode": 200, "body": json.dumps({"pong": True})}

    # ---- Extract payload fields ---------------------------------------------
    code = event.get("code", "")
    params = event.get("params", {})
    function_name = event.get("functionName", "main")
    ctx = event.get("context", {})
    access_token = ctx.get("accessToken", "")
    execution_mode = ctx.get("executionMode", "execute")
    mock_memory_data = ctx.get("mockMemoryData", {})
    block_dangerous_modules = ctx.get("blockDangerousModules", True)
    memory_api_base_url = ctx.get("memoryApiBaseUrl", "")

    # ---- Normalize block flag ------------------------------------------------
    def _normalize_block_flag(value):
        if value is None:
            return True
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return value != 0
        if isinstance(value, str):
            return value.strip().lower() in ("true", "1", "yes", "y", "on")
        return True

    block_enabled = _normalize_block_flag(block_dangerous_modules)

    # ---- Initialize memory manager ------------------------------------------
    if execution_mode == "simulate":
        memory = MockMemoryManager(mock_memory_data)
    else:
        memory = MemoryManager(access_token, memory_api_base_url)

    # ---- Capture stdout ------------------------------------------------------
    logs = []
    log_capture = io.StringIO()
    original_stdout = sys.stdout
    sys.stdout = log_capture

    try:
        # ---- Clear env vars if blocking enabled ------------------------------
        if block_enabled:
            import os
            os.environ.clear()

        # ---- Set up safe import ----------------------------------------------
        __builtins_obj = __builtins__
        __builtins_dict = (
            dict(__builtins_obj)
            if isinstance(__builtins_obj, dict)
            else dict(__builtins_obj.__dict__)
        )
        __original_import = __builtins_dict.get("__import__", __import__)

        def __safe_import(name, globals=None, locals=None, fromlist=(), level=0):
            if block_enabled and _is_blocked_import(name):
                raise ImportError(
                    f"Import of module '{name}' is blocked for security reasons"
                )
            return __original_import(name, globals, locals, fromlist, level)

        # ---- AST validation --------------------------------------------------
        _validate_user_code(code, block_enabled)

        # ---- Prepare restricted builtins for user execution context ----------
        __builtins_dict.update(
            {
                "__import__": __safe_import,
                "eval": None,
                "exec": None,
                "open": None,
                "compile": None,
            }
        )

        env = EnvProxy(params)

        exec_globals = {
            "__builtins__": __builtins_dict,
            "memory": memory,
            "env": env,
            "params": params,
        }

        # ---- Wrap user code in a function ------------------------------------
        user_code = code
        function_template = (
            "def user_function():\\n"
            + textwrap.indent(textwrap.dedent(user_code), "    ")
        )

        exec(function_template, exec_globals)

        # Expose params as top-level names so user code can reference them
        if isinstance(params, dict):
            for _k, _v in params.items():
                if isinstance(_k, str) and not _k.startswith("__"):
                    exec_globals[_k] = _v

        result = exec_globals["user_function"]()

        # ---- Collect stdout logs ---------------------------------------------
        sys.stdout = original_stdout
        captured_output = log_capture.getvalue().strip()
        if captured_output:
            logs.extend(captured_output.split("\\n"))

        return {
            "statusCode": 200,
            "body": json.dumps(
                {"response": result, "logs": logs, "error": ""}
            ),
        }

    except Exception as e:
        sys.stdout = original_stdout
        captured_output = log_capture.getvalue().strip()
        if captured_output:
            logs.extend(captured_output.split("\\n"))

        return {
            "statusCode": 500,
            "body": json.dumps(
                {
                    "response": None,
                    "logs": logs,
                    "error": f"[Error] {str(e)}",
                }
            ),
        }
`.trim();
