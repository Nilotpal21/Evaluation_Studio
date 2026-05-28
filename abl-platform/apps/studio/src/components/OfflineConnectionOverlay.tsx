import { WifiOff } from 'lucide-react';
import { Button } from './ui/Button';

interface OfflineConnectionOverlayProps {
  title: string;
  description: string;
  retryLabel: string;
  onRetry: () => void;
}

export function OfflineConnectionOverlay({
  title,
  description,
  retryLabel,
  onRetry,
}: OfflineConnectionOverlayProps) {
  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-950/55 p-4 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="offline-connection-title"
      aria-describedby="offline-connection-description"
    >
      <div className="w-full max-w-6xl rounded-[2rem] bg-background px-6 py-12 text-center shadow-[0_32px_80px_-24px_rgba(15,23,42,0.45)] sm:px-10 sm:py-16 lg:px-20 lg:py-20">
        <div className="mx-auto flex max-w-3xl flex-col items-center">
          <div className="mb-10 text-foreground">
            <WifiOff className="h-24 w-24 stroke-[1.5] sm:h-28 sm:w-28 lg:h-32 lg:w-32" />
          </div>

          <h2
            id="offline-connection-title"
            className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl"
          >
            {title}
          </h2>

          <p
            id="offline-connection-description"
            className="mt-5 max-w-3xl text-lg leading-8 text-muted sm:text-2xl sm:leading-10"
          >
            {description}
          </p>

          <Button
            type="button"
            size="lg"
            onClick={onRetry}
            className="mt-10 min-w-44 rounded-2xl bg-slate-900 px-8 py-4 text-lg font-semibold text-white hover:bg-slate-800 sm:min-w-52"
          >
            {retryLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
