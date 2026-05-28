import sys
import json
import subprocess
import os
import traceback
import httpx
import asyncio
from constants import *
from logger import *
from urllib.parse import urlparse

class gVisorInitializationError(Exception):
    """
    Custom exception class for handling server initialization errors in gVisor container
    """
    def __init__(self, message):
        super().__init__(message)
        self.message = message

async def make_startup_api(status):
    """
    Makes the API call to BE services to update the status of the pod; Executed as PostStartHook or PreStopHook
    Args:
        status (str): The status of the container (Running or Terminated)
    """
    if status.upper() == "RUNNING":
        log_info(f"Making API call to BE services to update the running status of the pod: {status}", X_TRACEID)
        pod_info_url = f"http://{APP_HOST}/api/internal/pods"
        headers = {'apikey': API_KEY}
        payload = {
            "pod_id" : POD_ID,
            "deployment_id" : DEPLOYMENT_ID,
            "status":"RUNNING",
            "pod_type":"WORKER",
            "hardware_info":{
                "device_type": HARDWARE_INFO["hardware_type"],
                "number_of_cpu": HARDWARE_INFO["cpu"],
                "cpu_memory": HARDWARE_INFO["memory"],
            }
        }
        log_info(f"api call info : {pod_info_url} {payload}", X_TRACEID)
        async with httpx.AsyncClient() as client:
            response = await client.post(pod_info_url, headers=headers, json=payload)
        if response.status_code == 200:
            log_info(f"Successfully updated the status of the pod: {status}", X_TRACEID)
        else:
            log_info(f"response : {response.status_code}", X_TRACEID)
            log_error(f"Failed to update the status of the pod: {response.status_code}", X_TRACEID, "")
    else:
        log_info(f"Making API call to BE services to update the termination status of the pod: {status}", X_TRACEID)
        pod_info_url = f"http://{APP_HOST}/api/internal/pods/{POD_ID}/status"
        headers = {'apikey': API_KEY}
        payload = {
            "status": status.upper()
        }
        log_info(f"api call info : {pod_info_url} {payload}", X_TRACEID)
        async with httpx.AsyncClient() as client:
            response = await client.put(pod_info_url, headers=headers, json=payload)
        if response.status_code == 200:
            log_info(f"Successfully updated the status of the pod: {status}", X_TRACEID)
        else:
            log_info(f"response : {response.status_code}", X_TRACEID)
            log_error(f"Failed to update the status of the pod: {response.status_code}", X_TRACEID, "")

    return status

async def update_deployment_status(status, message=None):
    """
    Updates the status of the deployment in the BE service
    Args:
        status (str): The status of the deployment (DEPLOYED or DEPLOYMENT_FAILED)
    """
    async with httpx.AsyncClient() as client:
        deployment_status_url = f"http://{APP_HOST}/api/internal/deployments/{DEPLOYMENT_ID}/status"
        headers = {'apikey': API_KEY}
        payload = {"status": status}
        if status == "DEPLOYMENT_FAILED":
            payload["err_msg"] = message
        
        log_info(f"api call info : {deployment_status_url} {payload}", X_TRACEID)
        response = await client.put(deployment_status_url, headers=headers, json=payload)
        
        if response.status_code == 200:
            log_info(f"Successfully updated deployment status for {DEPLOYMENT_ID}", X_TRACEID)
        else:
            log_info(f"response : {response.status_code}", X_TRACEID)
            log_warning(f"Failed to update deployment status for {DEPLOYMENT_ID}: {response.status_code}", X_TRACEID)


