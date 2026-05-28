"""
Runtime Utilities Module

This module provides secure Python code execution with AST (Abstract Syntax Tree) validation,
similar to the lambda deployment constants implementation.

Key Features:
1. AST-based security validation before code execution
2. Blocks dangerous modules and functions (subprocess, os, eval, exec, etc.)
3. Prevents sandbox escape attempts via introspection
4. Blocks pandas/numpy eval() bypass patterns
5. Configurable security via blockDangerousModules flag

Security Context Variables:
- authorization: Authorization token for API calls
- executionMode: 'simulate' for mock mode, null/undefined for real API calls
- mockMemoryData: Mock data object used when executionMode is 'simulate'
- blockDangerousModules: Boolean flag to enable/disable security restrictions (defaults to True)
  When True: Blocks dangerous modules and restricts operations
  When False: Allows all modules (use with caution)
"""

import json
import logging
import io
import textwrap
import sys
import ast
import os
import requests
from urllib.parse import urlparse
import memory_service_sdk
from constants import NO_PROXY, HTTP_PROXY, HTTPS_PROXY
from runtime.runtime_constants import (
    SEARCH_TYPE_KEYWORD, 
    SEARCH_TYPE_SEMANTIC, 
    PATCH_MODE_MERGE, 
    PATCH_MODE_OVERWRITE,
    OPTION_EXACT_MATCH,
    OPTION_TOP_K,
    DEFAULT_TOP_K,
    DEFAULT_SCORE
)

def should_bypass_proxy(url):
    """
    Check if a URL should bypass the proxy based on NO_PROXY environment variable.
    This implements similar logic to the JavaScript shouldBypassProxy function.
    
    Args:
        url (str): The URL to check
        
    Returns:
        bool: True if the URL should bypass proxy, False otherwise
    """
    no_proxy = NO_PROXY
    if not no_proxy:
        return False
    
    no_proxy_list = [pattern.strip() for pattern in no_proxy.split(',')]
    
    if '*' in no_proxy_list:
        return True
    
    try:
        parsed_url = urlparse(url)
        hostname = parsed_url.hostname.lower() if parsed_url.hostname else ''
        
        for pattern in no_proxy_list:
            pattern = pattern.lower().strip()
            if not pattern:
                continue
            
            # Check for port-specific pattern
            if ':' in pattern:
                pattern_host, pattern_port = pattern.rsplit(':', 1)
                url_port = parsed_url.port or (443 if parsed_url.scheme == 'https' else 80)
                if pattern_port.isdigit() and int(pattern_port) != url_port:
                    continue
                pattern = pattern_host
            
            # Check for wildcard patterns
            if pattern.endswith('*'):
                prefix = pattern[:-1]
                if hostname.startswith(prefix):
                    return True
            elif pattern.startswith('*') or pattern.startswith('.'):
                suffix = pattern.lstrip('*')
                if hostname.endswith(suffix):
                    return True
            elif hostname == pattern:
                return True
                
    except Exception as e:
        logging.debug(f'Failed to parse URL for proxy bypass check: {e}')
        return True
    
    return False


def create_proxy_aware_session():
    """
    Create a requests Session that respects proxy environment variables.
    This session will use the proxy for external calls but bypass it for internal services.
    
    Returns:
        requests.Session: A configured session object
    """
    session = requests.Session()
    
    # Get proxy configuration from environment
    http_proxy = HTTP_PROXY
    https_proxy = HTTPS_PROXY
    
    if http_proxy or https_proxy:
        # Set up proxies
        proxies = {}
        if http_proxy:
            proxies['http'] = http_proxy
        if https_proxy:
            proxies['https'] = https_proxy
        
        session.proxies.update(proxies)
        
        # Note: requests library automatically respects NO_PROXY environment variable
        # We don't need to manually implement bypass logic for the session
        logging.debug(f'Proxy configured for user code: HTTP={http_proxy}, HTTPS={https_proxy}')
    
    return session


