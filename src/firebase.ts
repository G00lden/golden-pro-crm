import { initializeApp } from 'firebase/app';
import {
  browserLocalPersistence,
  createUserWithEmailAndPassword,
  getAuth,
  getRedirectResult,
  GoogleAuthProvider,
  onAuthStateChanged,
  setPersistence,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  updateProfile,
} from 'firebase/auth';
import { getFirestore, collection, doc, setDoc, getDoc, getDocs, updateDoc, deleteDoc, query, where, onSnapshot, getDocFromServer, getCountFromServer, limit, orderBy, startAfter, initializeFirestore, terminate, writeBatch } from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// Use localStorage so the session survives the OAuth redirect / page reload
// (the default in some browsers is session-scoped, which loses state across the popup).
setPersistence(auth, browserLocalPersistence).catch((err) => {
  console.warn("Failed to set Firebase Auth persistence:", err);
});

// If the user came back from a previous signInWithRedirect call, consume the
// redirect result so onAuthStateChanged fires. Errors are logged but ignored —
// the popup path below is the primary flow on modern browsers.
if (typeof window !== "undefined") {
  getRedirectResult(auth).catch((err) => {
    if (err?.code && err.code !== "auth/no-redirect-operation") {
      console.warn("Firebase getRedirectResult error:", err);
    }
  });
}

// Initialize Firestore with settings to handle idle streams better
export const db = initializeFirestore(app, {
  experimentalForceLongPolling: true, // Use long-polling to avoid gRPC stream issues in some environments
}, firebaseConfig.firestoreDatabaseId);

export const googleProvider = new GoogleAuthProvider();

export type AppUser = {
  uid: string;
  email?: string | null;
  displayName?: string | null;
  local: boolean;
  getIdToken?: () => Promise<string>;
};

type LocalAccount = {
  uid: string;
  email: string;
  name: string;
  passwordHash: string;
  createdAt: string;
};

const LOCAL_ACCOUNTS_KEY = "golden-pro-crm-local-accounts";
const LOCAL_SESSION_KEY = "golden-pro-crm-local-session";
const LOCAL_AUTH_EVENT = "golden-pro-crm-local-auth";
const isBrowser = typeof window !== "undefined";
const isLocalHost = isBrowser && ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
export const localAuthEnabled = isBrowser && (import.meta.env.VITE_LOCAL_AUTH === "true" || (import.meta.env.DEV && isLocalHost));
const serverDataEnabled =
  import.meta.env.VITE_DATA_PROVIDER === "supabase" ||
  import.meta.env.VITE_DB_PROVIDER === "supabase";

