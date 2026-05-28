"""
Entity Extraction

Uses regex patterns and dateutil for extracting structured entities from queries.
Language-agnostic patterns for dates, numbers, emails, URLs, etc.
"""

import logging
import re
from typing import List, Dict, Optional, Any
from dateutil import parser as date_parser

from .models import Entity

logger = logging.getLogger(__name__)


class EntityExtractor:
    """
    Extract structured entities from queries using regex patterns

    Supported entity types:
    - Dates (ISO format, relative dates)
    - Numbers (with comparison operators)
    - Emails
    - URLs
    - Phone numbers
    - Currency amounts
    - Custom patterns (tenant-defined)

    Language-agnostic patterns work globally.
    Latency: 0.5-1ms per query
    """

    # Built-in entity patterns
    PATTERNS = {
        'date_iso': {
            'pattern': r'\b\d{4}-\d{2}-\d{2}\b',
            'type': 'date',
            'parser': 'date'
        },
        'date_slash': {
            'pattern': r'\b\d{1,2}/\d{1,2}/\d{2,4}\b',
            'type': 'date',
            'parser': 'date'
        },
        'date_quarter': {
            'pattern': r'\bQ[1-4]\s+\d{4}\b',
            'type': 'date',
            'parser': 'quarter'
        },
        'number_comparison': {
            'pattern': r'[><]=?\s*\d+(?:\.\d+)?',
            'type': 'number',
            'parser': 'comparison'
        },
        'number_range': {
            'pattern': r'\b\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?\b',
            'type': 'number',
            'parser': 'range'
        },
        'email': {
            'pattern': r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b',
            'type': 'email',
            'parser': 'text'
        },
        'url': {
            'pattern': r'\bhttps?://[^\s]+',
            'type': 'url',
            'parser': 'text'
        },
        'phone': {
            'pattern': r'\b\+?[\d\s()-]{10,}\b',
            'type': 'phone',
            'parser': 'text'
        },
        'currency_usd': {
            'pattern': r'\$\s*\d+(?:,\d{3})*(?:\.\d{2})?',
            'type': 'currency',
            'parser': 'currency'
        },
        'currency_eur': {
            'pattern': r'€\s*\d+(?:,\d{3})*(?:\.\d{2})?',
            'type': 'currency',
            'parser': 'currency'
        },
        'percentage': {
            'pattern': r'\b\d+(?:\.\d+)?%',
            'type': 'percentage',
            'parser': 'percentage'
        }
    }

    def __init__(self):
        """Initialize entity extractor"""
        logger.info("Entity extractor initialized")

    def extract(
        self,
        text: str,
        language: str,
        custom_patterns: Optional[List[Dict[str, str]]] = None
    ) -> List[Entity]:
        """
        Extract entities from text

        Args:
            text: Input text
            language: Language code (for date parsing)
            custom_patterns: Optional tenant-defined patterns

        Returns:
            List of Entity objects
        """
        entities = []

        # Apply built-in patterns
        for pattern_name, pattern_def in self.PATTERNS.items():
            matches = re.finditer(pattern_def['pattern'], text, re.IGNORECASE)

            for match in matches:
                entity = self._create_entity(
                    text=match.group(),
                    entity_type=pattern_def['type'],
                    parser=pattern_def['parser'],
                    start=match.start(),
                    end=match.end()
                )

                if entity:
                    entities.append(entity)
                    logger.debug(f"Extracted {entity.type}: {entity.text}")

        # Apply custom patterns (if provided)
        if custom_patterns:
            for custom_pattern in custom_patterns:
                try:
                    pattern = custom_pattern.get('pattern')
                    entity_type = custom_pattern.get('type', 'custom')

                    matches = re.finditer(pattern, text, re.IGNORECASE)

                    for match in matches:
                        entity = Entity(
                            text=match.group(),
                            type=entity_type,
                            value=match.group(),
                            start=match.start(),
                            end=match.end()
                        )
                        entities.append(entity)
                        logger.debug(f"Extracted custom entity: {entity.text}")

                except Exception as e:
                    logger.warning(f"Failed to apply custom pattern: {e}")

        # Sort entities by position
        entities.sort(key=lambda e: e.start)

        return entities

    def _create_entity(
        self,
        text: str,
        entity_type: str,
        parser: str,
        start: int,
        end: int
    ) -> Optional[Entity]:
        """
        Create an Entity object with parsed value

        Args:
            text: Matched text
            entity_type: Entity type
            parser: Parser type to use
            start: Start position in text
            end: End position in text

        Returns:
            Entity object or None if parsing fails
        """
        try:
            value = self._parse_value(text, parser)

            return Entity(
                text=text,
                type=entity_type,
                value=value,
                start=start,
                end=end
            )

        except Exception as e:
            logger.debug(f"Failed to parse entity '{text}': {e}")
            return None

    def _parse_value(self, text: str, parser: str) -> Any:
        """
        Parse entity value based on parser type

        Args:
            text: Entity text
            parser: Parser type

        Returns:
            Parsed value
        """
        if parser == 'date':
            # Parse date using dateutil
            dt = date_parser.parse(text, fuzzy=False)
            return dt.isoformat()

        elif parser == 'quarter':
            # Parse quarter (e.g., Q1 2024)
            match = re.match(r'Q([1-4])\s+(\d{4})', text)
            if match:
                quarter = int(match.group(1))
                year = int(match.group(2))
                # Convert to start month of quarter
                month = (quarter - 1) * 3 + 1
                return f"{year}-{month:02d}-01"

        elif parser == 'comparison':
            # Parse comparison operator and number (e.g., ">= 100")
            match = re.match(r'([><]=?)\s*(\d+(?:\.\d+)?)', text)
            if match:
                return {
                    'operator': match.group(1),
                    'value': float(match.group(2))
                }

        elif parser == 'range':
            # Parse number range (e.g., "10-20")
            match = re.match(r'(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)', text)
            if match:
                return {
                    'min': float(match.group(1)),
                    'max': float(match.group(2))
                }

        elif parser == 'currency':
            # Extract numeric value from currency
            numeric = re.sub(r'[^\d.]', '', text)
            return float(numeric) if numeric else 0.0

        elif parser == 'percentage':
            # Extract numeric value from percentage
            numeric = re.sub(r'[^\d.]', '', text)
            return float(numeric) if numeric else 0.0

        elif parser == 'text':
            # Return text as-is
            return text

        # Default: return text
        return text
