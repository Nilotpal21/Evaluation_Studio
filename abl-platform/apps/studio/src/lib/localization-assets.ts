import { createLogger } from '@abl/compiler/platform/logger.js';
import {
  localeAssetConfigKeyToRelativePath,
  localeAssetRelativePathToConfigKey,
  localeAssetRelativePathToFilePath,
  parseLocaleAssetPath,
} from '@agent-platform/project-io';
import { ensureDb } from '@/lib/ensure-db';

const log = createLogger('localization-assets');

interface RawLocalizationConfigVariable {
  _id?: string;
  key?: string;
  value?: string;
  description?: string | null;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

export interface ProjectLocalizationAsset {
  id: string;
  key: string;
  value: string;
  description: string | null;
  relativePath: string;
  filePath: string;
  localeCode: string;
  fileName: string;
  assetName: string;
  scope: 'shared' | 'agent';
  createdAt: string | null;
  updatedAt: string | null;
}

function toIsoString(value: Date | string | undefined): string | null {
  if (!value) {
    return null;
  }

  if (typeof value === 'string') {
    return value;
  }

  return value.toISOString();
}

function mapLocalizationAsset(doc: RawLocalizationConfigVariable): ProjectLocalizationAsset | null {
  const key = doc.key;
  const rawValue = doc.value;
  if (!key || typeof rawValue !== 'string') {
    return null;
  }

  const relativePath = localeAssetConfigKeyToRelativePath(key);
  if (!relativePath) {
    return null;
  }

  const parts = parseLocaleAssetPath(relativePath);
  if (!parts || !doc._id) {
    return null;
  }

  return {
    id: doc._id,
    key,
    value: rawValue,
    description: doc.description ?? null,
    relativePath,
    filePath: localeAssetRelativePathToFilePath(relativePath),
    localeCode: parts.localeCode,
    fileName: parts.fileName,
    assetName: parts.assetName,
    scope: parts.scope,
    createdAt: toIsoString(doc.createdAt),
    updatedAt: toIsoString(doc.updatedAt),
  };
}

export function formatLocalizationAssetJson(value: string): string {
  const parsed = JSON.parse(value) as unknown;
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('Locale asset content must be a JSON object');
  }

  return JSON.stringify(parsed, null, 2);
}

export async function listProjectLocalizationAssets(
  projectId: string,
  tenantId: string,
): Promise<ProjectLocalizationAsset[]> {
  await ensureDb();
  const { ProjectConfigVariable } = await import('@agent-platform/database/models');
  const docs = (await ProjectConfigVariable.find({
    projectId,
    tenantId,
    key: /^locale:/,
  })
    .sort({ key: 1 })
    .lean()
    .select('_id key value description createdAt updatedAt')) as RawLocalizationConfigVariable[];

  const assets = docs
    .map((doc) => {
      const asset = mapLocalizationAsset(doc);
      if (!asset) {
        log.warn('Skipping invalid localization asset record during listing', {
          projectId,
          tenantId,
          key: doc.key ?? null,
        });
      }
      return asset;
    })
    .filter((asset): asset is ProjectLocalizationAsset => asset !== null);

  return assets;
}

export async function getProjectLocalizationAssetById(
  assetId: string,
  projectId: string,
  tenantId: string,
): Promise<ProjectLocalizationAsset | null> {
  await ensureDb();
  const { ProjectConfigVariable } = await import('@agent-platform/database/models');
  const doc = (await ProjectConfigVariable.findOne({
    _id: assetId,
    projectId,
    tenantId,
    key: /^locale:/,
  })
    .lean()
    .select(
      '_id key value description createdAt updatedAt',
    )) as RawLocalizationConfigVariable | null;

  if (!doc) {
    return null;
  }

  return mapLocalizationAsset(doc);
}

export async function buildProjectLocalizationRelativeFileMap(
  projectId: string,
  tenantId: string,
): Promise<Map<string, string>> {
  const assets = await listProjectLocalizationAssets(projectId, tenantId);
  return new Map(assets.map((asset) => [asset.relativePath, asset.value]));
}

export async function buildProjectLocalizationFileMap(
  projectId: string,
  tenantId: string,
): Promise<Map<string, string>> {
  const assets = await listProjectLocalizationAssets(projectId, tenantId);
  return new Map(assets.map((asset) => [asset.filePath, asset.value]));
}

export function buildLocalizationAssetKey(relativePath: string): string {
  return localeAssetRelativePathToConfigKey(relativePath);
}
