import express from 'express';
import { db } from './db.js';
import { ApiError, badRequest, conflict, forbidden, methodNotAllowed, notFound, preconditionFailed } from './errors.js';
import { deviceKeyFor, requireDevice, requireRole, requireUser, signUserToken, verifyPassword } from './auth.js';
import { canSeeDistrict, canSeeProvince, scopeClause } from './scope.js';
import { paged, parseId, parseTime, sendResource } from './http.js';

const router = express.Router();

// ---------- cross-cutting: content negotiation (406/415) then JSON body parsing ----------
router.use((req, res, next) => {
  if (req.get('accept') && !req.accepts('json')) {
    return next(new ApiError(406, 'NOT_ACCEPTABLE', 'This API only produces application/json'));
  }
  if (['POST', 'PUT', 'PATCH'].includes(req.method) && Number(req.get('content-length') || 0) > 0 && !req.is('application/json')) {
    return next(new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Request bodies must be application/json'));
  }
  next();
});
router.use(express.json({ limit: '100kb' }));

// ---------- shared SQL ----------
const GEO_I = `FROM installations i
  JOIN grid_substations s ON s.id = i.substation_id
  JOIN districts d ON d.id = s.district_id
  JOIN provinces p ON p.id = d.province_id`;
const INST_SELECT = `SELECT i.id, i.meter_id, i.name, i.capacity_kw, i.status, i.installed_on,
  i.substation_id, s.district_id, d.province_id, i.version, i.updated_at`;
const R_FROM = `FROM generation_readings r
  JOIN installations i ON i.id = r.installation_id
  JOIN grid_substations s ON s.id = i.substation_id
  JOIN districts d ON d.id = s.district_id
  JOIN provinces p ON p.id = d.province_id`;
const R_SELECT = 'SELECT r.id, r.installation_id, r.timestamp, r.power_kw, r.energy_kwh, r.voltage';
const STATUSES = ['active', 'inactive', 'decommissioned'];
const SORTABLE = ['timestamp', 'power_kw', 'energy_kwh'];
const LK_OFFSET_MS = 5.5 * 3600 * 1000; // Sri Lanka local time (UTC+05:30)

const must = (row, label, id) => { if (!row) throw notFound(label, id); return row; };
const getProvince = (id) => must(db.prepare('SELECT id, name FROM provinces WHERE id = ?').get(id), 'Province', id);
const getDistrict = (id) => must(db.prepare('SELECT id, name, province_id FROM districts WHERE id = ?').get(id), 'District', id);
const getSubstation = (id) => must(db.prepare('SELECT id, name, voltage_kv, district_id FROM grid_substations WHERE id = ?').get(id), 'Grid substation', id);
const getInstallation = (id) => must(db.prepare(`${INST_SELECT} ${GEO_I} WHERE i.id = ?`).get(id), 'Installation', id);

const assertProvince = (u, p) => { if (!canSeeProvince(u, p.id)) throw forbidden(`Province ${p.id} is outside your jurisdiction`); };
const assertDistrict = (u, d) => { if (!canSeeDistrict(u, d)) throw forbidden(`District ${d.id} is outside your jurisdiction`); };
const assertSubstation = (u, s) => assertDistrict(u, getDistrict(s.district_id));
const assertInstallation = (u, i) => {
  if (!canSeeDistrict(u, { id: i.district_id, province_id: i.province_id })) throw forbidden(`Installation ${i.id} is outside your jurisdiction`);
};
const instEtag = (i) => `"inst-${i.id}-v${i.version}"`;
const localDayStart = (iso) => new Date(Math.floor((new Date(iso).getTime() + LK_OFFSET_MS) / 86400000) * 86400000 - LK_OFFSET_MS).toISOString();
const round = (n, dp = 3) => Math.round(n * 10 ** dp) / 10 ** dp;

// Validate + authorise optional geographic filters; scope is applied separately and always.
function geoFilters(req, forced, keys) {
  const q = { ...req.query, ...forced };
  const where = [];
  const params = [];
  if (keys.includes('province_id') && q.province_id !== undefined) {
    const p = getProvince(parseId(q.province_id, 'province_id')); assertProvince(req.user, p);
    where.push('p.id = ?'); params.push(p.id);
  }
  if (keys.includes('district_id') && q.district_id !== undefined) {
    const d = getDistrict(parseId(q.district_id, 'district_id')); assertDistrict(req.user, d);
    where.push('d.id = ?'); params.push(d.id);
  }
  if (keys.includes('substation_id') && q.substation_id !== undefined) {
    const s = getSubstation(parseId(q.substation_id, 'substation_id')); assertSubstation(req.user, s);
    where.push('s.id = ?'); params.push(s.id);
  }
  if (keys.includes('installation_id') && q.installation_id !== undefined) {
    const i = getInstallation(parseId(q.installation_id, 'installation_id')); assertInstallation(req.user, i);
    where.push('i.id = ?'); params.push(i.id);
  }
  return { where, params };
}

// ======================= AUTH =======================
router.post('/auth/login', (req, res) => {
  const { email, password } = req.body ?? {};
  const errs = [];
  if (typeof email !== 'string' || !email) errs.push({ field: 'email', issue: 'required string' });
  if (typeof password !== 'string' || !password) errs.push({ field: 'password', issue: 'required string' });
  if (errs.length) throw badRequest('Invalid login request', errs);
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
  if (!u || !verifyPassword(password, u.password_hash)) {
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Incorrect email or password', [], { 'WWW-Authenticate': 'Bearer' });
  }
  res.json({
    access_token: signUserToken(u), token_type: 'Bearer', expires_in: 3600,
    user: { id: u.id, email: u.email, role: u.role, province_id: u.province_id, district_id: u.district_id },
  });
});

// ======================= PROVINCES =======================
router.get('/provinces', requireUser, (req, res) => {
  const where = []; const params = [];
  if (req.user.role !== 'national') { where.push('id = ?'); params.push(req.user.province_id); }
  paged(req, res, { select: 'SELECT id, name', from: 'FROM provinces', where, params, order: 'id' });
});
router.get('/provinces/:id', requireUser, (req, res) => {
  const p = getProvince(parseId(req.params.id)); assertProvince(req.user, p);
  sendResource(req, res, p);
});

// ======================= DISTRICTS =======================
function districtsList(req, res, forced = {}) {
  const f = geoFilters(req, forced, ['province_id']);
  const sc = scopeClause(req.user);
  paged(req, res, {
    select: 'SELECT d.id, d.name, d.province_id',
    from: 'FROM districts d JOIN provinces p ON p.id = d.province_id',
    where: [...f.where, sc.sql], params: [...f.params, ...sc.params], order: 'd.id',
  });
}
router.get('/districts', requireUser, (req, res) => districtsList(req, res));
router.get('/provinces/:id/districts', requireUser, (req, res) => {
  const p = getProvince(parseId(req.params.id)); assertProvince(req.user, p);
  districtsList(req, res, { province_id: p.id });
});
router.get('/districts/:id', requireUser, (req, res) => {
  const d = getDistrict(parseId(req.params.id)); assertDistrict(req.user, d);
  sendResource(req, res, d);
});

// ======================= GRID SUBSTATIONS =======================
function substationsList(req, res, forced = {}) {
  const f = geoFilters(req, forced, ['province_id', 'district_id']);
  const sc = scopeClause(req.user);
  paged(req, res, {
    select: 'SELECT s.id, s.name, s.voltage_kv, s.district_id',
    from: 'FROM grid_substations s JOIN districts d ON d.id = s.district_id JOIN provinces p ON p.id = d.province_id',
    where: [...f.where, sc.sql], params: [...f.params, ...sc.params], order: 's.id',
  });
}
router.get('/substations', requireUser, (req, res) => substationsList(req, res));
router.get('/districts/:id/substations', requireUser, (req, res) => {
  const d = getDistrict(parseId(req.params.id)); assertDistrict(req.user, d);
  substationsList(req, res, { district_id: d.id });
});
router.get('/substations/:id', requireUser, (req, res) => {
  const s = getSubstation(parseId(req.params.id)); assertSubstation(req.user, s);
  sendResource(req, res, s);
});

export default router;