# ATLAS-KG v2 Test Document

## Introduction

This is a test document for the ATLAS-KG v2 indexing pipeline. It demonstrates the complete flow from document upload through embedding to vector search.

## Vector Search

ATLAS-KG v2 uses BGE-M3 embeddings with 1024 dimensions for semantic search. The system stores vectors in OpenSearch with strict field mappings to prevent schema bloat.

### Key Features

- **Shared Index Strategy**: Multiple apps can share a single OpenSearch index
- **Auto-Rotation**: Indices automatically rotate at 60% capacity
- **Hybrid Strategy**: Mix shared and dedicated indices per app

## Metadata Filtering

The system supports structured metadata filtering with three tiers:

- **System Metadata (sys)**: tenantId, appId, connectorId
- **Document Metadata (doc)**: name, contentType, language
- **Canonical Metadata (canonical)**: author, category, tags

## Hybrid Search

Combine vector similarity with metadata filters for precise retrieval. The system enables filtering by tenant, category, tags, and other structured fields while performing k-NN vector search.

## Conclusion

ATLAS-KG v2 provides a robust, scalable indexing pipeline with strict schemas and flexible search capabilities.
