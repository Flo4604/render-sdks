// Pointer and wheel input on the stage: drag orbits, pinch and wheel zoom,
// double-click resets. Active only when the engine has a camera.

import { type RefObject, useEffect } from "react";

export interface GestureHandlers {
  orbit(yaw: number, pitch: number): void;
  zoom(factor: number): void;
  reset(): void;
}

// Degrees per CSS pixel of drag.
const dragScale = 0.4;

export function useStageGestures(
  stage: RefObject<HTMLElement | null>,
  handlers: GestureHandlers,
  enabled: boolean,
): void {
  useEffect(() => {
    const element = stage.current;

    if (element === null || !enabled) {
      return;
    }

    const pointers = new Map<number, { x: number; y: number }>();
    let pinch = 0;
    const distance = () => {
      const [a, b] = [...pointers.values()];

      return a === undefined || b === undefined ? 0 : Math.hypot(a.x - b.x, a.y - b.y);
    };

    const down = (event: PointerEvent) => {
      element.setPointerCapture(event.pointerId);
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      pinch = distance();
    };

    const move = (event: PointerEvent) => {
      const previous = pointers.get(event.pointerId);

      if (previous === undefined) {
        return;
      }

      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

      if (pointers.size === 1) {
        // Dragging right turns the item right, so the camera orbits left.
        handlers.orbit(
          -(event.clientX - previous.x) * dragScale,
          (event.clientY - previous.y) * dragScale,
        );

        return;
      }

      const next = distance();

      if (pinch > 0 && next > 0) {
        handlers.zoom(next / pinch);
      }

      pinch = next;
    };

    const up = (event: PointerEvent) => {
      pointers.delete(event.pointerId);
      pinch = distance();
    };

    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      handlers.zoom(Math.exp(-event.deltaY * 0.0015));
    };

    const doubleClick = () => handlers.reset();

    element.addEventListener("pointerdown", down);
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", up);
    element.addEventListener("pointercancel", up);
    element.addEventListener("wheel", wheel, { passive: false });
    element.addEventListener("dblclick", doubleClick);

    return () => {
      element.removeEventListener("pointerdown", down);
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", up);
      element.removeEventListener("pointercancel", up);
      element.removeEventListener("wheel", wheel);
      element.removeEventListener("dblclick", doubleClick);
    };
  }, [stage, handlers, enabled]);
}
