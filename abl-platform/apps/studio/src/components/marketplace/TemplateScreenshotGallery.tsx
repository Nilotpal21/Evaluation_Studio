'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { X, ChevronLeft, ChevronRight, Play } from 'lucide-react';
import type { TemplateMedia } from '@/store/marketplace-store';

interface TemplateScreenshotGalleryProps {
  media: TemplateMedia[];
}

export function TemplateScreenshotGallery({ media }: TemplateScreenshotGalleryProps) {
  const t = useTranslations('marketplace');
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const sorted = [...media].sort((a, b) => a.order - b.order);

  if (sorted.length === 0) {
    return <p className="text-sm text-muted">{t('media.noMedia')}</p>;
  }

  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {sorted.map((item, index) => (
          <button
            key={`${item.url}-${index}`}
            onClick={() => setLightboxIndex(index)}
            className="rounded-xl border border-default overflow-hidden cursor-pointer card-hover text-left"
          >
            {item.type === 'video' ? (
              <div className="relative">
                <video
                  poster={item.thumbnailUrl ?? undefined}
                  className="w-full aspect-video object-cover"
                  controls={false}
                  muted
                  playsInline
                >
                  <source src={item.url} type="video/mp4" />
                </video>
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="w-10 h-10 rounded-full bg-background/80 flex items-center justify-center">
                    <Play className="w-5 h-5 text-foreground" />
                  </div>
                </div>
              </div>
            ) : (
              <img src={item.url} alt={item.caption} className="w-full aspect-video object-cover" />
            )}
            {item.caption && (
              <div className="px-3 py-2 text-xs text-muted bg-background-muted">{item.caption}</div>
            )}
          </button>
        ))}
      </div>

      {/* Lightbox */}
      {lightboxIndex !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm"
          onClick={() => setLightboxIndex(null)}
          role="dialog"
          aria-modal="true"
          aria-label={sorted[lightboxIndex]?.caption ?? t('media.title')}
        >
          <div className="relative max-w-4xl w-full mx-4" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => setLightboxIndex(null)}
              className="absolute -top-10 right-0 text-muted hover:text-foreground transition-default"
              aria-label={t('media.close')}
            >
              <X className="w-5 h-5" />
            </button>
            {sorted[lightboxIndex].type === 'video' ? (
              <video
                src={sorted[lightboxIndex].url}
                poster={sorted[lightboxIndex].thumbnailUrl ?? undefined}
                controls
                autoPlay
                className="w-full rounded-xl"
              >
                <source src={sorted[lightboxIndex].url} type="video/mp4" />
              </video>
            ) : (
              <img
                src={sorted[lightboxIndex].url}
                alt={sorted[lightboxIndex].caption}
                className="w-full rounded-xl"
              />
            )}
            {sorted[lightboxIndex].caption && (
              <p className="text-sm text-muted text-center mt-3">{sorted[lightboxIndex].caption}</p>
            )}
            {/* Navigation */}
            {sorted.length > 1 && (
              <div className="absolute inset-y-0 left-0 right-0 flex items-center justify-between pointer-events-none">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setLightboxIndex((lightboxIndex - 1 + sorted.length) % sorted.length);
                  }}
                  className="pointer-events-auto p-2 rounded-full bg-background-elevated border border-default text-muted hover:text-foreground transition-default -ml-4"
                  aria-label={t('pagination.previous')}
                >
                  <ChevronLeft className="w-5 h-5" />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setLightboxIndex((lightboxIndex + 1) % sorted.length);
                  }}
                  className="pointer-events-auto p-2 rounded-full bg-background-elevated border border-default text-muted hover:text-foreground transition-default -mr-4"
                  aria-label={t('pagination.next')}
                >
                  <ChevronRight className="w-5 h-5" />
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
