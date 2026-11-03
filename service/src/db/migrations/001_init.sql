create table if not exists updates (
  id               uuid primary key,
  accommodation_id text not null,
  from_date        date not null,
  to_date          date not null,
  available        boolean not null,
  price_per_night  numeric(10,2) not null,
  received_at      timestamptz not null default now()
);

create index if not exists updates_accommodation_received_idx
  on updates (accommodation_id, received_at desc);

create table if not exists sync_jobs (
  id                 uuid primary key,
  seq                bigserial not null,
  update_id          uuid not null references updates (id),
  accommodation_id   text not null,
  from_date          date not null,
  to_date            date not null,
  available          boolean not null,
  price_per_night    numeric(10,2) not null,
  state              text not null check (state in ('pending', 'in_progress', 'done', 'failed', 'superseded')),
  attempts           int not null default 0,
  next_attempt_at    timestamptz not null default now(),
  locked_at          timestamptz,
  last_error_code    text,
  last_error_message text,
  last_error_at      timestamptz,
  finished_at        timestamptz
);

create index if not exists sync_jobs_state_next_attempt_idx on sync_jobs (state, next_attempt_at);
create index if not exists sync_jobs_accommodation_seq_idx on sync_jobs (accommodation_id, seq);
create index if not exists sync_jobs_update_idx on sync_jobs (update_id);
