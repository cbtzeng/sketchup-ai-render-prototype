-- 002_upload_batches.sql
--
-- 補上 001 遺漏的 upload_batches 表。
--
-- 為什麼需要它：POST /v1/uploads 發出一組簽名 URL 後，POST /v1/jobs 必須知道
-- 「這次要認領的是哪一組」。沒有這張表的話，雲端只能猜「該使用者最近一個
-- 未認領的批次」—— 同一個帳號在兩台機器同時擷取，就會把別人的控制圖
-- 接到你的 job 上。那是會產生錯誤帳單與錯誤結果、而且極難查的 bug。
--
-- Ruby 端已配合修正：request_upload_urls 回傳 batch id → create_job 帶回去。
-- 見 docs/journal/main/007-上傳完整性校驗的位置.md

create table public.upload_batches (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,

  -- 這次發了哪些 pass 的 URL，例如 ["beauty","edge","depth"]。
  -- 用來在 create_job 時檢查「宣稱的控制圖」與「實際發過 URL 的」是否一致。
  passes       text[] not null,

  -- 每個 pass 在 storage 裡的物件路徑，形如 {"beauty": "u/<uid>/<batch>/beauty.png"}。
  paths        jsonb  not null,

  -- 被哪個 job 認領。null = 尚未認領。
  claimed_by   uuid references public.jobs (id) on delete set null,
  claimed_at   timestamptz,

  -- 簽名 URL 的到期時間。過期的批次不該再被認領。
  expires_at   timestamptz not null,
  created_at   timestamptz not null default now(),

  constraint upload_batches_passes_not_empty check (array_length(passes, 1) > 0)
);

-- create_job 要找「這個使用者、未認領、未過期」的批次。
create index upload_batches_user_open_idx
  on public.upload_batches (user_id, created_at desc)
  where claimed_by is null;

-- 一個批次只能被認領一次。並發的兩個 create_job 只有一個會成功 ——
-- 這是防止「兩個 job 共用同一組控制圖」的最後一道鎖。
create unique index upload_batches_claimed_by_uidx
  on public.upload_batches (claimed_by)
  where claimed_by is not null;

-- 清掉過期且未認領的批次時會用到。
create index upload_batches_expiry_idx
  on public.upload_batches (expires_at)
  where claimed_by is null;

alter table public.upload_batches enable row level security;
alter table public.upload_batches force row level security;

-- 與其他表一致：使用者只讀得到自己的。寫入一律走 service role。
create policy upload_batches_select_own on public.upload_batches
  for select using (user_id = auth.uid());

comment on table public.upload_batches is
  '一次 POST /v1/uploads 發出的簽名 URL 群組。create_job 用 id 認領，'
  '避免同帳號多機器並發時取錯批次。';
