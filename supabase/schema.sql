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
