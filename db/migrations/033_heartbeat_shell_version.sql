-- ============================================================================
-- Migration 033: which Android shell each tablet is running
-- ============================================================================
--
-- The web app updates itself (it reloads onto a new deploy at a quiet
-- moment). The Android shell around it - the TWA that owns the launcher
-- icon, the name, the notification delegation - cannot: a sideloaded APK
-- has no update channel, and under an MDM the console pushes it. Either
-- way, the office needs to know which tablets are on an old shell, and
-- nobody at a restaurant should ever be asked to look.
--
-- The shell tells the page its appVersionCode on the startUrl
-- (?shell=<code>, android/twa-manifest.json); the page remembers it and
-- reports it on every heartbeat. Null means the shell never said - a build
-- from before the param existed, or a plain browser - and is not "old".

alter table dashboard_heartbeats
  add column if not exists shell_version integer;

comment on column dashboard_heartbeats.shell_version is
  'appVersionCode of the Android shell (TWA) the dashboard that sent this heartbeat runs in, from the ?shell= startUrl param. Null = never reported (pre-param shell, or a plain browser). Compared against MIN_SHELL_VERSION so the office can list tablets that need the MDM to push a newer shell.';
