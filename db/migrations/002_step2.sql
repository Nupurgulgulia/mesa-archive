-- Step 2 (2026-10-20): finish the schema. Everything is profile-scoped (profile_id -> profiles.id).
-- 001 (already applied before this repo existed): profiles, courses, files, recordings,
-- calendar_events, assignments, notifications, sync_log.

-- ---------- courses ----------
alter table courses add column if not exists prefix text;            -- bucket prefix, e.g. 'Term 1/The Art of Selling'
alter table courses add column if not exists short_title text;
alter table courses add column if not exists category text;
create unique index if not exists courses_profile_prefix on courses(profile_id, prefix);

-- ---------- files: one row per Nexus item (file, note or link) ----------
-- Identity: storage_key (bucket key) and, for real files, Nexus material id.
alter table files drop constraint if exists files_course_id_tab_folder_name_key;   -- broke on duplicate labels
alter table files add column if not exists kind text;                -- 'file' | 'note' | 'link'
alter table files add column if not exists label text;               -- item label as shown on Nexus
alter table files add column if not exists dup_index int not null default 0;  -- nth item with the same label in a folder
alter table files add column if not exists path text;                -- folder path in bucket (prefix/tab/folder)
alter table files add column if not exists folder_date text;
alter table files add column if not exists material_id text;         -- '<course uuid>/<material uuid>.<ext>' (files only)
alter table files add column if not exists ext text;
alter table files add column if not exists size_bytes bigint;
alter table files add column if not exists etag text;
alter table files add column if not exists sha256 text;
alter table files add column if not exists note_text text;           -- notes: full text; links: label + url
alter table files add column if not exists links text[] not null default '{}';
alter table files add column if not exists last_seen timestamptz default now();
create unique index if not exists files_profile_key on files(profile_id, storage_key);
create unique index if not exists files_profile_material on files(profile_id, material_id) where material_id is not null;
create index if not exists files_course on files(course_id);

-- ---------- recordings ----------
alter table recordings add column if not exists rec_date date;
alter table recordings add column if not exists date_uncertain boolean not null default false;

-- ---------- assignments / notifications / calendar ----------
alter table assignments add column if not exists due_date date;
alter table assignments add column if not exists course_id text references courses(id);
alter table assignments add column if not exists kind text;          -- Individual / Group
alter table assignments add column if not exists marks text;
alter table notifications add column if not exists category text;
alter table notifications add column if not exists posted_on date;
create unique index if not exists notifications_dedupe on notifications(profile_id, title, body);
alter table calendar_events add column if not exists course_id text references courses(id);
comment on column calendar_events.status is 'Frozen at capture (2026-10-20). Do not use; compute past/upcoming from date.';

-- ---------- new: attendance ----------
create table if not exists attendance (
  id bigserial primary key,
  profile_id text not null references profiles(id),
  course_id text references courses(id),
  subject text not null,
  attended int not null,
  total int not null,
  pct numeric(5,1) generated always as (case when total > 0 then round(100.0 * attended / total, 1) end) stored,
  as_of date not null,
  note text,
  unique (profile_id, subject, as_of)
);

-- ---------- new: MRS (Mesa Readiness Score) ----------
create table if not exists mrs (
  id bigserial primary key,
  profile_id text not null references profiles(id),
  sitting text not null,                 -- 'MRS 1', 'MRS 2', ...
  title text,
  score numeric(5,1),
  out_of numeric(5,1) default 100,
  status text,                           -- 'scored' | 'not scheduled' | ...
  as_of date not null,
  note text,
  unique (profile_id, sitting)
);
create table if not exists mrs_requirements (
  id bigserial primary key,
  profile_id text not null references profiles(id),
  title text not null,
  due_at timestamptz,
  recurring text,                        -- e.g. 'weekly, Sun 23:59'
  status text,
  note text,
  unique (profile_id, title)
);

-- ---------- new: announcements (course-level) ----------
create table if not exists announcements (
  id bigserial primary key,
  profile_id text not null references profiles(id),
  course_id text references courses(id),
  title text not null,
  body text,
  posted text,
  first_seen timestamptz default now(),
  unique (profile_id, course_id, title)
);

-- ---------- new: external link targets (Google Docs/Sheets/Slides, Gamma, Drive, YouTube) ----------
create table if not exists link_targets (
  id bigserial primary key,
  profile_id text not null references profiles(id),
  url text not null,
  provider text not null,                -- gdoc | gsheet | gslide | gdrive_file | gdrive_folder | gamma | youtube | other
  resource_id text,
  export_status text not null default 'pending',  -- pending | exported | needs_login | unsupported | failed
  export_key text,                       -- bucket key of the exported copy
  export_bytes bigint,
  exported_at timestamptz,
  error text,
  unique (profile_id, url)
);
create table if not exists file_links (
  file_id bigint not null references files(id) on delete cascade,
  link_id bigint not null references link_targets(id) on delete cascade,
  primary key (file_id, link_id)
);

