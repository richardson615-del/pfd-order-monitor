"use client";

import { useEffect, useState } from "react";

/**
 * A clock that ticks once a second, for the timer on a ticket.
 *
 * The dashboard has its own (it drives every card at once); the ticket
 * page is one order and needs one clock. Every second, not ten: a timer
 * that jumps ten seconds at a time reads as broken rather than live.
 */
export function useTicking(everyMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}
