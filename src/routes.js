// src/routes.js

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

// ======================= INSTALLATIONS =======================
function installationsList(req, res, forced = {}) {
  const f = geoFilters(req, forced, ['province_id', 'district_id', 'substation_id']);
  const sc = scopeClause(req.user);
  const where = [...f.where, sc.sql]; const params = [...f.params, ...sc.params];
  if (req.query.status !== undefined) {
    if (!STATUSES.includes(req.query.status)) throw badRequest("Invalid query parameter 'status'", [{ field: 'status', issue: `must be one of ${STATUSES.join(', ')}` }]);
    where.push('i.status = ?'); params.push(req.query.status);
  }
  paged(req, res, { select: INST_SELECT, from: GEO_I, where, params, order: 'i.id' });
}
router.get('/installations', requireUser, (req, res) => installationsList(req, res));
router.get('/districts/:id/installations', requireUser, (req, res) => {
  const d = getDistrict(parseId(req.params.id)); assertDistrict(req.user, d);
  installationsList(req, res, { district_id: d.id });
});
router.get('/substations/:id/installations', requireUser, (req, res) => {
  const s = getSubstation(parseId(req.params.id)); assertSubstation(req.user, s);
  installationsList(req, res, { substation_id: s.id });
});

router.get('/installations/:id', requireUser, (req, res) => {
  const inst = getInstallation(parseId(req.params.id)); assertInstallation(req.user, inst);
  sendResource(req, res, inst, { etag: instEtag(inst), lastModified: inst.updated_at });
});

function validateInstallation(body, { creating }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Request body must be a JSON object');
  const b = body; const errs = [];
  if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 100) errs.push({ field: 'name', issue: 'required string, 1-100 chars' });
  if ((creating || b.meter_id !== undefined) && (typeof b.meter_id !== 'string' || !/^[A-Za-z0-9_-]{3,40}$/.test(b.meter_id))) {
    errs.push({ field: 'meter_id', issue: 'required string, 3-40 chars of A-Z a-z 0-9 _ -' });
  }
  if (!Number.isInteger(b.substation_id)) errs.push({ field: 'substation_id', issue: 'required integer' });
  else if (!db.prepare('SELECT 1 FROM grid_substations WHERE id = ?').get(b.substation_id)) errs.push({ field: 'substation_id', issue: 'does not exist' });
  if (typeof b.capacity_kw !== 'number' || !(b.capacity_kw > 0) || b.capacity_kw > 10000) errs.push({ field: 'capacity_kw', issue: 'required number > 0 and <= 10000' });
  if (typeof b.installed_on !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.installed_on) || Number.isNaN(Date.parse(b.installed_on))) errs.push({ field: 'installed_on', issue: 'required date YYYY-MM-DD' });
  const status = b.status ?? 'active';
  if (!STATUSES.includes(status)) errs.push({ field: 'status', issue: `must be one of ${STATUSES.join(', ')}` });
  if (errs.length) throw badRequest('Installation failed validation', errs);
  return { meter_id: b.meter_id, name: b.name.trim(), substation_id: b.substation_id, capacity_kw: b.capacity_kw, installed_on: b.installed_on, status };
}

// CREATE: POST -> 201 + Location (+ ETag). Returns the device key ONCE for provisioning.
router.post('/installations', requireUser, requireRole('national'), (req, res) => {
  const v = validateInstallation(req.body, { creating: true });
  let r;
  try {
    r = db.prepare('INSERT INTO installations (meter_id, name, substation_id, capacity_kw, status, installed_on, version, updated_at) VALUES (?,?,?,?,?,?,1,?)')
      .run(v.meter_id, v.name, v.substation_id, v.capacity_kw, v.status, v.installed_on, new Date().toISOString());
  } catch (e) {
    if (/UNIQUE/.test(e.message)) throw conflict('DUPLICATE_METER', 'meter_id is already registered', [{ field: 'meter_id', issue: 'must be unique' }]);
    throw e;
  }
  const inst = getInstallation(Number(r.lastInsertRowid));
  res.status(201).set({ Location: `/api/v1/installations/${inst.id}`, ETag: instEtag(inst), 'Cache-Control': 'no-store' })
    .json({ ...inst, device_key: deviceKeyFor(inst.meter_id) });
});

