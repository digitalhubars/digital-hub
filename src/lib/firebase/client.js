import { getApps, initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth } from 'firebase/auth';
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions';

// Web config from .env.local / .env.production (these values are public by design;
// access is controlled by firestore.rules and the Cloud Functions).
const config = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  databaseURL: process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

export const firebaseConfigured = Boolean(config.apiKey && config.projectId);
const useEmulators = process.env.NEXT_PUBLIC_FIREBASE_EMULATORS === 'true';

let services;

export function fb() {
  if (!services) {
    const app = getApps()[0] || initializeApp(config);
    const auth = getAuth(app);
    const db = getFirestore(app);
    const functions = getFunctions(app, 'asia-southeast1');
    if (useEmulators) {
      connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
      connectFirestoreEmulator(db, '127.0.0.1', 8080);
      connectFunctionsEmulator(functions, '127.0.0.1', 5001);
    }
    services = { app, auth, db, functions };
  }
  return services;
}

// Calls a Cloud Function and returns its result. Errors carry the function's message.
export async function call(name, data = {}) {
  const fn = httpsCallable(fb().functions, name, { timeout: 300000 });
  const result = await fn(data);
  return result.data;
}
