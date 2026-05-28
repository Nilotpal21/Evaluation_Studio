/**
 * Learning Academy — Auth Port
 *
 * Platform-agnostic auth interface. Each host implements this
 * to bridge their auth system into the academy package.
 */

import type { AcademyUser } from './types.js';

export interface AcademyAuthPort {
  getUserFromRequest(req: unknown): Promise<AcademyUser | null>;
}
