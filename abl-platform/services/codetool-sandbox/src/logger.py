import logging
import json
from datetime import datetime, timezone
import uuid
import time
import os
from constants import DEBUG, GALE_ENV, LOG_SOURCE, POD_ID, POD_NAME

# Set logging level based on DEBUG flag
logging.basicConfig(level=logging.DEBUG if DEBUG else logging.INFO)
logging.getLogger("opentelemetry.attributes").setLevel(logging.ERROR)
logger = logging.getLogger(__name__)

def log(message, logLevel, x_traceid, stack_trace=None):
    log_entry = {
        "logLevel": logLevel,
        "x-traceid": x_traceid,
        "meta": {
            "msg": f"{message}",
            "hostname": GALE_ENV,
            "pid" : os.getpid(),
            "podId" : POD_ID,
            "podName": POD_NAME,
            "logid": str(uuid.uuid4()),
            "source": LOG_SOURCE,
            "stack_trace": stack_trace,
            "x-traceid": x_traceid
        },
        "unixtimestamp": int(datetime.timestamp(datetime.now()) * 1000),   # Current timestamp in milliseconds
        "timestamp": datetime.fromtimestamp(time.time(), tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    }

    log_entry_json = json.dumps(log_entry)

    return log_entry_json

def log_debug(message, x_traceid):
    log_entry_json = log(message, "DEBUG", x_traceid)
    logger.debug(log_entry_json)

def log_info(message, x_traceid):
    log_entry_json = log(message, "INFO", x_traceid)
    logger.info(log_entry_json)

def log_warning(message, x_traceid):
    log_entry_json = log(message, "WARNING", x_traceid)
    logger.warning(log_entry_json)

def log_error(message, x_traceid, stack_trace=None):
    log_entry_json = log(message, "ERROR", x_traceid, stack_trace)
    logger.error(log_entry_json)

def time_usage(func):
    def wrapper(*args, **kwargs):
        start_time = time.time()
        result = func(*args, **kwargs)
        end_time = time.time()
        duration = end_time - start_time
        timing_info = f"{func.__name__} took {duration:.2f} seconds to execute"
        logging.info(timing_info)
        return result
    return wrapper