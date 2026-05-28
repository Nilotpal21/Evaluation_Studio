/**
 * Activepieces Piece Importer
 *
 * Reads Activepieces piece metadata and generates our ConnectorSDK
 * connector files at build time.
 *
 * Usage: pnpm connectors:import --pieces slack,stripe,github
 */

import { mapPieceToConnector } from './type-mapper.js';
import type { APPiece } from './type-mapper.js';

/**
 * Import a list of Activepieces pieces and return connector definitions.
 * This is the core function -- the CLI script calls this.
 */
export function importPieces(pieces: APPiece[]): ReturnType<typeof mapPieceToConnector>[] {
  return pieces.map(mapPieceToConnector);
}

/**
 * Generate TypeScript source code for a connector from piece metadata.
 * This produces a standalone file that can be checked into the repo.
 */
export function generateConnectorSource(piece: APPiece): string {
  const connector = mapPieceToConnector(piece);

  const actionsCode = connector.actions
    .map((a) => {
      const propsStr = a.props
        .map(
          (p) =>
            `      Property.${propertyBuilder(p.type)}('${p.name}', '${escape(p.displayName)}', { required: ${p.required} })`,
        )
        .join(',\n');
      return `  {
    name: '${a.name}',
    displayName: '${escape(a.displayName)}',
    description: '${escape(a.description)}',
    props: [\n${propsStr}\n    ],
    run: async (ctx) => {
      // TODO: implement ${a.name}
      return { success: true, data: {} };
    },
  }`;
    })
    .join(',\n');

  const triggersCode = connector.triggers
    .map((t) => {
      const propsStr = t.props
        .map(
          (p) =>
            `      Property.${propertyBuilder(p.type)}('${p.name}', '${escape(p.displayName)}', { required: ${p.required} })`,
        )
        .join(',\n');
      return `  {
    name: '${t.name}',
    displayName: '${escape(t.displayName)}',
    description: '${escape(t.description)}',
    triggerType: '${t.triggerType}' as const,
    props: [\n${propsStr}\n    ],
    onEnable: async () => {},
    onDisable: async () => {},
    run: async () => [],
  }`;
    })
    .join(',\n');

  return `/**
 * ${connector.displayName} Connector
 *
 * Auto-generated from Activepieces piece metadata.
 * Version: ${connector.version}
 */

import { Property } from '../../properties.js';
import type { Connector } from '../../types.js';

export const ${camelCase(connector.name)}Connector: Connector = {
  name: '${connector.name}',
  displayName: '${escape(connector.displayName)}',
  version: '${connector.version}',
  description: '${escape(connector.description)}',
  auth: ${JSON.stringify(connector.auth, null, 2).replace(/\n/g, '\n  ')},
  actions: [\n${actionsCode}\n  ],
  triggers: [\n${triggersCode}\n  ],
};
`;
}

/**
 * Maps our ConnectorPropertyType to the Property builder method name.
 * Must match the methods available on the Property object in properties.ts.
 */
function propertyBuilder(type: string): string {
  switch (type) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'dropdown':
      return 'dropdown';
    case 'dynamic_dropdown':
      return 'dynamicDropdown';
    case 'json':
      return 'json';
    case 'date':
      return 'string'; // No dedicated date builder; fall back to string
    case 'file':
      return 'string'; // No dedicated file builder; fall back to string
    default:
      return 'string';
  }
}

function camelCase(name: string): string {
  return name
    .replace(/^@[^/]+\//, '') // Remove npm scope
    .replace(/^piece-/, '') // Remove AP prefix
    .replace(/[-_](\w)/g, (_, c: string) => c.toUpperCase());
}

function escape(str: string): string {
  return str.replace(/'/g, "\\'").replace(/\n/g, '\\n');
}
