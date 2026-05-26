// Touch-gesture helpers — wires raw touchstart/move/end listeners on
// an element ref and surfaces them as named callbacks. Kept small and
// dependency-free; iOS Safari is finicky about PointerEvents for
// some of these (especially long-press in standalone PWA mode), so
// we stick to the lowest common denominator: TouchEvent.
//
// All thresholds are tuned for one-finger phone use:
//   - Swipe must be ≥48 px in the dominant axis, ≤24 px in the
//     other, and finish in under 500 ms. Matches Apple Music /
//     Spotify "feels right" cutoffs.
//   - Long-press fires at 450 ms, cancelled by either a touchend
//     before the timer or a touchmove that drifts ≥10 px (avoids
//     firing during a scroll).

import { onBeforeUnmount, onMounted } from 'vue';

const SWIPE_MIN = 48;
const SWIPE_OFF_AXIS_MAX = 36;
const SWIPE_MAX_DURATION = 500;
const LONG_PRESS_MS = 450;
const LONG_PRESS_DRIFT = 10;

/**
 * @param {Ref<HTMLElement>} elRef
 * @param {{
 *   onSwipeLeft?: () => void,
 *   onSwipeRight?: () => void,
 *   onSwipeUp?: () => void,
 *   onSwipeDown?: () => void,
 *   onLongPress?: (e: TouchEvent) => void,
 * }} handlers
 */
export function useGestures(elRef, handlers = {}) {
  let startX = 0;
  let startY = 0;
  let startT = 0;
  let longPressTimer = null;
  let longPressFired = false;

  function clearLongPress() {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }

  function onTouchStart(e) {
    if (!e.touches || e.touches.length !== 1) return;
    const t = e.touches[0];
    startX = t.clientX;
    startY = t.clientY;
    startT = Date.now();
    longPressFired = false;
    if (handlers.onLongPress) {
      clearLongPress();
      longPressTimer = setTimeout(() => {
        longPressTimer = null;
        longPressFired = true;
        handlers.onLongPress(e);
      }, LONG_PRESS_MS);
    }
  }

  function onTouchMove(e) {
    if (!longPressTimer) return;
    const t = e.touches[0];
    if (!t) return;
    if (Math.abs(t.clientX - startX) > LONG_PRESS_DRIFT
      || Math.abs(t.clientY - startY) > LONG_PRESS_DRIFT) {
      clearLongPress(); // user is scrolling or swiping, not pressing
    }
  }

  function onTouchEnd(e) {
    clearLongPress();
    if (longPressFired) {
      // Suppress the synthetic click that follows a long-press so
      // the row's normal tap handler doesn't also fire.
      e.preventDefault();
      return;
    }
    const t = (e.changedTouches && e.changedTouches[0]) || null;
    if (!t) return;
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    const dt = Date.now() - startT;
    if (dt > SWIPE_MAX_DURATION) return;
    const absX = Math.abs(dx);
    const absY = Math.abs(dy);
    if (absX > absY) {
      // Horizontal swipe
      if (absX < SWIPE_MIN || absY > SWIPE_OFF_AXIS_MAX) return;
      if (dx < 0 && handlers.onSwipeLeft) handlers.onSwipeLeft();
      else if (dx > 0 && handlers.onSwipeRight) handlers.onSwipeRight();
    } else {
      // Vertical swipe
      if (absY < SWIPE_MIN || absX > SWIPE_OFF_AXIS_MAX) return;
      if (dy < 0 && handlers.onSwipeUp) handlers.onSwipeUp();
      else if (dy > 0 && handlers.onSwipeDown) handlers.onSwipeDown();
    }
  }

  function onTouchCancel() {
    clearLongPress();
  }

  onMounted(() => {
    const el = elRef.value;
    if (!el) return;
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    el.addEventListener('touchend', onTouchEnd);
    el.addEventListener('touchcancel', onTouchCancel, { passive: true });
  });

  onBeforeUnmount(() => {
    const el = elRef.value;
    if (!el) return;
    el.removeEventListener('touchstart', onTouchStart);
    el.removeEventListener('touchmove', onTouchMove);
    el.removeEventListener('touchend', onTouchEnd);
    el.removeEventListener('touchcancel', onTouchCancel);
    clearLongPress();
  });
}
