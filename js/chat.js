// Nativoya — real-time group chat client (Firebase Firestore).
// Loaded after firebase-config.js and the Firebase compat SDK scripts.
(function () {
  let app, auth, db;
  let signedIn = false;

  function ensureInitialized() {
    if (!app) {
      app = firebase.initializeApp(window.NM_FIREBASE_CONFIG);
      auth = firebase.auth();
      db = firebase.firestore();
    }
  }

  // Exchanges our own JWT (via the backend) for a Firebase custom token, then
  // signs into Firebase Auth with it. After this, Firestore Security Rules
  // can see request.auth.uid / request.auth.token.role / .groupId.
  async function ensureFirebaseAuth() {
    ensureInitialized();
    if (signedIn && auth.currentUser) return;

    const { token } = await NM.apiFetch("/api/auth/firebase-token");
    await auth.signInWithCustomToken(token);
    signedIn = true;
  }

  // Live-listens to a group's messages (oldest → newest, capped at the last
  // 100). Returns an unsubscribe function — call it before switching groups.
  function listenToGroup(groupId, onMessages, onError) {
    ensureInitialized();
    return db.collection("groups").doc(groupId).collection("messages")
      .orderBy("createdAt", "asc")
      .limitToLast(100)
      .onSnapshot(
        (snap) => onMessages(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
        (err) => { console.error("Chat listener error:", err); if (onError) onError(err); }
      );
  }

  async function sendMessage(groupId, text, senderName) {
    ensureInitialized();
    await ensureFirebaseAuth();
    const uid = auth.currentUser.uid;
    await db.collection("groups").doc(groupId).collection("messages").add({
      text,
      senderId: uid,
      senderName,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
  }

  function currentUid() {
    return auth && auth.currentUser ? auth.currentUser.uid : null;
  }

  window.NMChat = { ensureFirebaseAuth, listenToGroup, sendMessage, currentUid };
})();
