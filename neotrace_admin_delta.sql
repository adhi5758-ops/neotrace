-- =====================================================================
-- NEOTRACE — ADMIN: matriks peran/hak akses WMS, dukungan data induk
-- PT Neopangan Selaras Indonesia (Neofood) · Sauce Division
--
-- CAKUPAN
--   1. Matriks peran/hak akses WMS dari wms_roles_permissions_matrix.csv
--      (6 peran x 17 modul). Ini LAPISAN BARU untuk menu Administrator —
--      TIDAK menggantikan profiles.role / user_role yang sudah menegakkan
--      RLS di seluruh v1 + Fase 1-4. Aditif, tanpa risiko ke schema lama.
--   2. profiles.wms_role_id — penanda peran WMS per pengguna, murni untuk
--      visibilitas menu Administrator, bukan input RLS tabel operasional.
--   3. Data induk (items/partners/locations) sudah ada dari v1 — di sini
--      tidak ada perubahan skema, hanya kolom wms_role_id di atas.
--
-- PRASYARAT: v1 + neotrace_phase1_delta.sql (untuk current_role_is, profiles).
-- =====================================================================

create type wms_permission_level as enum ('NO_ACCESS','VIEW_ONLY','VIEW_EDIT','FULL_CONTROL');

create table wms_roles (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique,
  name       text not null,
  sort_order smallint not null default 0
);

create table wms_modules (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique,
  category   text not null,
  name       text not null,
  sort_order smallint not null default 0
);

create table wms_role_permissions (
  role_id   uuid not null references wms_roles(id) on delete cascade,
  module_id uuid not null references wms_modules(id) on delete cascade,
  level     wms_permission_level not null default 'NO_ACCESS',
  primary key (role_id, module_id)
);

alter table profiles add column if not exists wms_role_id uuid references wms_roles(id);

-- =====================================================================
-- RLS — baca: siapa saja yang aktif; tulis: hanya ADMIN (peran aplikasi,
-- bukan peran WMS — menghindari lingkaran "siapa boleh mengubah siapa").
-- =====================================================================
alter table wms_roles             enable row level security;
alter table wms_modules           enable row level security;
alter table wms_role_permissions  enable row level security;

create policy p_read_wms_roles on wms_roles for select to authenticated
  using (exists (select 1 from profiles where id = auth.uid() and is_active));
create policy p_read_wms_modules on wms_modules for select to authenticated
  using (exists (select 1 from profiles where id = auth.uid() and is_active));
create policy p_read_wms_role_permissions on wms_role_permissions for select to authenticated
  using (exists (select 1 from profiles where id = auth.uid() and is_active));

create policy p_admin_wms_roles on wms_roles for all to authenticated
  using (current_role_is('ADMIN')) with check (current_role_is('ADMIN'));
create policy p_admin_wms_modules on wms_modules for all to authenticated
  using (current_role_is('ADMIN')) with check (current_role_is('ADMIN'));
create policy p_admin_wms_role_permissions on wms_role_permissions for all to authenticated
  using (current_role_is('ADMIN')) with check (current_role_is('ADMIN'));

-- =====================================================================
-- SEED — transkripsi persis dari wms_roles_permissions_matrix.csv
-- =====================================================================
insert into wms_roles (code, name, sort_order) values
 ('WAREHOUSE_MANAGER',    'Warehouse Manager',    1),
 ('INVENTORY_CONTROL',    'Inventory Control',    2),
 ('INBOUND_SUPERVISOR',   'Inbound Supervisor',   3),
 ('OUTBOUND_SUPERVISOR',  'Outbound Supervisor',  4),
 ('WAREHOUSE_ASSOCIATE',  'Warehouse Associate',  5),
 ('SYSTEM_ADMINISTRATOR', 'System Administrator', 6)
on conflict (code) do nothing;

