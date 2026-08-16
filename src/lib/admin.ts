/**
 * NEOTRACE — Administrator: peran/hak akses WMS, manajemen pengguna.
 *
 * wms_roles / wms_modules / wms_role_permissions datang dari
 * wms_roles_permissions_matrix.csv. Ini LAPISAN BARU untuk menu
 * Administrator — TIDAK menggantikan profiles.role (user_role) yang
 * menegakkan RLS di seluruh aplikasi sejak v1. Mengubahnya di sini hanya
 * mengubah tampilan menu/hak akses versi matriks, bukan aturan database.
 */
import { supabase } from './api';

export interface WmsRole { id: string; code: string; name: string; sort_order: number }
export async function listWmsRoles(): Promise<WmsRole[]> {
  const { data, error } = await supabase.from('wms_roles').select('*').order('sort_order');
  if (error) throw error;
  return data ?? [];
}

export interface WmsModule { id: string; code: string; category: string; name: string; sort_order: number }
export async function listWmsModules(): Promise<WmsModule[]> {
  const { data, error } = await supabase.from('wms_modules').select('*').order('sort_order');
  if (error) throw error;
  return data ?? [];
}

export type PermissionLevel = 'NO_ACCESS' | 'VIEW_ONLY' | 'VIEW_EDIT' | 'FULL_CONTROL';
export interface WmsRolePermission { role_id: string; module_id: string; level: PermissionLevel }
export async function listWmsPermissions(): Promise<WmsRolePermission[]> {
  const { data, error } = await supabase.from('wms_role_permissions').select('*');
  if (error) throw error;
  return data ?? [];
}

export async function setPermission(roleId: string, moduleId: string, level: PermissionLevel) {
  const { error } = await supabase
    .from('wms_role_permissions')
    .upsert({ role_id: roleId, module_id: moduleId, level }, { onConflict: 'role_id,module_id' });
  if (error) throw error;
}

/* ------------------------------------------------------------- pengguna */

export interface UserRow {
  id: string; full_name: string | null; employee_no: string | null;
  role: string; department: string | null; is_active: boolean; wms_role_id: string | null;
}
export async function listUsers(): Promise<UserRow[]> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name, employee_no, role, department, is_active, wms_role_id')
    .order('full_name');
  if (error) throw error;
  return data ?? [];
}

export const APP_ROLES = ['OPERATOR', 'WAREHOUSE', 'QA', 'PLANNER', 'FINANCE', 'ADMIN', 'VIEWER'] as const;

export async function setUserRole(userId: string, role: string) {
  const { error } = await supabase.from('profiles').update({ role }).eq('id', userId);
  if (error) throw error;
}

export async function setUserWmsRole(userId: string, wmsRoleId: string | null) {
  const { error } = await supabase.from('profiles').update({ wms_role_id: wmsRoleId }).eq('id', userId);
  if (error) throw error;
}

export async function setUserActive(userId: string, isActive: boolean) {
  const { error } = await supabase.from('profiles').update({ is_active: isActive }).eq('id', userId);
  if (error) throw error;
}
