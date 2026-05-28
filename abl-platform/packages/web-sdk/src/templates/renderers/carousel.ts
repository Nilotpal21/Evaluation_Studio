/**
 * Carousel Template Renderer
 *
 * Renders a carousel of cards with images, titles, subtitles, and buttons.
 * Migrated from rich-renderer.ts to the pluggable template system.
 */

import React from 'react';
import type { Message, Carousel, CarouselCard, ActionElement } from '../../core/types.js';
import type { TemplateRenderer, TemplateContext } from '../types.js';
import { defaultRegistry } from '../registry.js';
import { isSafeUrl } from '../utils/safe-url.js';
import { getString } from '../utils/strings.js';

// ---------------------------------------------------------------------------
// React renderer — uses a named function component for scroll ref
// ---------------------------------------------------------------------------

function CarouselTemplate(props: { data: Carousel; ctx: TemplateContext }): React.ReactElement {
  const { data, ctx } = props;
  const trackRef = React.useRef<HTMLDivElement>(null);

  const scrollBy = (offset: number) => {
    trackRef.current?.scrollBy({ left: offset, behavior: 'smooth' });
  };

  const cards = data.cards.map((card, i) =>
    React.createElement(
      'div',
      {
        key: `card-${i}`,
        className: 'rich-carousel-card',
        role: 'group',
        'aria-label': card.title,
        ...(card.default_action_url && isSafeUrl(card.default_action_url)
          ? {
              style: { cursor: 'pointer' },
              onClick: (e: React.MouseEvent) => {
                if ((e.target as HTMLElement).closest('.rich-btn')) return;
                window.open(card.default_action_url, '_blank', 'noopener');
              },
            }
          : {}),
      },
      // Image
      card.image_url && isSafeUrl(card.image_url, { allowDataImages: true })
        ? React.createElement('img', {
            className: 'rich-carousel-image',
            src: card.image_url,
            alt: card.title,
            loading: 'lazy',
          })
        : null,
      // Body
      React.createElement(
        'div',
        { className: 'rich-carousel-body' },
        React.createElement('div', { className: 'rich-carousel-title' }, card.title),
        card.subtitle
          ? React.createElement('div', { className: 'rich-carousel-subtitle' }, card.subtitle)
          : null,
        card.buttons && card.buttons.length > 0
          ? React.createElement(
              'div',
              { className: 'rich-button-group' },
              ...card.buttons.map((btn: ActionElement) =>
                React.createElement(
                  'button',
                  {
                    key: btn.id,
                    className: 'rich-btn',
                    onClick: () => {
                      ctx.onAction(
                        btn.id,
                        btn.value ?? btn.id,
                        ctx.actionRenderId ? { renderId: ctx.actionRenderId } : undefined,
                      );
                    },
                  },
                  btn.label,
                ),
              ),
            )
          : null,
      ),
    ),
  );

  const children: React.ReactElement[] = [
    React.createElement(
      'div',
      { key: 'track', className: 'rich-carousel-track', ref: trackRef },
      ...cards,
    ),
  ];

  if (data.cards.length > 1) {
    children.push(
      React.createElement(
        'button',
        {
          key: 'nav-left',
          className: 'rich-carousel-nav rich-carousel-nav-left',
          'aria-label': getString('carousel.previous'),
          onClick: () => scrollBy(-220),
        },
        '\u2039',
      ),
      React.createElement(
        'button',
        {
          key: 'nav-right',
          className: 'rich-carousel-nav rich-carousel-nav-right',
          'aria-label': getString('carousel.next'),
          onClick: () => scrollBy(220),
        },
        '\u203A',
      ),
    );
  }

  return React.createElement(
    'div',
    { className: 'rich-carousel', role: 'region', 'aria-label': getString('carousel.label') },
    ...children,
  );
}

// ---------------------------------------------------------------------------
// DOM renderer — mirrors rich-renderer.ts renderCarousel()
// ---------------------------------------------------------------------------

