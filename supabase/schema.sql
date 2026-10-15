-- KAAY 64기 계정 스키마 (충돌 방지 및 재실행 안전 버전)
-- Supabase 대시보드 > SQL Editor 에 전체를 붙여넣고 Run 하세요.

-- 만약 기존 profiles 테이블을 완전히 초기화하고 깨끗하게 다시 만들고 싶다면
-- 아래 주석 2줄의 맨 앞 '--' 를 지우고 실행하시면 됩니다:
-- drop trigger if exists on_auth_user_created on auth.users;
-- drop table if exists public.profiles cascade;

-- 1. profiles 테이블 생성 (이미 있으면 유지)
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  name text not null,
  created_at timestamptz default now()
);

-- 혹시 기존 profiles 테이블에 username, name 컬럼이 없을 경우를 대비해 컬럼 추가 보장
alter table public.profiles add column if not exists username text unique;
alter table public.profiles add column if not exists name text;
alter table public.profiles add column if not exists created_at timestamptz default now();

-- 2. RLS(행 단위 보안) 활성화
alter table public.profiles enable row level security;

-- 3. RLS 정책 (기존 정책 삭제 후 재생성)
drop policy if exists "own profile select" on public.profiles;
create policy "own profile select" on public.profiles
  for select using (auth.uid() = id);

-- 4. 신규 유저 생성 트리거 함수
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username, name)
  values (new.id, new.raw_user_meta_data->>'username', new.raw_user_meta_data->>'name');
  return new;
end; $$;

-- 5. 트리거 연결 (기존 트리거 삭제 후 재생성)
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();
