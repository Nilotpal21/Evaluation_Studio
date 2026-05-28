"""NLU Sidecar — wraps Kore.ai ML models + spaCy for entity extraction and correction detection.

Contract (Finding afaa28f6):
  This service exposes a strict request/response contract. When the underlying
  ML backend is not configured on a given deployment (no spaCy models, no
  Kore.ai NLU models), endpoints return **501 Not Implemented** with a stable
  error code rather than silently returning an empty success payload. This
  lets runtime callers distinguish "sidecar up, feature disabled" from
  "sidecar down" (which is `NLU_SIDECAR_UNAVAILABLE`).

Tenancy contract (Finding 1c7efeb2):
  Every /extract and /detect-correction call MUST carry
    - `x-abl-tenant-id`
    - `x-abl-project-id`
    - `x-abl-session-id`
  headers, and the body MUST echo the same values as `tenantId`, `projectId`,
  `sessionId`. Headers and body must agree. The sidecar validates both, logs
  structured tenancy for every request, and rejects with 400 when missing /
  inconsistent. Future ML backends will use these values for per-tenant
  model routing and per-session telemetry.
"""
from __future__ import annotations

from collections import Counter
from functools import lru_cache
import json
import logging
import os
from pathlib import Path
import re
import sys
from typing import Annotated, Any, Dict, List, Literal, Optional, Tuple

from flask import Flask, Response, g, jsonify, request
from pydantic import BaseModel, ConfigDict, Field, ValidationError

# ---------------------------------------------------------------------------
# Logging — structured JSON so runtime's log aggregator can key on tenancy.
# ---------------------------------------------------------------------------


class _JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: Dict[str, Any] = {
            'level': record.levelname,
            'logger': record.name,
            'message': record.getMessage(),
        }
        for key in ('tenantId', 'projectId', 'sessionId', 'path', 'errorCode'):
            value = getattr(record, key, None)
            if value is not None:
                payload[key] = value
        return json.dumps(payload, sort_keys=True)


_handler = logging.StreamHandler(sys.stdout)
_handler.setFormatter(_JsonFormatter())

log = logging.getLogger('nlu-sidecar')
# Only attach our handler once — pytest reloads the module and would otherwise
# double-log through root.
if not any(isinstance(h, logging.StreamHandler) for h in log.handlers):
    log.addHandler(_handler)
log.setLevel(logging.INFO)
log.propagate = False


# ---------------------------------------------------------------------------
# Error codes — MUST stay in sync with `packages/shared-kernel/src/errors.ts`
# `ErrorCodes.NLU_SIDECAR_*`.
# ---------------------------------------------------------------------------

ERR_MISSING_TENANCY = 'NLU_SIDECAR_MISSING_TENANCY'
ERR_TENANCY_MISMATCH = 'NLU_SIDECAR_TENANCY_MISMATCH'
ERR_INVALID_REQUEST = 'NLU_SIDECAR_INVALID_REQUEST'
ERR_NOT_IMPLEMENTED = 'NLU_SIDECAR_NOT_IMPLEMENTED'


# ---------------------------------------------------------------------------
# Feature flags — flip these on when an ML backend is wired.
#
# We read these once at import time so deployments can choose between
# "sidecar is a thin 501-returning stub" and "sidecar has models loaded".
# Tests override them via monkeypatch on `app.EXTRACT_BACKEND_ENABLED`.
# ---------------------------------------------------------------------------


def _env_bool(name: str) -> bool:
    return os.environ.get(name, '').strip().lower() in ('1', 'true', 'yes', 'on')


EXTRACT_BACKEND_ENABLED = _env_bool('NLU_SIDECAR_EXTRACT_BACKEND_ENABLED')
CORRECTION_BACKEND_ENABLED = _env_bool('NLU_SIDECAR_CORRECTION_BACKEND_ENABLED')
SEMANTIC_MATCH_BACKEND_ENABLED = _env_bool('NLU_SIDECAR_SEMANTIC_MATCH_BACKEND_ENABLED')

# ---------------------------------------------------------------------------
# Scope metrics — lightweight in-process counters until the sidecar is wired
# to a real metrics backend. Keyed by route + tenant/project scope so future
# classifier traffic can be attributed for routing, rate limiting, and audit.
# ---------------------------------------------------------------------------


_REQUEST_SCOPE_METRICS: Dict[str, Counter[str]] = {
    'accepted': Counter(),
    'missing_headers': Counter(),
    'body_mismatch': Counter(),
}


def _scope_metric_key(path: str, tenant_id: Optional[str], project_id: Optional[str]) -> str:
    return f'{path}|{tenant_id or "__missing_tenant__"}|{project_id or "__missing_project__"}'


