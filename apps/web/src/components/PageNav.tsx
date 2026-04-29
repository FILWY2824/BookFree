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

  // Click handler installed on the OUTER container. We let the user
  // select text without interference (the .page-zone overlays now have
  // pointer-events:none), and check on click whether they actually
  // intended a page flip — i.e. they clicked, didn't drag, and there's
  // no live selection.
  useEffect(() => {
    if (!enabled || !interactiveZones) return;
    const el = containerRef.current;
    if (!el) return;

    let downX = 0;
    let downY = 0;
    let downAt = 0;

    const onDown = (e: MouseEvent) => {
      // Only left button.
      if (e.button !== 0) return;
      downX = e.clientX;
      downY = e.clientY;
      downAt = performance.now();
    };
    const onClick = (e: MouseEvent) => {
      // Skip if focus / target is inside an interactive control.
      const t = e.target as HTMLElement | null;
      if (!t) return;
      // If the click landed on the prev/next pill or any other
      // explicit button, let that handler win — don't double-flip.
      if (t.closest('button, a, input, textarea, select, [data-hl-id], .selection-toolbar, .note-editor')) {
        return;
      }
      // No drag (movement < 6px) and no live selection.
      const dx = Math.abs(e.clientX - downX);
      const dy = Math.abs(e.clientY - downY);
      if (dx > 6 || dy > 6) return;
      const dt = performance.now() - downAt;
      if (dt > 600) return;
      const sel = window.getSelection();
      if (sel && sel.toString().trim().length > 0) return;

      const rect = el.getBoundingClientRect();
      const xRel = e.clientX - rect.left;
      const w = rect.width;
      if (xRel < w / 3) {
        if (canPrev) onPrev();
      } else if (xRel > (w * 2) / 3) {
        if (canNext) onNext();
      }
      // Middle third: do nothing, leave for selection / context menu.
    };

    el.addEventListener('mousedown', onDown);
    el.addEventListener('click', onClick);
    return () => {
      el.removeEventListener('mousedown', onDown);
      el.removeEventListener('click', onClick);
    };
  }, [enabled, interactiveZones, onPrev, onNext, canPrev, canNext]);

  // Wheel handler — translate scroll to page flips. Each "gesture"
  // (a contiguous burst of wheel events with no >250 ms gap) flips
  // exactly one page, no matter how much delta the user accumulates
  // during it. This stops trackpad inertia or a long mouse-wheel
  // spin from skipping multiple pages at once, which the previous
  // implementation (cooldown + accumulator) allowed to leak through.
  useEffect(() => {
    if (!enabled || !interactiveZones) return;
    const el = containerRef.current;
    if (!el) return;
    return attachWheelPager(el, {
      onPrev,
      onNext,
      canPrev: () => canPrev,
      canNext: () => canNext,
      // In the parent surface, defer to the nearest scrollable child
      // so wheel-on-a-pre-block scrolls the block, not the page.
      respectScrollables: true,
    });
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
          {/* Visual hint zones — kept as decorative overlays only.
              Pointer-events disabled in CSS so text selection works
              everywhere; the parent click handler decides flips. */}
          <div className="page-zone page-zone-left" aria-hidden="true" />
          <div className="page-zone page-zone-right" aria-hidden="true" />
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

// ─────────────────────────────────────────────────────────────────
// attachWheelPager — exported so non-React surfaces (notably the
// epub.js iframe) can install the same single-gesture wheel→flip
// behaviour. Returns a teardown function.
//
// Why this lives here:
//   The user complaint was that wheel-flipping only worked when the
//   cursor was over the parent-level click zones. For TXT that's a
//   misperception (events bubble up through normal DOM), but for
//   EPUB it's literally true — content is in a sandboxed iframe and
//   wheel events never escape it. The fix is to install a copy of
//   this same handler inside each rendered iframe document, which
//   is exactly what EpubReader does on epub.js's 'rendered' event.
// ─────────────────────────────────────────────────────────────────
export interface WheelPagerOpts {
  onPrev: () => void;
  onNext: () => void;
  /** Read at event time so updates to canPrev / canNext are seen. */
  canPrev: () => boolean;
  canNext: () => boolean;
  /** When true, wheel events whose target is inside a scrollable
   *  ancestor that can still scroll in the gesture's direction are
   *  passed through. Iframes don't need this (they have no nested
   *  scrollables that matter for the reading surface). */
  respectScrollables?: boolean;
}

export function attachWheelPager(
  target: HTMLElement | Document,
  opts: WheelPagerOpts,
): () => void {
  const QUIET_MS = 250;
  const STEP = 60;
  let accum = 0;
  let lastWheel = 0;
  let inFlight = false;

  const onWheel = (e: WheelEvent) => {
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;

    if (opts.respectScrollables) {
      const t = e.target as HTMLElement | null;
      const boundary = (target instanceof Document ? target.documentElement : target) as HTMLElement;
      const scrollable = t && nearestScrollable(t, boundary);
      if (scrollable) {
        const canScrollMore =
          (e.deltaY < 0 && scrollable.scrollTop > 0) ||
          (e.deltaY > 0 && scrollable.scrollTop + scrollable.clientHeight < scrollable.scrollHeight - 1);
        if (canScrollMore) return;
      }
    }

    e.preventDefault();
    const now = performance.now();
    if (now - lastWheel > QUIET_MS) {
      accum = 0;
      inFlight = false;
    }
    lastWheel = now;
    if (inFlight) return;

    accum += e.deltaY;
    if (accum >= STEP) {
      if (opts.canNext()) opts.onNext();
      accum = 0;
      inFlight = true;
    } else if (accum <= -STEP) {
      if (opts.canPrev()) opts.onPrev();
      accum = 0;
      inFlight = true;
    }
  };

  // `as EventListener` cast keeps TS happy across HTMLElement | Document.
  target.addEventListener('wheel', onWheel as EventListener, { passive: false });
  return () => target.removeEventListener('wheel', onWheel as EventListener);
}
