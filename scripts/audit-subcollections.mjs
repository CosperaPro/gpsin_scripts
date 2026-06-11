// Read-only audit. For each doc in `appMode/release/alerts` and
// `appMode/release/follow_up`, list any subcollections it carries so the
// move script knows what to recurse into. Aggregates by subcollection name.
//
// Usage:
//   node scripts/audit-subcollections.mjs

import admin from 'firebase-admin';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const credsDir = path.resolve(__dirname, '..', 'creds');
const cred = JSON.parse(readFileSync(path.join(credsDir, 'old.json'), 'utf8'));

const app = admin.initializeApp(
  { credential: admin.credential.cert(cred) },
  'old',
);
const db = app.firestore();
const parent = db.collection('appMode').doc('release');

for (const colName of ['alerts', 'follow_up']) {
  const col = parent.collection(colName);
  const snap = await col.get();
  console.log(`[${colName}] auditing ${snap.size} docs for nested subcollections...`);

  // counts by subcollection name; total docs per subcollection name.
  const tally = new Map();
  let docsWithAnySub = 0;
  let scanned = 0;

  for (const doc of snap.docs) {
    const subs = await doc.ref.listCollections();
    if (subs.length > 0) docsWithAnySub += 1;
    for (const s of subs) {
      const cnt = await s.count().get();
      const entry = tally.get(s.id) ?? { docsContaining: 0, totalSubDocs: 0 };
      entry.docsContaining += 1;
      entry.totalSubDocs += cnt.data().count;
      tally.set(s.id, entry);
    }
    scanned += 1;
    if (scanned % 100 === 0) {
      process.stdout.write(`  ${scanned}/${snap.size}\r`);
    }
  }

  console.log(`[${colName}] ${docsWithAnySub}/${snap.size} docs carry subcollections.`);
  if (tally.size === 0) {
    console.log(`[${colName}] No nested subcollections anywhere.`);
  } else {
    for (const [name, entry] of tally.entries()) {
      console.log(
        `[${colName}]   subcollection "${name}": present on ${entry.docsContaining} docs, ${entry.totalSubDocs} total docs inside.`,
      );
    }
  }
  console.log('');
}

await app.delete();