def download_file(service_files_path):
    if not (service_files_path.startswith('http://') or service_files_path.startswith('https://')):
        return os.path.join(SERVICE_FILES_MOUNT_PATH, SERVICE_FILES_PATH)
    file_extension = os.path.splitext(os.path.basename(urlparse(service_files_path).path))[1][1:]
    file_download_path = f"project.{file_extension}"
    
    try:
        response = httpx.get(service_files_path, timeout=DOWNLOAD_TIMEOUT)
    except httpx.TimeoutException:
        stack_trace = traceback.format_exc()
        log_error(f"Timeout occurred while downloading the file from {service_files_path}", X_TRACEID, stack_trace)
        raise Exception(f"Timeout occurred while downloading the file.")

    if response.status_code == 200:
        with open(file_download_path, 'wb') as file:
            file.write(response.content)
        log_info(f"File downloaded successfully. Saved as {file_download_path}", X_TRACEID)
        return file_download_path
    else:
        stack_trace = traceback.format_exc()
        log_error(f"Failed to download the file. Status code: {response.status_code}", X_TRACEID, stack_trace)
        raise Exception(f"Failed to download the file. Status code: {response.status_code}")

def undeploy_service():
    """
    Undeploys the service from the BE service
    """
    with httpx.Client() as client:
        response = client.post(f"{ML_APP_HOST}/api/v1/custom-code-undeploy/{DEPLOYMENT_ID}")
        log_info(f"Sent undeploy notification to ML main service with status code: {response.status_code}", X_TRACEID)

def run_gvisor_container(container_name, process_type):
    """
    Runs a gvisor container
    Args:
        container_name (str): Name with which the container will be started
    Returns:
        None
    """
    if process_type == "install":
        result = subprocess.run(['bash', '-c', f'runsc --debug --debug-log=/tmp/runsc/ --debug-to-user-log --ignore-cgroups --network=host run {container_name}'])
    else:
        result = subprocess.run(['bash', '-c', f'runsc --debug --debug-log=/tmp/runsc/ --debug-to-user-log --oci-seccomp --file-access-mounts=exclusive --ignore-cgroups --network=host run {container_name}'])
    log_debug(f"gvisor container started with result: {result.returncode}", X_TRACEID)
    if result.returncode != 0:
        log_error(f"Failed to initiate gvisor container", X_TRACEID, "")
        raise gVisorInitializationError("Failed to initiate gvisor container")

def _setup_gvisor_network(network_namespace):
    """
    Sets up a gvisor network namespace with the whitelisted domains
    Args:
        network_namespace (str): Name with which the namespace will be created
    Returns:
        None
    """
    try:
        domains_str = '(' + ' '.join(f'"{domain}"' for domain in WHITELISTED_DOMAINS) + ')'
        result = subprocess.run(['sed', '-i', f's/ALLOWED_DOMAINS=.*/ALLOWED_DOMAINS={domains_str}/', GVISOR_NETWORK_CONFIG_FILE])
        if result.returncode != 0:
            log_error("Failed to update whitelisted domains in network config", X_TRACEID, "")
            raise RuntimeError("Failed to update whitelisted domains in network config")
    except Exception as e:
        stack_trace = traceback.format_exc()
        log_error(f"Failed to setup whitelisted domains: {str(e)}", X_TRACEID, stack_trace)
        raise RuntimeError(f"Failed to setup whitelisted domains: {str(e)}")

    result = subprocess.run(['bash', '-c', f'source {GVISOR_NETWORK_CONFIG_FILE} {network_namespace}'], capture_output=True, text=True)
    if result.returncode != 0:
        log_error(f"Failed to setup gvisor network: {result.stderr}", X_TRACEID, "")
        raise RuntimeError(f"Failed to setup gvisor network: {result.stderr}")
    return result

def resolve_internal_services():
    """
    Resolves allowed internal services to their IP addresses using the pod's DNS.
    Returns a dict of {service_name: ip_address}
    """
    import socket
    resolved = {}
    for service in ALLOWED_INTERNAL_SERVICES:
        try:
            ip = socket.gethostbyname(service)
            resolved[service] = ip
            log_info(f"Resolved internal service {service}", X_TRACEID)
        except socket.gaierror as e:
            log_warning(f"Could not resolve internal service {service}: {e}", X_TRACEID)
    return resolved

