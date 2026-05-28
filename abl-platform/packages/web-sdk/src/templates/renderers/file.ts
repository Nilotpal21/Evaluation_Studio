/**
 * File Template Renderer
 *
 * Renders a download link for a file attachment.
 */

import React from 'react';
import type { Message, FileContent } from '../../core/types.js';
import type { TemplateRenderer, TemplateContext } from '../types.js';
import { defaultRegistry } from '../registry.js';
import { isSafeUrl } from '../utils/safe-url.js';
import { getString } from '../utils/strings.js';

/**
 * Format file size in bytes to a human-readable string.
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const fileRenderer: TemplateRenderer<FileContent> = {
  type: 'file',

  extract(message: Message): FileContent | undefined {
    return message.richContent?.file;
  },

  render(data: FileContent, _ctx: TemplateContext): React.ReactElement {
    if (!isSafeUrl(data.url)) {
      return React.createElement('div', { className: 'rich-file rich-file-blocked' });
    }

    const details: string[] = [data.filename];
    if (data.size_bytes !== undefined && data.size_bytes !== null) {
      details.push(formatSize(data.size_bytes));
    }

    return React.createElement(
      'div',
      { className: 'rich-file', role: 'group', 'aria-label': data.filename },
      React.createElement(
        'div',
        { key: 'info', className: 'rich-file-info' },
        React.createElement('span', { key: 'name', className: 'rich-file-name' }, data.filename),
        data.size_bytes !== undefined && data.size_bytes !== null
          ? React.createElement(
              'span',
              { key: 'size', className: 'rich-file-size' },
              formatSize(data.size_bytes),
            )
          : null,
      ),
      React.createElement(
        'a',
        {
          key: 'link',
          className: 'rich-file-download',
          href: data.url,
          download: data.filename,
          target: '_blank',
          rel: 'noopener noreferrer',
          'aria-label': `${getString('file.download')} ${data.filename}`,
        },
        getString('file.download'),
      ),
    );
  },

  renderDOM(data: FileContent, _ctx: TemplateContext): HTMLElement {
    if (!isSafeUrl(data.url)) {
      const blocked = document.createElement('div');
      blocked.className = 'rich-file rich-file-blocked';
      return blocked;
    }

    const container = document.createElement('div');
    container.className = 'rich-file';
    container.setAttribute('role', 'group');
    container.setAttribute('aria-label', data.filename);

    const info = document.createElement('div');
    info.className = 'rich-file-info';

    const nameEl = document.createElement('span');
    nameEl.className = 'rich-file-name';
    nameEl.textContent = data.filename;
    info.appendChild(nameEl);

    if (data.size_bytes !== undefined && data.size_bytes !== null) {
      const sizeEl = document.createElement('span');
      sizeEl.className = 'rich-file-size';
      sizeEl.textContent = formatSize(data.size_bytes);
      info.appendChild(sizeEl);
    }

    container.appendChild(info);

    const link = document.createElement('a');
    link.className = 'rich-file-download';
    link.href = data.url;
    link.download = data.filename;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = getString('file.download');
    link.setAttribute('aria-label', `${getString('file.download')} ${data.filename}`);
    container.appendChild(link);

    return container;
  },
};

defaultRegistry.register(fileRenderer);

export { fileRenderer };
