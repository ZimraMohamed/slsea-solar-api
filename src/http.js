import { badRequest } from './errors.js';
import { db } from './db.js';

export function parseId(v, name = 'id') {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw badRequest(`Invalid ${name}`, [{ field: name, issue: 'must be a positive integer' }]);
  return n;
}

export function intParam(v, def, name, min, max) {
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw badRequest(`Invalid query parameter '${name}'`, [{ field: name, issue: `must be an integer between ${min} and ${max}` }]);
  }
  return n;
}

export function parseTime(v, name) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(v) || Number.isNaN(Date.parse(v))) {
    throw badRequest(`Invalid query parameter '${name}'`, [{ field: name, issue: 'must be an ISO-8601 date-time, e.g. 2026-10-01T00:00:00Z' }]);
  }
  return new Date(v).toISOString();
}

// Single resource response. If no ETag is given Express derives a weak one from the body;
// res.json() then answers 304 with an empty body when If-None-Match / If-Modified-Since match.
export function sendResource(req, res, body, { etag, lastModified } = {}) {
  res.set('Cache-Control', 'private, no-cache');
  if (etag) res.set('ETag', etag);
  if (lastModified) res.set('Last-Modified', new Date(lastModified).toUTCString());
  res.json(body);
}

// Paginated collection: { data, pagination:{total,page,page_size,total_pages}, links:{self,first,prev,next,last} }
export function paged(req, res, { select, from, where = [], params = [], order, map = (x) => x }) {
  const page = intParam(req.query.page, 1, 'page', 1, 1e9);
  const size = intParam(req.query.page_size, 50, 'page_size', 1, 500);
  const w = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n ${from}${w}`).get(...params).n;
  const rows = db.prepare(`${select} ${from}${w} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, size, (page - 1) * size);
  const totalPages = Math.max(1, Math.ceil(total / size));
  const url = (p) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(req.query)) if (k !== 'page') u.append(k, String(v));
    u.set('page', String(p));
    return `${req.baseUrl}${req.path}?${u}`;
  };
  const links = {
    self: url(page),
    first: url(1),
    prev: page > 1 ? url(Math.min(page - 1, totalPages)) : null,
    next: page < totalPages ? url(page + 1) : null,
    last: url(totalPages),
  };
  const header = Object.entries(links).filter(([, v]) => v).map(([rel, v]) => `<${v}>; rel="${rel}"`).join(', ');
  res.set({ 'X-Total-Count': String(total), Link: header, 'Cache-Control': 'private, no-cache' });
  res.json({
    data: rows.map(map),
    pagination: { total, page, page_size: size, total_pages: totalPages },
    links,
  });
}
