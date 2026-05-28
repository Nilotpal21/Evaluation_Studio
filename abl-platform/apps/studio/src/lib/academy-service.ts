import 'server-only';

import { resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import {
  createAcademyServices,
  createMongooseAcademyStorage,
  type AcademyServices,
} from '@agent-platform/academy';
import { ensureDb } from '@/lib/ensure-db';

const ACADEMY_SERVICE_DIR = dirname(fileURLToPath(import.meta.url));
const ACADEMY_CONTENT_ROOT = resolve(ACADEMY_SERVICE_DIR, '../../../../packages/academy/content');

let academyServicesPromise: Promise<AcademyServices> | null = null;

export async function getAcademyServices(): Promise<AcademyServices> {
  if (!academyServicesPromise) {
    academyServicesPromise = (async () => {
      await ensureDb();
      return createAcademyServices(createMongooseAcademyStorage(mongoose.connection), {
        contentRoot: ACADEMY_CONTENT_ROOT,
      });
    })().catch((error) => {
      academyServicesPromise = null;
      throw error;
    });
  }

  return academyServicesPromise;
}
