/**
 * Knowledge Graph Taxonomy Model
 *
 * Stores parsed taxonomy for domain-aware knowledge graph.
 * One taxonomy per index, derived from domain definitions + organization profile.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import { ModelRegistry } from '../model-registry.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IKGDomain {
  id: string;
  name: string;
  version: string;
}

export interface IKGCategory {
  id: string;
  name: string;
  department: string;
}

export interface IKGSubProduct {
  id: string;
  name: string;
  disambiguationKeywords: string[];
}

export interface IKGProduct {
  id: string;
  name: string;
  categoryId: string;
  department: string;
  subDepartment: string;
  disambiguationKeywords: string[];
  organizationSpecificNames: string[];
  subProducts?: IKGSubProduct[];
}

export interface IKGAttribute {
  id: string;
  name: string;
  dataType: 'percentage' | 'currency' | 'date' | 'duration' | 'identifier' | 'string' | 'number';
  applicableTo: string[]; // Product IDs
  notApplicableTo: string[]; // Product IDs
  extraction: {
    method: 'regex' | 'llm' | 'hybrid';
    patterns?: string[]; // Regex patterns
    keywords?: string[]; // LLM hints
  };
  organizationContext?: {
    typicalRange?: string;
    aliases?: string[];
  };
}

export interface IKGDepartmentBoundary {
  product1: string;
  product2: string;
  reasoning: string;
}

export interface IKGTaxonomyVersion {
  version: string;
  taxonomy: {
    domain: IKGDomain;
    domainSources?: IKGDomain[];
    categories: IKGCategory[];
    products: IKGProduct[];
    attributes: IKGAttribute[];
    departmentBoundaries: IKGDepartmentBoundary[];
  };
  createdAt: Date;
  refinementAction?: string;
  rollbackReason?: string;
}

export interface IKnowledgeGraphTaxonomy {
  _id: string;
  tenantId: string;
  indexId: string;

  taxonomy: {
    domain: IKGDomain;
    domainSources: IKGDomain[];
    categories: IKGCategory[];
    products: IKGProduct[];
    attributes: IKGAttribute[];
    departmentBoundaries: IKGDepartmentBoundary[];
  };

  version: string;
  domains: string[];
  customDomainFiles: string[];
  organizationProfileFile: string;

  previousVersions: IKGTaxonomyVersion[];

  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const KnowledgeGraphTaxonomySchema = new Schema<IKnowledgeGraphTaxonomy>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    indexId: { type: String, required: true },

    taxonomy: {
      domain: {
        id: { type: String, required: true },
        name: { type: String, required: true },
        version: { type: String, required: true },
      },
      domainSources: {
        type: [
          {
            id: { type: String, required: true },
            name: { type: String, required: true },
            version: { type: String, required: true },
          },
        ],
        default: [],
      },
      categories: [
        {
          id: { type: String, required: true },
          name: { type: String, required: true },
          department: { type: String, required: true },
        },
      ],
      products: [
        {
          id: { type: String, required: true },
          name: { type: String, required: true },
          categoryId: { type: String, required: true },
          department: { type: String, required: true },
          subDepartment: { type: String, required: true },
          disambiguationKeywords: [{ type: String }],
          organizationSpecificNames: [{ type: String }],
          subProducts: [
            {
              id: { type: String, required: true },
              name: { type: String, required: true },
              disambiguationKeywords: [{ type: String }],
            },
          ],
        },
      ],
      attributes: [
        {
          id: { type: String, required: true },
          name: { type: String, required: true },
          dataType: {
            type: String,
            enum: ['percentage', 'currency', 'date', 'duration', 'identifier', 'string', 'number'],
            required: true,
          },
          applicableTo: [{ type: String }],
          notApplicableTo: [{ type: String }],
          extraction: {
            method: {
              type: String,
              enum: ['regex', 'llm', 'hybrid'],
              required: true,
            },
            patterns: [{ type: String }],
            keywords: [{ type: String }],
          },
          organizationContext: {
            typicalRange: { type: String },
            aliases: [{ type: String }],
          },
        },
      ],
      departmentBoundaries: [
        {
          product1: { type: String, required: true },
          product2: { type: String, required: true },
          reasoning: { type: String, required: true },
        },
      ],
    },

    version: { type: String, required: true },
    domains: [{ type: String }],
    customDomainFiles: [{ type: String }],
    organizationProfileFile: { type: String, required: true },

    previousVersions: [
      {
        version: { type: String, required: true },
        taxonomy: {
          domain: {
            id: { type: String, required: true },
            name: { type: String, required: true },
            version: { type: String, required: true },
          },
          domainSources: [
            {
              id: { type: String, required: true },
              name: { type: String, required: true },
              version: { type: String, required: true },
            },
          ],
          categories: [
            {
              id: { type: String, required: true },
              name: { type: String, required: true },
              department: { type: String, required: true },
            },
          ],
          products: [
            {
              id: { type: String, required: true },
              name: { type: String, required: true },
              categoryId: { type: String, required: true },
              department: { type: String, required: true },
              subDepartment: { type: String, required: true },
              disambiguationKeywords: [{ type: String }],
              organizationSpecificNames: [{ type: String }],
              subProducts: [
                {
                  id: { type: String, required: true },
                  name: { type: String, required: true },
                  disambiguationKeywords: [{ type: String }],
                },
              ],
            },
          ],
          attributes: [
            {
              id: { type: String, required: true },
              name: { type: String, required: true },
              dataType: {
                type: String,
                enum: [
                  'percentage',
                  'currency',
                  'date',
                  'duration',
                  'identifier',
                  'string',
                  'number',
                ],
                required: true,
              },
              applicableTo: [{ type: String }],
              notApplicableTo: [{ type: String }],
              extraction: {
                method: {
                  type: String,
                  enum: ['regex', 'llm', 'hybrid'],
                  required: true,
                },
                patterns: [{ type: String }],
                keywords: [{ type: String }],
              },
              organizationContext: {
                typicalRange: { type: String },
                aliases: [{ type: String }],
              },
            },
          ],
          departmentBoundaries: [
            {
              product1: { type: String, required: true },
              product2: { type: String, required: true },
              reasoning: { type: String, required: true },
            },
          ],
        },
        createdAt: { type: Date, required: true },
        refinementAction: { type: String },
        rollbackReason: { type: String },
      },
    ],
  },
  { timestamps: true, collection: 'knowledge_graph_taxonomy' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

KnowledgeGraphTaxonomySchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

// Unique index per index (one taxonomy per index)
KnowledgeGraphTaxonomySchema.index({ tenantId: 1, indexId: 1 }, { unique: true });

// ─── Model ───────────────────────────────────────────────────────────────

// Register with ModelRegistry for dual-database support
ModelRegistry.registerModelDefinition(
  'KnowledgeGraphTaxonomy',
  KnowledgeGraphTaxonomySchema,
  'searchaicontent',
);

export const KnowledgeGraphTaxonomy =
  (mongoose.models.KnowledgeGraphTaxonomy as any) ||
  model<IKnowledgeGraphTaxonomy>('KnowledgeGraphTaxonomy', KnowledgeGraphTaxonomySchema);
