import { readFileSync } from "fs";
import { createRequire } from "module";
import dotenv from "dotenv";
import {
  applicationDefault,
  cert,
  getApps,
  initializeApp,
  type App,
} from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { createSupabaseFirestoreAdapter } from "./supabaseFirestoreAdapter";
import { createSqliteFirestoreAdapter } from "./sqliteFirestoreAdapter";

// Use the same explicit environment file as the server bootstrap. This is
// critical for isolated QA: falling back to the repository .env here would
// load real provider credentials before server.ts can apply its configuration.
dotenv.config({ path: process.env.ENV_FILE || ".env", quiet: true });

type FirebaseAppletConfig = {
  projectId: string;
  firestoreDatabaseId?: string;
};

const require = createRequire(import.meta.url);
const firebaseConfig = require("../firebase-applet-config.json") as FirebaseAppletConfig;

function loadCredential() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON));
  }

  const serviceAccountPath =
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS;

  if (serviceAccountPath) {
    return cert(JSON.parse(readFileSync(serviceAccountPath, "utf8")));
  }

  return applicationDefault();
}

function initAdminApp(): App {
  const existing = getApps()[0];
  if (existing) return existing;

  return initializeApp({
    credential: loadCredential(),
    projectId: firebaseConfig.projectId,
  });
}

const dbProvider = process.env.DATA_PROVIDER || process.env.DB_PROVIDER || "firebase";

export const adminApp = getApps()[0] || initAdminApp();
export const adminAuth = getAuth(adminApp);

export const adminDb =
  dbProvider === "sqlite"
    ? createSqliteFirestoreAdapter()
    : dbProvider === "supabase"
      ? createSupabaseFirestoreAdapter()
      : getFirestore(
          adminApp,
          firebaseConfig.firestoreDatabaseId || "(default)",
        );
