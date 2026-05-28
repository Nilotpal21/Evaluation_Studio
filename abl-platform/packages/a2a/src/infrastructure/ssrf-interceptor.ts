import type { EndpointValidator } from '../domain/ports.js';
import { assertUrlSafeForSSRF } from '@agent-platform/shared-kernel/security';

export class SsrfEndpointValidator implements EndpointValidator {
  validate(url: string, allowPrivate = false): void {
    if (allowPrivate) return;
    assertUrlSafeForSSRF(url);
  }
}
