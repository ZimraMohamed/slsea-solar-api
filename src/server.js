// src/server.js

import app from './app.js';
import { seedDatabase } from './seed.js';

const seeded = seedDatabase();
console.log(seeded ? 'Database seeded.' : 'Database already populated; seed skipped.');

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`SLSEA Solar API listening on :${port}  (docs at /docs)`));
