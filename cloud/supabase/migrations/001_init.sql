-- =============================================================================
-- 001_init.sql —— ArchitechRender 雲端層初始 schema
--
-- 對應 docs/architecture.md 2.3 節的四張表：
--   jobs / job_events / assets / usage_daily
--
-- 三個硬性要求：
--   1. job_events 為 append-only（只能 INSERT，UPDATE / DELETE 一律拒絕）
--   2. jobs.idempotency_key 有 unique index
--   3. RLS 開啟，使用者只能讀自己的 row
--
-- 寫入模型：所有寫入都走雲端的 service_role（會繞過 RLS）。
-- Ruby 層拿到的是短效的使用者 token，只有 SELECT 權限。
-- 因此本檔**不建立任何 INSERT / UPDATE / DELETE 的 RLS policy** ——
-- 沒有 policy 就是拒絕，這是刻意的預設。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 型別
-- -----------------------------------------------------------------------------

create type public.job_status as enum (
  'created',
  'queued',
  'running',
  'retrying',
  'succeeded',
  'failed',
  'cancelled',
  'expired'
);

create type public.asset_kind as enum ('beauty', 'edge', 'depth', 'result');

-- 註：upload_state 不在 architecture.md 2.3 的欄位列表內，是本實作的**擴充**。
-- 理由：created → queued 的條件是「全部 asset 上傳完成、sha256 校驗通過」，
-- 光靠 sha256 欄位無法區分「還沒上傳」與「上傳了但雜湊不符」這兩種情況。
create type public.upload_state as enum ('pending', 'uploaded', 'verified', 'mismatch');

-- -----------------------------------------------------------------------------
-- jobs
-- -----------------------------------------------------------------------------

create table public.jobs (
  id                  uuid primary key default gen_random_uuid(),

  -- 🔴 待決（open-questions Q4）：使用者身分究竟是 Supabase auth 帳號還是 device_id。
  -- 目前先綁 auth.users；若改走 device_id 模式，這個 FK 與下方所有 RLS policy 都要重寫。
  user_id             uuid not null references auth.users (id) on delete cascade,

  model_guid          text,
  scene_name          text,
  status              public.job_status not null default 'created',

  preset              text,
  -- preset_version 必填的理由：沒有它就無法重現評估結果（architecture.md 2.2）。
  preset_version      text,
  prompt              text,
  seed                bigint,
  params_json         jsonb not null default '{}'::jsonb,

  provider            text,
  provider_job_id     text,
  idempotency_key     text not null,

  -- 擴充欄位（不在 2.3 列表內）：重試狀態機需要。
  retry_count         integer not null default 0 check (retry_count >= 0 and retry_count <= 2),
  next_attempt_at     timestamptz,

  cost_estimate_cents integer not null default 0 check (cost_estimate_cents >= 0),
  cost_actual_cents   integer check (cost_actual_cents >= 0),

  created_at          timestamptz not null default now(),
  started_at          timestamptz,
  finished_at         timestamptz,
  error_code          text,
  error_msg           text
);

-- 【硬性要求 2】冪等去重的唯一索引。
-- idempotency_key = sha256(controls_sha256 + params_json + user_id)，
-- user_id 已經是雜湊材料的一部分，所以全域 unique 即等於「每使用者唯一」。
create unique index jobs_idempotency_key_uidx on public.jobs (idempotency_key);

-- 🔴 待決：使用者重送一個**已 failed / cancelled / expired** 的相同請求時，
-- 上面這個全域 unique index 會直接擋住 INSERT。architecture.md 第 3 節只寫了
-- 「同一個 key 若已有 succeeded 的 job，直接回傳舊結果」，沒有定義失敗後重送。
-- 兩個候選解（尚未決定，故不改動上面的索引）：
--   (a) 改成 partial unique index，讓終態失敗的 row 不佔用 key：
--         create unique index jobs_idempotency_key_uidx on public.jobs (idempotency_key)
--           where status not in ('failed', 'cancelled', 'expired');
--   (b) 把 attempt 序號加進 idempotency_key 的雜湊材料。
-- 在決定之前，API handler 必須自行處理 23505 unique violation。

