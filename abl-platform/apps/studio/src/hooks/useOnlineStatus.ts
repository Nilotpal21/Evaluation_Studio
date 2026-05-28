import { useEffect, useState } from 'react';

function getIsOffline(): boolean {
  if (typeof navigator === 'undefined') {
    return false;
  }

  // In development, skip offline detection — all services run on localhost
  // and navigator.onLine can produce false negatives when there's no WAN
  if (process.env.NODE_ENV === 'development') {
    return false;
  }

  return !navigator.onLine;
}

export function useOnlineStatus(): boolean {
  const [isOffline, setIsOffline] = useState(getIsOffline);

  useEffect(() => {
    const syncOnlineStatus = () => {
      setIsOffline(getIsOffline());
    };

    syncOnlineStatus();
    window.addEventListener('online', syncOnlineStatus);
    window.addEventListener('offline', syncOnlineStatus);

    return () => {
      window.removeEventListener('online', syncOnlineStatus);
      window.removeEventListener('offline', syncOnlineStatus);
    };
  }, []);

  return isOffline;
}
