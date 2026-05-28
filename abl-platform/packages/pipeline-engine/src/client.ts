import * as restate from '@restatedev/restate-sdk-clients';

export function getRestateClient() {
  return restate.connect({
    url: process.env.RESTATE_INGRESS_URL ?? 'http://localhost:8091',
  });
}