insert into wms_modules (code, category, name, sort_order) values
 ('INBOUND_RECEIVE_ASN',         'Inbound',     'Receive ASNs',             1),
 ('INBOUND_GOODS_RECEIPT',       'Inbound',     'Goods Receipt',            2),
 ('INBOUND_PUTAWAY',             'Inbound',     'Putaway',                  3),
 ('INVENTORY_CYCLE_COUNT',       'Inventory',   'Cycle Counting',           4),
 ('INVENTORY_STOCK_TRANSFER',    'Inventory',   'Stock Transfers',          5),
 ('INVENTORY_ADJUSTMENT',        'Inventory',   'Adjustments',              6),
 ('OUTBOUND_PICK_PACK',          'Outbound',    'Pick & Pack',              7),
 ('OUTBOUND_STAGING_SHIPPING',   'Outbound',    'Staging & Shipping',       8),
 ('OUTBOUND_MANIFESTING',        'Outbound',    'Manifesting',              9),
 ('MASTERDATA_ITEM_CATALOG',     'Master Data', 'Item Catalog',            10),
 ('MASTERDATA_LOCATIONS_ZONES',  'Master Data', 'Locations & Zones',       11),
 ('MASTERDATA_VENDORS_CUSTOMERS','Master Data', 'Vendors/Customers',       12),
 ('SYSTEM_USER_MGMT',            'System',      'User Management',        13),
 ('SYSTEM_CONFIG_RULES',         'System',      'Configuration/Rules',    14),
 ('SYSTEM_INTEGRATION_LOGS',     'System',      'Integration Logs',       15),
 ('REPORTING_OPERATIONAL',       'Reporting',   'Operational Dashboards', 16),
 ('REPORTING_FINANCIAL_AUDIT',   'Reporting',   'Financial/Audit Logs',   17)
on conflict (code) do nothing;

