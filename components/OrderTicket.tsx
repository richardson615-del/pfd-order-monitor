import { Order } from "@/lib/types";
import { buildTicket, ticketLineClass } from "@/lib/ticket";

/**
 * The order, on screen, as the ticket it would print as.
 *
 * Not a lookalike - the same buildTicket() the printer and the email leg use.
 * Staff already read the paper ticket, and a screen that arranged the same
 * facts differently would make them learn a second layout for no reason. It
 * also means the two cannot drift: any change to the ticket shows up here for
 * free, and nobody has to remember there is a second renderer.
 *
 * Each line carries its own emphasis - bold, double height, double width,
 * reverse video - because that is how a thermal printer says "this matters".
 * Rendering those faithfully is what makes it read as a ticket rather than as
 * a wall of monospace.
 *
 * Always built at 48 columns and normal scale, whatever the restaurant's
 * ticket_text_scale is. That setting exists because a thermal head has a fixed
 * dot count; a screen does not, and sizes the whole ticket to fit instead.
 */

export default function OrderTicket({ order }: { order: Order }) {
  const lines = buildTicket(order as any, 48, {}, { omitFooter: true });

  return (
    <div className="receipt">
      <div className="receipt-paper">
        {lines.map((l, i) =>
          l.qr ? (
            // A QR is the customer's, and there is nothing to scan off a
            // kitchen screen. Say where it goes rather than leaving a gap.
            <div key={i} className="tl tl-c tl-note">
              [QR code prints here]
            </div>
          ) : (
            // A blank line is a real part of the layout - it is what keeps
            // items from reading as one block - so it needs a height.
            <div key={i} className={ticketLineClass(l)}>
              {l.text === "" ? " " : l.text}
            </div>
          )
        )}
      </div>
    </div>
  );
}
