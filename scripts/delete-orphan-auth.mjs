// Delete auth users in gpsin-prod that have NO matching `users` Firestore
// document (where `auth_token` == uid). Same orphan computation as
// list-orphan-auth.mjs; this one mutates instead of just listing.
//
// Safety:
//   - Without --confirm, prints the deletion plan and exits without writing.
//   - Aborts if more than --max orphans are detected (default 20) — a sanity
//     check in case the /users collection ever gets accidentally truncated.
//
// Usage:
//   node scripts/delete-orphan-auth.mjs                # dry-run
//   node scripts/delete-orphan-auth.mjs --confirm      # real delete

import admin from 'firebase-admin';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const credsDir = path.resolve(__dirname, '..', 'creds');

const { values } = parseArgs({
  options: {
    confirm: { type: 'boolean', default: false },
    max: { type: 'string', default: '20' },
  },
});

const confirm = values.confirm;
const maxAllowed = Number.parseInt(values.max, 10);

const cred = JSON.parse(readFileSync(path.join(credsDir, 'prod.json'), 'utf8'));
const app = admin.initializeApp(
  { credential: admin.credential.cert(cred) },
  'prod',
);
const auth = app.auth();
const db = app.firestore();

// Page through every auth user; remember email for nicer logging.
const authUsers = new Map();
let pageToken;
do {
  const page = await auth.listUsers(1000, pageToken);
  for (const u of page.users) authUsers.set(u.uid, u.email ?? '(no email)');
  pageToken = page.pageToken;
} while (pageToken);

// Collect every `auth_token` referenced in /users.
const usersSnap = await db.collection('users').get();
const docUids = new Set();
for (const d of usersSnap.docs) {
  const at = d.data().auth_token;
  if (at) docUids.add(at);
}

const orphans = [...authUsers.entries()].filter(([uid]) => !docUids.has(uid));
console.log(
  `Auth users: ${authUsers.size}   /users docs: ${docUids.size}   Orphans: ${orphans.length}\n`,
);

if (orphans.length === 0) {
  console.log('Nothing to delete. Done.');
  await app.delete();
  process.exit(0);
}

if (orphans.length > maxAllowed) {
  console.error(
    `Refusing to proceed: ${orphans.length} orphans exceeds --max=${maxAllowed}. ` +
      `If this is genuinely correct, re-run with --max=${orphans.length}.`,
  );
  await app.delete();
  process.exit(1);
}

console.log('Orphans:');
for (const [uid, email] of orphans) console.log(`  ${uid}  ${email}`);
console.log('');

if (!confirm) {
  console.log('DRY RUN — re-run with --confirm to actually delete.');
  await app.delete();
  process.exit(0);
}

let success = 0;
let failure = 0;
for (const [uid, email] of orphans) {
  try {
    await auth.deleteUser(uid);
    console.log(`  deleted ${uid}  ${email}`);
    success += 1;
  } catch (e) {
    console.warn(`  FAILED ${uid}  ${email}: ${e.message}`);
    failure += 1;
  }
}
console.log(`\nDONE — deleted=${success} failed=${failure}`);

await app.delete();
