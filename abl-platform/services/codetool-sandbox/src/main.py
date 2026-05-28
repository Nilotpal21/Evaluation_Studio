import httpx
import asyncio
import time

from constants import *
from utils import *
from logger import *

if __name__ == "__main__":
    try:
        setup_env_variables()
        log_info("Starting gVisor container", X_TRACEID)
        setup_gvisor_network()
        if EXECUTABLE_TYPE not in CODETOOL_EXECUTABLES:
            service_files_path = download_file(SERVICE_FILES_PATH)
            update_config_args("install", service_files_path)
            log_info("Custom package installation inside gVisor container", X_TRACEID)
            run_gvisor_container('execute_code', "install")
        log_info("Server initialization inside gVisor container", X_TRACEID)
        update_config_args("execute")
        run_gvisor_container('execute_code', "execute")
    except gVisorInitializationError as e:
        log_error(f"{str(e)}", X_TRACEID, stack_trace=traceback.format_exc())
        time.sleep(5) # Sleep for 5 seconds to ensure graceful pod shutdown
        undeploy_service()
    except Exception as e:
        log_error(f"{str(e)}", X_TRACEID, stack_trace=traceback.format_exc())
        time.sleep(5) # Sleep for 5 seconds to ensure graceful pod shutdown
        if EXECUTABLE_TYPE not in CODETOOL_EXECUTABLES:
            # Sent deplyment failed status to BE service
            asyncio.run(update_deployment_status("DEPLOYMENT_FAILED", str(e)))
        undeploy_service()