class MockMemoryManager:
    """Mock memory manager for testing without API calls"""
    
    def __init__(self, mock_memory_data=None):
        self.mock_memory_data = mock_memory_data or {}
    
    def _build_storage_key(self, memory_store_name, record_key=None):
        """Build storage key with optional custom key suffix"""
        return f"{memory_store_name}_{record_key}" if record_key else memory_store_name
    
    def _matches_filters(self, content, filters):
        """Check if content matches all filters"""
        for filter_path, filter_value in filters.items():
            actual_value = self._get_nested_value(content, filter_path)
            if actual_value != filter_value:
                return False
        return True
    
    def _get_nested_value(self, obj, path):
        """Get nested value from object using dot notation"""
        keys = path.split('.')
        current = obj
        for key in keys:
            if isinstance(current, dict) and key in current:
                current = current[key]
            else:
                return None
        return current
    
    def _keyword_search(self, content, query, exact_match):
        """Perform keyword search"""
        content_str = json.dumps(content).lower()
        return query in content_str
    
    def _semantic_search(self, content, query):
        """Simplified semantic search"""
        content_str = json.dumps(content).lower()
        return query in content_str
    
    def set_content(self, memory_store_name, content):
        """Mock implementation of set_content"""
        logging.info(f"MockMemoryManager.set_content: memory_store_name={memory_store_name}")
        self.mock_memory_data[memory_store_name] = content
        return {
            "success": True,
            "message": f"Content set successfully for {memory_store_name}",
            "data": content
        }
    
    def set(self, memory_store_name, record_key, content):
        """Mock implementation of set with key"""
        logging.info(f"MockMemoryManager.set: memory_store_name={memory_store_name}, record_key={record_key}")
        storage_key = self._build_storage_key(memory_store_name, record_key)
        self.mock_memory_data[storage_key] = content
        return {
            "success": True,
            "message": f"Content set successfully for {storage_key}",
            "data": content
        }
    
    def update(self, memory_store_name, record_key, patch, patchMode="merge", upsert=False):
        """Mock implementation of update"""
        logging.info(f"MockMemoryManager.update: memory_store_name={memory_store_name}, record_key={record_key}, patchMode={patchMode}, upsert={upsert}")
        storage_key = self._build_storage_key(memory_store_name, record_key)
        existing_content = self.mock_memory_data.get(storage_key)
        
        # Handle upsert
        if existing_content is None:
            if upsert:
                self.mock_memory_data[storage_key] = patch
                return {
                    "success": True,
                    "message": f"Content created successfully for {storage_key}",
                    "data": patch
                }
            else:
                return {
                    "success": False,
                    "message": f"No content found for {storage_key}",
                    "data": None
                }
        
        # Handle patchMode
        if patchMode == PATCH_MODE_OVERWRITE:
            updated_content = patch
        else:  # merge (default)
            if isinstance(existing_content, dict) and isinstance(patch, dict):
                updated_content = {**existing_content, **patch}
            else:
                updated_content = patch
        
        self.mock_memory_data[storage_key] = updated_content
        return {
            "success": True,
            "message": f"Content updated successfully for {storage_key}",
            "data": updated_content
        }
    
    def get_content(self, memory_store_name, projections=None):
        """Mock implementation of get_content"""
        logging.info(f"MockMemoryManager.get_content: memory_store_name={memory_store_name}, projections={projections}")
        if memory_store_name not in self.mock_memory_data:
            return {
                "success": False,
                "message": f"No content found for {memory_store_name}",
                "data": None
            }
        
        content = self.mock_memory_data[memory_store_name]
        
        # Apply projections if provided (simplified implementation)
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
            "data": result
        }
    
    def get(self, memory_store_name, record_key, projections=None):
        """Mock implementation of get with key"""
        logging.info(f"MockMemoryManager.get: memory_store_name={memory_store_name}, record_key={record_key}, projections={projections}")
        storage_key = self._build_storage_key(memory_store_name, record_key)
        if storage_key not in self.mock_memory_data:
            return {
                "success": False,
                "message": f"No content found for {storage_key}",
                "data": None
            }
        
        content = self.mock_memory_data[storage_key]
        
        # Apply projections if provided (simplified implementation)
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
            "data": result
        }
    
    def delete_content(self, memory_store_name):
        """Mock implementation of delete_content"""
        logging.info(f"MockMemoryManager.delete_content: memory_store_name={memory_store_name}")
        existed = memory_store_name in self.mock_memory_data
        if existed:
            del self.mock_memory_data[memory_store_name]
        
        return {
            "success": True,
            "message": f"Content deleted successfully for {memory_store_name}",
            "data": {"existed": existed}
        }
    
    def delete(self, memory_store_name, record_key):
        """Mock implementation of delete with key"""
        logging.info(f"MockMemoryManager.delete: memory_store_name={memory_store_name}, record_key={record_key}")
        storage_key = self._build_storage_key(memory_store_name, record_key)
        existed = storage_key in self.mock_memory_data
        if existed:
            del self.mock_memory_data[storage_key]
        
        return {
            "success": True,
            "message": f"Content deleted successfully for {storage_key}",
            "data": {"existed": existed}
        }
    
    def search(self, memory_store_name, query="", filters=None, options=None):
        """Mock implementation of search"""
        logging.info(f"MockMemoryManager.search: memory_store_name={memory_store_name}, query={query}, filters={filters}, options={options}")
        results = []
        search_query = query.lower() if query else ""
        filters = filters or {}
        options = options or {}
        
        # Determine search type based on query
        search_type = SEARCH_TYPE_KEYWORD if search_query and search_query.strip() else SEARCH_TYPE_SEMANTIC
        
        # Search through all stored data
        for store_key, store_content in self.mock_memory_data.items():
            # Check if this is the correct memory store
            if not store_key.startswith(memory_store_name):
                continue
            
            matches = False
            
            # Apply filters if provided
            if filters:
                matches = self._matches_filters(store_content, filters)
                if not matches:
                    continue
            
            # Apply search query
            if search_query:
                if search_type == SEARCH_TYPE_KEYWORD:
                    matches = self._keyword_search(store_content, search_query, options.get(OPTION_EXACT_MATCH, False))
                else:
                    matches = self._semantic_search(store_content, search_query)
            else:
                # No query means return all matching filters
                matches = True
            
            if matches:
                results.append({
                    "key": store_key,
                    "content": store_content,
                    "score": DEFAULT_SCORE  # Mock score
                })
        
        # Apply topK limit
        top_k = options.get(OPTION_TOP_K, DEFAULT_TOP_K)
        limited_results = results[:top_k]
        
        return {
            "success": True,
            "message": f"Search completed for {memory_store_name}",
            "data": {
                "results": limited_results,
                "total": len(results)
            }
        }