// UPDATE: PUT = full replacement of mutable fields; idempotent (no version bump if nothing changes).
router.put('/installations/:id', requireUser, requireRole('national'), (req, res) => {
  const id = parseId(req.params.id);
  const cur = getInstallation(id);
  const ifMatch = req.get('if-match');
  if (ifMatch && ifMatch !== '*' && ifMatch !== instEtag(cur)) throw preconditionFailed();
  const v = validateInstallation(req.body, { creating: false });
  if (v.meter_id !== undefined && v.meter_id !== cur.meter_id) {
    throw badRequest('meter_id is immutable', [{ field: 'meter_id', issue: 'cannot be changed (it identifies the device credential)' }]);
  }
  const changed = ['name', 'substation_id', 'capacity_kw', 'installed_on', 'status'].some((k) => v[k] !== cur[k]);
  if (changed) {
    db.prepare('UPDATE installations SET name=?, substation_id=?, capacity_kw=?, status=?, installed_on=?, version=version+1, updated_at=? WHERE id=?')
      .run(v.name, v.substation_id, v.capacity_kw, v.status, v.installed_on, new Date().toISOString(), id);
  }
  const inst = getInstallation(id);
  sendResource(req, res, inst, { etag: instEtag(inst), lastModified: inst.updated_at });
});

// DELETE: 204. Refused (409) if history exists, because readings are append-only.
router.delete('/installations/:id', requireUser, requireRole('national'), (req, res) => {
  const cur = getInstallation(parseId(req.params.id));
  const ifMatch = req.get('if-match');
  if (ifMatch && ifMatch !== '*' && ifMatch !== instEtag(cur)) throw preconditionFailed();
  const n = db.prepare('SELECT COUNT(*) AS n FROM generation_readings WHERE installation_id = ?').get(cur.id).n;
  if (n > 0) throw conflict('HAS_HISTORY', 'Installation has generation history; set status to "decommissioned" with PUT instead', [{ readings: n }]);
  db.prepare('DELETE FROM installations WHERE id = ?').run(cur.id);
  res.status(204).end();
});

// ---- Composite resource: installation + location + operational snapshot ----
router.get('/installations/:id/overview', requireUser, (req, res) => {
  const inst = getInstallation(parseId(req.params.id)); assertInstallation(req.user, inst);
  const last = db.prepare('SELECT id, timestamp, power_kw, energy_kwh, voltage FROM generation_readings WHERE installation_id = ? ORDER BY timestamp DESC LIMIT 1').get(inst.id) ?? null;
  const total = db.prepare('SELECT COUNT(*) AS n FROM generation_readings WHERE installation_id = ?').get(inst.id).n;
  let energyToday = 0;
  if (last) {
    const e = db.prepare('SELECT MAX(energy_kwh) - MIN(energy_kwh) AS e FROM generation_readings WHERE installation_id = ? AND timestamp >= ? AND timestamp <= ?')
      .get(inst.id, localDayStart(last.timestamp), last.timestamp);
    energyToday = round(e.e ?? 0);
  }
  const loc = db.prepare(`SELECT s.id AS substation_id, s.name AS substation_name, d.id AS district_id, d.name AS district_name, p.id AS province_id, p.name AS province_name
    FROM grid_substations s JOIN districts d ON d.id = s.district_id JOIN provinces p ON p.id = d.province_id WHERE s.id = ?`).get(inst.substation_id);
  sendResource(req, res, {
    installation: inst,
    location: {
      substation: { id: loc.substation_id, name: loc.substation_name },
      district: { id: loc.district_id, name: loc.district_name },
      province: { id: loc.province_id, name: loc.province_name },
    },
    last_reading: last,
    energy_today_kwh: energyToday,
    total_readings: total,
  }, { lastModified: last ? last.timestamp : inst.updated_at });
});

