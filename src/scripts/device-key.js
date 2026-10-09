// src/scripts/device-key.js

import { deviceKeyFor } from '../auth.js';
const meter = process.argv[2];
if (!meter) { console.error('Usage: npm run device-key -- <meter_id>'); process.exit(1); }
console.log(`Authorization: Device ${meter}:${deviceKeyFor(meter)}`);
