// Copy Firebase Auth users from the old project to gpsin-prod.
//
// Preserves:
//   - UID (so existing Firestore `users` doc IDs / authToken fields still match)
//   - email / displayName / photoURL / phoneNumber / disabled flag / metadata
//   - providerData (Google etc. — federated sign-in keeps working)
//   - password hash + salt   IF you provide hash params in creds/auth-hash.json
//
// What cannot be migrated:
//   - Active sessions / ID tokens / refresh tokens. Those are short-lived
//     credentials, not user identity — they always need to be re-issued by the
//     target project on next sign-in. Preserving the UID + provider data +
//     password hash is what makes that re-issuance invisible to the user.
//
// Getting the hash params (only needed if you want password-based users to
// keep their existing passwords): Firebase Console → Authentication →
// Users tab → kebab menu (⋮) at top-right → "Password hash parameters".
// Save the displayed values into creds/auth-hash.json:
//   {
//     "algorithm": "SCRYPT",
//     "base64_signer_key": "...",
//     "base64_salt_separator": "...",
//     "rounds": 8,
//     "mem_cost": 14
//   }
//
// Usage:
//   node scripts/copy-auth.mjs --dry-run
//   node scripts/copy-auth.mjs

import admin from 'firebase-admin';
import { readFileSync, existsSync } from 'node:fs';
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

if (values.target !== 'prod') {
  console.error('Auth migration is prod-only (real user accounts). Pass --target prod.');
  process.exit(1);
}
const dryRun = values['dry-run'];

const sourceCred = JSON.parse(readFileSync(path.join(credsDir, 'old.json'), 'utf8'));
const targetCred = JSON.parse(readFileSync(path.join(credsDir, 'prod.json'), 'utf8'));

console.log(
  `Source auth: ${sourceCred.project_id}  →  Target auth: ${targetCred.project_id}` +
    (dryRun ? '  [DRY RUN]' : ''),
);

const hashPath = path.join(credsDir, 'auth-hash.json');
let importOptions;
if (existsSync(hashPath)) {
  const h = JSON.parse(readFileSync(hashPath, 'utf8'));
  importOptions = {
    hash: {
      algorithm: h.algorithm ?? 'SCRYPT',
      key: Buffer.from(h.base64_signer_key, 'base64'),
      saltSeparator: Buffer.from(h.base64_salt_separator, 'base64'),
      rounds: h.rounds,
      memoryCost: h.mem_cost,
    },
  };
  console.log(`Loaded hash params (algorithm=${importOptions.hash.algorithm}) — passwords will be preserved.`);
} else {
  console.warn(
    'No creds/auth-hash.json — password-only users will need a password reset to sign in. ' +
      'Federated (Google etc.) sign-in still works because providerData is preserved.',
  );
}

const sourceApp = admin.initializeApp(
  { credential: admin.credential.cert(sourceCred) },
  'source',
);
const targetApp = admin.initializeApp(
  { credential: admin.credential.cert(targetCred) },
  'target',
);

const sourceAuth = sourceApp.auth();
const targetAuth = targetApp.auth();

// Page through all users.
const users = [];
let pageToken;
do {
  const page = await sourceAuth.listUsers(1000, pageToken);
  for (const u of page.users) {
    users.push({
      uid: u.uid,
      email: u.email,
      emailVerified: u.emailVerified,
      displayName: u.displayName,
      photoURL: u.photoURL,
      phoneNumber: u.phoneNumber,
      disabled: u.disabled,
      metadata: {
        creationTime: u.metadata.creationTime,
        lastSignInTime: u.metadata.lastSignInTime,
      },
      passwordHash: u.passwordHash ? Buffer.from(u.passwordHash, 'base64') : undefined,
      passwordSalt: u.passwordSalt ? Buffer.from(u.passwordSalt, 'base64') : undefined,
      providerData: u.providerData.map((p) => ({
        uid: p.uid,
        email: p.email,
        displayName: p.displayName,
        photoURL: p.photoURL,
        providerId: p.providerId,
      })),
      customClaims: u.customClaims,
    });
  }
  pageToken = page.pageToken;
} while (pageToken);

console.log(`Listed ${users.length} users from old project.`);
const withPasswordHash = users.filter((u) => u.passwordHash).length;
const googleUsers = users.filter((u) =>
  u.providerData.some((p) => p.providerId === 'google.com'),
).length;
console.log(`  ${withPasswordHash} with password hash, ${googleUsers} with Google provider linked.`);

if (dryRun) {
  console.log('DRY RUN — first 5 users:');
  for (const u of users.slice(0, 5)) {
    const providers = u.providerData.map((p) => p.providerId).join(',') || 'password';
    console.log(`  uid=${u.uid}  email=${u.email}  providers=${providers}`);
  }
  console.log('No writes performed.');
} else {
  let success = 0;
  let failure = 0;
  for (let i = 0; i < users.length; i += 1000) {
    const batch = users.slice(i, i + 1000);
    try {
      const result = await targetAuth.importUsers(batch, importOptions);
      success += result.successCount;
      failure += result.failureCount;
      for (const err of result.errors) {
        console.warn(`  failed uid=${batch[err.index].uid}: ${err.error.message}`);
      }
    } catch (e) {
      console.error(`Batch starting at ${i} threw:`, e.message);
      failure += batch.length;
    }
    console.log(`Progress: ${success + failure}/${users.length} (success=${success} fail=${failure})`);
  }
  console.log(`DONE — success=${success} fail=${failure}`);
}

await sourceApp.delete();
await targetApp.delete();
