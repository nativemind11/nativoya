// Nativoya — Firebase config for the real-time group chat (Firestore + Storage).
// These values are public identifiers, not secrets — Firebase is designed to
// have this object embedded directly in client-side code. Access control is
// enforced server-side by Firestore/Storage Security Rules, not by hiding this.

const firebaseConfig = {
  apiKey: "AIzaSyAs0Og20O_8LOpcsO4oHjLE8VLhoyqxcOo",
  authDomain: "nativoya-75e3a.firebaseapp.com",
  projectId: "nativoya-75e3a",
  storageBucket: "nativoya-75e3a.firebasestorage.app",
  messagingSenderId: "163283092493",
  appId: "1:163283092493:web:e34d951806c7eef3550144",
  measurementId: "G-0HRYQ1DFHG"
};

// Exposed for chat.js to consume once Firestore/Storage are wired in.
window.NM_FIREBASE_CONFIG = firebaseConfig;
