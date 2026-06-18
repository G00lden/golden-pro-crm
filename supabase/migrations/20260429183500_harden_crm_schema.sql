create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create index if not exists installations_customer_id_idx on public.installations(customer_id);
create index if not exists installations_product_id_idx on public.installations(product_id);

create index if not exists bookings_installation_id_idx on public.bookings(installation_id);
create index if not exists bookings_customer_id_idx on public.bookings(customer_id);
create index if not exists bookings_product_id_idx on public.bookings(product_id);
create index if not exists bookings_technician_id_idx on public.bookings(technician_id);

create index if not exists reminders_installation_id_idx on public.reminders(installation_id);
create index if not exists reminders_customer_id_idx on public.reminders(customer_id);
create index if not exists reminders_product_id_idx on public.reminders(product_id);

create index if not exists technician_notifications_booking_id_idx on public.technician_notifications(booking_id);
create index if not exists technician_notifications_technician_id_idx on public.technician_notifications(technician_id);
create index if not exists technician_notifications_customer_id_idx on public.technician_notifications(customer_id);
create index if not exists technician_notifications_product_id_idx on public.technician_notifications(product_id);

drop policy if exists customers_owner_access on public.customers;
drop policy if exists products_owner_access on public.products;
drop policy if exists installations_owner_access on public.installations;
drop policy if exists technicians_owner_access on public.technicians;
drop policy if exists bookings_owner_access on public.bookings;
drop policy if exists reminders_owner_access on public.reminders;
drop policy if exists settings_owner_access on public.settings;
drop policy if exists store_orders_owner_access on public.store_orders;
drop policy if exists store_webhook_events_owner_access on public.store_webhook_events;
drop policy if exists technician_notifications_owner_access on public.technician_notifications;

create policy customers_owner_access on public.customers
  for all using (owner_uid = (select auth.uid())::text) with check (owner_uid = (select auth.uid())::text);
create policy products_owner_access on public.products
  for all using (owner_uid = (select auth.uid())::text) with check (owner_uid = (select auth.uid())::text);
create policy installations_owner_access on public.installations
  for all using (owner_uid = (select auth.uid())::text) with check (owner_uid = (select auth.uid())::text);
create policy technicians_owner_access on public.technicians
  for all using (owner_uid = (select auth.uid())::text) with check (owner_uid = (select auth.uid())::text);
create policy bookings_owner_access on public.bookings
  for all using (owner_uid = (select auth.uid())::text) with check (owner_uid = (select auth.uid())::text);
create policy reminders_owner_access on public.reminders
  for all using (owner_uid = (select auth.uid())::text) with check (owner_uid = (select auth.uid())::text);
create policy settings_owner_access on public.settings
  for all using (owner_uid = (select auth.uid())::text) with check (owner_uid = (select auth.uid())::text);
create policy store_orders_owner_access on public.store_orders
  for all using (owner_uid = (select auth.uid())::text) with check (owner_uid = (select auth.uid())::text);
create policy store_webhook_events_owner_access on public.store_webhook_events
  for all using (owner_uid = (select auth.uid())::text) with check (owner_uid = (select auth.uid())::text);
create policy technician_notifications_owner_access on public.technician_notifications
  for all using (owner_uid = (select auth.uid())::text) with check (owner_uid = (select auth.uid())::text);
