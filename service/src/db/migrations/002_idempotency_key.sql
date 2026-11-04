-- SEC-12: a client-chosen key that makes a repeated POST /updates answer with the original update.
alter table updates add column if not exists idempotency_key text;
create unique index if not exists updates_idempotency_key_idx on updates (idempotency_key) where idempotency_key is not null;
