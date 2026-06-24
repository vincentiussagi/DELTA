import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyD0FgVMF15B9P44TdM8KvTce2vJMdCg_uw",
  authDomain: "delta-dco.firebaseapp.com",
  projectId: "delta-dco",
  storageBucket: "delta-dco.firebasestorage.app",
  messagingSenderId: "997044342555",
  appId: "1:997044342555:web:594f1a0609b406a4bd4dbe",
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
