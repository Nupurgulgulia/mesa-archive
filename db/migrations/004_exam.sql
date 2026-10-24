-- Step 4: exam-prep details.
alter table topics add column if not exists summary text;
alter table topics add column if not exists source_keys text[] not null default '{}';   -- documents the topic is built from
alter table topics add column if not exists created_at timestamptz default now();

alter table exam_items add column if not exists difficulty text;                        -- easy | medium | hard
alter table exam_items add column if not exists source_refs jsonb;                      -- [{key, page, label}] for "see source"
create unique index if not exists exam_items_dedupe on exam_items(profile_id, course_id, kind, md5(lower(prompt)));

-- Role-play drills (Art of Selling buyers etc.): the conversation and the feedback.
create table if not exists drill_sessions (
  id bigserial primary key,
  profile_id text not null references profiles(id),
  course_id text references courses(id),
  persona text not null,
  transcript jsonb not null default '[]',     -- [{role:'student'|'buyer', text, at}]
  feedback text,
  score numeric,
  started_at timestamptz default now(),
  finished_at timestamptz
);

-- Generation runs, so the app can show what was generated from what (and cost is visible).
create table if not exists generation_runs (
  id bigserial primary key,
  profile_id text not null references profiles(id),
  course_id text references courses(id),
  topic_id bigint references topics(id) on delete set null,
  model text,
  items_created int,
  chars_in int,
  error text,
  ran_at timestamptz default now()
);
