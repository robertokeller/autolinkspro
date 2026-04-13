-- Create amazon_affiliate_tags table
create table if not exists public.amazon_affiliate_tags (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  affiliate_tag text not null,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),

  -- Constraints
  constraint affiliate_tag_not_empty check (char_length(affiliate_tag) > 0),
  unique(user_id)
);

-- Enable RLS
alter table public.amazon_affiliate_tags enable row level security;

-- Create policies (idempotent)
do $$ begin
  create policy "Users can view their own amazon affiliate tags"
    on public.amazon_affiliate_tags
    for select
    using (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "Users can insert their own amazon affiliate tags"
    on public.amazon_affiliate_tags
    for insert
    with check (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "Users can update their own amazon affiliate tags"
    on public.amazon_affiliate_tags
    for update
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "Users can delete their own amazon affiliate tags"
    on public.amazon_affiliate_tags
    for delete
    using (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

-- Create indexes (idempotent via IF NOT EXISTS)
create index if not exists idx_amazon_affiliate_tags_user_id on public.amazon_affiliate_tags(user_id);
create index if not exists idx_amazon_affiliate_tags_created_at on public.amazon_affiliate_tags(created_at);
