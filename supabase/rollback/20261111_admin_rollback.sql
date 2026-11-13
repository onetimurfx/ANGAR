-- ROLLBACK of migration 20261111000001_admin_panel.sql (stage E: admin panel).
-- Run it BEFORE 20261109_pickup_rollback.sql if both are needed. Touches no Cart / Quick Order data.
-- It REFUSES while the audit log or stock adjustments hold rows: they are history, export them first.
begin;
do $$
begin
  if exists (select 1 from public.admin_audit_log) or exists (select 1 from public.stock_adjustments) then
    raise exception 'ADMIN_DATA_EXISTS: export admin_audit_log and stock_adjustments and clear them explicitly before rolling back';
  end if;
end $$;
drop function
  public.admin_add_product_image(bigint, text, text),
  public.admin_adjust_stock(bigint, uuid, text, integer, text),
  public.admin_audit(bigint, text, text, text, jsonb),
  public.admin_dashboard(bigint, integer),
  public.admin_delete_category(bigint, text),
  public.admin_delete_product_image(bigint, uuid),
  public.admin_get_customer(bigint, uuid),
  public.admin_get_order(bigint, uuid),
  public.admin_get_product(bigint, text),
  public.admin_get_settings(bigint),
  public.admin_like(text),
  public.admin_list_brands(bigint),
  public.admin_list_categories(bigint),
  public.admin_list_customers(bigint, text, integer, integer),
  public.admin_me(bigint),
  public.admin_save_brand(bigint, text, text, text, boolean),
  public.admin_save_category(bigint, text, text, integer, boolean),
  public.admin_save_product(bigint, jsonb),
  public.admin_set_cover_image(bigint, uuid),
  public.admin_set_order_delivery(bigint, uuid, integer),
  public.admin_set_order_status(bigint, uuid, text, text),
  public.admin_set_product_active(bigint, text, boolean),
  public.admin_slug(text),
  public.admin_update_pickup_settings(bigint, jsonb),
  public.admin_update_settings(bigint, jsonb);
drop table public.admin_audit_log, public.stock_adjustments;
alter table public.order_status_history drop column note;
commit;
