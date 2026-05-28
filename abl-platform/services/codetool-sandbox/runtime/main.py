#!/usr/bin/env python3
"""
Main script for executing user code with KoreRuntime

This script is called by the execute_script.py endpoint and provides secure
Python code execution with AST validation and security restrictions.

Security Features:
- AST-based code validation before execution
- Blocks dangerous modules and operations
- Configurable via blockDangerousModules context flag
- Default secure behavior (blocking enabled)

Context Variables:
- authorization: Authorization token for API calls
- executionMode: 'simulate' for mock mode, otherwise real API calls
- mockMemoryData: Mock data object for simulation mode
- args: Arguments to pass to the user script
- envParams: Environment parameters for the script
- blockDangerousModules: Enable/disable security (defaults to True)
"""

import sys
import json
import logging
import os

# Add the runtime directory to Python path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from utils import MockMemoryManager, execute_python_wrapper


class KoreRuntime:
    """Runtime class for executing Python scripts with memory and logging capabilities"""
    
    def __init__(self, script, memory=None, logger=None):
        """
        Initialize KoreRuntime with mandatory script parameter and optional memory and logger
        
        Args:
            script: Python script to execute (required)
            memory: Memory manager instance (optional)
            logger: Logger instance (optional)  
        """
        if logger:
            logger.debug(f"KoreRuntime.__init__() - Entry: has_memory={memory is not None}, "
                        f"has_logger={logger is not None}, script_length={len(script) if script else 0}")
        
        self.memory = memory
        self.logger = logger
        self.script = script
        
        if logger:
            logger.debug("KoreRuntime.__init__() - Exit: Initialization completed successfully")
    
    @staticmethod
    def execute(script, memory=None, logger=None, args=None, envParams=None, block_dangerous_modules=True):
        """
        Static method to execute a Python script with memory and logger
        
        Args:
            script (str): The Python script to execute
            memory: Memory manager instance (optional)
            logger: Logger instance (optional)
            args (dict): Arguments to be passed to the script (optional)
            envParams (dict): Environment parameters to be passed to the script (optional)
            block_dangerous_modules (bool): Whether to enable security restrictions (defaults to True)
        Returns:
            dict: Execution result containing response, logs, and error information
        """
        # Normalize args and envParams
        args = args or {}
        envParams = envParams or {}
        
        # Log function entry
        if logger:
            logger.debug(f"KoreRuntime.execute() - Entry: script_length={len(script) if script else 0}, "
                        f"has_memory={memory is not None}, has_logger={logger is not None}, "
                        f"args_keys={list(args.keys())}, envParams_keys={list(envParams.keys())}, "
                        f"block_dangerous_modules={block_dangerous_modules}")
        
        # Validate script is provided
        if not script:
            if logger:
                logger.error("KoreRuntime.execute() - No script provided for execution")
            return {
                "error": "No script provided for execution",
                "logs": [],
                "response": None
            }
        
        if logger:
            logger.debug(f"KoreRuntime.execute() - Calling execute_python_wrapper with script_length={len(script)}")
        
        try:
            result = execute_python_wrapper(script, memory, logger, args, envParams, block_dangerous_modules)
            
            if logger:
                logger.debug(f"KoreRuntime.execute() - Exit: success={result.get('error') is None}, "
                            f"has_response={result.get('response') is not None}, "
                            f"logs_count={len(result.get('logs', []))}")
            
            return result
        except Exception as e:
            if logger:
                logger.error(f"KoreRuntime.execute() - Exception in execute_python_wrapper: {str(e)}")
            raise


def main():
    """
    Main function to execute user code with proper context
    """
    try:
        # Get the user script from command line arguments
        if len(sys.argv) < 3:
            raise ValueError("Missing required arguments: script and context")
        
        user_script = sys.argv[1]
        context_json = sys.argv[2]
        # Parse execution context
        context_data = json.loads(context_json)
        authorization = context_data.get("authorization", "")
        execution_mode = context_data.get("executionMode", None)
        mock_memory_data = context_data.get("mockMemoryData", {})
        args = context_data.get("args", {})
        envParams = context_data.get("envParams", {})
        block_dangerous_modules = context_data.get("blockDangerousModules", True)  # Default to true for security
        jwt = authorization
        base_url = context_data.get("base_url", "") or 'http://agentic-design'
        
        # Suppress memory_service_sdk logging
        memory_sdk_logger = logging.getLogger('memory_service_sdk')
        original_memory_level = memory_sdk_logger.level
        memory_sdk_logger.setLevel(logging.CRITICAL)
        
        try:
            # Initialize memory manager based on execution mode
            if execution_mode == "simulate":
                # Use mock memory manager for testing
                memory = MockMemoryManager(mock_memory_data)
            else:
                # Use real API client and memory manager for production
                from memory_service_sdk import MemoryContentManager, APIClient
                api_client = APIClient(jwt=jwt, base_url=base_url)
                memory = MemoryContentManager(api_client=api_client)
            
            # Execute using KoreRuntime with args and block_dangerous_modules passed separately
            result = KoreRuntime.execute(
                user_script, 
                memory=memory, 
                logger=None, 
                args=args, 
                envParams=envParams,
                block_dangerous_modules=block_dangerous_modules
            )
            
            # Output the result as JSON
            print(json.dumps(result))
            
        finally:
            # Always restore the original memory SDK logging level
            try:
                memory_sdk_logger.setLevel(original_memory_level)
            except:
                pass  # Ignore errors if variables don't exist
                
    except Exception as e:
        # Handle any errors and output as JSON
        error_result = {
            "error": f"[Error] {str(e)}",
            "logs": [],
            "response": None
        }
        print(json.dumps(error_result))
        sys.exit(1)

if __name__ == "__main__":
    main()
