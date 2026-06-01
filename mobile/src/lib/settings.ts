import * as SecureStore from "expo-secure-store";

// Device settings live in the OS keychain/keystore via expo-secure-store, NOT in the
// synced SQLite db. The OpenAI key is per-device (both devices run all features); the
// SimpleFIN access URL is also mirrored into the `connection` table so it can sync.
// The desktop peer URL is how the phone reaches the laptop's sync endpoints over LAN.

export type SettingKey = "openai_key" | "openai_model" | "desktop_peer_url";

const cache: Partial<Record<SettingKey, string>> = {};

export async function getSetting(key: SettingKey): Promise<string | null> {
  if (key in cache) return cache[key] ?? null;
  const v = await SecureStore.getItemAsync(key);
  cache[key] = v ?? undefined;
  return v;
}

export async function setSetting(key: SettingKey, value: string): Promise<void> {
  await SecureStore.setItemAsync(key, value);
  cache[key] = value;
}

export async function deleteSetting(key: SettingKey): Promise<void> {
  await SecureStore.deleteItemAsync(key);
  delete cache[key];
}

export async function getOpenAiKey(): Promise<string> {
  const k = await getSetting("openai_key");
  if (!k) throw new Error("No OpenAI API key set. Add it in Settings to use categorization and chat.");
  return k;
}

export async function getModel(): Promise<string> {
  return (await getSetting("openai_model")) || "gpt-5.5";
}

// Preload commonly-read settings into the in-memory cache at app start.
export async function preloadSettings(): Promise<void> {
  await Promise.all([
    getSetting("openai_key"),
    getSetting("openai_model"),
    getSetting("desktop_peer_url"),
  ]);
}