def _record_scope_metric(
    outcome: str,
    *,
    tenant_id: Optional[str],
    project_id: Optional[str],
) -> None:
    _REQUEST_SCOPE_METRICS.setdefault(outcome, Counter())[
        _scope_metric_key(request.path, tenant_id, project_id)
    ] += 1


def reset_request_scope_metrics() -> None:
    for counter in _REQUEST_SCOPE_METRICS.values():
        counter.clear()


def get_request_scope_metrics_snapshot() -> Dict[str, Dict[str, int]]:
    return {name: dict(counter) for name, counter in _REQUEST_SCOPE_METRICS.items()}


# ---------------------------------------------------------------------------
# Pydantic models — strict request/response schemas for /extract,
# /detect-correction, and /semantic-match.
# ---------------------------------------------------------------------------


_CLASSIFIER_CONTRACT_SOURCE_PATH = (
    Path(__file__).resolve().parents[2]
    / 'packages'
    / 'shared-kernel'
    / 'src'
    / 'classifier-sidecar-contract.ts'
)
_CLASSIFIER_CONTRACT_SCHEMA_JSON_PATTERN = re.compile(
    r'const CLASSIFIER_SIDECAR_CONTRACT_SCHEMA_JSON = `(?P<schema>\{.*?\})` as const;',
    re.DOTALL,
)
NonEmptyString = Annotated[str, Field(min_length=1)]


class ExtractionField(BaseModel):
    model_config = ConfigDict(extra='forbid')

    name: str = Field(..., min_length=1)
    type: str = Field(..., min_length=1)
    hints: List[str] = Field(default_factory=list)


class ExtractionRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')

    text: str
    fields: List[ExtractionField]
    locale: str = 'en'
    # Tenancy is required in the body as well as headers — runtime echoes
    # both for defense-in-depth. Pydantic rejects requests missing any of
    # these.
    tenantId: str = Field(..., min_length=1)
    projectId: str = Field(..., min_length=1)
    sessionId: str = Field(..., min_length=1)


class ExtractionResponse(BaseModel):
    model_config = ConfigDict(extra='forbid')

    entities: Dict[str, Any]
    confidence: Dict[str, float]
    tenantId: str
    projectId: str
    sessionId: str


class CorrectionRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')

    text: str
    context: Dict[str, Any] = Field(default_factory=dict)
    locale: str = 'en'
    tenantId: str = Field(..., min_length=1)
    projectId: str = Field(..., min_length=1)
    sessionId: str = Field(..., min_length=1)


class CorrectionResponse(BaseModel):
    model_config = ConfigDict(extra='forbid')

    is_correction: bool
    field: str = ''
    new_value: Optional[Any] = None
    confidence: float = 0.0
    tenantId: str
    projectId: str
    sessionId: str


class SemanticMatchCandidate(BaseModel):
    model_config = ConfigDict(extra='forbid')

    id: NonEmptyString
    phrases: List[NonEmptyString]
    examples: List[NonEmptyString]
    keywords: List[NonEmptyString]


class SemanticMatchRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')

    text: NonEmptyString
    locale: NonEmptyString
    task: Literal['flow_escape']
    top_k: int = Field(..., ge=1)
    threshold: float = Field(..., ge=0.0, le=1.0)
    candidates: List[SemanticMatchCandidate] = Field(..., min_length=1)
    tenantId: NonEmptyString
    projectId: NonEmptyString
    sessionId: NonEmptyString


class SemanticMatchTopKEntry(BaseModel):
    model_config = ConfigDict(extra='forbid')

    id: NonEmptyString
    score: float = Field(..., ge=0.0, le=1.0)


class SemanticMatchSelection(SemanticMatchTopKEntry):
    matched_text: NonEmptyString


class SemanticMatchResponse(BaseModel):
    model_config = ConfigDict(extra='forbid')

    accepted: bool
    threshold: float = Field(..., ge=0.0, le=1.0)
    selected: Optional[SemanticMatchSelection]
    top_k: List[SemanticMatchTopKEntry] = Field(..., min_length=1)
    tenantId: NonEmptyString
    projectId: NonEmptyString
    sessionId: NonEmptyString


@lru_cache(maxsize=1)
def load_classifier_sidecar_contract_schema() -> Dict[str, Any]:
    contract_source = _CLASSIFIER_CONTRACT_SOURCE_PATH.read_text(encoding='utf-8')
    match = _CLASSIFIER_CONTRACT_SCHEMA_JSON_PATTERN.search(contract_source)
    if not match:
        raise RuntimeError(
            'Unable to locate CLASSIFIER_SIDECAR_CONTRACT_SCHEMA_JSON in shared-kernel.'
        )

    return json.loads(match.group('schema'))