def setup_gvisor_hosts(resolved_services):
    """
    Sets up /etc/hosts in the gVisor rootfs with resolved internal service IPs.
    This allows access to specific internal services without exposing full cluster DNS.
    """
    hosts_content = ""
    for service, ip in resolved_services.items():
        hosts_content += f"{ip}\t{service}\n"
    
    with open(f'rootfs/{HOSTS_FILE}', 'w') as f:
        f.write(hosts_content)
    log_info(f"Setup gVisor /etc/hosts with services: {list(resolved_services.keys())}", X_TRACEID)

def setup_gvisor_network():
    """
    Sets up network communications from the gvisor container to the outside world
    """
    try:
        if EXECUTABLE_TYPE not in CODETOOL_EXECUTABLES:
            # Print contents of /etc/resolv.conf
            with open(f'/{DNS_RESOLUTION_FILE}', 'r') as f:
                etc_resolv_conf_content = f.read()
            log_debug(f"Contents of /{DNS_RESOLUTION_FILE}:\n{etc_resolv_conf_content}", X_TRACEID)

            # Copy contents of /etc/resolv.conf to rootfs/etc/resolv.conf
            with open(f'rootfs/{DNS_RESOLUTION_FILE}', 'w') as f:
                f.write(etc_resolv_conf_content)

            # Print contents of rootfs/etc/resolv.conf again
            with open(f'rootfs/{DNS_RESOLUTION_FILE}', 'r') as f:
                rootfs_resolv_conf_content_after = f.read()
            log_debug(f"Contents of rootfs/{DNS_RESOLUTION_FILE} after copy:\n{rootfs_resolv_conf_content_after}", X_TRACEID)
        else:
            # For codetool: use public DNS for external resolution
            with open(f'rootfs/{DNS_RESOLUTION_FILE}', 'w') as f:
                f.write(DNS_RESOLUTION_CONTENT)
            
            # Resolve allowed internal services and add to /etc/hosts
            # This provides access to specific services without exposing full cluster DNS
            resolved_services = resolve_internal_services()
            if resolved_services:
                setup_gvisor_hosts(resolved_services)
    except Exception as e:
        stack_trace = traceback.format_exc()
        log_error(f"Failed to setup gvisor network: {str(e)}", X_TRACEID, stack_trace)
        raise RuntimeError(f"Failed to setup gvisor network: {str(e)}")

