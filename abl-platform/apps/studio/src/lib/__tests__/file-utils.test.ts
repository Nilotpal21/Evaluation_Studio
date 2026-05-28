import { describe, test, expect, beforeAll } from 'vitest';
import { extractFileContent, extractMultipleFiles } from '../file-utils';

// Mock FileReader
class MockFileReader {
  result: string | ArrayBuffer | null = null;
  onload: ((event: ProgressEvent<FileReader>) => void) | null = null;
  onerror: ((event: ProgressEvent<FileReader>) => void) | null = null;

  readAsText(file: Blob) {
    setTimeout(() => {
      if (file.size > 10 * 1024 * 1024) {
        this.onerror?.(new ProgressEvent('error') as any);
      } else {
        // @ts-expect-error - accessing _mockContent
        this.result = (file as any)._mockContent || 'mock content';
        this.onload?.(new ProgressEvent('load') as any);
      }
    }, 0);
  }
}

// @ts-expect-error - replacing global FileReader
global.FileReader = MockFileReader;

// Helper to create a mock File with content
function createMockFile(name: string, content: string, type: string): File {
  const blob = new Blob([content], { type });
  const file = new File([blob], name, { type });
  // @ts-expect-error - adding _mockContent for testing
  file._mockContent = content;
  return file;
}

async function expectRejectedMessage(promise: Promise<unknown>, message: string) {
  await expect(promise).rejects.toMatchObject({
    message: expect.stringContaining(message),
  });
}

