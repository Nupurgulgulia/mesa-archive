-- Step 5: Nexus ids are the identity for synced rows. The old natural-key uniqueness (title/body, date/time/title)
-- only applies to rows captured by hand before the sync existed, because Nexus legitimately has distinct
-- items with identical text (repeated "Event updated" notices, two sessions in one slot with the same title).
alter table notifications drop constraint if exists notifications_dedupe;
drop index if exists notifications_dedupe;
create unique index if not exists notifications_legacy_dedupe on notifications(profile_id, title, body) where nexus_id is null;

alter table calendar_events drop constraint if exists calendar_events_profile_id_date_start_time_title_key;
create unique index if not exists calendar_events_legacy_slot on calendar_events(profile_id, date, start_time, title) where nexus_id is null;

alter table announcements drop constraint if exists announcements_profile_id_course_id_title_key;
create unique index if not exists announcements_legacy_title on announcements(profile_id, course_id, title) where nexus_id is null;

alter table assignments drop constraint if exists assignments_profile_id_course_title_key;
create unique index if not exists assignments_legacy_title on assignments(profile_id, course, title) where nexus_id is null;
