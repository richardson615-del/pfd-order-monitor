"use client";

import { useEffect } from "react";

/**
 * The tablet does not zoom (Matt, 2026-10-06: "it needs to be locked so it
 * doesn't zoom in and out").
 *
 * The viewport meta already says user-scalable=no, and that is not enough
 * on its own: Chrome on Android (which is what the TWA shell runs in)
 * ignores it when "Force enable zoom" is on under Accessibility, and some
 * Samsung builds ship with that on. A kitchen hand brushing the glass with
 * two fingers then blows the order list up to 300% and nobody knows how to
 * get it back.
 *
 * So the page refuses the gestures itself, belt and braces:
 *   - pinch: a touchmove with two or more fingers is cancelled (the CSS's
 *     `touch-action: pan-x pan-y` on <html> does the same where supported;
 *     this covers the browsers that ignore it)
 *   - Safari's gesturestart/gesturechange (an iPad left in a restaurant)
 *   - double-tap zoom: `touch-action: manipulation` in the CSS
 *   - ctrl/cmd + wheel and ctrl/cmd + plus/minus/zero, for a tablet with a
 *     keyboard case or the office testing on a laptop
 *
 * One-finger scrolling and every tap are untouched. Listeners are
 * non-passive only where cancelling needs it.
 */
export default function ZoomLock() {
  useEffect(() => {
    const multiTouch = (e: TouchEvent) => {
      if (e.touches.length > 1 && e.cancelable) e.preventDefault();
    };
    const gesture = (e: Event) => e.preventDefault();
    const wheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) e.preventDefault();
    };
    const keys = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && ["+", "-", "=", "0", "_"].includes(e.key)) e.preventDefault();
    };

    document.addEventListener("touchstart", multiTouch, { passive: false });
    document.addEventListener("touchmove", multiTouch, { passive: false });
    document.addEventListener("gesturestart", gesture, { passive: false } as AddEventListenerOptions);
    document.addEventListener("gesturechange", gesture, { passive: false } as AddEventListenerOptions);
    window.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("keydown", keys);
    return () => {
      document.removeEventListener("touchstart", multiTouch);
      document.removeEventListener("touchmove", multiTouch);
      document.removeEventListener("gesturestart", gesture);
      document.removeEventListener("gesturechange", gesture);
      window.removeEventListener("wheel", wheel);
      window.removeEventListener("keydown", keys);
    };
  }, []);
  return null;
}
