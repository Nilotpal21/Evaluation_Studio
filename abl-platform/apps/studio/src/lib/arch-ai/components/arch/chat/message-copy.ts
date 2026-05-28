'use client';

import type { ArchContentBlock } from '@/lib/arch-ai/ui/types';

interface CopyableMessageContent {
  content?: string;
  rawContent?: ArchContentBlock[];
}

const CODE_EXTENSIONS = new Set([
  'js',
  'ts',
  'jsx',
  'tsx',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'c',
  'cpp',
  'h',
  'cs',
  'sh',
  'bash',
  'zsh',
  'yaml',
  'yml',
  'json',
  'toml',
  'xml',
  'html',
  'css',
  'scss',
  'sql',
  'graphql',
  'md',
  'txt',
]);

function isCodeFile(name: string): boolean {
  const extension = name.split('.').pop()?.toLowerCase() ?? '';
  return CODE_EXTENSIONS.has(extension);
}

function getCodeLanguage(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? '';
}

function serializeContentBlockToMarkdown(block: ArchContentBlock): string {
  switch (block.type) {
    case 'text':
      return block.text;
    case 'image_ref': {
      const dimensions =
        block.width > 0 && block.height > 0 ? ` (${block.width}x${block.height})` : '';
      return `> Image: ${block.name}${dimensions}`;
    }
    case 'file_ref':
      if (block.summary && isCodeFile(block.name)) {
        const language = getCodeLanguage(block.name);
        return [`### ${block.name}`, '', `\`\`\`${language}`, block.summary.trimEnd(), '```'].join(
          '\n',
        );
      }
      return `> File: ${block.name} (${block.mediaType})`;
    case 'tool_result':
      return block.content;
    case 'tool_use':
      return '';
    default:
      return '';
  }
}

export function getMessageCopyMarkdown({ content, rawContent }: CopyableMessageContent): string {
  if (typeof content === 'string' && content.trim().length > 0) {
    return content;
  }

  if (!rawContent || rawContent.length === 0) {
    return '';
  }

  return rawContent
    .map(serializeContentBlockToMarkdown)
    .filter((value) => value.trim().length > 0)
    .join('\n\n')
    .trim();
}

function normalizeCodeBlocksForClipboard(root: HTMLElement) {
  const documentRef = root.ownerDocument;

  root.querySelectorAll<HTMLElement>('[data-code-block]').forEach((block) => {
    const codeSource = block.querySelector<HTMLElement>('[data-code-block-source]');
    const code = codeSource?.textContent ?? '';
    const language = block.dataset.codeLanguage?.trim();

    const pre = documentRef.createElement('pre');
    const codeNode = documentRef.createElement('code');
    if (language) {
      codeNode.className = `language-${language}`;
    }
    codeNode.textContent = code;
    pre.appendChild(codeNode);
    block.replaceWith(pre);
  });
}

export function buildRichTextClipboardHtml(root: HTMLElement): string {
  const clone = root.cloneNode(true) as HTMLElement;

  clone.querySelectorAll('button').forEach((button) => button.remove());
  normalizeCodeBlocksForClipboard(clone);

  return `<div>${clone.innerHTML}</div>`;
}

export async function copyRichTextFromRenderedMessage(
  root: HTMLElement,
  markdownFallback: string,
): Promise<void> {
  const html = buildRichTextClipboardHtml(root);
  const plainText = (root.innerText || root.textContent || '').trim() || markdownFallback;

  if (
    typeof globalThis.ClipboardItem === 'function' &&
    typeof navigator.clipboard?.write === 'function'
  ) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([plainText], { type: 'text/plain' }),
        }),
      ]);
      return;
    } catch {
      // Fall back to plain text below when richer clipboard types are unavailable.
    }
  }

  await navigator.clipboard.writeText(plainText);
}