// ---- Derived resource: last-known reading (operational / real-time view) ----
router.get('/installations/:id/last-reading', requireUser, (req, res) => {
  const inst = getInstallation(parseId(req.params.id)); assertInstallation(req.user, inst);
  const last = db.prepare('SELECT id, timestamp, power_kw, energy_kwh, voltage FROM generation_readings WHERE installation_id = ? ORDER BY timestamp DESC LIMIT 1').get(inst.id);
  if (!last) throw notFound(`Installation ${inst.id} has not reported any readings yet`);
  sendResource(req, res, { installation_id: inst.id, meter_id: inst.meter_id, ...last }, { lastModified: last.timestamp });
});
// ======================= GENERATION READINGS =======================
// Ingestion: device authenticates AS the installation and may write only to its own sub-collection.
router.post('/installations/:id/readings', requireDevice, (req, res) => {
  const id = parseId(req.params.id);
  const inst = req.device.installation;
  if (id !== inst.id) throw forbidden('A device may only write readings for its own installation');
  if (inst.status !== 'active') throw conflict('INSTALLATION_NOT_ACTIVE', `Installation is ${inst.status}`);
  const b = req.body;
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw badRequest('Request body must be a JSON object');
  const errs = [];
  let ts;
  if (typeof b.timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(b.timestamp) || Number.isNaN(Date.parse(b.timestamp))) {
    errs.push({ field: 'timestamp', issue: 'required ISO-8601 date-time' });
  } else {
    ts = new Date(b.timestamp).toISOString();
    if (new Date(ts).getTime() > Date.now() + 5 * 60 * 1000) errs.push({ field: 'timestamp', issue: 'must not be in the future' });
  }
  if (typeof b.power_kw !== 'number' || b.power_kw < 0 || b.power_kw > inst.capacity_kw * 1.2) errs.push({ field: 'power_kw', issue: `required number between 0 and ${round(inst.capacity_kw * 1.2, 2)} (120% of capacity)` });
  if (typeof b.energy_kwh !== 'number' || b.energy_kwh < 0) errs.push({ field: 'energy_kwh', issue: 'required number >= 0 (cumulative)' });
  if (typeof b.voltage !== 'number' || b.voltage < 100 || b.voltage > 300) errs.push({ field: 'voltage', issue: 'required number between 100 and 300' });
  if (errs.length) throw badRequest('Generation reading failed validation', errs);
  let r;
  try {
    r = db.prepare('INSERT INTO generation_readings (installation_id, timestamp, power_kw, energy_kwh, voltage) VALUES (?,?,?,?,?)')
      .run(inst.id, ts, b.power_kw, b.energy_kwh, b.voltage);
  } catch (e) {
    if (/UNIQUE/.test(e.message)) throw conflict('DUPLICATE_READING', 'A reading for this installation and timestamp already exists', [{ field: 'timestamp', issue: 'already recorded' }]);
    throw e;
  }
  const reading = { id: Number(r.lastInsertRowid), installation_id: inst.id, timestamp: ts, power_kw: b.power_kw, energy_kwh: b.energy_kwh, voltage: b.voltage };
  res.status(201).set({ Location: `/api/v1/readings/${reading.id}`, 'Cache-Control': 'no-store' }).json(reading);
});