describe('file-utils', () => {
  describe('extractFileContent', () => {
    test('should extract content from a text file', async () => {
      const file = createMockFile('test.txt', 'Hello, World!', 'text/plain');
      const result = await extractFileContent(file);

      expect(result.name).toBe('test.txt');
      expect(result.contentType).toBe('text/plain');
      expect(result.url).toContain('data:text/plain;base64,');
    });

    test('should extract content from a markdown file', async () => {
      const file = createMockFile('README.md', '# Title\n\nContent', 'text/markdown');
      const result = await extractFileContent(file);

      expect(result.name).toBe('README.md');
      expect(result.contentType).toBe('text/markdown');
      expect(result.url).toContain('data:text/markdown;base64,');
    });

    test('should extract and validate JSON files', async () => {
      const jsonContent = JSON.stringify({ key: 'value', nested: { data: [1, 2, 3] } });
      const file = createMockFile('config.json', jsonContent, 'application/json');
      const result = await extractFileContent(file);

      expect(result.name).toBe('config.json');
      expect(result.contentType).toBe('application/json');
      expect(result.url).toContain('data:application/json;base64,');
    });

    test('should reject invalid JSON files', async () => {
      const file = createMockFile('invalid.json', '{ invalid json }', 'application/json');
      await expectRejectedMessage(extractFileContent(file), 'Invalid JSON');
    });

    test('should extract and validate YAML files', async () => {
      const yamlContent = 'key: value\nnested:\n  data:\n    - 1\n    - 2\n    - 3';
      const file = createMockFile('config.yaml', yamlContent, 'application/x-yaml');
      const result = await extractFileContent(file);

      expect(result.name).toBe('config.yaml');
      expect(result.contentType).toBe('application/x-yaml');
      expect(result.url).toContain('data:application/x-yaml;base64,');
    });

    test('should reject files larger than 10MB', async () => {
      const largeContent = 'x'.repeat(11 * 1024 * 1024);
      const file = createMockFile('large.txt', largeContent, 'text/plain');
      Object.defineProperty(file, 'size', { value: 11 * 1024 * 1024 });

      await expectRejectedMessage(extractFileContent(file), 'File too large');
    });

    test('should reject unsupported file types', async () => {
      const file = createMockFile('image.png', 'binary data', 'image/png');
      await expectRejectedMessage(extractFileContent(file), 'Unsupported file type');
    });

    test('should detect content type from file extension when MIME type is missing', async () => {
      const file = createMockFile('config.json', '{"test": true}', '');
      const result = await extractFileContent(file);

      expect(result.contentType).toBe('application/json');
    });
  });

  describe('extractMultipleFiles', () => {
    test('should process multiple valid files', async () => {
      const files = [
        createMockFile('file1.txt', 'Content 1', 'text/plain'),
        createMockFile('file2.md', '# Markdown', 'text/markdown'),
        createMockFile('file3.json', '{"data": true}', 'application/json'),
      ];

      const results = await extractMultipleFiles(files);

      expect(results).toHaveLength(3);
      expect(results[0].name).toBe('file1.txt');
      expect(results[1].name).toBe('file2.md');
      expect(results[2].name).toBe('file3.json');
    });

    test('should reject more than 5 files', async () => {
      const files = Array.from({ length: 6 }, (_, i) =>
        createMockFile(`file${i}.txt`, `Content ${i}`, 'text/plain'),
      );

      await expectRejectedMessage(extractMultipleFiles(files), 'Too many files');
    });

    test('should accumulate errors from failed files', async () => {
      const files = [
        createMockFile('valid.txt', 'Valid content', 'text/plain'),
        createMockFile('invalid.json', '{ bad json }', 'application/json'),
        createMockFile('unsupported.exe', 'binary', 'application/x-executable'),
      ];

      await expectRejectedMessage(extractMultipleFiles(files), 'File processing errors');
    });

    test('should handle empty file array', async () => {
      const results = await extractMultipleFiles([]);
      expect(results).toHaveLength(0);
    });
  });

  describe('Phase 2: Structured Parsing', () => {
    test('should detect OpenAPI 3.0 specification and add metadata', async () => {
      const openapiSpec = JSON.stringify({
        openapi: '3.0.0',
        info: {
          title: 'Pet Store API',
          version: '1.0.0',
        },
        paths: {
          '/pets': {
            get: { summary: 'List pets' },
            post: { summary: 'Create pet' },
          },
          '/pets/{id}': {
            get: { summary: 'Get pet' },
            delete: { summary: 'Delete pet' },
          },
        },
        components: {
          schemas: {
            Pet: { type: 'object' },
            Error: { type: 'object' },
          },
        },
      });

      const file = createMockFile('openapi.json', openapiSpec, 'application/json');
      const result = await extractFileContent(file);

      // Decode base64 to verify structured context
      const decodedUrl = result.url.split(',')[1];
      const decoded = decodeURIComponent(escape(atob(decodedUrl)));

      expect(decoded).toContain('[File: openapi.json]');
      expect(decoded).toContain('Type: OpenAPI Specification');
      expect(decoded).toContain('Summary:');
      expect(decoded).toContain('2 endpoints');
      expect(decoded).toContain('4 operations');
      expect(decoded).toContain('2 schemas');
      expect(decoded).toContain('[End File]');
    });

    test('should detect Swagger 2.0 specification', async () => {
      const swaggerSpec = JSON.stringify({
        swagger: '2.0',
        info: { title: 'API', version: '1.0' },
        paths: {
          '/users': {
            get: {},
          },
        },
      });

      const file = createMockFile('swagger.yaml', swaggerSpec, 'application/x-yaml');
      const result = await extractFileContent(file);

      const decodedUrl = result.url.split(',')[1];
      const decoded = decodeURIComponent(escape(atob(decodedUrl)));

      expect(decoded).toContain('Type: OpenAPI Specification');
      expect(decoded).toContain('1 endpoints');
      expect(decoded).toContain('1 operations');
    });

    test('should detect JSON Schema', async () => {
      const jsonSchema = JSON.stringify({
        $schema: 'http://json-schema.org/draft-07/schema#',
        title: 'User',
        type: 'object',
        properties: {
          name: { type: 'string' },
          email: { type: 'string' },
        },
        required: ['name', 'email'],
      });

      const file = createMockFile('user-schema.json', jsonSchema, 'application/json');
      const result = await extractFileContent(file);

      const decodedUrl = result.url.split(',')[1];
      const decoded = decodeURIComponent(escape(atob(decodedUrl)));

      expect(decoded).toContain('[File: user-schema.json]');
      expect(decoded).toContain('Type: JSON Schema');
      expect(decoded).toContain('Title: User');
      expect(decoded).toContain('type: object');
    });

    test('should handle JSON Schema without $schema field', async () => {
      const jsonSchema = JSON.stringify({
        title: 'Config',
        type: 'object',
        properties: {
          debug: { type: 'boolean' },
        },
      });

      const file = createMockFile('config-schema.json', jsonSchema, 'application/json');
      const result = await extractFileContent(file);

      const decodedUrl = result.url.split(',')[1];
      const decoded = decodeURIComponent(escape(atob(decodedUrl)));

      expect(decoded).toContain('Type: JSON Schema');
      expect(decoded).toContain('Title: Config');
    });

    test('should handle plain JSON without special format', async () => {
      const plainJson = JSON.stringify({
        users: [
          { name: 'Alice', age: 30 },
          { name: 'Bob', age: 25 },
        ],
      });

      const file = createMockFile('data.json', plainJson, 'application/json');
      const result = await extractFileContent(file);

      const decodedUrl = result.url.split(',')[1];
      const decoded = decodeURIComponent(escape(atob(decodedUrl)));

      // Should still have file markers but no special metadata
      expect(decoded).toContain('[File: data.json]');
      expect(decoded).toContain('[End File]');
      expect(decoded).toContain('users');
    });

    test('should parse YAML OpenAPI spec correctly', async () => {
      const yamlOpenApi = `openapi: 3.0.0
info:
  title: My API
  version: 1.0.0
paths:
  /health:
    get:
      summary: Health check
  /users:
    get:
      summary: List users
    post:
      summary: Create user
components:
  schemas:
    User:
      type: object
    Error:
      type: object`;

      const file = createMockFile('openapi.yaml', yamlOpenApi, 'application/x-yaml');
      const result = await extractFileContent(file);

      const decodedUrl = result.url.split(',')[1];
      const decoded = decodeURIComponent(escape(atob(decodedUrl)));

      expect(decoded).toContain('Type: OpenAPI Specification');
      expect(decoded).toContain('2 endpoints');
      expect(decoded).toContain('3 operations');
      expect(decoded).toContain('2 schemas');
    });

    test('should count operations correctly for all HTTP methods', async () => {
      const spec = JSON.stringify({
        openapi: '3.1.0',
        info: { title: 'Full API', version: '1.0' },
        paths: {
          '/resource': {
            get: {},
            post: {},
            put: {},
            patch: {},
            delete: {},
            options: {},
            head: {},
          },
        },
      });

      const file = createMockFile('full-api.json', spec, 'application/json');
      const result = await extractFileContent(file);

      const decodedUrl = result.url.split(',')[1];
      const decoded = decodeURIComponent(escape(atob(decodedUrl)));

      expect(decoded).toContain('7 operations');
    });
  });
});
