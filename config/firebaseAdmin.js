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

// IMPORTANT FIX: createCustomToken(uid, claims) only bakes `claims` into the
// very first ID token minted from that sign-in. When Firebase silently
// refreshes that ID token later (which it does automatically, typically
// every ~1 hour), the *new* ID token does NOT carry those claims unless
// they were persisted on the user's Firebase Auth record — this was the bug
// that made members/leaders get silently locked out of sending messages
// after using the chat for a while (Firestore rules saw an empty
// `request.auth.token.groupIds` and rejected the write as permission-denied).
// setCustomUserClaims() persists role/groupIds on the account itself, so
// every future token (including silent refreshes) keeps carrying them.
async function mintCustomToken(uid, claims) {
  const adminApp = getAdminApp();
  try {
    await adminApp.auth().setCustomUserClaims(uid, claims);
  } catch (err) {
    // setCustomUserClaims needs a Firebase Auth record to already exist for
    // this uid — but that record is normally only created automatically the
    // FIRST time someone signs in with a custom token. So a brand-new
    // account opening chat for the very first time hits a chicken-and-egg
    // gap: we're trying to set claims before that first sign-in has ever
    // happened. Create the bare Auth record ourselves, then set the claims.
    if (err.code === "auth/user-not-found") {
      await adminApp.auth().createUser({ uid });
      await adminApp.auth().setCustomUserClaims(uid, claims);
    } else {
      throw err;
    }
  }
  return adminApp.auth().createCustomToken(uid);
}

module.exports = { mintCustomToken };
