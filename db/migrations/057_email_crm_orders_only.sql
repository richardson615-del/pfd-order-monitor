-- 057: paper-ticket email for CRM orders only (Nick, 2026-11-06).
--
-- A restaurant on "Email to a PC" whose PC inbox also gets Zuppler's own
-- order email received every Zuppler order twice. With this on, the PC-inbox
-- email goes only for orders placed in the CRM (source 'phone', P- numbers;
-- test orders too, so the PC can still be checked). Zuppler orders skip the
-- destination and the CRM's "Where it went" says why (lib/email-routing.ts).
--
-- Default off: every restaurant keeps today's behaviour until someone turns
-- it on in the CRM (Equipment -> Manage -> Paper ticket). Safe to run twice.

alter table restaurants add column if not exists email_crm_orders_only boolean not null default false;

comment on column restaurants.email_crm_orders_only is
  '057: with print_method = email, send the PC-inbox ticket only for CRM orders (phone / P- numbers, and test orders). Zuppler orders skip it. Default off.';
