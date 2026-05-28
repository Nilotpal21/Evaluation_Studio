/**
 * Test File Generation Helpers
 *
 * Generate realistic test files (PDF, Markdown, Text) for document processing tests.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export interface TestFile {
  filePath: string;
  fileName: string;
  fileType: string;
  expectedText: string;
  sizeBytes: number;
}

/**
 * Test file generator
 */
export class TestFileGenerator {
  constructor(private testDataDir: string) {}

  /**
   * Ensure test data directory exists
   */
  async ensureTestDir(): Promise<void> {
    await fs.mkdir(this.testDataDir, { recursive: true });
  }

  /**
   * Generate a simple PDF with text content
   */
  async generatePDF(
    fileName: string,
    content: string,
    options?: { pages?: number },
  ): Promise<TestFile> {
    await this.ensureTestDir();

    const pdfDoc = await PDFDocument.create();
    const timesRomanFont = await pdfDoc.embedFont(StandardFonts.TimesRoman);

    const pages = options?.pages || 1;
    const linesPerPage = 40;
    const lines = content.split('\n');

    for (let pageNum = 0; pageNum < pages; pageNum++) {
      const page = pdfDoc.addPage([612, 792]); // US Letter size
      const { width, height } = page.getSize();
      const fontSize = 12;
      const lineHeight = 18;

      const startLine = pageNum * linesPerPage;
      const endLine = Math.min(startLine + linesPerPage, lines.length);
      const pageLines = lines.slice(startLine, endLine);

      let yPosition = height - 50;

      for (const line of pageLines) {
        if (yPosition < 50) break; // Prevent overflow

        page.drawText(line, {
          x: 50,
          y: yPosition,
          size: fontSize,
          font: timesRomanFont,
          color: rgb(0, 0, 0),
        });

        yPosition -= lineHeight;
      }

      // Add page number
      page.drawText(`Page ${pageNum + 1}`, {
        x: width / 2 - 20,
        y: 30,
        size: 10,
        font: timesRomanFont,
        color: rgb(0.5, 0.5, 0.5),
      });
    }

    const pdfBytes = await pdfDoc.save();
    const filePath = path.join(this.testDataDir, fileName);
    await fs.writeFile(filePath, pdfBytes);

    const stats = await fs.stat(filePath);

    return {
      filePath,
      fileName,
      fileType: 'application/pdf',
      expectedText: content,
      sizeBytes: stats.size,
    };
  }

  /**
   * Generate a markdown file
   */
  async generateMarkdown(fileName: string, content: string): Promise<TestFile> {
    await this.ensureTestDir();

    const filePath = path.join(this.testDataDir, fileName);
    await fs.writeFile(filePath, content, 'utf-8');

    const stats = await fs.stat(filePath);

    return {
      filePath,
      fileName,
      fileType: 'text/markdown',
      expectedText: content,
      sizeBytes: stats.size,
    };
  }

  /**
   * Generate a plain text file
   */
  async generateText(fileName: string, content: string): Promise<TestFile> {
    await this.ensureTestDir();

    const filePath = path.join(this.testDataDir, fileName);
    await fs.writeFile(filePath, content, 'utf-8');

    const stats = await fs.stat(filePath);

    return {
      filePath,
      fileName,
      fileType: 'text/plain',
      expectedText: content,
      sizeBytes: stats.size,
    };
  }

  /**
   * Generate a sample technical document (PDF)
   */
  async generateTechnicalDoc(topic: string): Promise<TestFile> {
    const content = `${topic}

Introduction

This document provides a comprehensive overview of ${topic.toLowerCase()}.
It covers key concepts, implementation patterns, and best practices.

Core Concepts

The fundamental principles of ${topic.toLowerCase()} include:
- Modularity and composability
- Performance optimization
- Error handling and resilience
- Security considerations

Implementation Patterns

When implementing ${topic.toLowerCase()}, consider the following patterns:

1. Pattern One: Direct implementation
   - Simple and straightforward
   - Best for small-scale applications
   - Limited flexibility

2. Pattern Two: Layered architecture
   - Separation of concerns
   - Easier to test and maintain
   - More complex setup

3. Pattern Three: Event-driven approach
   - Decoupled components
   - Scalable and resilient
   - Requires event infrastructure

Best Practices

Always follow these best practices:
- Write comprehensive tests
- Document your code
- Use type safety where possible
- Monitor performance metrics
- Handle errors gracefully

Conclusion

Mastering ${topic.toLowerCase()} requires understanding both theory and practice.
This document serves as a starting point for further exploration.

References

1. Official Documentation
2. Community Forums
3. Research Papers
4. Open Source Examples`;

    return this.generatePDF(`${topic.toLowerCase().replace(/\s+/g, '-')}.pdf`, content);
  }

  /**
   * Generate a sample code snippet document
   */
  async generateCodeDoc(): Promise<TestFile> {
    const content = `# Code Examples and Patterns

## Introduction

This document contains various code examples demonstrating common patterns.

## JavaScript Patterns

### Async/Await Pattern

\`\`\`javascript
async function fetchData(url) {
  try {
    const response = await fetch(url);
    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Fetch failed:', error);
    throw error;
  }
}
\`\`\`

### Factory Pattern

\`\`\`javascript
class UserFactory {
  static createUser(type) {
    switch (type) {
      case 'admin':
        return new AdminUser();
      case 'guest':
        return new GuestUser();
      default:
        return new RegularUser();
    }
  }
}
\`\`\`

## Python Patterns

### Context Manager

\`\`\`python
class FileManager:
    def __init__(self, filename):
        self.filename = filename

    def __enter__(self):
        self.file = open(self.filename, 'r')
        return self.file

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.file.close()

# Usage
with FileManager('data.txt') as f:
    content = f.read()
\`\`\`

## Conclusion

These patterns form the foundation of robust software design.`;

    return this.generateMarkdown('code-examples.md', content);
  }

  /**
   * Generate multiple test files at once
   */
  async generateTestBatch(): Promise<TestFile[]> {
    const files: TestFile[] = [];

    // Technical docs
    files.push(await this.generateTechnicalDoc('Machine Learning Fundamentals'));
    files.push(await this.generateTechnicalDoc('Distributed Systems'));
    files.push(await this.generateTechnicalDoc('Database Optimization'));

    // Code examples
    files.push(await this.generateCodeDoc());

    // Simple text file
    files.push(
      await this.generateText(
        'readme.txt',
        `SearchAI Test Document

This is a simple text file used for testing document ingestion.

It contains multiple lines and paragraphs to verify text extraction.

Features:
- Plain text processing
- Simple structure
- Fast extraction

End of document.`,
      ),
    );

    return files;
  }

  /**
   * Clean up test data directory
   */
  async cleanup(): Promise<void> {
    try {
      await fs.rm(this.testDataDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore if directory doesn't exist
    }
  }
}
