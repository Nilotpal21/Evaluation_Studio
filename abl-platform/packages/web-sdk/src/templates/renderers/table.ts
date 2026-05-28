/**
 * Table Template Renderer
 *
 * Renders a semantic HTML table with optional "Show more / Show less" toggle.
 */

import React from 'react';
import type { Message, TableTemplate } from '../../core/types.js';
import type { TemplateRenderer, TemplateContext } from '../types.js';
import { defaultRegistry } from '../registry.js';
import { getString } from '../utils/strings.js';

/** Default number of visible rows before truncation */
const DEFAULT_MAX_VISIBLE_ROWS = 10;

// ---------------------------------------------------------------------------
// React component (needs state for expand/collapse)
// ---------------------------------------------------------------------------

function TableComponent(props: { data: TableTemplate }): React.ReactElement {
  const { data } = props;
  const maxRows = data.max_visible_rows ?? DEFAULT_MAX_VISIBLE_ROWS;
  const [expanded, setExpanded] = React.useState(false);
  const needsToggle = data.rows.length > maxRows;
  const visibleRows = expanded ? data.rows : data.rows.slice(0, maxRows);

  const headerCells = data.columns.map((col) =>
    React.createElement(
      'th',
      {
        key: col.key,
        scope: 'col',
        className: 'rich-table-th',
        style: col.align ? { textAlign: col.align } : undefined,
      },
      col.header,
    ),
  );

  const bodyRows = visibleRows.map((row, rowIndex) =>
    React.createElement(
      'tr',
      { key: `row-${rowIndex}`, className: 'rich-table-row' },
      ...data.columns.map((col) =>
        React.createElement(
          'td',
          {
            key: col.key,
            className: 'rich-table-td',
            style: col.align ? { textAlign: col.align } : undefined,
          },
          String(row[col.key] ?? ''),
        ),
      ),
    ),
  );

  const children: React.ReactElement[] = [
    React.createElement(
      'table',
      { key: 'table', className: 'rich-table-element', role: 'table' },
      React.createElement(
        'thead',
        { key: 'thead' },
        React.createElement('tr', { key: 'header-row' }, ...headerCells),
      ),
      React.createElement('tbody', { key: 'tbody' }, ...bodyRows),
    ),
  ];

  if (needsToggle) {
    children.push(
      React.createElement(
        'button',
        {
          key: 'toggle',
          className: 'rich-table-toggle',
          'aria-expanded': expanded,
          onClick: () => setExpanded(!expanded),
        },
        expanded ? getString('table.showLess') : getString('table.showMore'),
      ),
    );
  }

  return React.createElement(
    'div',
    { className: 'rich-table', role: 'region', 'aria-label': getString('table.label') },
    ...children,
  );
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

const tableRenderer: TemplateRenderer<TableTemplate> = {
  type: 'table',

  extract(message: Message): TableTemplate | undefined {
    const table = message.richContent?.table;
    if (table && table.columns.length > 0 && table.rows.length > 0) {
      return table;
    }
    return undefined;
  },

  render(data: TableTemplate, _ctx: TemplateContext): React.ReactElement {
    return React.createElement(TableComponent, { data });
  },

  renderDOM(data: TableTemplate, _ctx: TemplateContext): HTMLElement {
    const maxRows = data.max_visible_rows ?? DEFAULT_MAX_VISIBLE_ROWS;
    const needsToggle = data.rows.length > maxRows;
    let expanded = false;

    const container = document.createElement('div');
    container.className = 'rich-table';
    container.setAttribute('role', 'region');
    container.setAttribute('aria-label', getString('table.label'));

    const table = document.createElement('table');
    table.className = 'rich-table-element';
    table.setAttribute('role', 'table');

    // Header
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    for (const col of data.columns) {
      const th = document.createElement('th');
      th.className = 'rich-table-th';
      th.scope = 'col';
      th.textContent = col.header;
      if (col.align) th.style.textAlign = col.align;
      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Body
    const tbody = document.createElement('tbody');

    const renderRows = () => {
      tbody.innerHTML = '';
      const visible = expanded ? data.rows : data.rows.slice(0, maxRows);
      for (const row of visible) {
        const tr = document.createElement('tr');
        tr.className = 'rich-table-row';
        for (const col of data.columns) {
          const td = document.createElement('td');
          td.className = 'rich-table-td';
          td.textContent = String(row[col.key] ?? '');
          if (col.align) td.style.textAlign = col.align;
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
    };

    renderRows();
    table.appendChild(tbody);
    container.appendChild(table);

    // Toggle button
    if (needsToggle) {
      const toggleBtn = document.createElement('button');
      toggleBtn.className = 'rich-table-toggle';
      toggleBtn.textContent = getString('table.showMore');
      toggleBtn.setAttribute('aria-expanded', 'false');
      toggleBtn.addEventListener('click', () => {
        expanded = !expanded;
        toggleBtn.textContent = expanded
          ? getString('table.showLess')
          : getString('table.showMore');
        toggleBtn.setAttribute('aria-expanded', String(expanded));
        renderRows();
      });
      container.appendChild(toggleBtn);
    }

    return container;
  },
};

defaultRegistry.register(tableRenderer);

export { tableRenderer };
