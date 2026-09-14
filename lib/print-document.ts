import type { TicketLine } from "@/lib/ticket";

/**
 * Tickets that are not orders.
 *
 * A print job normally renders from an `orders` row. This composes the other
 * kind: a small, self-contained set of ticket lines stored on the job itself
 * (migration 029) and drawn by the same renderer, so paper that is not food
 * does not need a second layout engine and cannot drift from the first.
 *
 * There is exactly one document today - a restaurant's tablet login, printed
 * on the Epson already in their kitchen. The point of printing it is that the
 * person who has to type the password is holding it: reading a password down
 * a phone line to a kitchen mid-service is how they end up written on the
 * wall, or typed wrong four times and then reset.
 */

/** The width the Epson path lays a ticket out at. Same source as the order path. */
export const DOCUMENT_COLS = Number(process.env.TICKET_COLS || 48);

const L = (text: string, opts: Partial<TicketLine> = {}): TicketLine => ({ text, ...opts });

function wrap(text: string, cols: number): string[] {
  const words = String(text ?? "").split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let line = "";
  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w;
    if (candidate.length > cols && line) {
      out.push(line);
      line = w;
    } else {
      line = candidate;
    }
  }
  if (line) out.push(line);
  return out.length ? out : [""];
}

function localTime(when: Date): string {
  return when.toLocaleString("en-US", {
    weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
    timeZone: process.env.TICKET_TIMEZONE || "America/Chicago",
  });
}

export interface LoginTicketInput {
  restaurantName: string;
  username: string;
  password: string;
  /** Where the tablet app lives, printed so nobody has to be told it. */
  appUrl: string;
  /** The CRM user who pressed the button. Printed, and audited separately. */
  actor: string | null;
  /** Whether to print the four setup steps as well as the credentials. */
  includeSetupSteps: boolean;
  /** True when this print also rotated the password. Changes one sentence. */
  rotated: boolean;
  /** Injectable so the test does not depend on what time it runs. */
  now?: Date;
  /** The support number a restaurant already has on their tickets. */
  supportPhone?: string;
}

/**
 * The four steps, in the order they must actually be done.
 *
 * "Enable notifications" is third and not optional: a tablet signed in but
 * never subscribed looks completely set up and receives nothing, which is the
 * single most expensive way this deployment fails.
 */
export const SETUP_STEPS = [
  "Open the Order Monitor app on the tablet",
  "Sign in with the username and password above",
  'Tap "Enable notifications" when it asks',
  "Leave the tablet plugged in and awake",
];

export const SUPPORT_PHONE = "(615) 619-5081";

/**
 * A restaurant's tablet login, as a ticket.
 *
 * The credentials are set in double height and left-aligned rather than
 * centred, because they are transcribed character by character and a centred
 * line gives the eye nothing to come back to. The password is NOT wrapped: a
 * password broken across two lines is a password typed wrong, so a long one
 * runs to the paper's edge and is printed at single width instead.
 */
export function buildLoginTicket(input: LoginTicketInput, cols = DOCUMENT_COLS): TicketLine[] {
  const rule = "-".repeat(cols);
  const heavy = "=".repeat(cols);
  const half = Math.floor(cols / 2);
  const lines: TicketLine[] = [];

  // Says what this is before anything else, in the same reverse-video band
  // the order ticket uses for its one most important fact. A slip of paper
  // in a kitchen with a password on it and no heading is a mystery.
  lines.push(L("  T A B L E T   L O G I N  ", {
    align: "center", size: "double-h", bold: true, reverse: true,
  }));
  lines.push(L(heavy));
  for (const l of wrap(input.restaurantName, cols)) lines.push(L(l, { align: "center", bold: true }));
  lines.push(L(rule));

  // The address first: somebody who cannot find the app has nothing to type
  // the credentials into.
  lines.push(L("App:"));
  for (const l of wrap(input.appUrl, cols)) lines.push(L(l, { bold: true }));
  lines.push(L(""));

  lines.push(L("Username:"));
  lines.push(L(input.username, {
    bold: true,
    size: input.username.length <= half ? "double" : "double-h",
  }));
  lines.push(L(""));
  lines.push(L("Password:"));
  lines.push(L(input.password, {
    bold: true,
    size: input.password.length <= half ? "double" : "double-h",
  }));
  lines.push(L(rule));

  if (input.includeSetupSteps) {
    SETUP_STEPS.forEach((step, i) => {
      const [first, ...rest] = wrap(step, cols - 3);
      lines.push(L(`${i + 1}. ${first}`));
      for (const extra of rest) lines.push(L(`   ${extra}`));
    });
    lines.push(L(rule));
  }

  if (input.rotated) {
    // Said on the paper, not only in the CRM: the person holding this is the
    // one who will be asked why the old password stopped working.
    for (const l of wrap(
      "This is a NEW password. The previous one stopped working when this printed.",
      cols
    )) {
      lines.push(L(l, { bold: true }));
    }
    lines.push(L(""));
  }

  for (const l of wrap(
    `Keep this ticket somewhere private - anyone holding it can sign in to ${input.restaurantName}'s orders.`,
    cols
  )) {
    lines.push(L(l));
  }
  lines.push(L(""));
  for (const l of wrap(
    `If it does not work, call Premium on ${input.supportPhone ?? SUPPORT_PHONE}.`,
    cols
  )) {
    lines.push(L(l));
  }

  lines.push(L(rule));
  const when = localTime(input.now ?? new Date());
  // Attribution on the paper as well as in the audit row. The audit answers
  // "who printed this" to us; this answers it to the restaurant.
  lines.push(L(`Sent by ${input.actor ?? "Premium"}`));
  lines.push(L(when));

  return lines;
}