// History: filter by jurisdiction + time window, sort, paginate.
function readingsList(req, res, forced = {}) {
  const f = geoFilters(req, forced, ['province_id', 'district_id', 'substation_id', 'installation_id']);
  const sc = scopeClause(req.user);
  const where = [...f.where, sc.sql]; const params = [...f.params, ...sc.params];
  const from = req.query.from !== undefined ? parseTime(req.query.from, 'from') : null;
  const to = req.query.to !== undefined ? parseTime(req.query.to, 'to') : null;
  if (from && to && from > to) throw badRequest("'from' must not be after 'to'", [{ field: 'from', issue: 'later than to' }]);
  if (from) { where.push('r.timestamp >= ?'); params.push(from); }
  if (to) { where.push('r.timestamp <= ?'); params.push(to); }
  const sort = req.query.sort ?? 'timestamp';
  if (!SORTABLE.includes(sort)) throw badRequest("Invalid query parameter 'sort'", [{ field: 'sort', issue: `must be one of ${SORTABLE.join(', ')}` }]);
  const order = String(req.query.order ?? 'desc').toLowerCase();
  if (!['asc', 'desc'].includes(order)) throw badRequest("Invalid query parameter 'order'", [{ field: 'order', issue: 'must be asc or desc' }]);
  paged(req, res, { select: R_SELECT, from: R_FROM, where, params, order: `r.${sort} ${order}, r.id ${order}` });
}
router.get('/installations/:id/readings', requireUser, (req, res) => {
  const inst = getInstallation(parseId(req.params.id)); assertInstallation(req.user, inst);
  readingsList(req, res, { installation_id: inst.id });
});
router.get('/readings', requireUser, (req, res) => readingsList(req, res));
router.get('/readings/:id', requireUser, (req, res) => {
  const r = must(db.prepare('SELECT id, installation_id, timestamp, power_kw, energy_kwh, voltage FROM generation_readings WHERE id = ?').get(parseId(req.params.id)), 'Reading', req.params.id);
  assertInstallation(req.user, getInstallation(r.installation_id));
  // readings are immutable -> strong ETag + Last-Modified = the reading's own timestamp
  sendResource(req, res, r, { etag: `"reading-${r.id}"`, lastModified: r.timestamp });
});

// Append-only: no update / delete of readings
router.all('/readings/:id', (req, res, next) => next(methodNotAllowed(['GET', 'HEAD'])));
router.all('/readings', (req, res, next) => next(methodNotAllowed(['GET', 'HEAD'])));
router.all('/installations/:id/readings', (req, res, next) => next(methodNotAllowed(['GET', 'HEAD', 'POST'])));

// ======================= DISTRICT GENERATION SUMMARY (processing resource) =======================
router.get('/districts/:id/generation-summary', requireUser, (req, res) => {
  const d = getDistrict(parseId(req.params.id)); assertDistrict(req.user, d);
  const base = `FROM generation_readings r JOIN installations i ON i.id = r.installation_id JOIN grid_substations s ON s.id = i.substation_id WHERE s.district_id = ?`;
  const latest = db.prepare(`SELECT MAX(r.timestamp) AS t ${base}`).get(d.id).t;
  const asOf = req.query.as_of !== undefined ? parseTime(req.query.as_of, 'as_of') : latest;
  const totalInst = db.prepare('SELECT COUNT(*) AS n FROM installations i JOIN grid_substations s ON s.id = i.substation_id WHERE s.district_id = ?').get(d.id).n;
  const summary = { district_id: d.id, district_name: d.name, as_of: asOf, window_minutes: 30, installations_total: totalInst, installations_reporting: 0, current_power_kw: 0, energy_today_kwh: 0, day_start: null };
  if (asOf) {
    const windowStart = new Date(new Date(asOf).getTime() - 30 * 60 * 1000).toISOString();
    const dayStart = localDayStart(asOf);
    const cur = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(r.power_kw), 0) AS kw
      FROM generation_readings r
      JOIN (SELECT r2.installation_id AS iid, MAX(r2.timestamp) AS ts
            FROM generation_readings r2 JOIN installations i2 ON i2.id = r2.installation_id
            JOIN grid_substations s2 ON s2.id = i2.substation_id
            WHERE s2.district_id = ? AND r2.timestamp <= ? AND r2.timestamp > ?
            GROUP BY r2.installation_id) l ON l.iid = r.installation_id AND l.ts = r.timestamp`).get(d.id, asOf, windowStart);
    const en = db.prepare(`SELECT COALESCE(SUM(mx - mn), 0) AS e FROM
      (SELECT MAX(r.energy_kwh) AS mx, MIN(r.energy_kwh) AS mn ${base} AND r.timestamp >= ? AND r.timestamp <= ? GROUP BY r.installation_id)`).get(d.id, dayStart, asOf);
    summary.installations_reporting = cur.n;
    summary.current_power_kw = round(cur.kw);
    summary.energy_today_kwh = round(en.e);
    summary.day_start = dayStart;
  }
  sendResource(req, res, summary, { lastModified: asOf ?? undefined });
});



export default router;