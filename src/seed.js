import { pathToFileURL } from 'node:url';
import { db, tx } from './db.js';
import { hashPassword } from './auth.js';

const GEOGRAPHY = {
  Western: ['Colombo', 'Gampaha', 'Kalutara'],
  Central: ['Kandy', 'Matale', 'Nuwara Eliya'],
  Southern: ['Galle', 'Matara', 'Hambantota'],
  Northern: ['Jaffna', 'Kilinochchi', 'Mannar', 'Vavuniya', 'Mullaitivu'],
  Eastern: ['Batticaloa', 'Ampara', 'Trincomalee'],
  'North Western': ['Kurunegala', 'Puttalam'],
  'North Central': ['Anuradhapura', 'Polonnaruwa'],
  Uva: ['Badulla', 'Monaragala'],
  Sabaragamuwa: ['Ratnapura', 'Kegalle'],
};
const INSTALLATIONS = 240;
const SUBSTATIONS_PER_DISTRICT = 2;
const DAYS = 7;
const INTERVAL_MIN = 15;
const LK_OFFSET_MS = 5.5 * 3600 * 1000;

// Deterministic PRNG so the dataset is reproducible
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const slug = (s) => s.toLowerCase().replace(/\s+/g, '-');

export function seedDatabase() {
  if (db.prepare('SELECT COUNT(*) AS n FROM provinces').get().n > 0) return false;
  const rnd = mulberry32(20260824);
  const nowIso = new Date().toISOString();

  tx(() => {
    const insProv = db.prepare('INSERT INTO provinces (name) VALUES (?)');
    const insDist = db.prepare('INSERT INTO districts (province_id, name) VALUES (?, ?)');
    const insSub = db.prepare('INSERT INTO grid_substations (district_id, name, voltage_kv) VALUES (?, ?, ?)');
    const insInst = db.prepare('INSERT INTO installations (meter_id, name, substation_id, capacity_kw, status, installed_on, version, updated_at) VALUES (?,?,?,?,?,?,1,?)');
    const insRead = db.prepare('INSERT INTO generation_readings (installation_id, timestamp, power_kw, energy_kwh, voltage) VALUES (?,?,?,?,?)');
    const insUser = db.prepare('INSERT INTO users (email, password_hash, role, province_id, district_id) VALUES (?,?,?,?,?)');
    const pw = process.env.SEED_USER_PASSWORD || 'ChangeMe123!';

    insUser.run('national@slsea.lk', hashPassword(pw), 'national', null, null);

    const substations = [];
    for (const [province, districts] of Object.entries(GEOGRAPHY)) {
      const pid = Number(insProv.run(province).lastInsertRowid);
      insUser.run(`province-${slug(province)}@slsea.lk`, hashPassword(pw), 'provincial', pid, null);
      for (const district of districts) {
        const did = Number(insDist.run(pid, district).lastInsertRowid);
        insUser.run(`district-${slug(district)}@slsea.lk`, hashPassword(pw), 'district', pid, did);
        for (let k = 1; k <= SUBSTATIONS_PER_DISTRICT; k++) {
          const sid = Number(insSub.run(did, `${district} GSS-${k}`, k === 1 ? 132 : 33).lastInsertRowid);
          substations.push({ id: sid, district });
        }
      }
    }

    // Reading timestamps: last full 15-min slot back DAYS days
    const step = INTERVAL_MIN * 60 * 1000;
    const end = Math.floor(Date.now() / step) * step;
    const slots = DAYS * 24 * 60 / INTERVAL_MIN;
    const capacities = [3, 4, 5, 6, 8, 10];

    for (let n = 0; n < INSTALLATIONS; n++) {
      const sub = substations[n % substations.length];
      const meter = `SLSEA-${String(n + 1).padStart(5, '0')}`;
      const cap = capacities[Math.floor(rnd() * capacities.length)];
      const year = 2021 + Math.floor(rnd() * 5);
      const month = String(1 + Math.floor(rnd() * 12)).padStart(2, '0');
      const iid = Number(insInst.run(meter, `Rooftop ${n + 1} - ${sub.district}`, sub.id, cap, 'active', `${year}-${month}-15`, nowIso).lastInsertRowid);

      let energy = 1000 + Math.floor(rnd() * 8000); // lifetime kWh register
      let lastDay = null; let cloud = 1;
      for (let k = slots - 1; k >= 0; k--) {
        const t = end - k * step;
        const local = t + LK_OFFSET_MS;
        const day = Math.floor(local / 86400000);
        if (day !== lastDay) { lastDay = day; cloud = 0.55 + 0.45 * rnd(); } // per-day weather factor
        const hour = (local % 86400000) / 3600000;
        let power = 0;
        if (hour > 6 && hour < 18) power = cap * 0.85 * cloud * Math.sin(Math.PI * (hour - 6) / 12) * (0.9 + 0.1 * rnd());
        energy += power * (INTERVAL_MIN / 60);
        const voltage = 230 + (rnd() - 0.5) * 8 + (power / cap) * 3;
        insRead.run(iid, new Date(t).toISOString(), Math.round(power * 1000) / 1000, Math.round(energy * 1000) / 1000, Math.round(voltage * 10) / 10);
      }
    }
  });
  return true;
}

// `npm run seed` -> seeds only if the database is empty
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(seedDatabase() ? 'Seeded.' : 'Already populated (delete the DB file to reseed).');
}
