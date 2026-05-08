-- =============================================================================
-- CareerBoost — avatars storage bucket + policies
-- =============================================================================
-- Public-read bucket. Users can only write objects under a path that starts
-- with their own user_id, e.g. "<uuid>/avatar-<ts>.jpg".
-- Avatars are not sensitive and the URL is effectively unguessable when
-- uploaded under a random filename — public read is fine.
-- =============================================================================

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do update set public = excluded.public;

-- Drop old policies if re-running the migration.
drop policy if exists "avatars_public_read"  on storage.objects;
drop policy if exists "avatars_owner_insert" on storage.objects;
drop policy if exists "avatars_owner_update" on storage.objects;
drop policy if exists "avatars_owner_delete" on storage.objects;

-- Public read — anyone can fetch an avatar URL.
create policy "avatars_public_read"
  on storage.objects for select
  to public
  using (bucket_id = 'avatars');

-- Owner-only writes: first path segment must equal the user's UUID.
create policy "avatars_owner_insert"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "avatars_owner_update"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "avatars_owner_delete"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
