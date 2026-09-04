-- Listings keep the amount they were listed with, so the remaining amount can be
-- derived from the fills rather than accumulated by decrementing.
--
-- Decrementing was not idempotent: a batch that failed partway was retried whole,
-- and every Filled in it applied a second time. The column went negative, active
-- flipped false, and the listing vanished from the UI. No attacker needed, just a
-- transient database error.

alter table listings add column if not exists listed_amount numeric(78,0);

-- Backfill: for rows already present, the best available estimate of the original
-- is what remains plus everything already filled against it.
update listings l
   set listed_amount = l.amount + coalesce(
         (select sum(f.amount) from fills f where f.listing_id = l.listing_id), 0)
 where l.listed_amount is null;

alter table listings alter column listed_amount set default 0;
update listings set listed_amount = 0 where listed_amount is null;
alter table listings alter column listed_amount set not null;

-- The remaining amount can never be negative. This is the assertion the old
-- decrementing code silently violated.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'listings_amount_non_negative'
  ) then
    alter table listings add constraint listings_amount_non_negative check (amount >= 0);
  end if;
end $$;
