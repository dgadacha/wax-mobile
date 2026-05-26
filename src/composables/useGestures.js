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

import { onBeforeUnmount, watch } from 'vue';

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
 *   // Live progress callbacks for finger-tracking animations.
 *   // `dx`/`dy` are signed deltas from the start of the touch.
 *   // `axis` is set to 'x' or 'y' once the gesture commits to a
 *   //   direction (when the move clearly favors one axis over the
 *   //   other), so the consumer knows which transform to apply.
 *   //   It stays null until the gesture leaves the dead-zone.
 *   onProgress?: ({ dx: number, dy: number, axis: 'x'|'y'|null }) => void,
 *   onEnd?: ({ committed: boolean, direction: 'left'|'right'|'up'|'down'|null }) => void,
 * }} handlers
 */
export function useGestures(elRef, handlers = {}) {
  let startX = 0;
  let startY = 0;
  let startT = 0;
  let axis = null;
  let lastDx = 0;
  let lastDy = 0;
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
    axis = null;
    lastDx = 0;
    lastDy = 0;
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
    const t = e.touches[0];
    if (!t) return;
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    lastDx = dx;
    lastDy = dy;
    if (longPressTimer) {
      if (Math.abs(dx) > LONG_PRESS_DRIFT || Math.abs(dy) > LONG_PRESS_DRIFT) {
        clearLongPress(); // user is scrolling or swiping, not pressing
      }
    }
    // Commit to an axis once the move clearly favors one side. Helps
    // the consumer (e.g. cover swipe) know whether to translateX or
    // translateY, and prevents diagonal jitter from animating both
    // axes simultaneously.
    if (!axis) {
      const absX = Math.abs(dx);
      const absY = Math.abs(dy);
      if (absX > 10 && absX > absY * 1.5) axis = 'x';
      else if (absY > 10 && absY > absX * 1.5) axis = 'y';
    }
    if (handlers.onProgress) handlers.onProgress({ dx, dy, axis });
  }

  function emitEnd(committed, direction) {
    if (handlers.onEnd) handlers.onEnd({ committed, direction });
  }

  function onTouchEnd(e) {
    clearLongPress();
    if (longPressFired) {
      // Suppress the synthetic click that follows a long-press so
      // the row's normal tap handler doesn't also fire.
      e.preventDefault();
      emitEnd(false, null);
      return;
    }
    const t = (e.changedTouches && e.changedTouches[0]) || null;
    if (!t) { emitEnd(false, null); return; }
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    const dt = Date.now() - startT;
    if (dt > SWIPE_MAX_DURATION) { emitEnd(false, null); return; }
    const absX = Math.abs(dx);
    const absY = Math.abs(dy);
    if (absX > absY) {
      if (absX < SWIPE_MIN || absY > SWIPE_OFF_AXIS_MAX) {
        emitEnd(false, null); return;
      }
      const dir = dx < 0 ? 'left' : 'right';
      if (dir === 'left' && handlers.onSwipeLeft) handlers.onSwipeLeft();
      else if (dir === 'right' && handlers.onSwipeRight) handlers.onSwipeRight();
      emitEnd(true, dir);
    } else {
      if (absY < SWIPE_MIN || absX > SWIPE_OFF_AXIS_MAX) {
        emitEnd(false, null); return;
      }
      const dir = dy < 0 ? 'up' : 'down';
      if (dir === 'up' && handlers.onSwipeUp) handlers.onSwipeUp();
      else if (dir === 'down' && handlers.onSwipeDown) handlers.onSwipeDown();
      emitEnd(true, dir);
    }
  }

  function onTouchCancel() {
    clearLongPress();
    emitEnd(false, null);
  }

  // Watch the ref so we bind whenever the element appears or
  // changes — critical for v-if'd content like Vant's <van-popup>
  // which lazy-renders its body. A bare onMounted wouldn't catch
  // the moment the popup actually opens.
  let bound = null;
  function bind(el) {
    if (bound === el) return;
    if (bound) unbind(bound);
    bound = el;
    if (!el) return;
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    el.addEventListener('touchend', onTouchEnd);
    el.addEventListener('touchcancel', onTouchCancel, { passive: true });
  }
  function unbind(el) {
    el.removeEventListener('touchstart', onTouchStart);
    el.removeEventListener('touchmove', onTouchMove);
    el.removeEventListener('touchend', onTouchEnd);
    el.removeEventListener('touchcancel', onTouchCancel);
  }

  watch(elRef, (el) => bind(el), { immediate: true, flush: 'post' });

  onBeforeUnmount(() => {
    if (bound) unbind(bound);
    bound = null;
    clearLongPress();
  });
}
