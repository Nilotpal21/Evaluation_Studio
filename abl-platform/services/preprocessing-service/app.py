"""
Preprocessing Service - Main Flask Application

Provides multilingual query preprocessing for search-ai-runtime.
Supports 20+ languages for spell correction, 30+ for synonym expansion.
"""

import os
import logging
from typing import Dict, Any
from flask import Flask, request, jsonify
from prometheus_client import Counter, Histogram, generate_latest
from dotenv import load_dotenv

from src.preprocessing.pipeline import PreprocessingPipeline
from src.cache.redis_cache import RedisCache

# Load environment variables
load_dotenv()

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Create Flask app
app = Flask(__name__)

# Metrics
REQUEST_COUNT = Counter(
    'preprocessing_requests_total',
    'Total preprocessing requests',
    ['language', 'tenant_id']
)
REQUEST_DURATION = Histogram(
    'preprocessing_duration_seconds',
    'Preprocessing request duration',
    ['language', 'stage']
)
ERROR_COUNT = Counter(
    'preprocessing_errors_total',
    'Total preprocessing errors',
    ['error_type']
)

# Initialize services
redis_cache = None
pipeline = None


def init_services():
    """Initialize Redis cache and preprocessing pipeline"""
    global redis_cache, pipeline

    try:
        # Initialize Redis cache — prefer REDIS_URL (from shared secrets), fall back to host/port
        redis_url = os.getenv('REDIS_URL')
        if redis_url:
            redis_cache = RedisCache(url=redis_url)
            logger.info("Connected to Redis via REDIS_URL")
        else:
            redis_host = os.getenv('REDIS_HOST', 'localhost')
            redis_port = int(os.getenv('REDIS_PORT', '6379'))
            redis_cache = RedisCache(host=redis_host, port=redis_port)
            logger.info(f"Connected to Redis at {redis_host}:{redis_port}")

        # Initialize preprocessing pipeline
        pipeline = PreprocessingPipeline(cache=redis_cache)
        logger.info("Preprocessing pipeline initialized")

    except Exception as e:
        logger.error(f"Failed to initialize services: {e}")
        raise


@app.route('/health', methods=['GET'])
def health_check():
    """Health check endpoint"""
    try:
        # Check Redis connection
        if redis_cache:
            redis_cache.ping()

        return jsonify({
            'status': 'healthy',
            'service': 'preprocessing-service',
            'version': '1.0.0'
        }), 200
    except Exception as e:
        logger.error(f"Health check failed: {e}")
        return jsonify({
            'status': 'unhealthy',
            'error': str(e)
        }), 503


@app.route('/v1/preprocess', methods=['POST'])
def preprocess():
    """
    Preprocess a query with multilingual support

    Request body:
    {
        "query": "string",
        "tenantId": "string",
        "config": {
            "enableSpellCorrection": true,
            "enableSynonymExpansion": true,
            "enableEntityExtraction": true,
            "maxSynonyms": 3
        }
    }

    Response:
    {
        "processedQuery": "string",
        "language": "string",
        "confidence": 0.99,
        "stages": {
            "spellCorrection": [...],
            "synonymExpansion": [...],
            "entities": [...]
        },
        "metadata": {
            "originalQuery": "string",
            "processingTimeMs": 2.5,
            "stagesExecuted": ["language_detection", "spell_correction"]
        }
    }
    """
    try:
        # Validate request
        data = request.get_json()
        if not data:
            return jsonify({'error': 'Request body is required'}), 400

        query = data.get('query')
        tenant_id = data.get('tenantId')
        config = data.get('config', {})

        if not query:
            return jsonify({'error': 'query is required'}), 400
        if not tenant_id:
            return jsonify({'error': 'tenantId is required'}), 400

        # Process query
        result = pipeline.process(
            query=query,
            tenant_id=tenant_id,
            config=config
        )

        # Record metrics
        REQUEST_COUNT.labels(
            language=result.language,
            tenant_id=tenant_id
        ).inc()

        # Convert to dict for JSON response (by_alias=True to emit camelCase keys)
        response = result.dict(by_alias=True)

        logger.info(
            f"Processed query for tenant {tenant_id}, "
            f"language={result.language}, "
            f"time={result.metadata['processingTimeMs']}ms"
        )

        return jsonify(response), 200

    except ValueError as e:
        ERROR_COUNT.labels(error_type='validation').inc()
        logger.warning(f"Validation error: {e}")
        return jsonify({'error': str(e)}), 400

    except Exception as e:
        ERROR_COUNT.labels(error_type='internal').inc()
        logger.error(f"Processing error: {e}", exc_info=True)
        return jsonify({'error': 'Internal server error'}), 500


@app.route('/metrics', methods=['GET'])
def metrics():
    """Prometheus metrics endpoint"""
    return generate_latest(), 200


@app.route('/v1/languages', methods=['GET'])
def list_languages():
    """List supported languages"""
    return jsonify({
        'languages': {
            'spellCorrection': [
                'en', 'es', 'de', 'fr', 'it', 'nl', 'pt', 'ru',
                'ar', 'lv', 'eu', 'tr'
            ],
            'synonymExpansion': [
                'en', 'es', 'de', 'fr', 'it', 'nl', 'pt', 'ru',
                'ja', 'zh', 'ar', 'fa', 'pl', 'no', 'fi', 'da',
                'sv', 'el', 'he', 'id', 'th', 'ro', 'bg', 'sk',
                'sl', 'hr', 'ca', 'eu', 'gl', 'lt', 'lv', 'et'
            ],
            'detection': [
                'en', 'es', 'de', 'fr', 'it', 'nl', 'pt', 'ru',
                'ja', 'zh-cn', 'zh-tw', 'ko', 'ar', 'hi', 'tr',
                'pl', 'uk', 'cs', 'sv', 'ro', 'no', 'fi', 'da',
                'el', 'he', 'id', 'th', 'vi', 'ms', 'bn', 'fa',
                'hu', 'bg', 'hr', 'sk', 'sl', 'lt', 'lv', 'et',
                'ca', 'eu', 'gl', 'af', 'sq', 'hy', 'az', 'be',
                'bs', 'cy', 'eo', 'ka', 'is', 'kn', 'la', 'mk',
                'ml', 'mr', 'ne', 'pa', 'sr', 'sw', 'ta', 'te'
            ]
        },
        'total': {
            'spellCorrection': 12,
            'synonymExpansion': 32,
            'detection': 55
        }
    }), 200


# Initialize services at module load time (works with both gunicorn and direct run).
# Gunicorn imports app:app, so init_services() must run at import time.
try:
    init_services()
except Exception:
    logger.exception("Failed to initialize preprocessing pipeline at startup")

if __name__ == '__main__':
    # Run Flask app directly (dev mode)
    port = int(os.getenv('PORT', '8003'))
    app.run(
        host='0.0.0.0',
        port=port,
        debug=os.getenv('FLASK_ENV') == 'development'
    )
