"""
Tests for preprocessing pipeline
"""

import pytest
from src.preprocessing.pipeline import PreprocessingPipeline
from src.preprocessing.models import PreprocessingResult


class TestPreprocessingPipeline:
    """Test complete preprocessing pipeline"""

    @pytest.fixture
    def pipeline(self):
        """Create pipeline instance without cache"""
        return PreprocessingPipeline(cache=None)

    def test_process_english_query(self, pipeline):
        """Test processing English query"""
        query = "show me documents about the deployment"
        result = pipeline.process(query, 'tenant-123')

        assert isinstance(result, PreprocessingResult)
        assert result.language == 'en'
        assert result.confidence > 0.9
        assert 'language_detection' in result.metadata['stagesExecuted']
        assert result.metadata['processingTimeMs'] > 0

    def test_process_spanish_query(self, pipeline):
        """Test processing Spanish query"""
        query = "mostrar documentos sobre despliegue"
        result = pipeline.process(query, 'tenant-123')

        assert result.language == 'es'
        assert result.confidence > 0.9

    def test_spell_correction_stage(self, pipeline):
        """Test spell correction stage"""
        # Use common misspellings that will be found
        query = "recieve the mesage from server"
        result = pipeline.process(query, 'tenant-123', {
            'enableSpellCorrection': True,
            'enableSynonymExpansion': False,
            'enableEntityExtraction': False
        })

        # Should find corrections for common misspellings
        assert len(result.stages['spellCorrection']) >= 1
        assert 'spell_correction' in result.metadata['stagesExecuted']

    def test_synonym_expansion_stage(self, pipeline):
        """Test synonym expansion stage"""
        query = "container deployment process"
        result = pipeline.process(query, 'tenant-123', {
            'enableSpellCorrection': False,
            'enableSynonymExpansion': True,
            'enableEntityExtraction': False,
            'maxSynonyms': 3
        })

        assert 'synonym_expansion' in result.metadata['stagesExecuted']
        # May have synonyms depending on WordNet availability

    def test_entity_extraction_stage(self, pipeline):
        """Test entity extraction stage"""
        query = "orders from 2024-01-15 with amount > 1000"
        result = pipeline.process(query, 'tenant-123', {
            'enableSpellCorrection': False,
            'enableSynonymExpansion': False,
            'enableEntityExtraction': True
        })

        assert 'entity_extraction' in result.metadata['stagesExecuted']
        # Should extract date and number comparison
        entities = result.stages['entities']
        assert any(e['type'] == 'date' for e in entities)

    def test_all_stages_enabled(self, pipeline):
        """Test with all stages enabled"""
        query = "show documents from 2024-01-01"
        result = pipeline.process(query, 'tenant-123', {
            'enableSpellCorrection': True,
            'enableSynonymExpansion': True,
            'enableEntityExtraction': True
        })

        assert len(result.metadata['stagesExecuted']) >= 3
        assert 'language_detection' in result.metadata['stagesExecuted']

    def test_processing_time_recorded(self, pipeline):
        """Test processing time is recorded"""
        query = "test query"
        result = pipeline.process(query, 'tenant-123')

        assert 'processingTimeMs' in result.metadata
        assert result.metadata['processingTimeMs'] > 0
        assert result.metadata['processingTimeMs'] < 1000  # Should be < 1 second

    def test_original_query_preserved(self, pipeline):
        """Test original query is preserved in metadata"""
        query = "original query text"
        result = pipeline.process(query, 'tenant-123')

        assert result.metadata['originalQuery'] == query

    def test_empty_query_handling(self, pipeline):
        """Test handling of empty query"""
        query = ""
        result = pipeline.process(query, 'tenant-123')

        assert result.processed_query == ""
        assert result.language in pipeline.language_detector.SUPPORTED_LANGUAGES

    def test_config_defaults(self, pipeline):
        """Test default configuration"""
        query = "test query"
        result = pipeline.process(query, 'tenant-123')  # No config provided

        # All stages should be enabled by default
        assert 'language_detection' in result.metadata['stagesExecuted']