-- ---------- new: extracted text + full-text search ----------
create table if not exists doc_extractions (
  profile_id text not null references profiles(id),
  storage_key text not null,             -- file object or export object
  etag text,                             -- re-extract when the object changes
  status text not null,                  -- ok | empty | unsupported | failed
  pages int,
  chars int,
  error text,
  extracted_at timestamptz default now(),
  primary key (profile_id, storage_key)
);
create table if not exists doc_chunks (
  id bigserial primary key,
  profile_id text not null references profiles(id),
  course_id text references courses(id),
  file_id bigint references files(id) on delete cascade,
  link_id bigint references link_targets(id) on delete cascade,
  storage_key text not null,
  source_kind text not null,             -- file | note | link_export
  page int,                              -- PDF page / slide / sheet number
  seq int not null,
  heading text,
  content text not null,
  tsv tsvector generated always as (
    setweight(to_tsvector('english', coalesce(heading, '')), 'A') || setweight(to_tsvector('english', content), 'B')
  ) stored,
  unique (profile_id, storage_key, seq)
);
create index if not exists doc_chunks_tsv on doc_chunks using gin(tsv);
create index if not exists doc_chunks_course on doc_chunks(course_id);

-- ---------- new: exam prep ----------
create table if not exists exams (
  id bigserial primary key,
  profile_id text not null references profiles(id),
  course_id text references courses(id),  -- null = cross-course exam window (e.g. 'Mid Term Exam')
  title text not null,
  starts_on date not null,
  ends_on date,
  source text,                            -- 'calendar' | 'manual'
  unique (profile_id, title, starts_on)
);
create table if not exists topics (
  id bigserial primary key,
  profile_id text not null references profiles(id),
  course_id text not null references courses(id),
  name text not null,
  session_label text,
  unique (profile_id, course_id, name)
);
create table if not exists exam_items (
  id bigserial primary key,
  profile_id text not null references profiles(id),
  course_id text not null references courses(id),
  topic_id bigint references topics(id) on delete set null,
  kind text not null,                     -- mcq | short | flashcard | case | discovery | pitch | objection | negotiation
  prompt text not null,
  choices jsonb,                          -- mcq options
  answer text,
  explanation text,
  rubric jsonb,                           -- for open answers
  source_chunk_ids bigint[] not null default '{}',
  generator text,                         -- model / skill that produced it
  created_at timestamptz default now(),
  retired boolean not null default false
);
create index if not exists exam_items_course on exam_items(course_id, kind) where not retired;
create table if not exists exam_sessions (
  id bigserial primary key,
  profile_id text not null references profiles(id),
  course_id text references courses(id),
  mode text not null,                     -- mock | drill | flashcards | review
  started_at timestamptz default now(),
  finished_at timestamptz,
  score numeric,
  max_score numeric
);
create table if not exists attempts (
  id bigserial primary key,
  profile_id text not null references profiles(id),
  session_id bigint references exam_sessions(id) on delete cascade,
  item_id bigint not null references exam_items(id) on delete cascade,
  response text,
  correct boolean,
  score numeric,                          -- 0..1 for graded open answers
  feedback text,
  time_ms int,
  answered_at timestamptz default now()
);
create index if not exists attempts_item on attempts(profile_id, item_id);
create table if not exists srs_state (       -- spaced repetition (SM-2 style)
  profile_id text not null references profiles(id),
  item_id bigint not null references exam_items(id) on delete cascade,
  ease numeric not null default 2.5,
  interval_days numeric not null default 0,
  reps int not null default 0,
  lapses int not null default 0,
  due_at timestamptz not null default now(),
  last_reviewed timestamptz,
  primary key (profile_id, item_id)
);
create or replace view topic_mastery as
  select a.profile_id, i.course_id, i.topic_id, t.name as topic,
         count(*) as attempts,
         avg(coalesce(a.score, case when a.correct then 1 else 0 end))::numeric(4,3) as accuracy,
         max(a.answered_at) as last_attempt
  from attempts a join exam_items i on i.id = a.item_id left join topics t on t.id = i.topic_id
  group by 1, 2, 3, 4;

-- ---------- sync_log: richer ----------
alter table sync_log add column if not exists finished_at timestamptz;
alter table sync_log add column if not exists status text;           -- ok | partial | failed | login_required
alter table sync_log add column if not exists changed_items int;
alter table sync_log add column if not exists details jsonb;
