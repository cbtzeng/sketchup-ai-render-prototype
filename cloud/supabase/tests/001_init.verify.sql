-- =============================================================================
-- 001_init.verify.sql —— migration 的行為驗證（RLS / append-only / 原子額度）
--
-- 執行方式（需要 docker）：  npm run test:sql
-- 或手動：psql -f supabase/tests/_auth_stub.sql -f supabase/migrations/001_init.sql -f 本檔
--
-- 這份不是自動斷言的測試 —— 它印出結果，由人比對「預期」註解。
-- 標 ERROR 的區段**必須**出現錯誤；那才是通過。
-- =============================================================================
\set ON_ERROR_STOP off
insert into auth.users (id) values
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222');
insert into public.jobs (id, user_id, idempotency_key, preset_version)
values ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','key-a','v1'),
       ('bbbbbbbb-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','key-b','v1');
insert into public.job_events (job_id, from_status, to_status)
values ('aaaaaaaa-0000-0000-0000-000000000001', null, 'created'),
       ('bbbbbbbb-0000-0000-0000-000000000002', null, 'created');
insert into public.assets (job_id, kind, storage_path, upload_state)
values ('aaaaaaaa-0000-0000-0000-000000000001','beauty','p/a.png','pending');

\echo ''
\echo '=== [1] jobs.idempotency_key unique index（預期 ERROR） ==='
insert into public.jobs (user_id, idempotency_key, preset_version)
values ('22222222-2222-2222-2222-222222222222','key-a','v1');

\echo ''
\echo '=== [2] job_events append-only（預期兩個 ERROR） ==='
update public.job_events set to_status='succeeded';
delete from public.job_events;

\echo ''
\echo '=== [3] RLS：user1 只看得到自己的 row（每張表都應為 1） ==='
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111"}';
select current_user, 'jobs' as t, count(*) from public.jobs
union all select current_user, 'job_events', count(*) from public.job_events
union all select current_user, 'assets', count(*) from public.assets
union all select current_user, 'usage_daily', count(*) from public.usage_daily;
commit;

\echo ''
\echo '=== [4] RLS：user2 只看得到自己那一筆 job ==='
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222"}';
select id from public.jobs;
commit;

\echo ''
\echo '=== [5] RLS：未登入（anon）看不到任何 row ==='
begin;
set local role anon;
select count(*) as anon_visible_jobs from public.jobs;
commit;

\echo ''
\echo '=== [6] RLS：authenticated 不得寫入 jobs（預期 ERROR） ==='
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222"}';
insert into public.jobs (user_id, idempotency_key, preset_version)
values ('22222222-2222-2222-2222-222222222222','key-c','v1');
rollback;

\echo ''
\echo '=== [7] reserve_daily_quota：40 次請求只放行 30 次 ==='
select count(*) filter (where ok) as allowed, count(*) filter (where not ok) as denied
from (select (public.reserve_daily_quota('11111111-1111-1111-1111-111111111111','2026-09-04',1,1,30,200)).*
      from generate_series(1,40)) s;
select jobs_count, cents_spent from public.usage_daily
where user_id='11111111-1111-1111-1111-111111111111';

\echo ''
\echo '=== [8] reserve_daily_quota：當天第一筆就超過金額上限也要擋（回歸測試） ==='
select ok, jobs_count, cents_spent, exceeded from public.reserve_daily_quota(
  '22222222-2222-2222-2222-222222222222','2026-09-04',1,250,30,200);
select count(*) as rows_written from public.usage_daily
where user_id='22222222-2222-2222-2222-222222222222';

\echo ''
\echo '=== [9] reserve_daily_quota：金額先達上限時 exceeded=cents ==='
select ok, cents_spent, exceeded from public.reserve_daily_quota(
  '22222222-2222-2222-2222-222222222222','2026-09-04',1,150,30,200);
select ok, cents_spent, exceeded from public.reserve_daily_quota(
  '22222222-2222-2222-2222-222222222222','2026-09-04',1,150,30,200);
