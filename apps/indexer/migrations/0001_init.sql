-- Hesoyam indexer schema.
--
-- Two layers on purpose.
--
--   `events` is an append only mirror of what the chain emitted. It is the source of
--   truth for this database, and a full reindex means truncating the derived tables
--   and replaying it. Nothing is ever computed and then forgotten.
--
--   The derived tables hold current state, so the client can read a grow or a listing
--   without folding an event stream on every request.
--
-- This file runs unchanged on PGlite locally and on Supabase Postgres in production.
-- uint256 values are NUMERIC(78,0), which holds the full range without loss. Do not
-- use bigint for token amounts.

create table if not exists cursor_state (
  id           smallint primary key default 1,
  last_block   bigint      not null default 0,
  chain_id     integer     not null,
  updated_at   timestamptz not null default now(),
  constraint cursor_singleton check (id = 1)
);

create table if not exists events (
  block_number  bigint       not null,
  block_time    timestamptz,
  tx_hash       text         not null,
  log_index     integer      not null,
  address       text         not null,
  contract      text         not null,
  event_name    text         not null,
  args          jsonb        not null,
  primary key (tx_hash, log_index)
);

create index if not exists events_block_idx     on events (block_number);
create index if not exists events_contract_idx  on events (contract, event_name);
create index if not exists events_address_idx   on events (address);

-- ---------------------------------------------------------------- growing

create table if not exists grows (
  grow_id       numeric(78,0) primary key,
  grower        text          not null,
  strain_id     integer       not null,
  bench_id      numeric(78,0) not null,
  planted_at    timestamptz   not null,
  event_seed    text          not null,
  feed_mask     smallint      not null default 0,
  treated_mask  smallint      not null default 0,
  active        boolean       not null default true,
  outcome       text,
  block_number  bigint        not null
);

create index if not exists grows_grower_idx on grows (grower);
create index if not exists grows_active_idx on grows (active);

create table if not exists harvests (
  grow_id      numeric(78,0) primary key,
  grower       text          not null,
  strain_id    integer,
  units        integer       not null,
  quality      smallint      not null,
  care         smallint      not null,
  damage_bps   integer       not null,
  curing       boolean       not null,
  harvest_id   numeric(78,0),
  collected    boolean       not null default false,
  final_tier   smallint,
  block_number bigint        not null,
  tx_hash      text          not null
);

create index if not exists harvests_grower_idx on harvests (grower);

-- ---------------------------------------------------------------- market

create table if not exists listings (
  listing_id     numeric(78,0) primary key,
  seller         text          not null,
  token_id       numeric(78,0) not null,
  strain_id      integer       not null,
  tier           smallint      not null,
  amount         numeric(78,0) not null,
  price_per_unit numeric(78,0) not null,
  active         boolean       not null default true,
  block_number   bigint        not null
);

create index if not exists listings_active_idx on listings (active, token_id);
create index if not exists listings_seller_idx on listings (seller);

create table if not exists fills (
  tx_hash      text          not null,
  log_index    integer       not null,
  listing_id   numeric(78,0) not null,
  buyer        text          not null,
  seller       text,
  token_id     numeric(78,0),
  amount       numeric(78,0) not null,
  gross        numeric(78,0) not null,
  fee          numeric(78,0) not null,
  block_number bigint        not null,
  block_time   timestamptz,
  primary key (tx_hash, log_index)
);

create index if not exists fills_listing_idx on fills (listing_id);
create index if not exists fills_time_idx    on fills (block_time);

create table if not exists dispensary_sales (
  tx_hash        text          not null,
  log_index      integer       not null,
  seller         text          not null,
  token_id       numeric(78,0) not null,
  units          numeric(78,0) not null,
  price_per_unit numeric(78,0) not null,
  proceeds       numeric(78,0) not null,
  block_number   bigint        not null,
  primary key (tx_hash, log_index)
);

-- ---------------------------------------------------------------- staking

create table if not exists positions (
  owner        text          not null,
  position_id  integer       not null,
  amount       numeric(78,0) not null,
  tier_id      integer       not null,
  unlock_at    timestamptz   not null,
  active       boolean       not null default true,
  exit_kind    text,
  returned     numeric(78,0),
  penalty      numeric(78,0),
  block_number bigint        not null,
  primary key (owner, position_id)
);

create index if not exists positions_owner_idx on positions (owner, active);

create table if not exists claims (
  tx_hash      text          not null,
  log_index    integer       not null,
  claimer      text          not null,
  amount       numeric(78,0) not null,
  block_number bigint        not null,
  block_time   timestamptz,
  primary key (tx_hash, log_index)
);

create index if not exists claims_claimer_idx on claims (claimer);

-- ---------------------------------------------------------------- revenue

-- The provenance table. Every reward a player ever claims traces back to one of
-- these rows, and every row traces to the transaction that produced the revenue.
create table if not exists distributions (
  tx_hash          text          not null,
  log_index        integer       not null,
  to_equity        numeric(78,0) not null,
  to_dispensary    numeric(78,0) not null,
  to_liquidity     numeric(78,0) not null,
  to_ops           numeric(78,0) not null,
  to_reserve       numeric(78,0) not null,
  total            numeric(78,0) not null,
  block_number     bigint        not null,
  block_time       timestamptz,
  primary key (tx_hash, log_index)
);

create index if not exists distributions_time_idx on distributions (block_time);

create table if not exists sweeps (
  tx_hash      text          not null,
  log_index    integer       not null,
  hesoyam_in      numeric(78,0) not null,
  usdc_out     numeric(78,0) not null,
  distributed  numeric(78,0) not null,
  block_number bigint        not null,
  primary key (tx_hash, log_index)
);

create table if not exists reward_notifications (
  tx_hash         text          not null,
  log_index       integer       not null,
  amount          numeric(78,0) not null,
  acc_per_weight  numeric(78,0) not null,
  block_number    bigint        not null,
  primary key (tx_hash, log_index)
);

-- ---------------------------------------------------------------- assets

create table if not exists cards (
  token_id     numeric(78,0) primary key,
  owner        text          not null,
  weight_bps   integer       not null,
  strain_id    integer       not null,
  rarity       smallint      not null,
  equipped_by  text,
  block_number bigint        not null
);

create index if not exists cards_owner_idx on cards (owner);

create table if not exists benches (
  token_id     numeric(78,0) primary key,
  owner        text          not null,
  tranche_id   numeric(78,0) not null,
  price        numeric(78,0) not null,
  block_number bigint        not null
);

create index if not exists benches_owner_idx on benches (owner);

create table if not exists strains (
  strain_id     integer primary key,
  name          text    not null,
  cycle_seconds integer not null,
  seed_price    numeric(78,0) not null,
  active        boolean not null default true,
  block_number  bigint  not null
);

-- ---------------------------------------------------------------- views

-- Fee revenue per day, the number the landing page and the treasury page both read.
create or replace view daily_revenue as
select
  date_trunc('day', block_time) as day,
  sum(total)         as total,
  sum(to_equity)     as to_equity,
  sum(to_dispensary) as to_dispensary,
  count(*)           as distribution_count
from distributions
where block_time is not null
group by 1
order by 1 desc;

-- Marketplace volume per day and quality tier.
create or replace view daily_market as
select
  date_trunc('day', block_time) as day,
  sum(gross) as gross,
  sum(fee)   as fee,
  count(*)   as fill_count
from fills
where block_time is not null
group by 1
order by 1 desc;