function renderCarouselDOM(data: Carousel, ctx: TemplateContext): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'rich-carousel';
  wrapper.setAttribute('role', 'region');
  wrapper.setAttribute('aria-label', getString('carousel.label'));

  const track = document.createElement('div');
  track.className = 'rich-carousel-track';

  for (const card of data.cards) {
    const cardEl = document.createElement('div');
    cardEl.className = 'rich-carousel-card';
    cardEl.setAttribute('role', 'group');
    cardEl.setAttribute('aria-label', card.title);

    if (card.image_url && isSafeUrl(card.image_url, { allowDataImages: true })) {
      const img = document.createElement('img');
      img.className = 'rich-carousel-image';
      img.src = card.image_url;
      img.alt = card.title;
      img.loading = 'lazy';
      cardEl.appendChild(img);
    }

    const body = document.createElement('div');
    body.className = 'rich-carousel-body';

    const title = document.createElement('div');
    title.className = 'rich-carousel-title';
    title.textContent = card.title;
    body.appendChild(title);

    if (card.subtitle) {
      const subtitle = document.createElement('div');
      subtitle.className = 'rich-carousel-subtitle';
      subtitle.textContent = card.subtitle;
      body.appendChild(subtitle);
    }

    if (card.buttons && card.buttons.length > 0) {
      const btnGroup = document.createElement('div');
      btnGroup.className = 'rich-button-group';
      for (const btn of card.buttons) {
        btnGroup.appendChild(createCardButton(btn, ctx));
      }
      body.appendChild(btnGroup);
    }

    cardEl.appendChild(body);

    if (card.default_action_url && isSafeUrl(card.default_action_url)) {
      cardEl.style.cursor = 'pointer';
      cardEl.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.rich-btn')) return;
        window.open(card.default_action_url, '_blank', 'noopener');
      });
    }

    track.appendChild(cardEl);
  }

  wrapper.appendChild(track);

  if (data.cards.length > 1) {
    const leftBtn = document.createElement('button');
    leftBtn.className = 'rich-carousel-nav rich-carousel-nav-left';
    leftBtn.innerHTML = '&#8249;';
    leftBtn.setAttribute('aria-label', getString('carousel.previous'));
    leftBtn.addEventListener('click', () => {
      track.scrollBy({ left: -220, behavior: 'smooth' });
    });

    const rightBtn = document.createElement('button');
    rightBtn.className = 'rich-carousel-nav rich-carousel-nav-right';
    rightBtn.innerHTML = '&#8250;';
    rightBtn.setAttribute('aria-label', getString('carousel.next'));
    rightBtn.addEventListener('click', () => {
      track.scrollBy({ left: 220, behavior: 'smooth' });
    });

    wrapper.appendChild(leftBtn);
    wrapper.appendChild(rightBtn);
  }

  return wrapper;
}

function createCardButton(el: ActionElement, ctx: TemplateContext): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'rich-btn';
  btn.textContent = el.label;
  btn.addEventListener('click', () => {
    ctx.onAction(
      el.id,
      el.value ?? el.id,
      ctx.actionRenderId ? { renderId: ctx.actionRenderId } : undefined,
    );
    btn.disabled = true;
    btn.classList.add('rich-btn-clicked');
  });
  return btn;
}

// ---------------------------------------------------------------------------
// Renderer registration
// ---------------------------------------------------------------------------

const carouselRenderer: TemplateRenderer<Carousel> = {
  type: 'carousel',

  extract(message: Message): Carousel | undefined {
    const carousel = message.richContent?.carousel;
    if (carousel && carousel.cards.length > 0) {
      return carousel;
    }
    return undefined;
  },

  render(data: Carousel, ctx: TemplateContext): React.ReactElement {
    return React.createElement(CarouselTemplate, { data, ctx });
  },

  renderDOM(data: Carousel, ctx: TemplateContext): HTMLElement {
    return renderCarouselDOM(data, ctx);
  },
};

defaultRegistry.register(carouselRenderer);

export { carouselRenderer };