insert into wms_role_permissions (role_id, module_id, level)
select r.id, m.id, v.level::wms_permission_level
from (values
  ('INBOUND_RECEIVE_ASN','WAREHOUSE_MANAGER','FULL_CONTROL'),
  ('INBOUND_RECEIVE_ASN','INVENTORY_CONTROL','VIEW_ONLY'),
  ('INBOUND_RECEIVE_ASN','INBOUND_SUPERVISOR','FULL_CONTROL'),
  ('INBOUND_RECEIVE_ASN','OUTBOUND_SUPERVISOR','NO_ACCESS'),
  ('INBOUND_RECEIVE_ASN','WAREHOUSE_ASSOCIATE','VIEW_EDIT'),
  ('INBOUND_RECEIVE_ASN','SYSTEM_ADMINISTRATOR','FULL_CONTROL'),

  ('INBOUND_GOODS_RECEIPT','WAREHOUSE_MANAGER','FULL_CONTROL'),
  ('INBOUND_GOODS_RECEIPT','INVENTORY_CONTROL','VIEW_ONLY'),
  ('INBOUND_GOODS_RECEIPT','INBOUND_SUPERVISOR','FULL_CONTROL'),
  ('INBOUND_GOODS_RECEIPT','OUTBOUND_SUPERVISOR','NO_ACCESS'),
  ('INBOUND_GOODS_RECEIPT','WAREHOUSE_ASSOCIATE','VIEW_EDIT'),
  ('INBOUND_GOODS_RECEIPT','SYSTEM_ADMINISTRATOR','FULL_CONTROL'),

  ('INBOUND_PUTAWAY','WAREHOUSE_MANAGER','FULL_CONTROL'),
  ('INBOUND_PUTAWAY','INVENTORY_CONTROL','VIEW_ONLY'),
  ('INBOUND_PUTAWAY','INBOUND_SUPERVISOR','FULL_CONTROL'),
  ('INBOUND_PUTAWAY','OUTBOUND_SUPERVISOR','NO_ACCESS'),
  ('INBOUND_PUTAWAY','WAREHOUSE_ASSOCIATE','FULL_CONTROL'),
  ('INBOUND_PUTAWAY','SYSTEM_ADMINISTRATOR','FULL_CONTROL'),

  ('INVENTORY_CYCLE_COUNT','WAREHOUSE_MANAGER','FULL_CONTROL'),
  ('INVENTORY_CYCLE_COUNT','INVENTORY_CONTROL','FULL_CONTROL'),
  ('INVENTORY_CYCLE_COUNT','INBOUND_SUPERVISOR','VIEW_ONLY'),
  ('INVENTORY_CYCLE_COUNT','OUTBOUND_SUPERVISOR','VIEW_ONLY'),
  ('INVENTORY_CYCLE_COUNT','WAREHOUSE_ASSOCIATE','VIEW_EDIT'),
  ('INVENTORY_CYCLE_COUNT','SYSTEM_ADMINISTRATOR','FULL_CONTROL'),

  ('INVENTORY_STOCK_TRANSFER','WAREHOUSE_MANAGER','FULL_CONTROL'),
  ('INVENTORY_STOCK_TRANSFER','INVENTORY_CONTROL','FULL_CONTROL'),
  ('INVENTORY_STOCK_TRANSFER','INBOUND_SUPERVISOR','VIEW_ONLY'),
  ('INVENTORY_STOCK_TRANSFER','OUTBOUND_SUPERVISOR','VIEW_ONLY'),
  ('INVENTORY_STOCK_TRANSFER','WAREHOUSE_ASSOCIATE','VIEW_EDIT'),
  ('INVENTORY_STOCK_TRANSFER','SYSTEM_ADMINISTRATOR','FULL_CONTROL'),

  ('INVENTORY_ADJUSTMENT','WAREHOUSE_MANAGER','FULL_CONTROL'),
  ('INVENTORY_ADJUSTMENT','INVENTORY_CONTROL','FULL_CONTROL'),
  ('INVENTORY_ADJUSTMENT','INBOUND_SUPERVISOR','NO_ACCESS'),
  ('INVENTORY_ADJUSTMENT','OUTBOUND_SUPERVISOR','NO_ACCESS'),
  ('INVENTORY_ADJUSTMENT','WAREHOUSE_ASSOCIATE','NO_ACCESS'),
  ('INVENTORY_ADJUSTMENT','SYSTEM_ADMINISTRATOR','FULL_CONTROL'),

  ('OUTBOUND_PICK_PACK','WAREHOUSE_MANAGER','FULL_CONTROL'),
  ('OUTBOUND_PICK_PACK','INVENTORY_CONTROL','VIEW_ONLY'),
  ('OUTBOUND_PICK_PACK','INBOUND_SUPERVISOR','NO_ACCESS'),
  ('OUTBOUND_PICK_PACK','OUTBOUND_SUPERVISOR','FULL_CONTROL'),
  ('OUTBOUND_PICK_PACK','WAREHOUSE_ASSOCIATE','FULL_CONTROL'),
  ('OUTBOUND_PICK_PACK','SYSTEM_ADMINISTRATOR','FULL_CONTROL'),

  ('OUTBOUND_STAGING_SHIPPING','WAREHOUSE_MANAGER','FULL_CONTROL'),
  ('OUTBOUND_STAGING_SHIPPING','INVENTORY_CONTROL','NO_ACCESS'),
  ('OUTBOUND_STAGING_SHIPPING','INBOUND_SUPERVISOR','NO_ACCESS'),
  ('OUTBOUND_STAGING_SHIPPING','OUTBOUND_SUPERVISOR','FULL_CONTROL'),
  ('OUTBOUND_STAGING_SHIPPING','WAREHOUSE_ASSOCIATE','VIEW_EDIT'),
  ('OUTBOUND_STAGING_SHIPPING','SYSTEM_ADMINISTRATOR','FULL_CONTROL'),

  ('OUTBOUND_MANIFESTING','WAREHOUSE_MANAGER','FULL_CONTROL'),
  ('OUTBOUND_MANIFESTING','INVENTORY_CONTROL','NO_ACCESS'),
  ('OUTBOUND_MANIFESTING','INBOUND_SUPERVISOR','NO_ACCESS'),
  ('OUTBOUND_MANIFESTING','OUTBOUND_SUPERVISOR','FULL_CONTROL'),
  ('OUTBOUND_MANIFESTING','WAREHOUSE_ASSOCIATE','NO_ACCESS'),
  ('OUTBOUND_MANIFESTING','SYSTEM_ADMINISTRATOR','FULL_CONTROL'),

  ('MASTERDATA_ITEM_CATALOG','WAREHOUSE_MANAGER','FULL_CONTROL'),
  ('MASTERDATA_ITEM_CATALOG','INVENTORY_CONTROL','VIEW_EDIT'),
  ('MASTERDATA_ITEM_CATALOG','INBOUND_SUPERVISOR','VIEW_ONLY'),
  ('MASTERDATA_ITEM_CATALOG','OUTBOUND_SUPERVISOR','VIEW_ONLY'),
  ('MASTERDATA_ITEM_CATALOG','WAREHOUSE_ASSOCIATE','VIEW_ONLY'),
  ('MASTERDATA_ITEM_CATALOG','SYSTEM_ADMINISTRATOR','FULL_CONTROL'),

  ('MASTERDATA_LOCATIONS_ZONES','WAREHOUSE_MANAGER','FULL_CONTROL'),
  ('MASTERDATA_LOCATIONS_ZONES','INVENTORY_CONTROL','VIEW_EDIT'),
  ('MASTERDATA_LOCATIONS_ZONES','INBOUND_SUPERVISOR','VIEW_ONLY'),
  ('MASTERDATA_LOCATIONS_ZONES','OUTBOUND_SUPERVISOR','VIEW_ONLY'),
  ('MASTERDATA_LOCATIONS_ZONES','WAREHOUSE_ASSOCIATE','VIEW_ONLY'),
  ('MASTERDATA_LOCATIONS_ZONES','SYSTEM_ADMINISTRATOR','FULL_CONTROL'),

  ('MASTERDATA_VENDORS_CUSTOMERS','WAREHOUSE_MANAGER','FULL_CONTROL'),
  ('MASTERDATA_VENDORS_CUSTOMERS','INVENTORY_CONTROL','VIEW_ONLY'),
  ('MASTERDATA_VENDORS_CUSTOMERS','INBOUND_SUPERVISOR','VIEW_ONLY'),
  ('MASTERDATA_VENDORS_CUSTOMERS','OUTBOUND_SUPERVISOR','VIEW_ONLY'),
  ('MASTERDATA_VENDORS_CUSTOMERS','WAREHOUSE_ASSOCIATE','NO_ACCESS'),
  ('MASTERDATA_VENDORS_CUSTOMERS','SYSTEM_ADMINISTRATOR','FULL_CONTROL'),

  ('SYSTEM_USER_MGMT','WAREHOUSE_MANAGER','VIEW_EDIT'),
  ('SYSTEM_USER_MGMT','INVENTORY_CONTROL','NO_ACCESS'),
  ('SYSTEM_USER_MGMT','INBOUND_SUPERVISOR','NO_ACCESS'),
  ('SYSTEM_USER_MGMT','OUTBOUND_SUPERVISOR','NO_ACCESS'),
  ('SYSTEM_USER_MGMT','WAREHOUSE_ASSOCIATE','NO_ACCESS'),
  ('SYSTEM_USER_MGMT','SYSTEM_ADMINISTRATOR','FULL_CONTROL'),

  ('SYSTEM_CONFIG_RULES','WAREHOUSE_MANAGER','FULL_CONTROL'),
  ('SYSTEM_CONFIG_RULES','INVENTORY_CONTROL','NO_ACCESS'),
  ('SYSTEM_CONFIG_RULES','INBOUND_SUPERVISOR','NO_ACCESS'),
  ('SYSTEM_CONFIG_RULES','OUTBOUND_SUPERVISOR','NO_ACCESS'),
  ('SYSTEM_CONFIG_RULES','WAREHOUSE_ASSOCIATE','NO_ACCESS'),
  ('SYSTEM_CONFIG_RULES','SYSTEM_ADMINISTRATOR','FULL_CONTROL'),

  ('SYSTEM_INTEGRATION_LOGS','WAREHOUSE_MANAGER','VIEW_ONLY'),
  ('SYSTEM_INTEGRATION_LOGS','INVENTORY_CONTROL','NO_ACCESS'),
  ('SYSTEM_INTEGRATION_LOGS','INBOUND_SUPERVISOR','NO_ACCESS'),
  ('SYSTEM_INTEGRATION_LOGS','OUTBOUND_SUPERVISOR','NO_ACCESS'),
  ('SYSTEM_INTEGRATION_LOGS','WAREHOUSE_ASSOCIATE','NO_ACCESS'),
  ('SYSTEM_INTEGRATION_LOGS','SYSTEM_ADMINISTRATOR','FULL_CONTROL'),

  ('REPORTING_OPERATIONAL','WAREHOUSE_MANAGER','VIEW_ONLY'),
  ('REPORTING_OPERATIONAL','INVENTORY_CONTROL','VIEW_ONLY'),
  ('REPORTING_OPERATIONAL','INBOUND_SUPERVISOR','VIEW_ONLY'),
  ('REPORTING_OPERATIONAL','OUTBOUND_SUPERVISOR','VIEW_ONLY'),
  ('REPORTING_OPERATIONAL','WAREHOUSE_ASSOCIATE','NO_ACCESS'),
  ('REPORTING_OPERATIONAL','SYSTEM_ADMINISTRATOR','VIEW_ONLY'),

  ('REPORTING_FINANCIAL_AUDIT','WAREHOUSE_MANAGER','VIEW_ONLY'),
  ('REPORTING_FINANCIAL_AUDIT','INVENTORY_CONTROL','VIEW_ONLY'),
  ('REPORTING_FINANCIAL_AUDIT','INBOUND_SUPERVISOR','NO_ACCESS'),
  ('REPORTING_FINANCIAL_AUDIT','OUTBOUND_SUPERVISOR','NO_ACCESS'),
  ('REPORTING_FINANCIAL_AUDIT','WAREHOUSE_ASSOCIATE','NO_ACCESS'),
  ('REPORTING_FINANCIAL_AUDIT','SYSTEM_ADMINISTRATOR','FULL_CONTROL')
) as v(module_code, role_code, level)
join wms_modules m on m.code = v.module_code
join wms_roles r on r.code = v.role_code
on conflict (role_id, module_id) do update set level = excluded.level;
