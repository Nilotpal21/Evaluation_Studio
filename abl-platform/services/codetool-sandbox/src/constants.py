import os
import ast

ACCOUNT_ID = os.getenv('ACCOUNT_ID')
ML_APP_HOST = os.getenv('ML_APP_HOST')
X_TRACEID = os.getenv('X_TRACEID')
APP_HOST = os.getenv('APP_HOST')
API_KEY = os.getenv('API_KEY')
EXECUTABLE_TYPE = os.getenv('EXECUTABLE_TYPE')
DEPLOYMENT_ID = os.getenv('DEPLOYMENT_ID')
TIMEOUT = int(os.getenv('TIMEOUT', '60'))
HARDWARE_INFO = ast.literal_eval(os.getenv('HARDWARE_INFO', '{}'))
SERVICE_FILES_PATH = os.getenv('SERVICE_FILES_PATH')
WHITELISTED_DOMAINS = ast.literal_eval(os.getenv('WHITELISTED_DOMAINS', '[]'))
GVISOR_ENV_VARS = ast.literal_eval(os.getenv('GVISOR_ENVIRONMENT_VARIABLES', '{}'))
OTEL_ENDPOINT = os.getenv('OTEL_ENDPOINT')

# Environment variables for logging
GALE_ENV = os.environ.get("GALE_ENV")
LOG_SOURCE = "gvisor-service"
DEBUG = os.environ.get("DEBUG") == 'True'
POD_NAME = os.environ.get("POD_NAME")
POD_ID = os.environ.get("POD_ID")

# Proxy configuration environment variables
# Proxy is disabled by default. To enable, set PROXY_ENABLED=true and configure
# HTTPS_SQUID_PROXY (e.g. http://squid:3128) or individual proxy env vars.
PROXY_ENABLED = os.environ.get("PROXY_ENABLED", "false").lower() == "true"
PROXY_GLOBAL_NATIVE = os.environ.get("PROXY_GLOBAL_NATIVE", "true").lower() == "true"
ALLOW_CUSTOM_AGENTS = os.environ.get("ALLOW_CUSTOM_AGENTS", "false").lower() == "true"
HTTPS_SQUID_PROXY = os.environ.get("HTTPS_SQUID_PROXY", "")
HTTP_PROXY = os.environ.get("HTTP_PROXY", HTTPS_SQUID_PROXY)
HTTPS_PROXY = os.environ.get("HTTPS_PROXY", HTTPS_SQUID_PROXY)
NO_PROXY = os.environ.get("NO_PROXY", "localhost,127.0.0.1,0.0.0.0,inlinetool,agentic-design,agentic-runtime,agentic-async,app,adminserver,memory-mgmt-service,agentic-encryption,growthbook,koretracing,env-*")
GLOBAL_AGENT_HTTP_PROXY = os.environ.get("GLOBAL_AGENT_HTTP_PROXY", HTTPS_SQUID_PROXY)
GLOBAL_AGENT_HTTPS_PROXY = os.environ.get("GLOBAL_AGENT_HTTPS_PROXY", HTTPS_SQUID_PROXY)
GLOBAL_AGENT_NO_PROXY = os.environ.get("GLOBAL_AGENT_NO_PROXY", NO_PROXY)
GLOBAL_AGENT_FORCE_GLOBAL_AGENT = os.environ.get("GLOBAL_AGENT_FORCE_GLOBAL_AGENT", "false")


SERVICE_FILES_MOUNT_PATH = "/gvisor-files"
GVISOR_SERVICE_FILES_PATH = "service_files"
UPLOADS_DIR = "/uploads"
DNS_RESOLUTION_FILE = "etc/resolv.conf"
DNS_RESOLUTION_CONTENT = """nameserver 9.9.9.9\noptions ndots:1"""
# Allowed internal services for codetool (will be resolved and added to /etc/hosts)
# squid is only needed when PROXY_ENABLED=true
ALLOWED_INTERNAL_SERVICES = ["agentic-design"] + (["squid"] if PROXY_ENABLED and HTTPS_SQUID_PROXY else [])
HOSTS_FILE = "etc/hosts"
GVISOR_NETWORK_CONFIG_FILE = "network_config/network_build.sh"
NGINX_CONFIG_TEMPLATE = "network_config/nginx.conf.template"
DOWNLOAD_TIMEOUT = 180

PYTHON = "python"
JS = "javascript"
PYTHON_CODETOOL = "codetool_python"
JS_CODETOOL = "codetool_js"
CODETOOL_EXECUTABLES = [PYTHON_CODETOOL, JS_CODETOOL]
PYTHON_INSTALLATION_CMD = "exec_env/bin/pip install -r requirements.txt --no-cache-dir"
# Node.js and NVM configuration
NODE_VERSION = "v22.22.0"
NODE_PATH_BASE = f"/opt/.nvm/versions/node/{NODE_VERSION}"
NODE_BIN_PATH = f"{NODE_PATH_BASE}/bin"
NODE_MODULES_PATH = f"{NODE_PATH_BASE}/lib/node_modules"
NVM_INSTALLTION_PATH = "/opt"
NVM_ACTIVATE_CMD = f"export NVM_DIR=\"{NVM_INSTALLTION_PATH}/.nvm\" && . \"$NVM_DIR/nvm.sh\""
JS_INSTALLATION_CMD = f"{NVM_ACTIVATE_CMD} && npm install"
PYTHON_EXECUTION_CMD = ["exec_env/bin/python", "execute_code.py"]
JS_EXECUTION_CMD = ["sh", "-c", f"{NVM_ACTIVATE_CMD} && node execute_code.js"]
PYTHON_CODETOOL_EXECUTION_CMD = ["exec_env/bin/python", "execute_script.py"]
JS_CODETOOL_EXECUTION_CMD = ["exec_env/bin/python", "execute_script.py"]  # Same as Python since execute_script.py handles both
PYTHON_MAIN_FILE = "main.py"
JS_MAIN_FILE = "main.js"
PYTHON_REQUIREMENTS_FILE = "requirements.txt"
JS_REQUIREMENTS_FILE = "package.json"
EXECUTABLE_CONFIG = {
    PYTHON : {
        "main_file": PYTHON_MAIN_FILE,
        "requirements_file": PYTHON_REQUIREMENTS_FILE
    },
    JS : {
        "main_file": JS_MAIN_FILE,
        "requirements_file": JS_REQUIREMENTS_FILE
    }
}
PYTHON_MOUNTS = ["exec_env", "requirements.txt", "functions"]
JS_MOUNTS = ["node_modules", "root", "package-lock.json", "package.json", "functions"]
