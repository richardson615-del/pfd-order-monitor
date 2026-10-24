/**
 * The restaurant's weekly statements on its tablet (migration 051; prs-crm
 * brief 2026-10-24 "run everything from the CRM", partner portal A1).
 *
 * The CRM pushes a summary of each closed week's statement; the Money tab
 * shows them. Pure: this decides what a push may contain and how a row
 * reads on the page. The routes read and write.
 *
 * Nothing here computes money. `amount_due_cents` is the CRM's frozen
 * `netPayable`, copied. A field the CRM did not send is shown as missing,
 * never as $0.
 */

export const PAYMENT_STATUSES = ["paid", "pending", "held", "failed", "skipped", "none"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** Weeks in one push. The CRM sends a restaurant's recent history, not all time. */
export const MAX_STATEMENTS_PER_PUSH = 60;

export interface StatementPush {
  period_start: string;
  period_end: string;
  statement_no: string;
  payment_status: PaymentStatus;
  paid_at: string | null;
  payment_date: string | null;
  payment_ref: string | null;
  order_count: number;
  amount_due_cents: number;
  view_url: string | null;
  pdf_url: string | null;
  generated_at: string | null;
  /** The restaurant-facing summary lines the CRM chose to send, as sent. */
  payload: Record<string, unknown>;
}

export type StatementsPushDecision = { ok: true; statements: StatementPush[] } | { ok: false; error: string };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const str = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  return s && s.length <= max ? s : null;
};

const isoOrNull = (v: unknown): string | null | "bad" => {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || Number.isNaN(Date.parse(v))) return "bad";
  return new Date(v).toISOString();
};

const dateOrNull = (v: unknown): string | null | "bad" => {
  if (v === undefined || v === null || v === "") return null;
  return typeof v === "string" && DATE_RE.test(v) ? v : "bad";
};

/**
 * Where a statement link may point. The app opens these links for the
 * restaurant, so only the CRM's own host is accepted - a push carrying
 * any other link is refused whole.
 */
