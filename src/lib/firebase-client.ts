"use client";

import { initializeApp, getApps, type FirebaseOptions } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";

const config: FirebaseOptions = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain:
    process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ?? "wearthistea.firebaseapp.com",
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? "wearthistea",
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

let cachedAuth: Auth | null = null;

/** Lazy singleton — only touched from the admin sign-in page, never at page load. */
export function getFirebaseAuth(): Auth {
  if (cachedAuth) return cachedAuth;
  const app = getApps().length ? getApps()[0] : initializeApp(config);
  cachedAuth = getAuth(app);
  return cachedAuth;
}
