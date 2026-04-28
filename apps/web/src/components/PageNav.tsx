// PageNav renders the four navigation affordances every paginated
// reader needs: a wide left click-zone (33% of the viewport), a wide
// right click-zone (33% of the viewport), and two pill-shaped
// buttons floating on the inner edges. It also installs a wheel
// listener that translates vertical mouse-wheel ticks into page flips.
//
// Why all of these in one component?
//   • They share state ("can we go forward?", "can we go back?") and
//     responding to the same prev / next callbacks.
//   • Wheel-debouncing has a single source of truth — without it, a
//     trackpad spits out twenty events per scroll and we'd flip
//     twenty pages.
//
// The component wraps around children. The reader passes its content
// as children, and PageNav becomes the relative-positioned container.
// This way the click zones and floating buttons are siblings of the
// content inside one absolute-positioning context.
//
// Disabled state is a soft display (opacity drops to ~12 %, cursor
// becomes not-allowed) — we never strip the button from the DOM, so
// keyboard focus order stays predictable.

import { useEffect, useRef } from 'react';

interface Props {
  onPrev: () => void;
  onNext: () => void;
  canPrev?: boolean;
  canNext?: boolean;
  /** When false, suppress every nav affordance — used for scroll-mode. */
  enabled?: boolean;
  /** When false, only the buttons are exposed — wheel + zones are silent. */
  interactiveZones?: boolean;
  className?: string;
  children: React.ReactNode;
}

export default function PageNav({
  onPrev, onNext,
  canPrev = true, canNext = true,
  enabled = true,
  interactiveZones = true,
  className,
  children,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Wheel handler — translate scroll to page flips. We accumulate
  // delta until we cross a threshold, then commit one page and
  // briefly mute further input so a single trackpad gesture turns
  // a single page.
  useEffect(() => {
    if (!enabled || !interactiveZones) return;
    const el = containerRef.current;
    if (!el) return;

    let accum = 0;
    let lastFlip = 0;
    const COOLDOWN_MS = 320;
    const STEP = 60;

    const onWheel = (e: WheelEvent) => {
      // Ignore horizontal scroll — usually the user is scrubbing
      // a code block or a horizontally-overflowing image.
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      // pdf.js, scroll-mode TxtReader etc. need real scrolling for
      // their own UX. We only intercept inside paginated readers,
      // and they pass `interactiveZones=true`. The host reader is
      // already gated on its own pageMode prop; if the host doesn't
      // want our wheel behaviour it sets interactiveZones=false.

      // If the target is a scrollable element that *can* still scroll
      // in the gesture's direction, leave it alone — the user is
      // probably trying to read a long pre/code block.
      const target = e.target as HTMLElement | null;
      const scrollable = target && nearestScrollable(target, el);
      if (scrollable) {
        const canScrollMore =
          (e.deltaY < 0 && scrollable.scrollTop > 0) ||
          (e.deltaY > 0 && scrollable.scrollTop + scrollable.clientHeight < scrollable.scrollHeight - 1);
        if (canScrollMore) return;
      }

      e.preventDefault();
      accum += e.deltaY;
      const now = performance.now();
      if (now - lastFlip < COOLDOWN_MS) return;
      if (accum >= STEP) {
        accum = 0;
        lastFlip = now;
        if (canNext) onNext();
      } else if (accum <= -STEP) {
        accum = 0;
        lastFlip = now;
        if (canPrev) onPrev();
      }
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [enabled, interactiveZones, onPrev, onNext, canPrev, canNext]);

  // Keyboard arrows — page-up / page-down / left / right.
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      // Skip if focus is inside an input/textarea/contenteditable.
      const t = e.target as HTMLElement | null;
      if (t && (t.matches('input, textarea, select, [contenteditable=""], [contenteditable="true"]'))) {
        return;
      }
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        if (canPrev) { e.preventDefault(); onPrev(); }
      } else if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
        if (canNext) { e.preventDefault(); onNext(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, onPrev, onNext, canPrev, canNext]);

  return (
    <div
      ref={containerRef}
      className={'relative h-full w-full ' + (className ?? '')}
    >
      {children}

      {enabled && interactiveZones && (
        <>
          <button
            type="button"
            className="page-zone page-zone-left"
            aria-label="上一页（点击左侧）"
            tabIndex={-1}
            onClick={() => canPrev && onPrev()}
          />
          <button
            type="button"
            className="page-zone page-zone-right"
            aria-label="下一页（点击右侧）"
            tabIndex={-1}
            onClick={() => canNext && onNext()}
          />
        </>
      )}

      {enabled && (
        <>
          <button
            type="button"
            className="page-nav-btn page-nav-btn-left"
            onClick={onPrev}
            disabled={!canPrev}
            aria-label="上一页"
            title="上一页"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <button
            type="button"
            className="page-nav-btn page-nav-btn-right"
            onClick={onNext}
            disabled={!canNext}
            aria-label="下一页"
            title="下一页"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        </>
      )}
    </div>
  );
}

// Walk up from `from` toward (but not past) `boundary`, returning the
// first ancestor whose CSS makes it scrollable on the Y axis. Used
// so wheel events inside e.g. a <pre> code block keep scrolling that
// element instead of flipping the whole page.
function nearestScrollable(from: HTMLElement, boundary: HTMLElement): HTMLElement | null {
  let el: HTMLElement | null = from;
  while (el && el !== boundary) {
    const cs = getComputedStyle(el);
    const overflowY = cs.overflowY;
    if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 1) {
      return el;
    }
    el = el.parentElement;
  }
  return null;
}