create index jobs_user_status_idx on public.jobs (user_id, status);
create index jobs_provider_job_id_idx on public.jobs (provider, provider_job_id)
  where provider_job_id is not null;

-- 逾時清理（created_at + 10 min → expired）的掃描索引，只涵蓋非終態。
create index jobs_sweep_idx on public.jobs (created_at)
  where status in ('created', 'queued', 'running', 'retrying');

comment on table public.jobs is
  '算圖 job。status 的唯一寫入者是 cloud/lib/job-service.ts，不要從其他地方 UPDATE。';

-- -----------------------------------------------------------------------------
-- job_events（append-only）
-- -----------------------------------------------------------------------------

create table public.job_events (
  id          bigint generated always as identity primary key,
  job_id      uuid not null references public.jobs (id) on delete cascade,
  from_status public.job_status,          -- 建立事件為 null
  to_status   public.job_status not null,
  at          timestamptz not null default now(),
  detail_json jsonb not null default '{}'::jsonb
);

create index job_events_job_id_at_idx on public.job_events (job_id, at, id);

comment on table public.job_events is
  '狀態機軌跡，append-only。除錯與 SLA 分析全靠這張，不要只看 jobs.status。';

-- 【硬性要求 1】append-only。
-- 用 trigger 而不是只靠權限：service_role 會繞過 RLS，但繞不過 trigger。
create or replace function public.job_events_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'job_events 為 append-only，禁止 % 操作', tg_op
    using errcode = 'restrict_violation';
end;
$$;

create trigger job_events_no_update
  before update on public.job_events
  for each row execute function public.job_events_append_only();

create trigger job_events_no_delete
  before delete on public.job_events
  for each row execute function public.job_events_append_only();

-- 額外一層：連 grant 都不給（trigger 是保險，權限是第一道門）。
revoke update, delete on public.job_events from anon, authenticated;

-- -----------------------------------------------------------------------------
-- assets
-- -----------------------------------------------------------------------------

create table public.assets (
  id              uuid primary key default gen_random_uuid(),
  job_id          uuid not null references public.jobs (id) on delete cascade,
  kind            public.asset_kind not null,
  storage_path    text not null,
  width           integer check (width > 0),
  height          integer check (height > 0),

  -- 伺服器端實際算出的雜湊（權威值）。上傳完成前為 null。
  sha256          text check (sha256 ~ '^[0-9a-f]{64}$'),
  -- 擴充欄位：Ruby 層在取簽名 URL 時宣告的雜湊，用來比對。
  sha256_declared text check (sha256_declared ~ '^[0-9a-f]{64}$'),
  upload_state    public.upload_state not null default 'pending',

  created_at      timestamptz not null default now()
);

-- 一個 job 的每種 kind 只會有一張（result 亦同；多結果圖需要先改這條約束）。
create unique index assets_job_kind_uidx on public.assets (job_id, kind);
-- 控制圖去重與快取命中的依據（architecture.md 2.3）。
create index assets_sha256_idx on public.assets (sha256) where sha256 is not null;

-- -----------------------------------------------------------------------------
-- usage_daily（成本護欄的計數來源）
-- -----------------------------------------------------------------------------

create table public.usage_daily (
  user_id     uuid not null references auth.users (id) on delete cascade,
  day         date not null,
  jobs_count  integer not null default 0 check (jobs_count >= 0),
  cents_spent integer not null default 0 check (cents_spent >= 0),
  primary key (user_id, day)
);

comment on table public.usage_daily is
  '每日用量。只能透過 reserve_daily_quota() 遞增，不要直接 UPDATE，否則會有 race。';

-- -----------------------------------------------------------------------------
-- 原子式額度預留
--
-- 「檢查上限」與「遞增計數」必須在同一個 statement 內完成，
-- 否則兩個併發請求會同時讀到 29 然後都通過檢查，變成 31 個 job。
-- ON CONFLICT DO UPDATE ... WHERE 就是這個原子操作：
-- WHERE 條件不成立時不更新，RETURNING 就回不到 row，據此判定被擋。
-- -----------------------------------------------------------------------------

