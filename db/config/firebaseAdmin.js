const admin = require("firebase-admin");

let app;

// Lazily initialized so a missing/late-added env var doesn't crash the whole
// server — only requests that actually need chat will hit this.
function getAdminApp() {
  if (app) return app;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    const err = new Error("Firebase isn't configured yet — FIREBASE_SERVICE_ACCOUNT_JSON is missing.");
    err.code = "FIREBASE_NOT_CONFIGURED";
    throw err;
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch (e) {
    const err = new Error("FIREBASE_SERVICE_ACCOUNT_JSON isn't valid JSON.");
    err.code = "FIREBASE_NOT_CONFIGURED";
    throw err;
  }

  app = admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  return app;
}

// One token per request is fine for our traffic; ties the Firestore
// `request.auth.uid` to our own Postgres user id, and carries role/group as
// custom claims so Security Rules can scope access per-group.
async function mintCustomToken(uid, claims) {
  const adminApp = getAdminApp();
  return adminApp.auth().createCustomToken(uid, claims);
}

module.exports = { mintCustomToken };
