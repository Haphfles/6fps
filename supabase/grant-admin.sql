-- First create your own confirmed email/password user in Supabase Authentication.
-- Replace the email below with YOUR email, then run this in the SQL Editor.
-- Never put a password or service-role key in this file.
do $$
declare chosen_user uuid;
begin
  select id into chosen_user from auth.users
    where lower(email) = lower('YOUR_EMAIL_HERE')
      and is_anonymous is false and email_confirmed_at is not null;
  if chosen_user is null then
    raise exception 'No confirmed, non-anonymous user found. Create your user and replace YOUR_EMAIL_HERE first.';
  end if;
  insert into public.sixfps_admins(user_id) values (chosen_user) on conflict do nothing;
end $$;