create or replace function public.reserve_daily_quota(
  p_user_id     uuid,
  p_day         date,
  p_add_jobs    integer,
  p_add_cents   integer,
  p_jobs_limit  integer,
  p_cents_limit integer
)
returns table (
  ok          boolean,
  jobs_count  integer,
  cents_spent integer,
  exceeded    text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_jobs  integer;
  v_cents integer;
begin
  -- 注意 INSERT 用的是 `select ... where`，不是 `values`。
  -- 用 values 的話，當天的**第一筆**會直接插入而完全跳過上限檢查
  -- （ON CONFLICT 的 WHERE 只在真的發生衝突時才會被評估）——
  -- 那會讓「單一請求就超過每日金額上限」的情況直接放行。
  insert into public.usage_daily as u (user_id, day, jobs_count, cents_spent)
  select p_user_id, p_day, p_add_jobs, p_add_cents
  where p_add_jobs <= p_jobs_limit
    and p_add_cents <= p_cents_limit
  on conflict (user_id, day) do update
    set jobs_count  = u.jobs_count + p_add_jobs,
        cents_spent = u.cents_spent + p_add_cents
    where u.jobs_count + p_add_jobs <= p_jobs_limit
      and u.cents_spent + p_add_cents <= p_cents_limit
  returning u.jobs_count, u.cents_spent into v_jobs, v_cents;

  if found then
    return query select true, v_jobs, v_cents, null::text;
    return;
  end if;

  -- 沒有更新成功：可能是超限，也可能是第一次插入就超限。
  select u.jobs_count, u.cents_spent into v_jobs, v_cents
  from public.usage_daily u
  where u.user_id = p_user_id and u.day = p_day;

  v_jobs  := coalesce(v_jobs, 0);
  v_cents := coalesce(v_cents, 0);

  return query select
    false,
    v_jobs,
    v_cents,
    case when v_jobs + p_add_jobs > p_jobs_limit then 'jobs' else 'cents' end;
end;
$$;

revoke all on function public.reserve_daily_quota(uuid, date, integer, integer, integer, integer)
  from anon, authenticated;

-- -----------------------------------------------------------------------------
-- 【硬性要求 3】RLS：使用者只能讀自己的 row
--
-- 只給 SELECT policy。沒有 INSERT / UPDATE / DELETE policy = 一律拒絕，
-- 所有寫入必須經由持有 service_role key 的雲端函式。
-- -----------------------------------------------------------------------------

alter table public.jobs        enable row level security;
alter table public.job_events  enable row level security;
alter table public.assets      enable row level security;
alter table public.usage_daily enable row level security;

-- 連 table owner 也套用 RLS，避免 owner 身分意外繞過。
alter table public.jobs        force row level security;
alter table public.job_events  force row level security;
alter table public.assets      force row level security;
alter table public.usage_daily force row level security;

create policy jobs_select_own on public.jobs
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy job_events_select_own on public.job_events
  for select to authenticated
  using (
    exists (
      select 1 from public.jobs j
      where j.id = job_events.job_id
        and j.user_id = (select auth.uid())
    )
  );

create policy assets_select_own on public.assets
  for select to authenticated
  using (
    exists (
      select 1 from public.jobs j
      where j.id = assets.job_id
        and j.user_id = (select auth.uid())
    )
  );

create policy usage_daily_select_own on public.usage_daily
  for select to authenticated
  using (user_id = (select auth.uid()));

-- =============================================================================
-- 驗證（Phase 2 Task 2.1）：`supabase db reset` 後在 SQL editor 執行
--
--   set local role authenticated;
--   set local request.jwt.claims = '{"sub":"<別人的 user_id>"}';
--   select count(*) from public.jobs;        -- 必須是 0
--   select count(*) from public.job_events;  -- 必須是 0
--   update public.job_events set to_status = 'succeeded' where true;
--                                            -- 必須拋 restrict_violation
--
-- ⚠️ 本檔尚未在真實 Postgres 上執行過（本機無 psql / 未起 supabase local）。
--    在跑過 `supabase db reset` 之前，視為未驗證。
-- =============================================================================
