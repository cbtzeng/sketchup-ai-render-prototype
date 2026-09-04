-- 003_retry_index.sql
--
-- 退避重送排程器（cloud/lib/retry-scheduler.ts）每次掃描都要找出
-- 「status = 'retrying' 且退避時間已到」的 job。沒有索引的話那是全表掃描，
-- job 累積之後每次掃描都會變慢，而它是被 cron 定期呼叫的。

-- 部分索引：只涵蓋 retrying。其他狀態的 row 完全不佔索引空間，
-- 而它們本來就不是這個查詢的對象。
create index jobs_retry_due_idx
  on public.jobs (next_attempt_at)
  where status = 'retrying';

comment on index public.jobs_retry_due_idx is
  'retry-scheduler 掃描待重送 job 用。next_attempt_at 在進入 retrying 時寫定，'
  '語意為「這次何時可以重送」；重送出去後會被清成 null。';
