import type { SWRConfiguration } from 'swr';

export const swrConfig: SWRConfiguration = {
  revalidateOnFocus: false,
  revalidateOnReconnect: true,
  dedupingInterval: 5000,
  errorRetryCount: 3,
  onError: (error: Error) => {
    if (error.message === 'Unauthorized') {
      window.location.href = '/login';
    }
  },
};
