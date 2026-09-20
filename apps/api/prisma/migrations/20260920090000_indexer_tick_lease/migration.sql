-- A lease so two ticks cannot index the same stream at once.
--
-- The `FOR UPDATE` lock inside a batch serialises writers, but it makes a
-- second arrival WAIT and then do the work anyway. A scheduler that fires every
-- minute needs the opposite: the second tick must find the stream busy and
-- leave immediately. An expiring lease also self-heals — a process killed
-- mid-tick releases nothing, and the next tick takes over once it lapses.
ALTER TABLE "IndexerCursor" ADD COLUMN "tickLeaseOwner" TEXT;
ALTER TABLE "IndexerCursor" ADD COLUMN "tickLeaseUntil" TIMESTAMP(3);