def build_semantic_match_stub_response(
    request_model: SemanticMatchRequest,
) -> SemanticMatchResponse:
    top_k = [
        SemanticMatchTopKEntry(id=candidate.id, score=0.0)
        for candidate in request_model.candidates[: request_model.top_k]
    ]
    return SemanticMatchResponse(
        accepted=False,
        threshold=request_model.threshold,
        selected=None,
        top_k=top_k,
        tenantId=request_model.tenantId,
        projectId=request_model.projectId,
        sessionId=request_model.sessionId,
    )


# ---------------------------------------------------------------------------
# Flask app + tenancy middleware
# ---------------------------------------------------------------------------

app = Flask(__name__)


def _extract_tenancy_headers() -> Tuple[Optional[str], Optional[str], Optional[str]]:
    return (
        request.headers.get('x-abl-tenant-id'),
        request.headers.get('x-abl-project-id'),
        request.headers.get('x-abl-session-id'),
    )


def _error_response(code: str, message: str, status: int) -> Response:
    response = jsonify({'error': {'code': code, 'message': message}})
    response.status_code = status
    return response


def _log(level: int, msg: str, **fields: Any) -> None:
    tenancy = getattr(g, 'tenancy', {}) or {}
    log.log(
        level,
        msg,
        extra={
            'tenantId': tenancy.get('tenantId'),
            'projectId': tenancy.get('projectId'),
            'sessionId': tenancy.get('sessionId'),
            'path': request.path if request else None,
            **fields,
        },
    )


@app.before_request
def _validate_tenancy_for_tenanted_routes() -> Optional[Response]:
    # `/health` is intentionally exempt — operators need an unauthenticated
    # liveness probe.
    if request.path == '/health':
        return None

    tenant_id, project_id, session_id = _extract_tenancy_headers()
    if not tenant_id or not project_id or not session_id:
        g.tenancy = {}
        _record_scope_metric(
            'missing_headers',
            tenant_id=tenant_id,
            project_id=project_id,
        )
        _log(
            logging.WARNING,
            'NLU sidecar rejecting request missing tenancy headers',
            errorCode=ERR_MISSING_TENANCY,
        )
        return _error_response(
            ERR_MISSING_TENANCY,
            'Request requires x-abl-tenant-id, x-abl-project-id, and x-abl-session-id headers.',
            400,
        )

    g.tenancy = {
        'tenantId': tenant_id,
        'projectId': project_id,
        'sessionId': session_id,
    }
    return None


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.route('/health', methods=['GET'])
def health() -> Response:
    return jsonify({'status': 'ok'})


@app.route('/extract', methods=['POST'])
def extract() -> Response:
    try:
        payload = request.get_json(silent=False)
    except Exception as err:  # noqa: BLE001 - flask raises varied JSON errors
        _log(logging.WARNING, 'invalid JSON body on /extract', errorCode=ERR_INVALID_REQUEST)
        return _error_response(ERR_INVALID_REQUEST, f'Invalid JSON body: {err}', 400)

    try:
        req_model = ExtractionRequest.model_validate(payload or {})
    except ValidationError as err:
        _log(logging.WARNING, 'pydantic validation failed on /extract', errorCode=ERR_INVALID_REQUEST)
        return _error_response(ERR_INVALID_REQUEST, err.json(), 400)

    tenancy = g.tenancy
    if (
        req_model.tenantId != tenancy['tenantId']
        or req_model.projectId != tenancy['projectId']
        or req_model.sessionId != tenancy['sessionId']
    ):
        _record_scope_metric(
            'body_mismatch',
            tenant_id=tenancy['tenantId'],
            project_id=tenancy['projectId'],
        )
        _log(
            logging.WARNING,
            'tenancy header/body mismatch on /extract',
            errorCode=ERR_TENANCY_MISMATCH,
        )
        return _error_response(
            ERR_TENANCY_MISMATCH,
            'Tenancy in request body does not match x-abl-* headers.',
            400,
        )

    _record_scope_metric(
        'accepted',
        tenant_id=req_model.tenantId,
        project_id=req_model.projectId,
    )
    _log(logging.INFO, 'NLU extract request accepted', fields=len(req_model.fields))

    if not EXTRACT_BACKEND_ENABLED:
        _log(
            logging.INFO,
            'NLU /extract backend not configured, returning 501',
            errorCode=ERR_NOT_IMPLEMENTED,
        )
        return _error_response(
            ERR_NOT_IMPLEMENTED,
            'NLU /extract backend (Kore.ai + spaCy) is not configured on this deployment. '
            'Set NLU_SIDECAR_EXTRACT_BACKEND_ENABLED and wire a model provider to enable.',
            501,
        )

    # TODO: Wire Kore.ai ML models + spaCy NER here. Until the backend is
    # implemented, the 501 branch above short-circuits this path.
    entities: Dict[str, Any] = {}
    confidence: Dict[str, float] = {}

    return jsonify(
        ExtractionResponse(
            entities=entities,
            confidence=confidence,
            tenantId=req_model.tenantId,
            projectId=req_model.projectId,
            sessionId=req_model.sessionId,
        ).model_dump()
    )


