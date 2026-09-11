-- ============================================================================
-- Migration 022: make printer_expected true again for sites that have one
-- Run in Supabase SQL Editor. Safe to run more than once.
-- ============================================================================
--
-- printer_expected (migration 014) gates the "No printer" health warning, so
-- that the hundreds of channel restaurants which will never print a ticket
-- stay quiet. It works, and it has been dead since the day it shipped.
--
-- 014 backfilled it once, for every restaurant that held an active device at
-- that moment, and then NOTHING in the codebase ever wrote it again. Every
-- restaurant onboarded through the CRM Printers console since then has a
-- registered, working printer and printer_expected still false -- so if that
-- printer is ever deactivated or removed, the check that exists to notice
-- cannot fire. The gap is invisible in exactly the way the column was
-- invented to prevent.
--
-- The code fix is in the three places that register or move a device. This is
-- the catch-up for everything registered while nothing was setting it.
--
-- Note what this does NOT do, and why it raises no new alerts today: it only
-- marks restaurants that have an ACTIVE device right now, and the health check
-- only warns when printer_expected is true AND there is no active device. So
-- every row this touches passes the check the moment it is touched. What
-- changes is the future: when one of those printers goes away, somebody finds
-- out.
--
-- A restaurant whose only device is INACTIVE is deliberately left alone.
-- Deactivating a device is usually a decision - that site came off the printer
-- path - and marking it "expected" would manufacture a standing warning about
-- something somebody already chose. 014's own backfill drew the line in the
-- same place.

update restaurants r
   set printer_expected = true
 where r.printer_expected = false
   and exists (
     select 1 from print_devices d
      where d.restaurant_id = r.id and d.is_active
   );

comment on column restaurants.printer_expected is
  'True when this restaurant is meant to have a printer. Gates the "no printer" health warning so the hundreds of channel restaurants that will never print stay quiet. Set automatically when a device is registered or reassigned (migration 022 fixed a gap where nothing set it). Deliberately NOT cleared when a device is deactivated: the intention survives the hardware, which is the whole point of the warning.';
