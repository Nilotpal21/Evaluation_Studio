"""
Redis Cache

Cluster-aware Redis client for caching preprocessing results and tenant
dictionaries. Supports both standalone and Redis Cluster mode via the same
env vars used by the TypeScript platform services:

  REDIS_URL         — connection URL (or comma-separated seed list in cluster mode)
  REDIS_PASSWORD    — AUTH password (optional)
  REDIS_CLUSTER     — 'true' to enable Redis Cluster mode (default: false)
  REDIS_TLS_ENABLED — 'true' to enable TLS (default: false)
  REDIS_HOST / REDIS_PORT — fallback when REDIS_URL is not set
"""

import json
import logging
import os
import ssl
from typing import Any, Optional

import redis
import redis.cluster

logger = logging.getLogger(__name__)


def _build_ssl_context() -> ssl.SSLContext:
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


class RedisCache:
    """
    Redis cache for preprocessing service.

    Reads REDIS_CLUSTER, REDIS_TLS_ENABLED, REDIS_PASSWORD from the environment
    automatically so the same Docker/Helm config used by runtime also works here.
    """

    def __init__(self, host: str = 'localhost', port: int = 6379, db: int = 0, url: Optional[str] = None):
        """
        Initialize Redis client.

        Priority: env vars > constructor args (kept for backwards compatibility).

        Args:
            host: Redis host (fallback when REDIS_HOST / REDIS_URL env vars are not set)
            port: Redis port (fallback when REDIS_PORT / REDIS_URL env vars are not set)
            db:   Redis database number (standalone only; ignored in cluster mode)
            url:  Explicit URL override (lowest priority — REDIS_URL env var takes precedence)
        """
        cluster_mode = os.getenv('REDIS_CLUSTER', 'false').lower() == 'true'
        tls_enabled = os.getenv('REDIS_TLS_ENABLED', 'false').lower() == 'true'
        password = os.getenv('REDIS_PASSWORD') or None

        effective_url = os.getenv('REDIS_URL') or url
        ssl_ctx = _build_ssl_context() if tls_enabled else None

        if cluster_mode:
            # REDIS_URL is a comma-separated seed list: "host1:port1,host2:port2,..."
            if effective_url:
                raw_nodes = effective_url.split(',')
            else:
                raw_nodes = [f'{os.getenv("REDIS_HOST", host)}:{os.getenv("REDIS_PORT", str(port))}']

            startup_nodes = []
            for node in raw_nodes:
                node = node.strip().lstrip('redis://').lstrip('rediss://')
                node_host, _, node_port = node.rpartition(':')
                startup_nodes.append(
                    redis.cluster.ClusterNode(node_host or node, int(node_port) if node_port else 6379)
                )

            self.client = redis.cluster.RedisCluster(
                startup_nodes=startup_nodes,
                decode_responses=True,
                password=password,
                ssl=tls_enabled,
                ssl_context=ssl_ctx,
                socket_connect_timeout=5,
                socket_timeout=5,
            )
            logger.info("Redis cache initialized in cluster mode (%d seed nodes)", len(startup_nodes))

        elif effective_url:
            connect_kwargs: dict = dict(
                decode_responses=True,
                socket_connect_timeout=5,
                socket_timeout=5,
            )
            if password:
                connect_kwargs['password'] = password
            if ssl_ctx:
                connect_kwargs['ssl_context'] = ssl_ctx
            self.client = redis.Redis.from_url(effective_url, **connect_kwargs)
            logger.info("Redis cache initialized from URL")

        else:
            redis_host = os.getenv('REDIS_HOST', host)
            redis_port = int(os.getenv('REDIS_PORT', str(port)))
            redis_db = int(os.getenv('REDIS_DB', str(db)))
            self.client = redis.Redis(
                host=redis_host,
                port=redis_port,
                db=redis_db,
                password=password,
                decode_responses=True,
                ssl=tls_enabled,
                ssl_context=ssl_ctx,
                socket_connect_timeout=5,
                socket_timeout=5,
            )
            logger.info("Redis cache initialized: %s:%d/%d", redis_host, redis_port, redis_db)

    def get(self, key: str) -> Optional[Any]:
        """Get value from cache. Returns None on miss or Redis error."""
        try:
            value = self.client.get(key)
            if value:
                return json.loads(value)
            return None
        except redis.RedisError as e:
            logger.error("Redis GET error for key '%s': %s", key, e)
            return None
        except json.JSONDecodeError as e:
            logger.error("JSON decode error for key '%s': %s", key, e)
            return None

    def set(self, key: str, value: Any, ttl: int = 3600) -> bool:
        """Set value in cache with TTL. Returns True on success."""
        try:
            serialized = json.dumps(value)
            self.client.setex(key, ttl, serialized)
            return True
        except redis.RedisError as e:
            logger.error("Redis SET error for key '%s': %s", key, e)
            return False
        except (TypeError, ValueError) as e:
            logger.error("JSON encode error for key '%s': %s", key, e)
            return False

    def delete(self, key: str) -> bool:
        """Delete key from cache. Returns True if key existed."""
        try:
            result = self.client.delete(key)
            return result > 0
        except redis.RedisError as e:
            logger.error("Redis DELETE error for key '%s': %s", key, e)
            return False

    def ping(self) -> bool:
        """Check Redis connection health."""
        try:
            return bool(self.client.ping())
        except redis.RedisError as e:
            logger.error("Redis PING failed: %s", e)
            return False

    def flush_pattern(self, pattern: str) -> int:
        """
        Delete all keys matching a pattern.

        Uses SCAN in both standalone and cluster mode to avoid the blocking
        KEYS command (KEYS returns partial results in cluster mode).
        """
        try:
            deleted = 0
            if isinstance(self.client, redis.cluster.RedisCluster):
                # Cluster: scan each master node independently
                for node in self.client.get_primaries():
                    node_client = self.client.get_redis_connection(node)
                    cursor = 0
                    while True:
                        cursor, keys = node_client.scan(cursor, match=pattern, count=100)
                        if keys:
                            deleted += node_client.delete(*keys)
                        if cursor == 0:
                            break
            else:
                cursor = 0
                while True:
                    cursor, keys = self.client.scan(cursor, match=pattern, count=100)
                    if keys:
                        deleted += self.client.delete(*keys)
                    if cursor == 0:
                        break
            return deleted
        except redis.RedisError as e:
            logger.error("Redis FLUSH pattern '%s' failed: %s", pattern, e)
            return 0