export function statementOrigins(): string[] {
  const raw = process.env.CRM_STATEMENT_ORIGINS ?? "https://crm.pfdworks.com";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Only the CRM's own statement links are opened from the app: https, on the CRM's host. */
export function isStatementUrl(v: string, crmOrigins: readonly string[]): boolean {
  try {
    const u = new URL(v);
    if (u.protocol !== "https:") return false;
    return crmOrigins.length === 0 || crmOrigins.some((o) => o === u.origin);
  } catch {
    return false;
  }
}

/**
 * Validate what the CRM pushes (PUT /api/crm/restaurants/:id/statements).
 * A bad week fails the whole push: a Money page with one wrong line is
 * worse than a stale one.
 */
export function parseStatementsPush(input: unknown, crmOrigins: readonly string[] = []): StatementsPushDecision {
  const o = (input ?? {}) as Record<string, unknown>;
  if (!Array.isArray(o.statements)) return { ok: false, error: "statements must be an array" };
  if (o.statements.length > MAX_STATEMENTS_PER_PUSH) return { ok: false, error: `too many statements (${MAX_STATEMENTS_PER_PUSH} max)` };
  const seen = new Set<string>();
  const out: StatementPush[] = [];
  for (const [i, raw] of (o.statements as unknown[]).entries()) {
    const s = (raw ?? {}) as Record<string, unknown>;
    const where = `statement ${i}`;
    const periodStart = dateOrNull(s.period_start);
    const periodEnd = dateOrNull(s.period_end);
    if (!periodStart || periodStart === "bad") return { ok: false, error: `${where}: period_start must be YYYY-MM-DD` };
    if (!periodEnd || periodEnd === "bad") return { ok: false, error: `${where}: period_end must be YYYY-MM-DD` };
    if (periodEnd < periodStart) return { ok: false, error: `${where}: period_end is before period_start` };
    if (seen.has(periodStart)) return { ok: false, error: `${where}: week ${periodStart} appears twice` };
    seen.add(periodStart);
    const statementNo = str(s.statement_no, 40);
    if (!statementNo) return { ok: false, error: `${where}: statement_no is required` };
    const status = typeof s.payment_status === "string" && (PAYMENT_STATUSES as readonly string[]).includes(s.payment_status) ? (s.payment_status as PaymentStatus) : null;
    if (!status) return { ok: false, error: `${where}: payment_status must be one of ${PAYMENT_STATUSES.join(", ")}` };
    const paidAt = isoOrNull(s.paid_at);
    if (paidAt === "bad") return { ok: false, error: `${where}: paid_at must be a date-time` };
    const paymentDate = dateOrNull(s.payment_date);
    if (paymentDate === "bad") return { ok: false, error: `${where}: payment_date must be YYYY-MM-DD` };
    const generatedAt = isoOrNull(s.generated_at);
    if (generatedAt === "bad") return { ok: false, error: `${where}: generated_at must be a date-time` };
    const orderCount = typeof s.order_count === "number" && Number.isInteger(s.order_count) && s.order_count >= 0 ? s.order_count : null;
    if (orderCount === null) return { ok: false, error: `${where}: order_count must be a whole number` };
    const due = typeof s.amount_due_cents === "number" && Number.isInteger(s.amount_due_cents) && Math.abs(s.amount_due_cents) <= 100_000_000 ? s.amount_due_cents : null;
    if (due === null) return { ok: false, error: `${where}: amount_due_cents must be a whole number of cents` };
    const viewUrl = s.view_url == null || s.view_url === "" ? null : str(s.view_url, 500);
    const pdfUrl = s.pdf_url == null || s.pdf_url === "" ? null : str(s.pdf_url, 500);
    if (s.view_url != null && s.view_url !== "" && (!viewUrl || !isStatementUrl(viewUrl, crmOrigins))) return { ok: false, error: `${where}: view_url must be an https link on the CRM` };
    if (s.pdf_url != null && s.pdf_url !== "" && (!pdfUrl || !isStatementUrl(pdfUrl, crmOrigins))) return { ok: false, error: `${where}: pdf_url must be an https link on the CRM` };
    const payload = s.payload && typeof s.payload === "object" && !Array.isArray(s.payload) ? (s.payload as Record<string, unknown>) : {};
    if (JSON.stringify(payload).length > 20_000) return { ok: false, error: `${where}: payload is too large` };
    out.push({
      period_start: periodStart,
      period_end: periodEnd,
      statement_no: statementNo,
      payment_status: status,
      paid_at: paidAt,
      payment_date: paymentDate,
      payment_ref: str(s.payment_ref, 80),
      order_count: orderCount,
      amount_due_cents: due,
      view_url: viewUrl,
      pdf_url: pdfUrl,
      generated_at: generatedAt,
      payload,
    });
  }
  return { ok: true, statements: out };
}

// --- what the Money tab shows ------------------------------------------------

export interface StatementView {
  period_start: string;
  period_end: string;
  statement_no: string;
  payment_status: PaymentStatus;
  paid_at: string | null;
  payment_date: string | null;
  order_count: number;
  amount_due_cents: number;
  view_url: string | null;
  pdf_url: string | null;
}

export function statusLabel(s: StatementView): { label: string; tone: "paid" | "pending" | "attention" | "muted" } {
  switch (s.payment_status) {
    case "paid":
      return { label: "Paid", tone: "paid" };
    case "pending":
      return { label: s.payment_date ? "Paying" : "Pending", tone: "pending" };
    case "held":
      return { label: "On hold - call Premium", tone: "attention" };
    case "failed":
      return { label: "Payment failed - call Premium", tone: "attention" };
    case "skipped":
      return { label: "Not paid this week", tone: "muted" };
    default:
      return { label: "Scheduled", tone: "pending" };
  }
}

export function cents(c: number): string {
  const sign = c < 0 ? "-" : "";
  return `${sign}$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "Oct 13 - Oct 19" from two ISO dates, no timezone shift (dates, not instants). */
export function weekLabel(periodStart: string, periodEnd: string): string {
  const fmt = (d: string) => {
    const [y, m, day] = d.split("-").map(Number);
    return new Date(Date.UTC(y!, m! - 1, day!)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  };
  return `${fmt(periodStart)} - ${fmt(periodEnd)}`;
}

/** Totals for the strip at the top: what is owed and unpaid, and the last paid week. */
export function moneySummary(rows: StatementView[]): { owedCents: number; owedWeeks: number; lastPaid: StatementView | null; weeks: number } {
  let owedCents = 0;
  let owedWeeks = 0;
  let lastPaid: StatementView | null = null;
  for (const r of rows) {
    if (r.payment_status === "paid") {
      if (!lastPaid || r.period_start > lastPaid.period_start) lastPaid = r;
    } else if (r.payment_status !== "skipped" && r.amount_due_cents > 0) {
      owedCents += r.amount_due_cents;
      owedWeeks += 1;
    }
  }
  return { owedCents, owedWeeks, lastPaid, weeks: rows.length };
}
