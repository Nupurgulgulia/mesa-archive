-- Step 5: sync. Every record learns its Nexus id so later syncs match exactly instead of by title.

-- Course materials as Nexus models them (one row per material id). Files map to a bucket object.
create table if not exists nexus_materials (
  material_id text primary key,
  profile_id text not null references profiles(id),
  course_id text references courses(id),
  topic_id text,                    -- Nexus topic = a course tab (Resources, Pre-Reads, ...)
  topic_title text,
  session_id text,
  session_name text,                -- folder on Nexus ("Session 3"); null = not in a folder
  session_date date,
  kind text not null,               -- file | text | link
  title text not null,
  file_name text,
  size_bytes bigint,
  url text,                         -- link target
  content text,                     -- note text (HTML from Nexus)
  nexus_updated_at timestamptz,
  storage_key text,                 -- bucket object holding this material
  file_id bigint references files(id) on delete set null,
  first_seen timestamptz default now(),
  last_seen timestamptz default now(),
  removed_at timestamptz            -- no longer on Nexus (kept in the archive)
);
create index if not exists nexus_materials_course on nexus_materials(course_id);

-- Per-session attendance (Nexus gives one row per class)
create table if not exists attendance_sessions (
  event_id text primary key,
  profile_id text not null references profiles(id),
  course_name text,
  event_title text,
  start_at timestamptz,
  status text,                      -- present | absent | leave | ...
  term_name text,
  last_seen timestamptz default now()
);

alter table announcements add column if not exists nexus_id text;
alter table announcements add column if not exists posted_at timestamptz;
alter table announcements add column if not exists author text;
alter table announcements add column if not exists attachments jsonb;
create unique index if not exists announcements_nexus on announcements(profile_id, nexus_id) where nexus_id is not null;

alter table assignments add column if not exists nexus_id text;
alter table assignments add column if not exists due_at timestamptz;
alter table assignments add column if not exists submission_status text;   -- Nexus mySubmissionStatus (null = not submitted)
alter table assignments add column if not exists description text;
alter table assignments add column if not exists instructions text;
alter table assignments add column if not exists max_marks text;
create unique index if not exists assignments_nexus on assignments(profile_id, nexus_id) where nexus_id is not null;

alter table notifications add column if not exists nexus_id text;
alter table notifications add column if not exists created_at timestamptz;
alter table notifications add column if not exists ntype text;
create unique index if not exists notifications_nexus on notifications(profile_id, nexus_id) where nexus_id is not null;

alter table calendar_events add column if not exists nexus_id text;
alter table calendar_events add column if not exists start_at timestamptz;
alter table calendar_events add column if not exists end_at timestamptz;
alter table calendar_events add column if not exists event_type text;
alter table calendar_events add column if not exists nexus_status text;     -- scheduled | cancelled | ...
create unique index if not exists calendar_events_nexus on calendar_events(profile_id, nexus_id) where nexus_id is not null;

alter table recordings add column if not exists nexus_id text;
create unique index if not exists recordings_nexus on recordings(profile_id, nexus_id) where nexus_id is not null;

alter table mrs add column if not exists slug text;
alter table mrs add column if not exists marks numeric;
alter table mrs add column if not exists max_marks numeric;

alter table courses add column if not exists nexus_term_id text;
alter table courses add column if not exists start_date date;
alter table courses add column if not exists end_date date;

alter table sync_log add column if not exists run_id text;
create unique index if not exists sync_log_run on sync_log(run_id) where run_id is not null;
