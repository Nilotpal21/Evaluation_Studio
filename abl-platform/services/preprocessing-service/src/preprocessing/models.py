"""
Data models for preprocessing service
"""

from typing import List, Dict, Optional, Any
from pydantic import BaseModel, Field, ConfigDict


class PreprocessingConfig(BaseModel):
    """Configuration for preprocessing pipeline"""
    model_config = ConfigDict(populate_by_name=True)

    enable_spell_correction: bool = Field(default=True, alias='enableSpellCorrection')
    enable_synonym_expansion: bool = Field(default=True, alias='enableSynonymExpansion')
    enable_entity_extraction: bool = Field(default=True, alias='enableEntityExtraction')
    max_synonyms: int = Field(default=3, alias='maxSynonyms')


class SpellCorrection(BaseModel):
    """Spell correction result"""
    original: str
    corrected: str
    confidence: float
    source: str  # 'tenant_dict', 'spellchecker', 'none'


class SynonymExpansion(BaseModel):
    """Synonym expansion result"""
    term: str
    synonyms: List[str]
    source: str  # 'tenant_dict', 'abbreviation', 'wordnet', 'none'


class Entity(BaseModel):
    """Extracted entity"""
    text: str
    type: str  # 'date', 'number', 'email', 'url', 'phone', 'currency', 'custom'
    value: Any
    start: int
    end: int


class PreprocessingResult(BaseModel):
    """Complete preprocessing result"""
    model_config = ConfigDict(populate_by_name=True)

    processed_query: str = Field(alias='processedQuery')
    language: str
    confidence: float
    stages: Dict[str, List[Any]] = {
        'spellCorrection': [],
        'synonymExpansion': [],
        'entities': []
    }
    metadata: Dict[str, Any] = {
        'originalQuery': '',
        'processingTimeMs': 0.0,
        'stagesExecuted': []
    }


class TenantDictionary(BaseModel):
    """Tenant-specific dictionary"""
    tenant_id: str
    corrections: Dict[str, str] = {}
    synonyms: Dict[str, List[str]] = {}
    abbreviations: Dict[str, str] = {}
    entity_patterns: List[Dict[str, str]] = []
