-- Mainnet waitlist.
--
-- One row per wallet, written only by the /api/waitlist route, which connects with
-- the service role. The table holds nothing secret, but it is also nobody else's
-- business who signed up, so there is no public read.
--
-- As with the rest of this schema, no value is decided here. A row in this table
-- is a mailing list entry, not a claim on anything. Whatever the launch actually
-- grants gets decided on chain, against addresses exported from here.

create table if not exists waitlist (
  wallet     text primary key,
  source     text,
  user_agent text,
  created_at timestamptz not null default now()
);

create index if not exists waitlist_created_idx on waitlist (created_at);

alter table waitlist enable row level security;

-- No policy is created on purpose. RLS with no permissive policy denies anon and
-- authenticated everything, while the service role bypasses RLS and keeps working.
-- That is exactly the access shape this table wants: writes from the API route,
-- reads from whoever exports the list at launch, nothing from the browser.

comment on table waitlist is
  'Mainnet launch waitlist. Wallet addresses are stored lowercased, deduplicated by primary key.';
