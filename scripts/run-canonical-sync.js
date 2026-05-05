// CLI runner for canonical migration.
// Usage:
//   node scripts/run-canonical-sync.js                                # full DRY-RUN (no QBO writes)
//   node scripts/run-canonical-sync.js --apply                        # full APPLY
//   node scripts/run-canonical-sync.js --apply --phases=0,1,2,4       # only specific phases
//
// Phases:
//   0 = snapshot QBO state
//   1 = rename + setSku legacy Inventory
//   2 = create new Inventory
//   4 = create Group/Bundle items
//   3 = redirect Service invoice lines
//   5 = inactivate Service items
//   6 = inactivate orphan Inventory
//   7 = stock adjustment

require('dotenv').config();
const mongoose = require('mongoose');
const { getQboInstance } = require('../services/qboService');
const { runCanonicalSync } = require('../services/canonicalSync');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const phasesArg = args.find(a => a.startsWith('--phases='));
const phases = phasesArg ? phasesArg.split('=')[1].split(',') : ['0', '1', '2', '4', '3', '5', '6', '7'];

(async () => {
    if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI not set');
    await mongoose.connect(process.env.MONGODB_URI);
    try {
        const qbo = await getQboInstance();
        await runCanonicalSync({ qbo, apply, phases });
    } finally {
        await mongoose.disconnect();
    }
})().catch(e => {
    console.error('💥', e.message);
    console.error(e.stack);
    process.exit(1);
});
