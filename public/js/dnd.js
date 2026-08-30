/**
 * Pointer Events によるドラッグ&ドロップ。
 * iPad(iOS Safari) は HTML5 の Drag and Drop API を実装していないため自前で扱う。
 *
 * ・長押し(250ms)でドラッグ開始 — それより前に動かした場合はブラウザのスクロールに任せる
 * ・ドラッグ中はゴーストを指に追従させ、elementFromPoint でドロップ先を判定する
 * ・動かさずに離した場合は「タップ」として扱う（タップで選択→タップで配置の代替操作用）
 */

const HOLD_MS = 250;
const MOVE_CANCEL_PX = 8;

/**
 * ドラッグ中はページのスクロールを止める。touch-action だけでは進行中のジェスチャを
 * 抑えられないため、非パッシブな touchmove で preventDefault する。
 */
let activeDragCount = 0;
document.addEventListener(
  'touchmove',
  (event) => {
    if (activeDragCount > 0) event.preventDefault();
  },
  { passive: false },
);

export function enableDrag(root, options) {
  const {
    itemSelector,
    dropSelector = '[data-drop]',
    getPayload,
    onDrop,
    onTap,
    onDragStart,
    onDragEnd,
  } = options;

  let pending = null; // { pointerId, item, startX, startY, timer }
  let drag = null; // { pointerId, item, payload, ghost, target }

  function clearPending() {
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.item.classList.remove('is-pressing');
    pending = null;
  }

  function beginDrag(x, y) {
    const { item } = pending;
    const payload = getPayload(item);
    clearPending();
    if (!payload) return;

    const rect = item.getBoundingClientRect();
    const ghost = item.cloneNode(true);
    ghost.classList.add('drag-ghost');
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    document.body.append(ghost);

    drag = {
      item,
      payload,
      ghost,
      offsetX: x - rect.left,
      offsetY: y - rect.top,
      target: null,
    };
    item.classList.add('is-dragging');
    document.body.classList.add('is-dragging-active');
    activeDragCount += 1;
    moveGhost(x, y);
    if (navigator.vibrate) navigator.vibrate(8);
    onDragStart?.(payload, item);
  }

  function moveGhost(x, y) {
    drag.ghost.style.transform = `translate(${x - drag.offsetX}px, ${y - drag.offsetY}px)`;
  }

  function updateTarget(x, y) {
    drag.ghost.style.visibility = 'hidden';
    const under = document.elementFromPoint(x, y);
    drag.ghost.style.visibility = '';
    const target = under?.closest(dropSelector) ?? null;
    if (target === drag.target) return;
    drag.target?.classList.remove('is-drop-target');
    drag.target = target;
    if (target && target.dataset.dropDisabled !== 'true') {
      target.classList.add('is-drop-target');
    }
  }

  function finishDrag(commit) {
    const { payload, item, ghost, target } = drag;
    ghost.remove();
    item.classList.remove('is-dragging');
    target?.classList.remove('is-drop-target');
    document.body.classList.remove('is-dragging-active');
    activeDragCount = Math.max(0, activeDragCount - 1);
    drag = null;
    onDragEnd?.(payload, item);
    if (commit && target && target.dataset.dropDisabled !== 'true') {
      onDrop(payload, target, item);
    }
  }

  root.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    if (drag || pending) return;
    const item = event.target.closest(itemSelector);
    if (!item || !root.contains(item)) return;

    const { clientX: startX, clientY: startY, pointerId } = event;
    item.classList.add('is-pressing');
    pending = {
      pointerId,
      item,
      startX,
      startY,
      moved: false,
      timer: setTimeout(() => {
        if (pending) beginDrag(startX, startY);
      }, HOLD_MS),
    };
    // ポインタを捕捉して、指がカードの外に出ても move/up を受け取り続ける。
    item.setPointerCapture?.(pointerId);
  });

  root.addEventListener('pointermove', (event) => {
    if (drag) {
      event.preventDefault();
      moveGhost(event.clientX, event.clientY);
      updateTarget(event.clientX, event.clientY);
      return;
    }
    if (!pending || pending.pointerId !== event.pointerId) return;
    const distance = Math.hypot(event.clientX - pending.startX, event.clientY - pending.startY);
    if (distance > MOVE_CANCEL_PX) {
      // スクロール操作とみなしてドラッグ開始を取り消す。
      pending.moved = true;
      clearPending();
    }
  });

  root.addEventListener('pointerup', (event) => {
    if (drag) {
      finishDrag(true);
      return;
    }
    if (!pending || pending.pointerId !== event.pointerId) return;
    const { item, moved } = pending;
    clearPending();
    if (!moved) onTap?.(item);
  });

  const cancel = () => {
    if (drag) finishDrag(false);
    clearPending();
  };
  root.addEventListener('pointercancel', cancel);
  root.addEventListener('lostpointercapture', () => {
    // 捕捉が外れた場合もドラッグを畳んで、ゴーストが残らないようにする。
    if (drag) finishDrag(false);
  });

  return { cancel };
}
