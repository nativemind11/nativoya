// Nativoya — Firebase config + init for the real-time group chat (Firestore).
// These values are public identifiers, not secrets — Firebase is designed to
// have this object embedded directly in client-side code. Access control is
// enforced server-side by Firestore Security Rules, not by hiding this.

const firebaseConfig = {
  apiKey: "AIzaSyAs0Og20O_8LOpcsO4oHjLE8VLhoyqxcOo",
  authDomain: "nativoya-75e3a.firebaseapp.com",
  projectId: "nativoya-75e3a",
  storageBucket: "nativoya-75e3a.firebasestorage.app",
  messagingSenderId: "163283092493",
  appId: "1:163283092493:web:e34d951806c7eef3550144",
  measurementId: "G-0HRYQ1DFHG"
};

firebase.initializeApp(firebaseConfig);

// NM_FIREBASE.ready resolves once anonymous auth succeeds — every chat page
// awaits this before reading/writing Firestore, since our security rules
// require request.auth != null (we don't use Firebase Auth for real login;
// the app's real identity/roles come from the Postgres+JWT backend — this
// anonymous sign-in only satisfies Firestore's auth requirement).
const NM_FIREBASE = {
  db: firebase.firestore(),
  auth: firebase.auth(),
  ready: firebase.auth().currentUser
    ? Promise.resolve(firebase.auth().currentUser)
    : firebase.auth().signInAnonymously().then(() => firebase.auth().currentUser),
};
window.NM_FIREBASE = NM_FIREBASE;
