/**
 * Airlines Domain Vocabulary
 *
 * 7 vocabulary entries mapping airline business terms to canonical
 * metadata filters and aggregation specifications. Used by the
 * vocabulary_resolve search tool to translate natural language
 * queries into structured search parameters.
 */

export const AIRLINE_VOCABULARY = {
  tenantId: 'airline-tenant-1',
  projectKnowledgeBaseId: 'airline-kb-1',
  version: 1,
  status: 'active',
  entries: [
    {
      term: 'domestic flights',
      aliases: ['domestic routes', 'local flights'],
      description: 'Flights within the domestic route network',
      resolution: {
        type: 'filter',
        filters: [{ field: 'route_type', operator: 'eq', value: 'domestic' }],
      },
      enabled: true,
    },
    {
      term: 'international flights',
      aliases: ['intl flights', 'overseas routes'],
      description: 'Flights on international routes',
      resolution: {
        type: 'filter',
        filters: [{ field: 'route_type', operator: 'eq', value: 'international' }],
      },
      enabled: true,
    },
    {
      term: 'first class',
      aliases: ['first', 'premium cabin'],
      description: 'First class cabin service',
      resolution: {
        type: 'filter',
        filters: [{ field: 'cabin_class', operator: 'eq', value: 'first' }],
      },
      enabled: true,
    },
    {
      term: 'business class',
      aliases: ['business', 'executive class'],
      description: 'Business class cabin service',
      resolution: {
        type: 'filter',
        filters: [{ field: 'cabin_class', operator: 'eq', value: 'business' }],
      },
      enabled: true,
    },
    {
      term: 'economy class',
      aliases: ['economy', 'coach'],
      description: 'Economy class cabin service',
      resolution: {
        type: 'filter',
        filters: [{ field: 'cabin_class', operator: 'eq', value: 'economy' }],
      },
      enabled: true,
    },
    {
      term: 'total revenue',
      aliases: ['total fares', 'fare revenue'],
      description: 'Sum of all base fares',
      resolution: {
        type: 'aggregate',
        aggregation: { measure: 'base_fare', function: 'sum' },
      },
      enabled: true,
    },
    {
      term: 'average fare',
      aliases: ['avg fare', 'mean ticket price'],
      description: 'Average base fare across documents',
      resolution: {
        type: 'aggregate',
        aggregation: { measure: 'base_fare', function: 'avg' },
      },
      enabled: true,
    },
  ],
};