@app.route('/detect-correction', methods=['POST'])
def detect_correction() -> Response:
    try:
        payload = request.get_json(silent=False)
    except Exception as err:  # noqa: BLE001
        _log(
            logging.WARNING,
            'invalid JSON body on /detect-correction',
            errorCode=ERR_INVALID_REQUEST,
        )
        return _error_response(ERR_INVALID_REQUEST, f'Invalid JSON body: {err}', 400)

    try:
        req_model = CorrectionRequest.model_validate(payload or {})
    except ValidationError as err:
        _log(
            logging.WARNING,
            'pydantic validation failed on /detect-correction',
            errorCode=ERR_INVALID_REQUEST,
        )
        return _error_response(ERR_INVALID_REQUEST, err.json(), 400)

    tenancy = g.tenancy
    if (
        req_model.tenantId != tenancy['tenantId']
        or req_model.projectId != tenancy['projectId']
        or req_model.sessionId != tenancy['sessionId']
    ):
        _record_scope_metric(
            'body_mismatch',
            tenant_id=tenancy['tenantId'],
            project_id=tenancy['projectId'],
        )
        _log(
            logging.WARNING,
            'tenancy header/body mismatch on /detect-correction',
            errorCode=ERR_TENANCY_MISMATCH,
        )
        return _error_response(
            ERR_TENANCY_MISMATCH,
            'Tenancy in request body does not match x-abl-* headers.',
            400,
        )

    _record_scope_metric(
        'accepted',
        tenant_id=req_model.tenantId,
        project_id=req_model.projectId,
    )
    _log(logging.INFO, 'NLU detect-correction request accepted')

    if not CORRECTION_BACKEND_ENABLED:
        _log(
            logging.INFO,
            'NLU /detect-correction backend not configured, returning 501',
            errorCode=ERR_NOT_IMPLEMENTED,
        )
        return _error_response(
            ERR_NOT_IMPLEMENTED,
            'NLU /detect-correction backend is not configured on this deployment. '
            'Set NLU_SIDECAR_CORRECTION_BACKEND_ENABLED and wire a model provider to enable.',
            501,
        )

    # TODO: Wire Kore.ai correction model here.
    return jsonify(
        CorrectionResponse(
            is_correction=False,
            field='',
            new_value=None,
            confidence=0.0,
            tenantId=req_model.tenantId,
            projectId=req_model.projectId,
            sessionId=req_model.sessionId,
        ).model_dump()
    )


@app.route('/semantic-match', methods=['POST'])
def semantic_match() -> Response:
    try:
        payload = request.get_json(silent=False)
    except Exception as err:  # noqa: BLE001
        _log(
            logging.WARNING,
            'invalid JSON body on /semantic-match',
            errorCode=ERR_INVALID_REQUEST,
        )
        return _error_response(ERR_INVALID_REQUEST, f'Invalid JSON body: {err}', 400)

    try:
        req_model = SemanticMatchRequest.model_validate(payload or {})
    except ValidationError as err:
        _log(
            logging.WARNING,
            'pydantic validation failed on /semantic-match',
            errorCode=ERR_INVALID_REQUEST,
        )
        return _error_response(ERR_INVALID_REQUEST, err.json(), 400)

    tenancy = g.tenancy
    if (
        req_model.tenantId != tenancy['tenantId']
        or req_model.projectId != tenancy['projectId']
        or req_model.sessionId != tenancy['sessionId']
    ):
        _record_scope_metric(
            'body_mismatch',
            tenant_id=tenancy['tenantId'],
            project_id=tenancy['projectId'],
        )
        _log(
            logging.WARNING,
            'tenancy header/body mismatch on /semantic-match',
            errorCode=ERR_TENANCY_MISMATCH,
        )
        return _error_response(
            ERR_TENANCY_MISMATCH,
            'Tenancy in request body does not match x-abl-* headers.',
            400,
        )

    _record_scope_metric(
        'accepted',
        tenant_id=req_model.tenantId,
        project_id=req_model.projectId,
    )
    _log(
        logging.INFO,
        'NLU semantic-match request accepted',
        candidateCount=len(req_model.candidates),
    )

    if not SEMANTIC_MATCH_BACKEND_ENABLED:
        _log(
            logging.INFO,
            'NLU /semantic-match backend not configured, returning 501',
            errorCode=ERR_NOT_IMPLEMENTED,
        )
        return _error_response(
            ERR_NOT_IMPLEMENTED,
            'NLU /semantic-match backend is not configured on this deployment. '
            'Set NLU_SIDECAR_SEMANTIC_MATCH_BACKEND_ENABLED and wire a semantic matcher to enable.',
            501,
        )

    return jsonify(build_semantic_match_stub_response(req_model).model_dump())


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8090)
