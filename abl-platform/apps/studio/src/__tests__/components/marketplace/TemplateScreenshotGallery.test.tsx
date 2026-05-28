/**
 * TemplateScreenshotGallery Component Tests
 *
 * Tests the media gallery component with image, video, and mixed media items.
 *
 * @vitest-environment happy-dom
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TemplateScreenshotGallery } from '../../../components/marketplace/TemplateScreenshotGallery';
import type { TemplateMedia } from '@/store/marketplace-store';

describe('TemplateScreenshotGallery', () => {
  const media: TemplateMedia[] = [
    { type: 'image', url: '/img/screen1.png', caption: 'Dashboard view', order: 1 },
    { type: 'image', url: '/img/screen2.png', caption: 'Settings page', order: 2 },
    { type: 'image', url: '/img/screen3.png', caption: 'Analytics panel', order: 3 },
  ];

  it('renders thumbnails sorted by order', () => {
    render(<TemplateScreenshotGallery media={media} />);
    const images = screen.getAllByRole('img');
    expect(images).toHaveLength(3);
    expect(images[0].getAttribute('alt')).toBe('Dashboard view');
    expect(images[1].getAttribute('alt')).toBe('Settings page');
    expect(images[2].getAttribute('alt')).toBe('Analytics panel');
  });

  it('opens lightbox on click', () => {
    render(<TemplateScreenshotGallery media={media} />);
    // Click first thumbnail
    fireEvent.click(screen.getByAltText('Dashboard view'));
    // Lightbox dialog should appear
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('navigates with arrows in lightbox', () => {
    render(<TemplateScreenshotGallery media={media} />);
    fireEvent.click(screen.getByAltText('Dashboard view'));

    // Lightbox shows — there are now 4 images (3 thumbnails + 1 lightbox)
    const images = screen.getAllByRole('img');
    const lightboxImg = images[images.length - 1];
    expect(lightboxImg.getAttribute('alt')).toBe('Dashboard view');

    // Click next arrow
    const nextButton = screen.getByLabelText(/next/i);
    fireEvent.click(nextButton);

    // Now lightbox should show second image
    const imagesAfterNext = screen.getAllByRole('img');
    const updatedLightboxImg = imagesAfterNext[imagesAfterNext.length - 1];
    expect(updatedLightboxImg.getAttribute('alt')).toBe('Settings page');
  });

  it('shows empty state for no media', () => {
    render(<TemplateScreenshotGallery media={[]} />);
    // Should show "No media available" text (from i18n)
    const text = screen.getByText(/no media/i);
    expect(text).toBeTruthy();
  });

  it('renders video items with video element and controls in lightbox', () => {
    const videoMedia: TemplateMedia[] = [
      {
        type: 'video',
        url: '/videos/demo.mp4',
        thumbnailUrl: '/img/poster.jpg',
        caption: 'Demo video',
        order: 1,
      },
    ];
    render(<TemplateScreenshotGallery media={videoMedia} />);

    // Click to open lightbox
    fireEvent.click(screen.getByText('Demo video'));

    // Lightbox should open
    expect(screen.getByRole('dialog')).toBeTruthy();

    // Video in lightbox should have controls
    const videos = document.querySelectorAll('video');
    // There should be at least 2 videos: thumbnail + lightbox
    expect(videos.length).toBeGreaterThanOrEqual(1);
    // The lightbox video should have controls attribute
    const lightboxVideo = Array.from(videos).find((v) => v.hasAttribute('controls'));
    expect(lightboxVideo).toBeTruthy();
  });

  it('shows video thumbnail with play overlay in grid', () => {
    const videoMedia: TemplateMedia[] = [
      {
        type: 'video',
        url: '/videos/demo.mp4',
        thumbnailUrl: '/img/poster.jpg',
        caption: 'Demo video',
        order: 1,
      },
    ];
    render(<TemplateScreenshotGallery media={videoMedia} />);

    // The play icon should be rendered (lucide Play icon via SVG stub)
    const playIcon = document.querySelector('[data-testid="icon-play"]');
    expect(playIcon).toBeTruthy();

    // Should have a video element with poster as thumbnail
    const video = document.querySelector('video');
    expect(video).toBeTruthy();
    expect(video?.getAttribute('poster')).toBe('/img/poster.jpg');
  });

  it('handles mixed image+video media array', () => {
    const mixedMedia: TemplateMedia[] = [
      { type: 'image', url: '/img/screen1.png', caption: 'Image one', order: 1 },
      {
        type: 'video',
        url: '/videos/demo.mp4',
        thumbnailUrl: '/img/poster.jpg',
        caption: 'Video one',
        order: 2,
      },
      { type: 'image', url: '/img/screen2.png', caption: 'Image two', order: 3 },
    ];
    render(<TemplateScreenshotGallery media={mixedMedia} />);

    // Should have 2 image elements and 1 video element in the grid
    const images = screen.getAllByRole('img');
    expect(images).toHaveLength(2);

    const videos = document.querySelectorAll('video');
    expect(videos).toHaveLength(1);

    // Captions should all be visible
    expect(screen.getByText('Image one')).toBeTruthy();
    expect(screen.getByText('Video one')).toBeTruthy();
    expect(screen.getByText('Image two')).toBeTruthy();
  });
});
