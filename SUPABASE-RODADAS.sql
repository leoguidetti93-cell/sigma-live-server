create table if not exists public.sigma_double_rounds (
  round_id text primary key,
  roll smallint not null check (roll between 0 and 14),
  color smallint not null check (color between 0 and 2),
  created_at timestamptz not null,
  updated_at timestamptz null,
  status text not null default 'complete',
  payload jsonb not null default '{}'::jsonb,
  stored_at timestamptz not null default now()
);

create index if not exists sigma_double_rounds_created_at_idx
  on public.sigma_double_rounds (created_at desc);

alter table public.sigma_double_rounds enable row level security;

-- O servidor usa a Secret Key do Supabase. Nenhuma política pública é necessária.