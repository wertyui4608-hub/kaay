-- KAAY 64기 계정 스키마
-- Supabase 대시보드 > SQL Editor 에 전체를 붙여넣고 Run 하세요. (최초 1회)

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  name text not null,
  created_at timestamptz default now()
);
alter table public.profiles enable row level security;
create policy "own profile select" on public.profiles
  for select using (auth.uid() = id);

create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username, name)
  values (new.id, new.raw_user_meta_data->>'username', new.raw_user_meta_data->>'name');
  return new;
end; $$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();
