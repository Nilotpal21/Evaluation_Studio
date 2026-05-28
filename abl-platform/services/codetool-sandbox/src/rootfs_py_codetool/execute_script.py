from pydantic import BaseModel
from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
import uvicorn
import json
import asyncio
import os

from gvisor_logger import *
from constants import *
from utils import *

# Define the FastAPI app
app = FastAPI()

@app.get("/health")
def health_check():
    """Health check endpoint."""
    return {"status": "Service is running"}

class ExecuteScriptRequest(BaseModel):
    script: str
    args: dict
    envParams: str
    executionMode: str = None
    mockMemoryData: dict = {}
    codeType: str = "python"  # "python" or "javascript"
    blockDangerousModules: bool = True  # Security flag to block dangerous modules (defaults to True)
    base_url: str = ""  # Base URL for memory API callbacks (e.g., http://abl-platform-runtime:3113)

@app.post("/execute-script")
async def execute_script(request: ExecuteScriptRequest, traceparent: str = Header(None), authorization: str = Header(None)):
    """
    Endpoint to execute given Python or JavaScript script with given arguments.
    Args:
        request (Request): The request object
            script: Python or JavaScript script to be executed
            args: Arguments to be passed to the script
            codeType: "python" or "javascript"
        traceparent (str): The traceparent header
    Returns:
        result: Script output
        stdout: Standard output of the script execution
        stderr: Standard error of the script execution
    """
    x_traceid = traceparent.split("-")[1] if traceparent else None
    log_info(f"gVisor service received request: {request}", x_traceid)
    script = request.script
    args = request.args
    envParams = request.envParams
    code_type = request.codeType.lower()

    # Create execution context with authorization from header and execution details from payload
    execution_context = {
        "authorization": authorization or "",
        "executionMode": request.executionMode,
        "mockMemoryData": request.mockMemoryData,
        "args": args,
        "envParams": envParams,
        "blockDangerousModules": True,
        "base_url": request.base_url
    }
    serialized_context = json.dumps(execution_context)
    
    # For Python scripts, prepare the script with seccomp wrapper
    # The runtime will validate only the user's code portion (not the wrapper)
    if code_type == "python":
        executable_script = prepare_script(script)
    else:
        executable_script = script
    
    log_debug(f"User script: {script}", x_traceid)
    log_debug(f"Code type: {code_type}", x_traceid)
    log_debug(f"Execution context: {serialized_context}", x_traceid)

    # Use appropriate runtime based on code type
    current_dir = os.path.dirname(os.path.abspath(__file__))  # In Docker: /app/rootfs
    log_debug(f"Current dir (working dir for module execution): {current_dir}", x_traceid)
    
    if code_type == "javascript":
        # Use Node.js runtime for JavaScript with environment variable approach
        runtime_path = os.path.join(current_dir, "runtime_js", "index.js")
        node_executable = os.path.join(NODE_BIN_PATH, "node")
        
        log_debug(f"Runtime JS path: {runtime_path}", x_traceid)
        log_debug(f"Node executable: {node_executable}", x_traceid)
        
        # Build environment with proxy configuration
        js_env = {
            "HOME": os.getenv("HOME"),
            "PATH": f"{NODE_BIN_PATH}:" + os.environ.get("PATH", ""),
            "NODE_PATH": NODE_MODULES_PATH,
            "PROXY_GLOBAL_NATIVE": str(PROXY_GLOBAL_NATIVE).lower(),
            "ALLOW_CUSTOM_AGENTS": str(ALLOW_CUSTOM_AGENTS).lower()
        }
        
        # Add proxy environment variables if proxy is enabled
        if PROXY_ENABLED:
            js_env.update({
                "HTTP_PROXY": HTTP_PROXY,
                "HTTPS_PROXY": HTTPS_PROXY,
                "NO_PROXY": NO_PROXY,
                "http_proxy": HTTP_PROXY,
                "https_proxy": HTTPS_PROXY,
                "no_proxy": NO_PROXY,
                "GLOBAL_AGENT_HTTP_PROXY": GLOBAL_AGENT_HTTP_PROXY,
                "GLOBAL_AGENT_HTTPS_PROXY": GLOBAL_AGENT_HTTPS_PROXY,
                "GLOBAL_AGENT_NO_PROXY": GLOBAL_AGENT_NO_PROXY,
                "GLOBAL_AGENT_FORCE_GLOBAL_AGENT": GLOBAL_AGENT_FORCE_GLOBAL_AGENT
            })
        
        # Set NODE_PATH environment variable and use full path to node command
        process = await asyncio.create_subprocess_exec(
            node_executable, runtime_path, script, serialized_context,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            preexec_fn=set_limits_nodejs,
            env=js_env,
            cwd=current_dir
        )
    else:
        # Use Python runtime for Python (default)
        log_debug(f"Executing Python runtime: runtime.main", x_traceid)
        
        # Pass the prepared script (with seccomp wrapper) to runtime
        # The runtime will extract and validate only the user's code portion
        command = [ENV_ACTIVATION_PATH, "-m", "runtime.main", executable_script, serialized_context]    
        log_debug(f"Executing command: {command}", x_traceid)
        
        # Build environment with proxy configuration
        py_env = {"HOME": os.getenv("HOME")}
        
        # Add proxy environment variables if proxy is enabled
        if PROXY_ENABLED:
            py_env.update({
                "HTTP_PROXY": HTTP_PROXY,
                "HTTPS_PROXY": HTTPS_PROXY,
                "NO_PROXY": NO_PROXY,
                "http_proxy": HTTP_PROXY,
                "https_proxy": HTTPS_PROXY,
                "no_proxy": NO_PROXY
            })
        
        process = await asyncio.create_subprocess_exec(
            *command, 
            stdout=asyncio.subprocess.PIPE, 
            stderr=asyncio.subprocess.PIPE, 
            preexec_fn=set_limits, 
            env=py_env, 
            cwd=current_dir
        )
        log_debug(command, x_traceid)

    # Output and error streams of subprocess captured after execution
    stdout, stderr = await process.communicate()
    log_debug(f"stdout: {stdout}", x_traceid)
    log_debug(f"stderr: {stderr}", x_traceid)

    log_info(f"Process return code: {process.returncode}", x_traceid)
    if process.returncode == -9:
        # Indicates that the execution timed out
        error_message = f"Execution timed out after {CPU_TIME_LIMIT_SECONDS} seconds. Please optimize your code for faster performance."
        return JSONResponse(status_code=408, content={"error": error_message, "logs": ""})
    else:
        stdout_text = stdout.decode()
        error = stderr.decode()
        
        # Try to parse JSON from stdout, handling cases where there might be extra output
        try:
            # Look for the first valid JSON object in the output
            lines = stdout_text.strip().split('\n')
            json_output = None
            
            for line in lines:
                line = line.strip()
                if line.startswith('{') and line.endswith('}'):
                    try:
                        json_output = json.loads(line)
                        break
                    except json.JSONDecodeError:
                        continue
            
            if json_output is None:
                # If no valid JSON found, try parsing the entire output
                json_output = json.loads(stdout_text)
                
            output = json_output
            
        except json.JSONDecodeError as e:
            log_error(f"Failed to parse JSON from stdout: {e}. Raw stdout: {stdout_text}", x_traceid, "")
            # Create a fallback response with the raw output
            output = {
                "error": f"Failed to parse execution output as JSON: {str(e)}",
                "raw_output": stdout_text,
                "logs": []
            }
            
        # Check if there's actually an error (only check error field in output, ignore stderr debug messages)
        has_error = (process.returncode != 0 or 
                    (isinstance(output, dict) and output.get("error", "")))
        if has_error:
            log_error(f"Error in execution: {output.get('error', error)}", x_traceid, "")
            return JSONResponse(status_code=500, content=output)
        log_info(f"Script output: {output}", x_traceid)
        return output

if __name__ == "__main__":
    uvicorn.run("execute_script:app", host=HOST, port=PORT, workers=WORKERS)
