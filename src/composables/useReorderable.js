// Touch-friendly drag-to-reorder for vertical lists.
//
// Mobile HTML5 DnD doesn't work natively — Safari/Chrome on iOS don't
// fire dragstart from a touch. So we wire raw touch events:
//   1. touchstart → arm a 450 ms long-press timer
//   2. touchmove >10 px during timer → cancel (user is scrolling)
//   3. timer fires while finger still down → enter "drag mode" with
//      haptic + elevate the card visually (lifted state via CSS)
//   4. touchmove after that → translate the card, find the sibling
//      under the finger, show insert indicator (above/below)
//   5. touchend in drag mode → fire onReorder(draggedId, targetId,
//      above), snap card back, clear state
//
// Cards in the container must carry a data attribute matching
// `idAttr` (default 'data-reorder-id') so we know which logical id
// is being dragged + where to drop.

import { onBeforeUnmount, watch } from 'vue';

const LONG_PRESS_MS = 450;
const SCROLL_DRIFT = 10;

export function useReorderable(containerRef, onReorder, opts = {}) {
  const idAttr = opts.idAttr || 'data-reorder-id';

  let timer = null;
  let dragEl = null;             // the card being dragged
  let draggedId = null;
  let startY = 0;
  let startX = 0;
  let inDrag = false;
  let placeholderHeight = 0;     // for visual stability if needed

  function clearMarkers() {
    if (!containerRef.value) return;
    containerRef.value
      .querySelectorAll('.reorder-drop-above, .reorder-drop-below')
      .forEach((el) => el.classList.remove('reorder-drop-above', 'reorder-drop-below'));
  }

  function endDrag(commit) {
    if (!inDrag) return;
    inDrag = false;
    const lastTarget = containerRef.value?.querySelector(
      '.reorder-drop-above, .reorder-drop-below',
    );
    let dropAbove = false;
    let targetId = null;
    if (lastTarget) {
      dropAbove = lastTarget.classList.contains('reorder-drop-above');
      targetId = lastTarget.getAttribute(idAttr);
    }
    if (dragEl) {
      dragEl.classList.remove('is-reorder-dragging');
      dragEl.style.transform = '';
      dragEl.style.zIndex = '';
    }
    clearMarkers();
    if (commit && targetId && draggedId && targetId !== draggedId && onReorder) {
      onReorder(draggedId, targetId, dropAbove);
    }
    dragEl = null;
    draggedId = null;
    placeholderHeight = 0;
  }

  function onTouchStart(e) {
    if (!e.touches || e.touches.length !== 1) return;
    const card = e.target.closest(`[${idAttr}]`);
    if (!card || !containerRef.value?.contains(card)) return;
    const t = e.touches[0];
    startX = t.clientX;
    startY = t.clientY;
    dragEl = card;
    draggedId = card.getAttribute(idAttr);
    inDrag = false;

    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (!dragEl) return;
      inDrag = true;
      placeholderHeight = dragEl.getBoundingClientRect().height;
      dragEl.classList.add('is-reorder-dragging');
      dragEl.style.zIndex = '20';
      try { navigator.vibrate?.(8); } catch {}
    }, LONG_PRESS_MS);
  }

  function onTouchMove(e) {
    if (!dragEl) return;
    const t = e.touches[0];
    if (!t) return;
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;

    // Pre-drag phase: any movement >10 px cancels the long-press
    // (scroll intent wins).
    if (!inDrag) {
      if (Math.abs(dx) > SCROLL_DRIFT || Math.abs(dy) > SCROLL_DRIFT) {
        if (timer) { clearTimeout(timer); timer = null; }
        dragEl = null;
        draggedId = null;
      }
      return;
    }

    // In drag mode — translate the card with the finger + find the
    // sibling under the touch point to show the drop indicator.
    e.preventDefault();
    dragEl.style.transform = `translateY(${dy}px)`;

    // Pick the sibling under the touch. elementFromPoint is the
    // robust way (handles scrolling, sticky headers, etc.).
    const under = document.elementFromPoint(t.clientX, t.clientY);
    if (!under) return;
    const targetCard = under.closest(`[${idAttr}]`);
    if (!targetCard || targetCard === dragEl) {
      clearMarkers();
      return;
    }
    const rect = targetCard.getBoundingClientRect();
    const above = t.clientY < rect.top + rect.height / 2;
    clearMarkers();
    targetCard.classList.add(above ? 'reorder-drop-above' : 'reorder-drop-below');
  }

  function onTouchEnd() {
    if (timer) { clearTimeout(timer); timer = null; }
    endDrag(true);
  }

  function onTouchCancel() {
    if (timer) { clearTimeout(timer); timer = null; }
    endDrag(false);
  }

  function bind(el) {
    if (!el) return () => {};
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd);
    el.addEventListener('touchcancel', onTouchCancel, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchCancel);
    };
  }

  let unbind = null;
  watch(containerRef, (el) => {
    if (unbind) unbind();
    unbind = bind(el);
  }, { immediate: true, flush: 'post' });

  onBeforeUnmount(() => {
    if (unbind) unbind();
    if (timer) clearTimeout(timer);
  });
}