def setup_env_variables():
    """
    Set the environment variables required for logging inside the gvisor container
    """
    if EXECUTABLE_TYPE in [PYTHON, PYTHON_CODETOOL]:
        with open('rootfs/constants.py', 'w') as f:
            f.write(f"""ACCOUNT_ID = "{ACCOUNT_ID}"
DEPLOYMENT_ID = "{DEPLOYMENT_ID}"
GALE_ENV = "{GALE_ENV}"
LOG_SOURCE = "{LOG_SOURCE}"
DEBUG = {DEBUG}
POD_NAME = "{POD_NAME}"
POD_ID = "{POD_ID}"
X_TRACEID = "{X_TRACEID}"
TIMEOUT = {TIMEOUT}
MAIN_FILE = "{PYTHON_MAIN_FILE}"
REQUIREMENTS_FILE = "{PYTHON_REQUIREMENTS_FILE}"
INSTALLATION_CMD = "{PYTHON_INSTALLATION_CMD}"
ENV_ACTIVATION_PATH = "exec_env/bin/python3"
NODE_BIN_PATH = "{NODE_BIN_PATH}"
NODE_MODULES_PATH = "{NODE_MODULES_PATH}"
GVISOR_SERVICE_FILES_PATH = "functions"
OTEL_ENDPOINT = "{OTEL_ENDPOINT}"
HOST = "0.0.0.0"
PORT = 8001
WORKERS = 5
PROXY_ENABLED = {PROXY_ENABLED}
HTTPS_SQUID_PROXY = "{HTTPS_SQUID_PROXY}"
HTTP_PROXY = "{HTTP_PROXY}"
HTTPS_PROXY = "{HTTPS_PROXY}"
NO_PROXY = "{NO_PROXY}"
GLOBAL_AGENT_HTTP_PROXY = "{GLOBAL_AGENT_HTTP_PROXY}"
GLOBAL_AGENT_HTTPS_PROXY = "{GLOBAL_AGENT_HTTPS_PROXY}"
GLOBAL_AGENT_NO_PROXY = "{GLOBAL_AGENT_NO_PROXY}"
GLOBAL_AGENT_FORCE_GLOBAL_AGENT = "{GLOBAL_AGENT_FORCE_GLOBAL_AGENT}"
PROXY_GLOBAL_NATIVE = {PROXY_GLOBAL_NATIVE}
ALLOW_CUSTOM_AGENTS = {ALLOW_CUSTOM_AGENTS}
""")
    else:
        with open('rootfs/constants.js', 'w') as f:
            f.write(f"""const ACCOUNT_ID = "{ACCOUNT_ID}";
const DEPLOYMENT_ID = "{DEPLOYMENT_ID}";
const GALE_ENV = "{GALE_ENV}";
const LOG_SOURCE = "{LOG_SOURCE}";
const DEBUG = {str(DEBUG).lower()};
const POD_NAME = "{POD_NAME}";
const POD_ID = "{POD_ID}";
const X_TRACEID = "{X_TRACEID}";
const TIMEOUT = {TIMEOUT};
const MAIN_FILE = "{JS_MAIN_FILE}";
const REQUIREMENTS_FILE = "{JS_REQUIREMENTS_FILE}";
const GVISOR_SERVICE_FILES_PATH = "functions";
const OTEL_ENDPOINT = "{OTEL_ENDPOINT}";""" + """

module.exports = {
    DEPLOYMENT_ID,  
    GALE_ENV,
    LOG_SOURCE,
    DEBUG,
    POD_NAME,
    POD_ID,
    X_TRACEID,
    TIMEOUT,
    MAIN_FILE,
    REQUIREMENTS_FILE,
    GVISOR_SERVICE_FILES_PATH,
    OTEL_ENDPOINT
};
""")
        
def setup_nginx_config(pod_ip):
    """
    Sets up the nginx configuration to direct traffic to the gvisor container
    Args:
        pod_ip (str): The IP address of the service inside the gvisor container
    Returns:
        None
    """
    try:
        # Use sed to replace pod_ip and timeout values in the template
        result = subprocess.run([
            'sed', 
            '-e', f's/{{pod_ip}}/{pod_ip}/g',
            '-e', f's/{{timeout}}/{TIMEOUT}s/g',
            NGINX_CONFIG_TEMPLATE
        ], capture_output=True, text=True)

        if result.returncode != 0:
            raise RuntimeError(f"Failed to process nginx template: {result.stderr}")
        
        # Write nginx config to the rootfs
        with open('/app/rootfs/etc/nginx/nginx.conf', 'w') as f:
            f.write(result.stdout)
        
        # Start nginx inside the rootfs
        result = subprocess.run(['chroot', '/app/rootfs', 'nginx'], capture_output=True, text=True)
        if result.returncode != 0:
            raise RuntimeError(f"{result.stderr}")

        log_info(f"Nginx started successfully to direct traffic to gvisor service with IP {pod_ip}", X_TRACEID)
    except Exception as e:
        stack_trace = traceback.format_exc()
        log_error(f"Failed to setup Nginx: {str(e)}", X_TRACEID, stack_trace)
        raise RuntimeError(f"Failed to setup Nginx: {str(e)}")
    
