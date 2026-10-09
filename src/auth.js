// src/auth.js
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { db } from './db.js';
import { forbidden, unauthorized } from './errors.js';

function secret(name, devDefault) {
  const v = process.env[name];
  if (v) return v;
  if (process.env.NODE_ENV === 'production') throw new Error(`${name} must be set in production`);
  return devDefault;
}
const JWT_SECRET = secret('JWT_SECRET', 'dev-jwt-secret');
const DEVICE_SECRET = secret('DEVICE_KEY_SECRET', 'dev-device-secret');

// ---- passwords (scrypt, per-user salt) ----
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}
export function verifyPassword(pw, stored) {
  const [s, h] = stored.split(':');
  const calc = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64);
  return crypto.timingSafeEqual(calc, Buffer.from(h, 'hex'));
}

// ---- device credentials: key = HMAC(secret, meter_id). Nothing secret stored in the DB. ----
export const deviceKeyFor = (meterId) =>
  crypto.createHmac('sha256', DEVICE_SECRET).update(meterId).digest('hex');

// ---- user tokens (JWT) ----
export function signUserToken(u) {
  return jwt.sign(
    { sub: String(u.id), role: u.role, province_id: u.province_id, district_id: u.district_id },
    JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' },
  );
}

function parseAuthHeader(req) {
  const h = req.get('authorization') || '';
  const i = h.indexOf(' ');
  return i < 0 ? {} : { scheme: h.slice(0, i).toLowerCase(), cred: h.slice(i + 1).trim() };
}

// READ path: SLSEA users only (Authorization: Bearer <jwt>)
export function requireUser(req, res, next) {
  const { scheme, cred } = parseAuthHeader(req);
  if (scheme === 'device') return next(forbidden('Metering devices cannot read SLSEA data'));
  if (scheme !== 'bearer' || !cred) return next(unauthorized());
  try {
    const p = jwt.verify(cred, JWT_SECRET, { algorithms: ['HS256'] });
    req.user = { id: Number(p.sub), role: p.role, province_id: p.province_id, district_id: p.district_id };
    next();
  } catch {
    next(unauthorized('Invalid or expired token'));
  }
}

export const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : next(forbidden(`Requires role: ${roles.join(' or ')}`));

// WRITE path (readings): devices only (Authorization: Device <meter_id>:<device_key>)
export function requireDevice(req, res, next) {
  const { scheme, cred } = parseAuthHeader(req);
  if (scheme === 'bearer') return next(forbidden('SLSEA users cannot write generation readings'));
  if (scheme !== 'device' || !cred) return next(unauthorized('Device credentials required', 'Device'));
  const sep = cred.indexOf(':');
  const meterId = sep < 0 ? '' : cred.slice(0, sep);
  const key = sep < 0 ? '' : cred.slice(sep + 1);
  const inst = db.prepare('SELECT id, meter_id, capacity_kw, status FROM installations WHERE meter_id = ?').get(meterId);
  const expected = Buffer.from(deviceKeyFor(inst ? inst.meter_id : 'unknown'));
  const given = Buffer.from(key);
  const ok = inst && given.length === expected.length && crypto.timingSafeEqual(given, expected);
  if (!ok) return next(unauthorized('Invalid device credentials', 'Device'));
  req.device = { installation: inst };
  next();
}
