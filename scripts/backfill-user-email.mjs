// Backfill the `email` field on /users docs from Firebase Auth.
//
// The mobile signup only writes `email` onto the /users doc when it was
// provided, so older / federated accounts can have an empty `email` even
// though their Auth record has one. The admin Users tab now shows an Email
// column; this fills it from the authoritative source (Auth).
//
// For each /users doc:
//   - resolve its `auth_token` (== Auth uid) to the Auth email
//   - if they differ, set the doc's `email` to the Auth email
// Skips:
//   - docs flagged `deleted: true` (RGPD-anonymised — leave their email blank)
//   - docs whose Auth account no longer exists (nothing authoritative to write)
//   - docs with no `auth_token`
//
// Usage:
//   node scripts/backfill-user-email.mjs --dry-run        # report only
//   node scripts/backfill-user-email.mjs                  # write (prod)
//   node scripts/backfill-user-email.mjs --target stg     # other env

import admin from 'firebase-admin';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const credsDir = path.resolve(__dirname, '..', 'creds');

const { values } = parseArgs({
  options: {
    target: { type: 'string', default: 'prod' },
    'dry-run': { type: 'boolean', default: false },
  },
});

const target = values.target;
const dryRun = values['dry-run'];

const cred = JSON.parse(readFileSync(path.join(credsDir, `${target}.json`), 'utf8'));
const app = admin.initializeApp({ credential: admin.credential.cert(cred) });
const db = app.firestore();
const auth = app.auth();

console.log(
  `Target: ${cred.project_id} (${target})` + (dryRun ? '  [DRY RUN]' : '  [WRITING]'),
);

// 1. Build uid -> email map by paging through all Auth users (cheaper than a
//    getUser() per doc).
const emailByUid = new Map();
let pageToken;
do {
  const page = await auth.listUsers(1000, pageToken);
  for (const u of page.users) {
    if (u.email) emailByUid.set(u.uid, u.email);
  }
  pageToken = page.pageToken;
} while (pageToken);
console.log(`Auth users with an email: ${emailByUid.size}`);

// 2. Walk every /users doc and decide what to write.
const snap = await db.collection('users').get();
console.log(`/users docs: ${snap.size}`);

const toUpdate = []; // { id, from, to }
const counts = {
  fill: 0, // doc email was empty
  correct: 0, // doc email differed from Auth
  unchanged: 0, // already matches
  skippedDeleted: 0,
  skippedNoAuthToken: 0,
  skippedNoAuthEmail: 0, // Auth user gone or has no email
};

for (const doc of snap.docs) {
  const d = doc.data();
  if (d.deleted === true) {
    counts.skippedDeleted++;
    continue;
  }
  const uid = d.auth_token;
  if (!uid) {
    counts.skippedNoAuthToken++;
    continue;
  }
  const authEmail = emailByUid.get(uid);
  if (!authEmail) {
    counts.skippedNoAuthEmail++;
    continue;
  }
  const current = d.email || '';
  if (current === authEmail) {
    counts.unchanged++;
    continue;
  }
  if (current === '') counts.fill++;
  else counts.correct++;
  toUpdate.push({ id: doc.id, from: current, to: authEmail });
}

console.log('\nPlan:');
console.log(`  fill (was empty):     ${counts.fill}`);
console.log(`  correct (differed):   ${counts.correct}`);
console.log(`  unchanged (matches):  ${counts.unchanged}`);
console.log(`  skip (anonymised):    ${counts.skippedDeleted}`);
console.log(`  skip (no auth_token): ${counts.skippedNoAuthToken}`);
console.log(`  skip (no Auth email): ${counts.skippedNoAuthEmail}`);
console.log(`  => ${toUpdate.length} docs to write`);

if (counts.correct > 0) {
  console.log('\nCorrections (doc email differed from Auth):');
  for (const u of toUpdate.filter((x) => x.from !== '').slice(0, 25)) {
    console.log(`  ${u.id}: "${u.from}" -> "${u.to}"`);
  }
}

if (dryRun) {
  console.log('\nDRY RUN — no writes performed.');
} else if (toUpdate.length === 0) {
  console.log('\nNothing to write.');
} else {
  let written = 0;
  for (let i = 0; i < toUpdate.length; i += 400) {
    const batch = db.batch();
    for (const u of toUpdate.slice(i, i + 400)) {
      batch.update(db.collection('users').doc(u.id), { email: u.to });
    }
    await batch.commit();
    written += Math.min(400, toUpdate.length - i);
    console.log(`Progress: ${written}/${toUpdate.length}`);
  }
  console.log(`\nDONE — wrote ${written} docs.`);
}

await app.delete();