def update_config_args(process_type, service_files_path=None):
    """
    Update the args in config.json based on EXECUTABLE_TYPE
    """
    log_info(f"Updating config.json args based on EXECUTABLE_TYPE: {EXECUTABLE_TYPE}", X_TRACEID)
    
    try:
        # Read the current config
        with open('config_template.json', 'r') as f:
            config = json.load(f)
        
        # Set args and mount folder for write access based on EXECUTABLE_TYPE
        if process_type == "install":
            # uid and gid to 0
            config['process']['user']['uid'] = 0
            config['process']['user']['gid'] = 0
            if EXECUTABLE_TYPE == PYTHON:
                config['process']['args'] = PYTHON_EXECUTION_CMD + ["install"]
                for i in PYTHON_MOUNTS:
                    config["mounts"].append({
                        "destination": f"/{i}",
                        "type": "bind",
                        "source": f"rootfs/{i}",
                        "options": [
                            "rbind",
                            "rw"
                        ]
                    })
            else:
                js_execution_cmd = JS_EXECUTION_CMD[0:-1] + [f"{JS_EXECUTION_CMD[-1]} install"]
                config['process']['args'] = js_execution_cmd
                for i in JS_MOUNTS:
                    config["mounts"].append({
                        "destination": f"/{i}",
                        "type": "bind",
                        "source": f"rootfs/{i}",
                        "options": [
                            "rbind",
                            "rw"
                        ]
                    })
            # Mount service files to the gvisor container
            _, file_extension = os.path.splitext(service_files_path)
            if file_extension == ".gz":
                file_extension = ".tar.gz"
            config["mounts"].append({
                "destination": f"/{SERVICE_FILES_MOUNT_PATH}/project{file_extension}",
                "type": "bind",
                "source": f"{service_files_path}",
                "options": ["rbind", "rw"]
            })
            config["process"]["env"].append(f"SERVICE_FILES_PATH={SERVICE_FILES_MOUNT_PATH}/project{file_extension}")  # Path inside the gVisor container where the service files will be mounted

        elif process_type == "execute":
            if EXECUTABLE_TYPE == PYTHON:
                config['process']['args'] = PYTHON_EXECUTION_CMD + ["execute"]
            elif EXECUTABLE_TYPE == JS:
                js_execution_cmd = JS_EXECUTION_CMD[0:-1] + [f"{JS_EXECUTION_CMD[-1]} execute"]
                config['process']['args'] = js_execution_cmd
            elif EXECUTABLE_TYPE == PYTHON_CODETOOL:
                config['process']['args'] = PYTHON_CODETOOL_EXECUTION_CMD
            elif EXECUTABLE_TYPE == JS_CODETOOL:
                config['process']['args'] = JS_CODETOOL_EXECUTION_CMD
            else:
                raise RuntimeError(f"Invalid EXECUTABLE_TYPE: {EXECUTABLE_TYPE}")
        
        # Append GVISOR_ENV_VARS to config["process"]["env"]
        if GVISOR_ENV_VARS:
            for key, value in GVISOR_ENV_VARS.items():
                if key != "UPLOADS_DIR":
                    config["process"]["env"].append(f"{key}={value}")
                else:
                    config["process"]["env"].append(f"UPLOADS_DIR={UPLOADS_DIR}")
                    config["process"]["env"].append(f"API_KEY={API_KEY}")
                    config["process"]["env"].append(f"APP_HOST={APP_HOST}")
                    config["process"]["env"].append(f"ML_APP_HOST={ML_APP_HOST}")

            # Mount account-specfic folder from NFS to gVisor to access files imported using public API
            if GVISOR_ENV_VARS["UPLOADS_DIR"]:
                uploads_dir_path = os.path.join(SERVICE_FILES_MOUNT_PATH, GVISOR_ENV_VARS["UPLOADS_DIR"])
                config["mounts"].append({
                    "destination": f"/uploads",
                    "type": "bind",
                    "source": uploads_dir_path,
                    "options": ["rbind", "ro"]
                })
        
        # Write the updated config back to the file
        with open('config.json', 'w') as f:
            json.dump(config, f, indent=4)
            
        log_info("Successfully updated config.json args", X_TRACEID)
    except Exception as e:
        stack_trace = traceback.format_exc()
        log_error(f"Failed to update config.json args: {str(e)}", X_TRACEID, stack_trace)
        raise RuntimeError(f"Failed to setup container configuration: {str(e)}")
        
if __name__ == "__main__":
    status = sys.argv[1]
    asyncio.run(make_startup_api(status))
