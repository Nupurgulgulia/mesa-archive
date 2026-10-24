-- Step 4: a session remembers which items it contains (in order) and any time limit.
alter table exam_sessions add column if not exists item_ids bigint[] not null default '{}';
alter table exam_sessions add column if not exists time_limit_min int;
alter table exam_sessions add column if not exists title text;
