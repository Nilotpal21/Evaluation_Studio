/**
 * SearchAI API Client for E2E Tests
 *
 * Provides authenticated HTTP requests to SearchAI, Runtime, and Studio APIs.
 * Zero assumptions — all responses are typed and verified.
 */

import type { APIRequestContext } from '@playwright/test';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  userId: string;
  tenantId: string;
}

export interface KnowledgeBase {
  _id: string;
  name: string;
  description?: string;
  projectId: string;
  tenantId: string;
  searchIndexId: string;
  status: 'active' | 'inactive' | 'error';
  createdAt: string;
  updatedAt: string;
}

export interface SearchIndex {
  _id: string;
  slug: string;
  name: string;
  projectId: string;
  tenantId: string;
  embeddingModel: string;
  embeddingDimensions: number;
  vectorStore: {
    provider: string;
    config: Record<string, unknown>;
  };
  status: 'active' | 'inactive';
  sourceCount: number;
}

export interface SearchDocument {
  _id: string;
  indexId: string;
  sourceId: string;
  tenantId: string;
  contentHash: string;
  status:
    | 'pending'
    | 'extracting'
    | 'extracted'
    | 'enriching'
    | 'enriched'
    | 'embedding'
    | 'indexed'
    | 'error';
  contentSizeBytes: number;
  fileName?: string;
  fileType?: string;
  extractedText?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface SearchChunk {
  _id: string;
  indexId: string;
  documentId: string;
  tenantId: string;
  content: string;
  tokenCount: number;
  chunkIndex: number;
  embedding?: number[];
  status: 'pending' | 'ready' | 'error';
  metadata?: Record<string, unknown>;
}

export interface UploadResponse {
  success: boolean;
  document?: SearchDocument;
  jobId?: string;
  error?: {
    code: string;
    message: string;
  };
}

/**
 * SearchAI API Client
 */
export class SearchAIApiClient {
  constructor(
    private request: APIRequestContext,
    private baseUrl: string,
    private tokens?: AuthTokens,
    private runtimeUrl?: string,
  ) {}

  /**
   * Authenticate via Studio dev-login
   */
  static async authenticate(
    request: APIRequestContext,
    studioUrl: string,
    email = 'test@example.com',
    name = 'E2E Test User',
  ): Promise<AuthTokens> {
    const response = await request.post(`${studioUrl}/api/auth/dev-login`, {
      data: { email, name },
    });

    if (!response.ok()) {
      throw new Error(`Auth failed: ${response.status()} ${await response.text()}`);
    }

    const body = await response.json();
    return {
      accessToken: body.accessToken,
      refreshToken: body.refreshToken,
      userId: body.userId || 'test-user-001',
      tenantId: body.tenantId || 'tenant-dev-001',
    };
  }

