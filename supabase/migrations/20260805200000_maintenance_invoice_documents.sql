alter table public.maintenance_request_attachments
  drop constraint if exists maintenance_request_attachments_kind_check;

alter table public.maintenance_request_attachments
  add constraint maintenance_request_attachments_kind_check
  check (kind in ('image', 'video', 'document'));