def extract_user_code_from_prepared_script(prepared_script):
    """
    Extract only the user's code from a prepared script that includes wrapper imports and seccomp.
    
    The prepared script format is:
        import sys
        import logging
        ...
        import pyseccomp as seccomp
        def drop_perms():
            ...
        drop_perms()
        
        <USER_CODE_HERE>
    
    We extract everything after the last drop_perms() call.
    
    Args:
        prepared_script (str): The full prepared script with wrappers
    
    Returns:
        str: Just the user's code portion
    """
    # Find the drop_perms() call which marks the end of the wrapper
    drop_perms_marker = "drop_perms()"
    
    if drop_perms_marker in prepared_script:
        # Split at the last occurrence of drop_perms()
        parts = prepared_script.rsplit(drop_perms_marker, 1)
        if len(parts) == 2:
            # Everything after drop_perms() is user code
            user_code = parts[1].strip()
            return user_code
    
    # If no drop_perms() found, assume the entire script is user code
    # (this handles cases where prepare_script wasn't used)
    return prepared_script


def validate_user_code(code_str, block_enabled=True):
    """
    Validate user code using AST to prevent known bypass vectors.
    
    Args:
        code_str (str): The user's Python code to validate
        block_enabled (bool): Whether security restrictions are enabled
    
    Raises:
        ValueError: If the code contains dangerous patterns
        SyntaxError: If the code has syntax errors
    """
    if not block_enabled:
        return
    
    # Define blocked imports (dangerous module roots)
    blocked_import_roots = {
        # System/process and escape primitives
        "os", "sys", "subprocess", "importlib", "imp", "runpy", "builtins",
        # Concurrency/process control
        "threading", "multiprocessing", "asyncio", "concurrent",
        # Binary/native code and serialization / code loading
        "ctypes", "pickle", "marshal", "py_compile",
        # TTY/PTY and low-level file/process control
        "pty", "termios", "tty", "fcntl", "resource",
        # Network / remote access modules
        "socket", "ssl", "http", "urllib", "ftplib", "smtplib", "telnetlib", "xmlrpc",
        # Introspection that can surface already-loaded modules/objects (bypass import restrictions)
        "gc", "inspect", "types", "importlib_metadata",
    }
    
    # Blocked direct call names
    blocked_direct_call_names = {
        "eval", "exec", "open", "compile", "__import__",
        "globals", "locals", "vars", "dir",
        "getattr", "setattr", "delattr", "hasattr",
    }
    
    # Blocked attribute names (dunder introspection / sandbox escape primitives)
    blocked_attribute_names = {
        "__builtins__", "__globals__", "__code__", "__closure__", "__dict__",
        "__class__", "__bases__", "__subclasses__", "__mro__",
        "__import__", "__loader__", "__spec__",
    }
    
    # Blacklisted module.method patterns (pandas.eval, numpy.eval, and aliases)
    blacklisted_module_methods = {
        ("pandas", "eval"),
        ("pd", "eval"),
        ("numpy", "eval"),
        ("np", "eval"),
    }
    
    # Blacklisted method names (instance methods that can execute arbitrary code)
    blacklisted_method_names = {"eval", "query"}
    
    def get_import_root(name):
        """Extract the root module name from a full import path"""
        if name is None or not isinstance(name, str):
            return None
        stripped = name.strip()
        if stripped == "":
            return None
        return stripped.split(".")[0]
    
    def is_blocked_import(name):
        """Check if an import is blocked"""
        root = get_import_root(name)
        if root is None:
            return False
        return root in blocked_import_roots
    
    # Dedent and wrap code for proper parsing
    dedented = textwrap.dedent(code_str or "")
    wrapped = "def __user_function__():\n" + textwrap.indent(dedented, "    ")
    
    # Parse the code into an AST
    try:
        tree = ast.parse(wrapped)
    except SyntaxError as e:
        raise SyntaxError(f"Code has syntax errors: {str(e)}")
    
    # Walk through the AST and check for dangerous patterns
    for node in ast.walk(tree):
        # Block imports only for dangerous roots (safe imports still allowed)
        if isinstance(node, ast.Import):
            for alias in node.names:
                if is_blocked_import(alias.name):
                    raise ValueError(f"Import of module '{alias.name}' is blocked for security reasons")
        
        elif isinstance(node, ast.ImportFrom):
            if node.module is not None and is_blocked_import(node.module):
                raise ValueError(f"Import of module '{node.module}' is blocked for security reasons")
        
        # Block direct reference to __builtins__ (even as a name)
        if isinstance(node, ast.Name) and node.id == "__builtins__":
            raise ValueError("Access to '__builtins__' is not allowed")
        
        # Block dangerous attribute names (dunder introspection / sandbox escape primitives)
        if isinstance(node, ast.Attribute) and node.attr in blocked_attribute_names:
            raise ValueError(f"Access to attribute '{node.attr}' is not allowed")
        
        # Block dangerous calls and eval/query bypass patterns
        if isinstance(node, ast.Call):
            # Direct calls like eval(), exec(), open(), getattr(), etc.
            if isinstance(node.func, ast.Name) and node.func.id in blocked_direct_call_names:
                raise ValueError(f"Restricted function '{node.func.id}' is not allowed")
            
            if isinstance(node.func, ast.Attribute):
                # Block dangerous instance methods regardless of object type (df.eval(), df.query(), etc.)
                if node.func.attr in blacklisted_method_names:
                    raise ValueError(
                        f"Method '{node.func.attr}()' is not allowed - it can execute arbitrary code and bypass security restrictions"
                    )
                
                # Block dangerous module.method patterns (pandas.eval, numpy.eval, and aliases)
                if isinstance(node.func.value, ast.Name):
                    module_name = node.func.value.id
                    method_name = node.func.attr
                    if (module_name, method_name) in blacklisted_module_methods:
                        raise ValueError(
                            f"Restricted function '{module_name}.{method_name}' is not allowed - it can be used to bypass security restrictions"
                        )
            
            # Block getattr(x, "eval") / getattr(x, "__import__") patterns
            if isinstance(node.func, ast.Name) and node.func.id == "getattr" and len(node.args) >= 2:
                second = node.args[1]
                attr_name = None
                # Handle both old (ast.Str) and new (ast.Constant) AST node types
                if hasattr(ast, 'Str') and isinstance(second, ast.Str):
                    attr_name = second.s
                elif isinstance(second, ast.Constant) and isinstance(second.value, str):
                    attr_name = second.value
                if attr_name is not None and attr_name in blocked_direct_call_names:
                    raise ValueError(f"Restricted getattr access to '{attr_name}' is not allowed")