  /**
   * Create authenticated headers
   */
  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.tokens?.accessToken) {
      headers['Authorization'] = `Bearer ${this.tokens.accessToken}`;
    }
    return headers;
  }

  /**
   * Create a knowledge base
   */
  async createKnowledgeBase(
    projectId: string,
    name: string,
    description?: string,
  ): Promise<{ knowledgeBase: KnowledgeBase }> {
    const response = await this.request.post(`${this.baseUrl}/api/knowledge-bases`, {
      headers: this.getHeaders(),
      data: {
        projectId,
        name,
        description: description || `E2E test KB - ${Date.now()}`,
      },
    });

    if (!response.ok()) {
      const text = await response.text();
      throw new Error(`Create KB failed: ${response.status()} ${text}`);
    }

    return response.json();
  }

  /**
   * Get knowledge base by ID
   */
  async getKnowledgeBase(kbId: string): Promise<{ knowledgeBase: KnowledgeBase }> {
    const response = await this.request.get(`${this.baseUrl}/api/knowledge-bases/${kbId}`, {
      headers: this.getHeaders(),
    });

    if (!response.ok()) {
      throw new Error(`Get KB failed: ${response.status()}`);
    }

    return response.json();
  }

  /**
   * Create a manual source for file uploads
   */
  async createManualSource(indexId: string, name: string = 'Manual Upload'): Promise<string> {
    const response = await this.request.post(`${this.baseUrl}/api/indexes/${indexId}/sources`, {
      headers: this.getHeaders(),
      data: {
        name,
        sourceType: 'manual',
        sourceConfig: {},
      },
    });

    if (!response.ok()) {
      throw new Error(`Create source failed: ${response.status()}`);
    }

    const body = await response.json();
    return body.source._id;
  }

  /**
   * Upload a file to a knowledge base (creates source if needed)
   */
  async uploadFile(
    indexId: string,
    filePath: string,
    fileName: string,
    fileType: string,
    sourceId?: string,
  ): Promise<UploadResponse> {
    const fs = await import('fs/promises');
    const fileContent = await fs.readFile(filePath);

    // Create a manual source if not provided
    const uploadSourceId = sourceId || (await this.createManualSource(indexId));

    const response = await this.request.post(
      `${this.baseUrl}/api/indexes/${indexId}/sources/${uploadSourceId}/documents`,
      {
        headers: {
          Authorization: `Bearer ${this.tokens?.accessToken}`,
        },
        multipart: {
          file: {
            name: fileName,
            mimeType: fileType,
            buffer: fileContent,
          },
        },
      },
    );

    if (!response.ok()) {
      const text = await response.text();
      throw new Error(`Upload failed: ${response.status()} ${text}`);
    }

    const body = await response.json();
    // The API returns the document directly, not wrapped
    // Response format: { id, originalReference, contentType, contentSizeBytes, status, metadata, createdAt }
    return {
      success: true,
      document: {
        _id: body.id,
        fileName: body.originalReference,
        fileType: body.contentType,
        fileSize: body.contentSizeBytes,
        status: body.status,
        metadata: body.metadata,
        createdAt: body.createdAt,
      } as any,
      jobId: undefined, // Not returned by API
    };
  }

  /**
   * List documents for an index
   */
  async listDocuments(
    indexId: string,
    filters?: { status?: string; page?: number; limit?: number },
  ): Promise<{ documents: SearchDocument[]; total: number }> {
    const params = new URLSearchParams();
    if (filters?.status) params.append('status', filters.status);
    if (filters?.page !== undefined) params.append('page', filters.page.toString());
    if (filters?.limit !== undefined) params.append('limit', filters.limit.toString());

    const url = `${this.baseUrl}/api/indexes/${indexId}/documents?${params.toString()}`;
    const response = await this.request.get(url, {
      headers: this.getHeaders(),
    });

    if (!response.ok()) {
      throw new Error(`List documents failed: ${response.status()}`);
    }

    return response.json();
  }

  /**
   * Get document by ID
   */
  async getDocument(indexId: string, documentId: string): Promise<{ document: SearchDocument }> {
    const response = await this.request.get(
      `${this.baseUrl}/api/indexes/${indexId}/documents/${documentId}`,
      {
        headers: this.getHeaders(),
      },
    );

    if (!response.ok()) {
      throw new Error(`Get document failed: ${response.status()}`);
    }

    return response.json();
  }

  /**
   * List chunks for a document
   */
  async listChunks(
    indexId: string,
    documentId: string,
  ): Promise<{
    chunks: SearchChunk[];
    pagination: { total: number; limit: number; offset: number; hasMore: boolean };
  }> {
    const response = await this.request.get(
      `${this.baseUrl}/api/indexes/${indexId}/documents/${documentId}/chunks`,
      {
        headers: this.getHeaders(),
      },
    );

    if (!response.ok()) {
      throw new Error(`List chunks failed: ${response.status()}`);
    }

    return response.json();
  }

  /**
   * Search documents
   */
  async search(
    indexId: string,
    query: string,
    options?: { topK?: number; filters?: Record<string, unknown> },
  ): Promise<{
    results: Array<{
      documentId: string;
      chunkId: string;
      score: number;
      content?: string;
      metadata?: Record<string, unknown>;
    }>;
    totalCount: number;
  }> {
    // Search queries go to SearchAI Runtime, not SearchAI ingestion service
    const searchUrl = this.runtimeUrl || this.baseUrl.replace(':3113', ':3114');
    const requestData: Record<string, unknown> = {
      query,
      topK: options?.topK || 10,
    };
    if (options?.filters) {
      requestData.filters = options.filters;
    }
    const response = await this.request.post(`${searchUrl}/api/search/${indexId}/query`, {
      headers: this.getHeaders(),
      data: requestData,
    });

    if (!response.ok()) {
      throw new Error(`Search failed: ${response.status()}`);
    }

    return response.json();
  }

  /**
   * Wait for document to reach a specific status
   */
  async waitForDocumentStatus(
    indexId: string,
    documentId: string,
    targetStatus: SearchDocument['status'],
    timeoutMs = 30000,
    pollIntervalMs = 1000,
  ): Promise<SearchDocument> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const { document } = await this.getDocument(indexId, documentId);

      if (document.status === targetStatus) {
        return document;
      }

      if (document.status === 'error') {
        throw new Error(`Document processing failed: ${document._id}`);
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error(`Timeout waiting for document ${documentId} to reach status ${targetStatus}`);
  }

  /**
   * Delete a document
   */
  async deleteDocument(indexId: string, documentId: string): Promise<{ deleted: boolean }> {
    const response = await this.request.delete(
      `${this.baseUrl}/api/indexes/${indexId}/documents/${documentId}`,
      {
        headers: this.getHeaders(),
      },
    );

    if (!response.ok()) {
      throw new Error(`Delete document failed: ${response.status()}`);
    }

    // Delete endpoint returns 204 No Content with empty body
    return { deleted: response.status() === 204 };
  }

  /**
   * Delete a knowledge base (cascade deletes index, documents, chunks)
   */
  async deleteKnowledgeBase(kbId: string): Promise<{ deleted: boolean }> {
    const response = await this.request.delete(`${this.baseUrl}/api/knowledge-bases/${kbId}`, {
      headers: this.getHeaders(),
    });

    if (!response.ok()) {
      throw new Error(`Delete KB failed: ${response.status()}`);
    }

    return response.json();
  }
}
