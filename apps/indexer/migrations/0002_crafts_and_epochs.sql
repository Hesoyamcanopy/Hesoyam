-- Second pass over the event mirror.
--
-- Everything here was already being stored in `events` and simply had no derived
-- table. Two of these were correctness bugs rather than gaps: card and bench
-- ownership went stale the moment either one was traded, because only the mint was
-- being recorded and not the transfer.

-- Pending and finished crafts, so the client can show a roll that is waiting on its
-- reveal block instead of appearing to have swallowed the Flower.
create table if not exists crafts (
  request_id    numeric(78,0) primary key,
  player        text          not null,
  strain_id     integer       not null,
  tier          smallint      not null,
  reveal_block  bigint        not null,
  finalized     boolean       not null default false,
  expired       boolean,
  card_token_id numeric(78,0),
  rarity        smallint,
  weight_bps    integer,
  requested_at  bigint        not null,
  finalized_at  bigint
);

create index if not exists crafts_player_idx  on crafts (player);
create index if not exists crafts_pending_idx on crafts (finalized) where finalized = false;

-- Dispensary epochs. The client needs the budget and the clock to draw the falling
-- bid, and neither is derivable from a sale alone.
create table if not exists dispensary_epochs (
  tx_hash      text          not null,
  log_index    integer       not null,
  amount       numeric(78,0) not null,
  budget       numeric(78,0) not null,
  epoch_start  timestamptz   not null,
  block_number bigint        not null,
  primary key (tx_hash, log_index)
);

create index if not exists dispensary_epochs_start_idx on dispensary_epochs (epoch_start desc);

-- Reference price history per quality tier.
create table if not exists reference_prices (
  tx_hash      text          not null,
  log_index    integer       not null,
  tier         smallint      not null,
  price        numeric(78,0) not null,
  block_number bigint        not null,
  block_time   timestamptz,
  primary key (tx_hash, log_index)
);

create index if not exists reference_prices_tier_idx on reference_prices (tier, block_number desc);

-- Transfer tax taken, which is the single largest revenue line and the one the
-- treasury page is asked about most.
create table if not exists tax_events (
  tx_hash      text          not null,
  log_index    integer       not null,
  from_addr    text          not null,
  to_addr      text          not null,
  platform_fee numeric(78,0) not null,
  protocol_fee numeric(78,0) not null,
  block_number bigint        not null,
  block_time   timestamptz,
  primary key (tx_hash, log_index)
);

create index if not exists tax_events_time_idx on tax_events (block_time);

-- Current bid per tier, as the client would compute it, without a round trip.
create or replace view latest_reference as
select distinct on (tier) tier, price, block_number, block_time
from reference_prices
order by tier, block_number desc;

-- Protocol revenue by source and day. The treasury page reads this.
create or replace view daily_tax as
select
  date_trunc('day', block_time) as day,
  sum(protocol_fee) as protocol_fee,
  sum(platform_fee) as platform_fee,
  count(*)          as transfers_taxed
from tax_events
where block_time is not null
group by 1
order by 1 desc;
