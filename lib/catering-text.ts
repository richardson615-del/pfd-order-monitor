/**
 * A restaurant never sees "ezCater" (Nick, 2026-10-29, Willie Mae's tablet):
 * a catering order is "Catering" on the tablet, the paper ticket and the
 * Sales tab. New orders are written that way (lib/ezcater-promote.ts,
 * lib/ezcater-client.ts, lib/ezcater.ts); rows stored before that still carry
 * the old words, so every restaurant-facing render passes its text through
 * here. No data is rewritten. Internal surfaces (/admin/ezcater, the CRM's
 * feeds, `source = 'ezcater'`) keep the real name.
 */

const REPLACEMENTS: [RegExp, string][] = [
  [/\*\*\*\s*ezCATER CATERING\s*\*\*\*/gi, "*** CATERING ***"],
  [/ezCATER CATERING/gi, "CATERING"],
  [/ezCater #/gi, "Catering #"],
  [/ezCater \(prepaid\)/gi, "Catering (prepaid)"],
];

/** The text a restaurant sees for this order. Only an ezCater order is touched. */
export function cateringText(source: string | null | undefined, text: string | null | undefined): string | null {
  if (text == null) return null;
  if (source !== "ezcater") return text;
  let out = text;
  for (const [re, to] of REPLACEMENTS) out = out.replace(re, to);
  return out;
}
