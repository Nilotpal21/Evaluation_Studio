import type { NextFunction, Request, Response } from 'express';
import type { IConnectorConfig, ISearchIndex, ISearchSource } from '@agent-platform/database';
import { getLazyModel } from '../db/index.js';
import { applyProjectScopeFilter } from './project-scope.js';

type Leanable<T> = Promise<T> | { lean: () => Promise<T> };

async function resolveLean<T>(query: Leanable<T>): Promise<T> {
  if (query && typeof (query as { lean?: unknown }).lean === 'function') {
    return (query as { lean: () => Promise<T> }).lean();
  }
  return query as Promise<T>;
}

function respondNotFound(res: Response, message: string): void {
  res.status(404).json({
    success: false,
    error: { code: 'NOT_FOUND', message },
  });
}

export async function assertSearchIndexAccess(req: Request, indexId: string): Promise<boolean> {
  const tenantId = req.tenantContext?.tenantId;
  if (!tenantId || !req.tenantContext) {
    return false;
  }

  const SearchIndex = getLazyModel<ISearchIndex>('SearchIndex');
  const index = await resolveLean<ISearchIndex | null>(
    SearchIndex.findOne(applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext)),
  );

  return Boolean(index);
}

export async function assertConnectorIndexAccess(
  req: Request,
  connectorId: string,
  routeIndexId?: string,
): Promise<boolean> {
  const tenantId = req.tenantContext?.tenantId;
  if (!tenantId || !req.tenantContext) {
    return false;
  }

  const ConnectorConfig = getLazyModel<IConnectorConfig>('ConnectorConfig');
  const SearchSource = getLazyModel<ISearchSource>('SearchSource');

  const connector = await resolveLean<IConnectorConfig | null>(
    ConnectorConfig.findOne({ _id: connectorId, tenantId }),
  );
  if (!connector?.sourceId) {
    return false;
  }

  const source = await resolveLean<ISearchSource | null>(
    SearchSource.findOne({
      _id: connector.sourceId,
      tenantId,
      ...(routeIndexId ? { indexId: routeIndexId } : {}),
    }),
  );
  if (!source?.indexId) {
    return false;
  }

  return assertSearchIndexAccess(req, source.indexId);
}

export function requireSearchIndexAccessFromParams(paramName = 'indexId') {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const indexId = req.params[paramName];
    if (!indexId || !(await assertSearchIndexAccess(req, indexId))) {
      respondNotFound(res, 'Index not found');
      return;
    }

    next();
  };
}

export function requireConnectorIndexAccessFromParams(
  indexParamName = 'indexId',
  connectorParamName = 'connectorId',
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const connectorId = req.params[connectorParamName];
    const indexId = req.params[indexParamName];
    if (!connectorId || !(await assertConnectorIndexAccess(req, connectorId, indexId))) {
      respondNotFound(res, 'Connector not found');
      return;
    }

    next();
  };
}

export function requireConnectorAccessFromParams(connectorParamName = 'connectorId') {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const connectorId = req.params[connectorParamName];
    if (!connectorId || !(await assertConnectorIndexAccess(req, connectorId))) {
      respondNotFound(res, 'Connector not found');
      return;
    }

    next();
  };
}
