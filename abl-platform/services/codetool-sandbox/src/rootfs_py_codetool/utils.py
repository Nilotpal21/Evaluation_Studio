import os
import resource

CPU_TIME_LIMIT_SECONDS = int(os.getenv("CPU_TIME_LIMIT_SECONDS", 30))
MEMORY_LIMIT_BYTES = int(os.getenv("MEMORY_LIMIT_BYTES", 1073741824))

# Path constants
ENV_ACTIVATION_PATH = "exec_env/bin/python3"

# Server configuration
HOST = "0.0.0.0"
PORT = 8001
WORKERS = 5

package_imports = """import sys
import logging
import io
import textwrap
import json
import requests"""

def set_limits():
    # Setting resource limits
    # RLIMIT_AS - maximum area (in bytes) of memory which may be taken by the process.
    # RLIMIT_CPU - maximum amount of processor time (in seconds) that a process can use.
    resource.setrlimit(resource.RLIMIT_AS, (MEMORY_LIMIT_BYTES , MEMORY_LIMIT_BYTES))
    resource.setrlimit(resource.RLIMIT_CPU, (CPU_TIME_LIMIT_SECONDS, CPU_TIME_LIMIT_SECONDS))

def set_limits_nodejs():
    # Setting resource limits for Node.js processes
    # Node.js has complex memory requirements for WebAssembly, V8 engine, etc.
    # For now, only limit CPU time to prevent infinite loops, but allow memory flexibility
    # RLIMIT_CPU - maximum amount of processor time (in seconds) that a process can use.
    resource.setrlimit(resource.RLIMIT_CPU, (CPU_TIME_LIMIT_SECONDS, CPU_TIME_LIMIT_SECONDS))
    resource.setrlimit(resource.RLIMIT_RSS, (MEMORY_LIMIT_BYTES, MEMORY_LIMIT_BYTES))

def prepare_script(script):
    with open("seccomp_policy.py", "r") as f:
        seccomp_filter = f.read()
    return f"{package_imports}\n{seccomp_filter}\n\n{script}"