function authError(code: string, message: string) {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function getLocalAccounts(): Record<string, LocalAccount> {
  if (!isBrowser) return {};
  try {
    return JSON.parse(window.localStorage.getItem(LOCAL_ACCOUNTS_KEY) || "{}") as Record<string, LocalAccount>;
  } catch {
    return {};
  }
}

function setLocalAccounts(accounts: Record<string, LocalAccount>) {
  window.localStorage.setItem(LOCAL_ACCOUNTS_KEY, JSON.stringify(accounts));
}

async function hashPassword(password: string) {
  const bytes = new TextEncoder().encode(password);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function emitLocalAuthChange() {
  if (isBrowser) window.dispatchEvent(new Event(LOCAL_AUTH_EVENT));
}

export function getCurrentAppUser(): AppUser | null {
  const firebaseUser = auth.currentUser;
  if (firebaseUser) {
    return {
      uid: firebaseUser.uid,
      email: firebaseUser.email,
      displayName: firebaseUser.displayName,
      local: false,
      getIdToken: () => firebaseUser.getIdToken(),
    };
  }

  if (!localAuthEnabled) return null;

  try {
    const session = JSON.parse(window.localStorage.getItem(LOCAL_SESSION_KEY) || "null") as { email?: string } | null;
    if (!session?.email) return null;
    const account = getLocalAccounts()[normalizeEmail(session.email)];
    if (!account) return null;
    return {
      uid: account.uid,
      email: account.email,
      displayName: account.name,
      local: true,
      getIdToken: async () => `local-dev:${account.uid}`,
    };
  } catch {
    return null;
  }
}

export async function loginLocal(email: string, password: string) {
  if (!localAuthEnabled) throw authError("auth/operation-not-allowed", "Local auth is disabled.");

  const key = normalizeEmail(email);
  const account = getLocalAccounts()[key];
  if (!account || account.passwordHash !== await hashPassword(password)) {
    throw authError("auth/invalid-credential", "Invalid local credentials.");
  }

  window.localStorage.setItem(LOCAL_SESSION_KEY, JSON.stringify({ email: account.email }));
  emitLocalAuthChange();
  return getCurrentAppUser();
}

export async function registerLocal(name: string, email: string, password: string) {
  if (!localAuthEnabled) throw authError("auth/operation-not-allowed", "Local auth is disabled.");
  if (password.length < 6) throw authError("auth/weak-password", "Password must contain at least 6 characters.");

  const key = normalizeEmail(email);
  const accounts = getLocalAccounts();
  if (accounts[key]) throw authError("auth/email-already-in-use", "Email is already registered locally.");

  accounts[key] = {
    uid: `local-${crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`,
    email: key,
    name: name.trim() || key,
    passwordHash: await hashPassword(password),
    createdAt: new Date().toISOString(),
  };
  setLocalAccounts(accounts);
  window.localStorage.setItem(LOCAL_SESSION_KEY, JSON.stringify({ email: key }));
  emitLocalAuthChange();
  return getCurrentAppUser();
}

export async function loginDemoLocal() {
  if (!localAuthEnabled) throw authError("auth/operation-not-allowed", "Local auth is disabled.");

  const key = "demo@goldenpro.local";
  const accounts = getLocalAccounts();
  accounts[key] = {
    uid: "local-dev-owner",
    email: key,
    name: "Golden Pro Demo",
    passwordHash: await hashPassword("demo123456"),
    createdAt: accounts[key]?.createdAt || new Date().toISOString(),
  };
  setLocalAccounts(accounts);
  window.localStorage.setItem(LOCAL_SESSION_KEY, JSON.stringify({ email: key }));
  emitLocalAuthChange();
  return getCurrentAppUser();
}

export function onAppAuthStateChanged(callback: (user: AppUser | null) => void) {
  const firebaseUnsubscribe = onAuthStateChanged(auth, () => callback(getCurrentAppUser()));
  const localHandler = () => callback(getCurrentAppUser());
  if (isBrowser) {
    window.addEventListener(LOCAL_AUTH_EVENT, localHandler);
    queueMicrotask(localHandler);
  }

  return () => {
    firebaseUnsubscribe();
    if (isBrowser) window.removeEventListener(LOCAL_AUTH_EVENT, localHandler);
  };
}

// Connection Test (Only run in browser)
if (typeof window !== 'undefined') {
  async function testConnection() {
    try {
      await getDocFromServer(doc(db, 'test', 'connection'));
    } catch (error) {
      if (error instanceof Error && error.message.includes('the client is offline')) {
        console.error("Please check your Firebase configuration.");
      }
    }
  }
  testConnection();
}

// Error Handling
export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: any[];
  }
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : "";
  const rawMessage = error instanceof Error ? error.message : String(error);
  const errInfo: FirestoreErrorInfo = {
    error: rawMessage,
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));

  if (code.includes("permission-denied")) {
    throw new Error("ليست لديك صلاحية تنفيذ هذه العملية أو أن البيانات لا تطابق قواعد Firestore.");
  }
  if (code.includes("failed-precondition") && rawMessage.includes("index")) {
    throw new Error("يتطلب هذا الاستعلام فهرسا في Firestore. انشر firestore.indexes.json ثم أعد المحاولة.");
  }
  if (code.includes("unavailable")) {
    throw new Error("تعذر الاتصال بـ Firestore حاليا. تحقق من الشبكة ثم أعد المحاولة.");
  }

  throw new Error(rawMessage || "حدث خطأ أثناء التعامل مع Firestore.");
}

// Google sign-in. Tries popup first (reliable on Chrome/Safari/Firefox with
// third-party cookie restrictions); falls back to redirect if the popup is
// blocked or unsupported (e.g. in some embedded webviews).
export const login = async () => {
  try {
    return await signInWithPopup(auth, googleProvider);
  } catch (error) {
    const code = (error as { code?: string })?.code || "";
    if (
      code === "auth/popup-blocked" ||
      code === "auth/operation-not-supported-in-this-environment" ||
      code === "auth/cancelled-popup-request"
    ) {
      return signInWithRedirect(auth, googleProvider);
    }
    throw error;
  }
};
export const loginWithEmail = (email: string, password: string) => signInWithEmailAndPassword(auth, email, password);
export const registerWithEmail = async (name: string, email: string, password: string) => {
  const result = await createUserWithEmailAndPassword(auth, email, password);
  if (name.trim()) {
    await updateProfile(result.user, { displayName: name.trim() });
  }
  return result;
};
export const logout = async () => {
  if (isBrowser) {
    window.localStorage.removeItem(LOCAL_SESSION_KEY);
    emitLocalAuthChange();
  }
  if (auth.currentUser) await auth.signOut();
};

export { collection, doc, setDoc, getDoc, getDocs, updateDoc, deleteDoc, query, where, onSnapshot, onAuthStateChanged, getCountFromServer, limit, orderBy, startAfter, writeBatch };