def execute_python_wrapper(user_code, memory, logger, args, envParams, block_dangerous_modules=True):
    """
    Python execution wrapper that handles user code execution with proper error handling.
    
    Args:
        user_code (str): The user's Python code to execute
        memory: Memory manager instance
        logger: Logger instance
        args (dict): Arguments to be passed to the script
        envParams (dict): Environment parameters to be passed to the script
        block_dangerous_modules (bool): Whether to enable security restrictions (defaults to True)
    Returns:
        dict: Dictionary containing result, logs, and error information
    """
    logs = []
    log_capture = io.StringIO()
    original_stdout = sys.stdout
    sys.stdout = log_capture  # Redirect stdout to capture print statements
    __ENV__ = {}
    if isinstance(envParams, str):
        try:
            __ENV__ = json.loads(envParams)
        except:
            __ENV__ = {}
    else:
        __ENV__ = envParams or {}
    
    try:
        # Normalize block_dangerous_modules flag
        def normalize_block_flag(value):
            """Normalize various input types to a boolean flag (default secure behavior)"""
            if value is None:
                return True
            if isinstance(value, bool):
                return value
            if isinstance(value, (int, float)):
                return value != 0
            if isinstance(value, str):
                return value.strip().lower() in ("true", "1", "yes", "y", "on")
            return True
        
        block_enabled = normalize_block_flag(block_dangerous_modules)
        
        # Extract only the user's code portion from the prepared script (if it was wrapped)
        # This allows validation of user code only, not the seccomp wrapper imports
        extracted_user_code = extract_user_code_from_prepared_script(user_code)
        
        # Validate only the user's code using AST (not the wrapper)
        # This is similar to how Lambda validates CODE_PLACEHOLDER separately
        validate_user_code(extracted_user_code, block_enabled=block_enabled)
        
        # Clear environment variables to prevent access to dangerous modules (if blocking enabled)
        if block_enabled:
            os.environ.clear()
        
        # Dangerous modules to block (when blocking is enabled)
        dangerous_modules = [
            'subprocess', 'threading', 
            'multiprocessing', 'asyncio', 'concurrent', 'ctypes', 'pickle',
            'marshal', 'imp', 'importlib', 'pty', 'termios', 'tty', 'fcntl',
            'resource', 'ftplib', 'smtplib',
            'telnetlib', 'xmlrpc'
        ]
        
        if block_enabled:
            for module in dangerous_modules:
                if module in sys.modules:
                    sys.modules[module] = None
        # Create a proxy-aware requests session for user code
        # This session will respect HTTP_PROXY, HTTPS_PROXY, and NO_PROXY environment variables
        proxy_session = create_proxy_aware_session()
        
        # Define blocked imports for safe_import wrapper
        blocked_import_roots = {
            "os", "sys", "subprocess", "importlib", "imp", "runpy", "builtins",
            "threading", "multiprocessing", "asyncio", "concurrent",
            "ctypes", "pickle", "marshal", "py_compile",
            "pty", "termios", "tty", "fcntl", "resource",
            "socket", "ssl", "http", "urllib", "ftplib", "smtplib", "telnetlib", "xmlrpc",
            "gc", "inspect", "types", "importlib_metadata",
        }
        
        def get_import_root(name):
            """Extract the root module name from a full import path"""
            if name is None or not isinstance(name, str):
                return None
            stripped = name.strip()
            if stripped == "":
                return None
            return stripped.split(".")[0]
        
        def is_blocked_import(name):
            """Check if an import is blocked"""
            root = get_import_root(name)
            if root is None:
                return False
            return root in blocked_import_roots
        
        # Safe import wrapper
        original_import = __import__
        
        def safe_import(name, globals=None, locals=None, fromlist=(), level=0):
            """Safe import wrapper that blocks dangerous modules when blocking is enabled"""
            if block_enabled and is_blocked_import(name):
                raise ImportError(f"Import of module '{name}' is blocked for security reasons")
            return original_import(name, globals, locals, fromlist, level)
        
        # Prepare restricted builtins
        builtins_dict = dict(__builtins__) if isinstance(__builtins__, dict) else dict(__builtins__.__dict__)
        
        if block_enabled:
            builtins_dict.update({
                "__import__": safe_import,
                "eval": None,
                "exec": None,
                "open": None,
                "compile": None,
            })
        
        # Create an EnvProxy class to expose environment variables safely
        class EnvProxy:
            """Proxy class to expose environment variables as attributes"""
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
        
        env = EnvProxy(__ENV__)
        
        # Create execution globals with memory and logger
        # In Python's exec(), the variables passed in the exec_globals dict become the global namespace
        # for the executed code. That means variables set in exec_globals (e.g., 'memory', 'logger', 'env')
        # are accessible as globals inside the executed user code.
        exec_globals = {
            "__builtins__": builtins_dict,
            "memory": memory,    # global in exec scope
            "logger": logger,    # global in exec scope
            "env": env,          # global in exec scope (attribute-accessible)
            "requests": requests,  # Make requests module available
            "session": proxy_session  # Provide proxy-aware session for user code
        }
        
        # Dynamically assign input parameters to local variables
        for key, value in args.items():
            exec_globals[key] = value  # Assign to exec_globals for access in user code
        
        # Execute ONLY the extracted user code (not the full prepared script with wrapper)
        # This ensures we don't try to execute the wrapper imports that would be blocked
        function_template = f"""
def user_function():
{textwrap.indent(extracted_user_code, '    ')}
"""
        
        exec(function_template, exec_globals)  # Execute user function dynamically
        exec_globals.update(locals())  # Ensure function is accessible
        
        # Call the user function and capture the response
        response = exec_globals["user_function"]()  # Call the user function
        
        # Capture print statements and add them to logs
        sys.stdout = original_stdout  # Reset stdout
        captured_output = log_capture.getvalue().strip()
        if captured_output:
            logs.extend(captured_output.split("\n"))
        
        # Format logs to include the log level prefix
        formatted_logs = [f"[LOG] {log}" for log in logs]
        
        # Prepare the final result
        result = {
            "response": response,
            "logs": formatted_logs,
            "error": ""
        }
        
        return result
        
    except Exception as e:
        sys.stdout = original_stdout  # Reset stdout
        error_msg = f"[Error] {str(e)}"
        logs.append(error_msg)
        if logger:
            logger.error(error_msg)
        
        return {
            "error": error_msg,
            "logs": logs,
            "response": None
        }
