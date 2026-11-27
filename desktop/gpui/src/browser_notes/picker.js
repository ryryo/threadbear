// Adapted from PickTarget.ts and PickPreload.ts at T3 Code c2fcbd79523e.
// Copyright (c) 2026 T3 Tools Inc. MIT, docs/third-party/t3-code-MIT.txt.
((id, elementMode) => {
  // PickTarget.ts. Open shadow roots expose their own hit testing.
  function pickElementAtPoint(scope, x, y, isExcluded) {
    for (const candidate of scope.elementsFromPoint(x, y)) {
      if (!scope.contains(candidate) || isExcluded(candidate)) continue;
      const inner = candidate.shadowRoot && pickElementAtPoint(candidate.shadowRoot, x, y, isExcluded);
      return inner ?? candidate;
    }
    return null;
  }

  const normalizeRect = (startX, startY, endX, endY) => ({
    x: Math.min(startX, endX),
    y: Math.min(startY, endY),
    width: Math.abs(endX - startX),
    height: Math.abs(endY - startY),
  });
  const isUsableRect = rect => rect.width >= 3 && rect.height >= 3;

  function positionBox(node, rect) {
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      node.style.display = "none";
      return;
    }
    node.style.display = "block";
    node.style.transform = `translate(${rect.x}px, ${rect.y}px)`;
    node.style.width = `${rect.width}px`;
    node.style.height = `${rect.height}px`;
  }

  if (globalThis.threadbearPicker?.id > id) return false;
  globalThis.threadbearPicker?.stop();
  if (!document.documentElement) return false;

  // PickPreload.ts uses a manual popover and closed shadow root so the
  // outline lives over dialogs and is insulated from the site's styles.
  const host = document.createElement("div");
  host.popover = "manual";
  host.style.cssText = "position:fixed;inset:0;width:auto;height:auto;margin:0;border:0;padding:0;overflow:visible;background:transparent;pointer-events:none";
  const shadow = host.attachShadow({ mode: "closed" });
  const layer = document.createElement("div");
  // Catch pointer sequences above iframe surfaces, including cross-origin ones.
  layer.style.cssText = "position:fixed;inset:0;pointer-events:auto;cursor:crosshair;touch-action:none";
  const box = document.createElement("div");
  box.style.cssText = "position:fixed;top:0;left:0;pointer-events:none;border:2px solid #2563eb;background:#2563eb16;border-radius:3px;box-sizing:border-box;display:none";
  shadow.append(layer, box);

  let selected = null;
  let region = null;
  let regionViewport = null;
  let dragStart = null;
  let suspended = false;
  let finished = false;
  let frame = 0;
  let waiting = null;
  let pending = undefined;
  let lastAnchor = null;

  function publish(value) {
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(value);
    } else {
      pending = value;
    }
  }

  function next() {
    if (finished) return Promise.resolve(null);
    if (pending !== undefined) {
      const value = pending;
      pending = undefined;
      return Promise.resolve(value);
    }
    return new Promise(resolve => { waiting = resolve; });
  }

  function viewport() {
    const visual = window.visualViewport;
    const magnified = visual && visual.scale !== 1;
    return {
      x: visual?.offsetLeft ?? 0,
      y: visual?.offsetTop ?? 0,
      width: magnified ? visual.width : innerWidth,
      height: magnified ? visual.height : innerHeight,
      scrollX, scrollY, scale: visual?.scale ?? 1, devicePixelRatio,
    };
  }

  function sameViewport(a, b) {
    return Object.keys(a).every(key => a[key] === b[key]);
  }

  function clip(rect, view) {
    const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
    return normalizeRect(
      clamp(rect.x, view.x, view.x + view.width),
      clamp(rect.y, view.y, view.y + view.height),
      clamp(rect.x + rect.width, view.x, view.x + view.width),
      clamp(rect.y + rect.height, view.y, view.y + view.height),
    );
  }

  // PickPreload.ts clips the element to scrolling and clipping ancestors.
  function visibleElementRect(element, view) {
    const rect = element.getBoundingClientRect();
    let left = Math.max(view.x, rect.left);
    let top = Math.max(view.y, rect.top);
    let right = Math.min(view.x + view.width, rect.right);
    let bottom = Math.min(view.y + view.height, rect.bottom);
    if (getComputedStyle(element).position !== "fixed") {
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        if (ancestor === document.body || ancestor === document.documentElement) break;
        const style = getComputedStyle(ancestor);
        const bounds = ancestor.getBoundingClientRect();
        const clipLeft = bounds.left + ancestor.clientLeft;
        const clipTop = bounds.top + ancestor.clientTop;
        if (style.overflowX !== "visible") {
          left = Math.max(left, clipLeft);
          right = Math.min(right, clipLeft + ancestor.clientWidth);
        }
        if (style.overflowY !== "visible") {
          top = Math.max(top, clipTop);
          bottom = Math.min(bottom, clipTop + ancestor.clientHeight);
        }
      }
    }
    return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  }

  function targetRect(view) {
    if (selected?.isConnected) return visibleElementRect(selected, view);
    if (region && sameViewport(view, regionViewport)) return clip(region, view);
    return null;
  }

  function targetName() {
    return selected ? selected.localName : region ? "region" : null;
  }

  function stamp() {
    const view = viewport();
    const rect = targetRect(view);
    return rect && isUsableRect(rect) ? { view, rect, target: targetName() } : null;
  }

  // A clipped target in visual-viewport fractions lets the app place its
  // own editor without adopting the page's zoom, scroll or pixel scale.
  function editorAnchor(current) {
    if (!current) return null;
    const { view, rect } = current;
    return {
      x: (rect.x - view.x) / view.width,
      y: (rect.y - view.y) / view.height,
      w: rect.width / view.width,
      h: rect.height / view.height,
    };
  }

  function publishTarget(current, flags = {}) {
    const anchor = editorAnchor(current);
    lastAnchor = JSON.stringify(anchor);
    publish({ target: targetName(), anchor, ...flags });
  }

  function drawnFrame() {
    if (finished) return;
    if (!suspended && !dragStart && (selected || region)) {
      const current = stamp();
      positionBox(box, current?.rect);
      if (!current) {
        selected = region = regionViewport = null;
        publishTarget(null, { lost: true });
      } else if (JSON.stringify(editorAnchor(current)) !== lastAnchor) {
        // The next actual selection or error in the same frame wins.
        publishTarget(current, { moved: true });
      }
    }
    frame = requestAnimationFrame(drawnFrame);
  }

  function pickFromPoint(x, y) {
    return pickElementAtPoint(document, x, y, node =>
      node === host || node === document.documentElement || node === document.body);
  }

  function block(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function onPointerDown(event) {
    block(event);
    if (suspended || !event.isPrimary || event.button !== 0) return;
    layer.setPointerCapture(event.pointerId);
    dragStart = { x: event.clientX, y: event.clientY };
  }

  function onPointerMove(event) {
    if (suspended || !event.isPrimary) return;
    if (dragStart && !elementMode) {
      positionBox(box, clip(normalizeRect(dragStart.x, dragStart.y, event.clientX, event.clientY), viewport()));
    } else if (!dragStart && elementMode && !selected) {
      const target = pickFromPoint(event.clientX, event.clientY);
      positionBox(box, target && visibleElementRect(target, viewport()));
    }
  }

  function onPointerUp(event) {
    if (!dragStart || !event.isPrimary || event.button !== 0) return;
    block(event);
    const start = dragStart;
    dragStart = null;
    if (elementMode) {
      const candidate = pickFromPoint(event.clientX, event.clientY);
      if (!candidate || candidate.localName === "iframe") {
        publishTarget(stamp(), { frame: candidate?.localName === "iframe" });
        return;
      }
      selected = candidate;
    } else {
      const view = viewport();
      const candidate = clip(normalizeRect(start.x, start.y, event.clientX, event.clientY), view);
      if (!isUsableRect(candidate)) {
        positionBox(box, targetRect(view));
        publishTarget(stamp(), { small: true });
        return;
      }
      region = candidate;
      regionViewport = view;
    }
    positionBox(box, targetRect(viewport()));
    publishTarget(stamp());
  }

  function onPointerCancel() {
    dragStart = null;
    positionBox(box, targetRect(viewport()));
  }

  function onKeyDown(event) {
    if (event.key !== "Escape" || event.isComposing || suspended) return;
    block(event);
    stop();
  }

  function onWheel(event) {
    if (suspended || event.ctrlKey || event.metaKey || event.deltaMode !== 0) return;
    // The overlay catches wheel events too. Preserve scrolling in nested panes.
    for (let node = pickFromPoint(event.clientX, event.clientY); node; node = node.parentElement ?? node.getRootNode().host) {
      const style = getComputedStyle(node);
      const canScroll = (direction, offset, range, overflow) =>
        /auto|scroll/.test(overflow) && (direction < 0 ? offset > 0 : direction > 0 && offset < range);
      if (canScroll(event.deltaY, node.scrollTop, node.scrollHeight - node.clientHeight, style.overflowY) ||
          canScroll(event.deltaX, node.scrollLeft, node.scrollWidth - node.clientWidth, style.overflowX)) {
        block(event);
        node.scrollBy(event.deltaX, event.deltaY);
        return;
      }
    }
  }

  function raiseOverlay() {
    if (suspended || finished) return;
    const parent = document.activeElement?.closest("dialog:modal") ??
      Array.from(document.querySelectorAll("dialog:modal")).at(-1) ?? document.documentElement;
    if (host.parentElement !== parent) parent.appendChild(host);
    if (!host.matches(":popover-open")) host.showPopover();
  }

  function onPageToggle(event) {
    if (event.target !== host && !suspended) {
      if (host.matches(":popover-open")) host.hidePopover();
      raiseOverlay();
    }
  }

  const controller = new AbortController();
  const listen = { capture: true, passive: false, signal: controller.signal };
  layer.addEventListener("pointerdown", onPointerDown, listen);
  layer.addEventListener("pointermove", onPointerMove, listen);
  layer.addEventListener("pointerup", onPointerUp, listen);
  layer.addEventListener("pointercancel", onPointerCancel, listen);
  for (const name of ["mousedown", "mouseup", "click", "dblclick", "auxclick", "contextmenu", "dragstart"]) {
    layer.addEventListener(name, block, listen);
  }
  layer.addEventListener("wheel", onWheel, listen);
  window.addEventListener("keydown", onKeyDown, listen);
  document.addEventListener("toggle", onPageToggle, listen);
  const detachObserver = new MutationObserver(() => {
    if (!host.isConnected) raiseOverlay();
  });

  function stop() {
    if (finished) return;
    finished = true;
    controller.abort();
    detachObserver.disconnect();
    cancelAnimationFrame(frame);
    host.remove();
    publish(null);
  }

  async function prepare() {
    const before = stamp();
    if (!before) return null;
    suspended = true;
    box.style.visibility = "hidden";
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return before;
  }

  function resume() {
    suspended = false;
    box.style.visibility = "";
    raiseOverlay();
  }

  function switchMode(useElement) {
    elementMode = useElement;
    selected = region = regionViewport = dragStart = null;
    positionBox(box, null);
    publishTarget(null);
  }

  globalThis.threadbearPicker = { id, next, stop, stamp, prepare, resume, switchMode };
  detachObserver.observe(document.documentElement, { childList: true, subtree: true });
  raiseOverlay();
  frame = requestAnimationFrame(drawnFrame);
  return true;
})
