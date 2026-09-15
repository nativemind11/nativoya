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

  // Translates raw Firebase error codes into plain Arabic for end users.
  // Anything unmapped falls back to a generic sentence — never shows the
  // raw Firebase/technical message.
  function friendlyChatError(err) {
    const code = err && err.code;
    const map = {
      "permission-denied": "معندكش صلاحية توصل للشات ده.",
      "unavailable": "الشات مش متاح دلوقتي. حاول تاني بعد شوية.",
      "auth/network-request-failed": "مفيش اتصال بالإنترنت. تأكد من الاتصال وحاول تاني.",
      "auth/invalid-custom-token": "تعذّر تسجيل الدخول للشات. حاول تسجّل خروج ودخول تاني.",
      "auth/custom-token-mismatch": "تعذّر تسجيل الدخول للشات. حاول تسجّل خروج ودخول تاني.",
    };
    if (code && map[code]) return new Error(map[code]);
    // Backend messages already in Arabic (e.g. Firebase-not-configured notice)
    // are already user-facing — pass them through.
    if (err && err.message && /[\u0600-\u06FF]/.test(err.message)) return err;
    console.error("[Nativoya] Unmapped chat error:", err);
    return new Error("حصل خطأ في الشات. حاول تاني بعد شوية.");
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
        (err) => { console.error("Chat listener error:", err); if (onError) onError(friendlyChatError(err)); }
      );
  }

  async function sendMessage(groupId, text, senderName) {
    try {
      ensureInitialized();
      await ensureFirebaseAuth();
      const uid = auth.currentUser.uid;
      await db.collection("groups").doc(groupId).collection("messages").add({
        type: "text",
        text,
        senderId: uid,
        senderName,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    } catch (err) {
      throw friendlyChatError(err);
    }
  }

  // Voice messages are stored as a base64 data URL directly on the message
  // document (no Firebase Storage / Blaze plan needed). Firestore caps a
  // document at 1MiB, so recordings are capped client-side (see
  // startVoiceRecording) well below that so the base64 inflation still fits.
  async function sendVoiceMessage(groupId, base64Audio, mimeType, senderName) {
    try {
      ensureInitialized();
      await ensureFirebaseAuth();
      const uid = auth.currentUser.uid;
      await db.collection("groups").doc(groupId).collection("messages").add({
        type: "audio",
        audioData: base64Audio,
        mimeType,
        senderId: uid,
        senderName,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    } catch (err) {
      throw friendlyChatError(err);
    }
  }

  // Records mic audio and resolves { base64, mimeType, seconds } when the
  // returned stop() is called (or after maxSeconds automatically). Throws a
  // friendly Arabic error if the mic can't be accessed.
  async function startVoiceRecording(maxSeconds) {
    maxSeconds = maxSeconds || 60;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      throw new Error("معندكش صلاحية الميكروفون. لازم توافق من المتصفح الأول.");
    }

    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus" : "audio/mp4";
    const recorder = new MediaRecorder(stream, { mimeType });
    const chunks = [];
    recorder.addEventListener("dataavailable", (e) => { if (e.data.size > 0) chunks.push(e.data); });
    recorder.start();
    const startedAt = Date.now();

    let autoStopTimer;
    const stopPromise = new Promise((resolve, reject) => {
      recorder.addEventListener("stop", async () => {
        clearTimeout(autoStopTimer);
        stream.getTracks().forEach((t) => t.stop());
        try {
          const blob = new Blob(chunks, { type: mimeType });
          // ~700KB raw audio keeps the base64 doc comfortably under Firestore's 1MiB limit
          if (blob.size > 700 * 1024) {
            reject(new Error("الرسالة الصوتية طويلة أوي. جرب تسجل رسالة أقصر (أقل من دقيقة تقريبًا)."));
            return;
          }
          const base64 = await blobToBase64(blob);
          resolve({ base64, mimeType, seconds: Math.round((Date.now() - startedAt) / 1000) });
        } catch (err) {
          reject(err);
        }
      });
      recorder.addEventListener("error", (e) => reject(e.error || new Error("تعذر تسجيل الرسالة الصوتية.")));
    });

    autoStopTimer = setTimeout(() => { if (recorder.state === "recording") recorder.stop(); }, maxSeconds * 1000);

    return {
      stop: () => { if (recorder.state === "recording") recorder.stop(); },
      cancel: () => { clearTimeout(autoStopTimer); stream.getTracks().forEach((t) => t.stop()); },
      result: stopPromise,
    };
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result.split(",")[1]);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  function currentUid() {
    return auth && auth.currentUser ? auth.currentUser.uid : null;
  }

  window.NMChat = { ensureFirebaseAuth, listenToGroup, sendMessage, sendVoiceMessage, startVoiceRecording, currentUid };
})();
