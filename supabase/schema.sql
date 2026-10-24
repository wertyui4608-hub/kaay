-- KAAY 64기 계정 & 체력 기록 클라우드 동기화 스키마
-- Supabase 대시보드 > SQL Editor 에 전체를 붙여넣고 Run 하세요.

-- ========================================================
-- 1. profiles (회원 프로필)
-- ========================================================
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  name text not null,
  created_at timestamptz default now()
);

alter table public.profiles add column if not exists username text unique;
alter table public.profiles add column if not exists name text;
alter table public.profiles add column if not exists created_at timestamptz default now();

alter table public.profiles enable row level security;

drop policy if exists "own profile select" on public.profiles;
create policy "own profile select" on public.profiles
  for select using (auth.uid() = id);

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username, name)
  values (new.id, new.raw_user_meta_data->>'username', new.raw_user_meta_data->>'name');
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();


-- ========================================================
-- 2. fitness_records (체력 측정 기록 - 폰/PC 다중 기기 실시간 동기화)
-- ========================================================
create table if not exists public.fitness_records (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  mode text not null,
  date text not null,
  val_display text not null,
  numeric_val numeric not null,
  grade text not null,
  badge_class text not null,
  gender text,
  age text,
  created_at timestamptz default now()
);

-- RLS 활성화 (오직 본인 계정만 읽고 쓰기 가능)
alter table public.fitness_records enable row level security;

drop policy if exists "own fitness select" on public.fitness_records;
create policy "own fitness select" on public.fitness_records
  for select using (auth.uid() = user_id);

drop policy if exists "own fitness insert" on public.fitness_records;
create policy "own fitness insert" on public.fitness_records
  for insert with check (auth.uid() = user_id);

drop policy if exists "own fitness update" on public.fitness_records;
create policy "own fitness update" on public.fitness_records
  for update using (auth.uid() = user_id);

drop policy if exists "own fitness delete" on public.fitness_records;
create policy "own fitness delete" on public.fitness_records
  for delete using (auth.uid() = user_id);


-- ========================================================
-- 3. fitness_records 확장 (메모 · 기록 출처)
--    source: 'test' = 2분/3km 측정 입력, 'set' = 훈련 세트 최대값 자동 반영
-- ========================================================
alter table public.fitness_records add column if not exists memo text;
alter table public.fitness_records add column if not exists source text default 'test';


-- ========================================================
-- 4. workout_logs (하루 훈련 세트 일지 - 종목별 1건)
--    sets: 팔굽혀펴기/윗몸 = [30, 25, 20] (세트당 횟수)
--          달리기         = [{"km": 5, "sec": 1800, "max": false}]
-- ========================================================
create table if not exists public.workout_logs (
  id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  date text not null,
  mode text not null,
  sets jsonb not null default '[]'::jsonb,
  note text,
  updated_at timestamptz default now(),
  primary key (user_id, id)
);

alter table public.workout_logs enable row level security;

drop policy if exists "own workout select" on public.workout_logs;
create policy "own workout select" on public.workout_logs
  for select using (auth.uid() = user_id);

drop policy if exists "own workout insert" on public.workout_logs;
create policy "own workout insert" on public.workout_logs
  for insert with check (auth.uid() = user_id);

drop policy if exists "own workout update" on public.workout_logs;
create policy "own workout update" on public.workout_logs
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own workout delete" on public.workout_logs;
create policy "own workout delete" on public.workout_logs
  for delete using (auth.uid() = user_id);


-- ========================================================
-- 5. user_settings (코치 플랜 설정: 목표 등급 · 임시 기준값 · 일정)
-- ========================================================
create table if not exists public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz default now()
);

alter table public.user_settings enable row level security;

drop policy if exists "own settings select" on public.user_settings;
create policy "own settings select" on public.user_settings
  for select using (auth.uid() = user_id);

drop policy if exists "own settings insert" on public.user_settings;
create policy "own settings insert" on public.user_settings
  for insert with check (auth.uid() = user_id);

drop policy if exists "own settings update" on public.user_settings;
create policy "own settings update" on public.user_settings
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
