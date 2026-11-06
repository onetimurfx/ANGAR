-- Public bucket for product photos. Reading is public (they are shop photos); uploads happen only through
-- admin Edge Functions (service_role) in Phase 6, so no write policy exists for anon/authenticated.
-- Guarded so the migration also runs on a plain Postgres without Supabase Storage (local tests).
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') and to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('product-images', 'product-images', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
    on conflict (id) do nothing;
  end if;
end $$;
