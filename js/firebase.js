// ============================================================
// firebase.js — Firebase initialization
// ============================================================
// Exports `db` (Firestore) and `auth` (Authentication).
// Import these wherever you need to read/write data or manage login.
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";

// ------------------------------------------------------------
// Firebase project config.
// The API key is injected at build time from the GOOGLE_API_KEY
// environment secret via vite.config.ts → define.
// All other values are public project identifiers.
// ------------------------------------------------------------
const firebaseConfig = {
  apiKey: AIzaSyD0FgVMF15B9P44TdM8KvTce2vJMdCg_uw,
  authDomain: "delta-dco.firebaseapp.com",
  projectId: "delta-dco",
  storageBucket: "delta-dco.firebasestorage.app",
  messagingSenderId: "997044342555",
  appId: "1:997044342555:web:594f1a0609b406a4bd4dbe",
};
// ------------------------------------------------------------

// Initialize Firebase app
const app = initializeApp(firebaseConfig);

// Connect to Firestore (the database)
export const db = getFirestore(app);

// Connect to Firebase Authentication
export const auth = getAuth(app);
