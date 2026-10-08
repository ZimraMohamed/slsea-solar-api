// Jurisdiction scoping. SQL fragments assume aliases: p = provinces, d = districts.
export function scopeClause(u) {
  switch (u.role) {
    case 'national': return { sql: '1=1', params: [] };
    case 'provincial': return { sql: 'p.id = ?', params: [u.province_id] };
    case 'district': return { sql: 'd.id = ?', params: [u.district_id] };
    default: return { sql: '1=0', params: [] };
  }
}
export const canSeeProvince = (u, provinceId) =>
  u.role === 'national' || u.province_id === provinceId;

export const canSeeDistrict = (u, { id, province_id }) =>
  u.role === 'national' ||
  (u.role === 'provincial' && u.province_id === province_id) ||
  (u.role === 'district' && u.district_id === id);
