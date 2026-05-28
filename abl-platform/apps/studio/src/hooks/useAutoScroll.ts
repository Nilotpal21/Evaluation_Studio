'use client';

import { useRef, useState, useCallback, useEffect } from 'react';

const DEFAULT_THRESHOLD = 300;

interface UseAutoScrollOptions {
  enabled?: boolean;
  nearBottomThreshold?: number;
}

interface UseAutoScrollReturn {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  showScrollButton: boolean;
  scrollToBottom: (behavior?: 'smooth' | 'instant') => void;
  onUserSent: () => void;
}

/**
 * Unified scroll management for chat surfaces.
 *
 * Uses `messageCount` (not the messages array) for new-message detection
 * and a ResizeObserver on the scroll container's content for streaming
 * content-growth pinning. This avoids putting the full `messages` object
 * in any useEffect dependency array.
 *
 * Streaming content growth uses RAF-throttled smooth scrolling to avoid
 * janky jumps when text is appended token-by-token.
 */
export function useAutoScroll(
  messageCount: number,
  chatState: string,
  options?: UseAutoScrollOptions,
): UseAutoScrollReturn {
  const { enabled = true, nearBottomThreshold = DEFAULT_THRESHOLD } = options ?? {};

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const isFollowingRef = useRef(true);
  const prevMessageCountRef = useRef(messageCount);
  const prevContentHeightRef = useRef(0);
  const rafRef = useRef(0);
  const [showScrollButton, setShowScrollButton] = useState(false);

  const doScroll = useCallback((behavior: 'smooth' | 'instant') => {
    const el = scrollRef.current;
    if (!el) return;
    if (behavior === 'smooth') {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }, []);

  const scrollToBottom = useCallback(
    (behavior: 'smooth' | 'instant' = 'smooth') => {
      isFollowingRef.current = true;
      setShowScrollButton(false);
      doScroll(behavior);
    },
    [doScroll],
  );

  const onUserSent = useCallback(() => {
    isFollowingRef.current = true;
    setShowScrollButton(false);
  }, []);

  // Track scroll position to determine if user is "following" the conversation
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !enabled) return;

    const handleScroll = () => {
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      const following = distFromBottom <= nearBottomThreshold;
      isFollowingRef.current = following;
      setShowScrollButton(!following && messageCount > 0);
    };

    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, [enabled, nearBottomThreshold, messageCount]);

  // New-message detection: smooth scroll when messageCount increases
  useEffect(() => {
    if (!enabled) return;
    const prev = prevMessageCountRef.current;
    prevMessageCountRef.current = messageCount;

    if (messageCount > prev && isFollowingRef.current) {
      doScroll('smooth');
    }
  }, [messageCount, enabled, doScroll]);

  // Content-growth pinning via ResizeObserver on the scroll container's
  // content. Handles streaming text, ThinkingPanel expand, image loads,
  // BuildProgressCard growth — all without `messages` in deps.
  //
  // Uses RAF throttling so we scroll at most once per frame, and smooth
  // scrolling so token-by-token growth doesn't cause janky jumps.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !enabled) return;

    const contentEl = el.firstElementChild as HTMLElement | null;
    const target = contentEl ?? el;

    if (typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(() => {
      const currentHeight = target.scrollHeight;
      const grew = currentHeight > prevContentHeightRef.current;
      prevContentHeightRef.current = currentHeight;

      if (grew && isFollowingRef.current) {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = 0;
          el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
        });
      }
    });

    prevContentHeightRef.current = target.scrollHeight;
    observer.observe(target);
    return () => {
      observer.disconnect();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [enabled, chatState]);

  return { scrollRef, showScrollButton, scrollToBottom, onUserSent };
}
