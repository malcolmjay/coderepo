import { initializeApp, type FirebaseOptions } from "firebase/app";
import { browserSessionPersistence, connectAuthEmulator, getAuth, setPersistence } from "firebase/auth";
import { connectFunctionsEmulator, getFunctions, httpsCallable } from "firebase/functions";
import { connectStorageEmulator, getStorage } from "firebase/storage";
import { VERIFICATION_TIMEOUT_SECONDS } from "../functions/src/upload-config.js";

const emulated = import.meta.env.DEV && import.meta.env.VITE_USE_EMULATORS === "true";
async function configuration(): Promise<FirebaseOptions> {
  if (emulated) return {apiKey: "demo-key", projectId: "demo-camera-portal", authDomain: "localhost", storageBucket: "demo-camera-portal.appspot.com"};
  const response = await fetch("/__/firebase/init.json", {cache: "no-store"});
  if (!response.ok || !response.headers.get("content-type")?.includes("json")) throw new Error("Hosting setup is not complete.");
  const config = await response.json();
  if (!config.apiKey || !config.projectId || !config.storageBucket) throw new Error("Firebase configuration is incomplete.");
  return config;
}

export async function connect() {
  const app = initializeApp(await configuration());
  const auth = getAuth(app);
  const functions = getFunctions(app, "northamerica-northeast1");
  const storage = getStorage(app);
  // Retry temporary connection failures; this is not a total-upload deadline.
  storage.maxUploadRetryTime = 30 * 60 * 1000;
  if (emulated) {
    connectAuthEmulator(auth, "http://127.0.0.1:9099", {disableWarnings: true});
    connectFunctionsEmulator(functions, "127.0.0.1", 5001);
    connectStorageEmulator(storage, "127.0.0.1", 9199);
  }
  await setPersistence(auth, browserSessionPersistence);
  const call = httpsCallable<Record<string, unknown>, unknown>(functions, "portal");
  const verify = httpsCallable<Record<string, unknown>, unknown>(functions, "portal", {timeout: (VERIFICATION_TIMEOUT_SECONDS + 60) * 1000});
  return {auth, storage, api: async <T>(operation: string, data: Record<string, unknown> = {}): Promise<T> => (await (["completeUpload", "completeCommunityUpload"].includes(operation) ? verify : call)({operation, ...data})).data as T};
}
