-- Supabase only. PGlite has no auth schema, so this file lives outside the indexer
-- migrations and is applied with the Supabase CLI.
--
-- What row level security is for here, and what it is not for.
--
--   It is for write protection and for privacy on the few tables that hold anything
--   a player would not want public. Chain data is already public, so read policies
--   on the mirror are permissive on purpose.
--
--   It is NOT a security boundary for value. No balance, no inventory and no reward
--   is decided by a row in this database. If every policy below were dropped, an
--   attacker could write nonsense into a cache and still could not take one unit of
--   Flower from anyone. Anything that would let them is on chain, behind a signature.

-- ---------------------------------------------------------------- helpers

-- The wallet address of the caller, taken from the JWT the SIWE function minted.
create or replace function auth_wallet() returns text
language sql stable
as $$
  select lower(coalesce(
    current_setting('request.jwt.claims', true)::jsonb ->> 'wallet',
    ''
  ));
$$;

-- ---------------------------------------------------------------- auth

-- Single use nonces for Sign In With Ethereum. Written and read only by the Edge
-- Function, which uses the service role, so there is no policy granting access to
-- anyone else. RLS with no permissive policy denies everything by default.
create table if not exists siwe_nonces (
  nonce      text primary key,
  address    text,
  issued_at  timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes',
  consumed   boolean     not null default false
);

create index if not exists siwe_nonces_expiry_idx on siwe_nonces (expires_at);

alter table siwe_nonces enable row level security;

-- Player profile. The one table a player writes to directly.
create table if not exists profiles (
  wallet       text primary key,
  display_name text,
  avatar_seed  text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint display_name_length check (display_name is null or char_length(display_name) between 2 and 24)
);

alter table profiles enable row level security;

drop policy if exists profiles_public_read on profiles;
create policy profiles_public_read on profiles
  for select using (true);

drop policy if exists profiles_self_insert on profiles;
create policy profiles_self_insert on profiles
  for insert with check (wallet = auth_wallet());

drop policy if exists profiles_self_update on profiles;
create policy profiles_self_update on profiles
  for update using (wallet = auth_wallet()) with check (wallet = auth_wallet());

-- Notification preferences are private to their owner.
create table if not exists notification_prefs (
  wallet        text primary key,
  feed_windows  boolean not null default true,
  pest_events   boolean not null default true,
  harvest_ready boolean not null default true,
  listing_sold  boolean not null default true,
  web_push_sub  jsonb,
  updated_at    timestamptz not null default now()
);

alter table notification_prefs enable row level security;

drop policy if exists prefs_self_read on notification_prefs;
create policy prefs_self_read on notification_prefs
  for select using (wallet = auth_wallet());

drop policy if exists prefs_self_write on notification_prefs;
create policy prefs_self_write on notification_prefs
  for all using (wallet = auth_wallet()) with check (wallet = auth_wallet());

-- ---------------------------------------------------------------- mirror tables

-- Everything the indexer writes is public chain data. Reads are open, writes belong
-- to the service role only, which is what the indexer connects as.
do $$
declare
  t text;
  mirror_tables text[] := array[
    'events', 'grows', 'harvests', 'listings', 'fills', 'dispensary_sales',
    'positions', 'claims', 'distributions', 'sweeps', 'reward_notifications',
    'cards', 'benches', 'strains', 'crafts', 'dispensary_epochs',
    'reference_prices', 'tax_events', 'cursor_state'
  ];
begin
  foreach t in array mirror_tables loop
    if to_regclass(t) is null then
      continue;
    end if;

    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_public_read', t);
    execute format('create policy %I on %I for select using (true)', t || '_public_read', t);
    -- No insert, update or delete policy is created on purpose. Without one, RLS
    -- denies those operations to anon and authenticated, while the service role
    -- bypasses RLS entirely and keeps working.
  end loop;
end
$$;

-- ---------------------------------------------------------------- housekeeping

create or replace function purge_expired_nonces() returns void
language sql
as $$
  delete from siwe_nonces where expires_at < now() - interval '1 hour';
$$;

comment on function purge_expired_nonces is
  'Run on a schedule. Nonces are single use, so anything past its window is dead weight.';
