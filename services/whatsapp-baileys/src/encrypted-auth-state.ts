/**
 * useEncryptedMultiFileAuthState
 *
 * Drop-in replacement for Baileys' useMultiFileAuthState that encrypts every
 * file written to disk using AES-256-GCM (via session-cipher.ts).
 *
 * Usage:
 *   import { useEncryptedMultiFileAuthState } from "./encrypted-auth-state.js";
 *   const { state, saveCreds } = await useEncryptedMultiFileAuthState(sessionDir);
 *
 * Migration note:
 *   Existing plaintext session directories will be treated as "session not found".
 *   Baileys will start a new session (QR / pairing code). This is intentional —
 *   plaintext sessions must not be silently imported after encryption is enabled.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AuthenticationCreds, AuthenticationState, SignalDataTypeMap } from "@whiskeysockets/baileys";
import { initAuthCreds, BufferJSON } from "@whiskeysockets/baileys";
import { readEncryptedJson, writeEncryptedJson } from "./session-cipher.js";

type SignalDataSet = { [T in keyof SignalDataTypeMap]?: { [id: string]: SignalDataTypeMap[T] } };

async function writeData(filePath: string, data: unknown): Promise<void> {
  await writeEncryptedJson(filePath, JSON.parse(JSON.stringify(data, BufferJSON.replacer)));
}

async function readData<T>(filePath: string): Promise<T | null> {
  const parsed = await readEncryptedJson<string>(filePath);
  if (parsed === null) return null;
  // parsed is already a JS object from readEncryptedJson
  return JSON.parse(JSON.stringify(parsed), BufferJSON.reviver) as T;
}

export async function useEncryptedMultiFileAuthState(folder: string): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}> {
  const fixFileName = (file: string) => (file.includes(path.sep) ? file.replaceAll(path.sep, "__") : file);

  await fs.mkdir(folder, { recursive: true });

  const credsPath = path.join(folder, "creds.json");

  // Load existing credentials — null means fresh session (plaintext or missing)
  let creds: AuthenticationCreds;
  const existingCreds = await readData<AuthenticationCreds>(credsPath);
  if (existingCreds) {
    creds = existingCreds;
  } else {
    creds = initAuthCreds();
  }

  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(
          type: T,
          ids: string[]
        ): Promise<{ [id: string]: SignalDataTypeMap[T] }> => {
          const data: { [id: string]: SignalDataTypeMap[T] } = {};
          await Promise.all(
            ids.map(async (id) => {
              const filePath = path.join(folder, `${fixFileName(`${type}-${id}`)}.json`);
              const value = await readData<SignalDataTypeMap[T]>(filePath);
              if (value) data[id] = value;
            })
          );
          return data;
        },
        set: async (data: SignalDataSet): Promise<void> => {
          const tasks: Promise<void>[] = [];
          for (const category in data) {
            const categoryData = data[category as keyof SignalDataTypeMap];
            if (!categoryData) continue;
            for (const id in categoryData) {
              const filePath = path.join(folder, `${fixFileName(`${category}-${id}`)}.json`);
              const value = categoryData[id];
              if (value) {
                tasks.push(writeData(filePath, value));
              } else {
                // null/undefined means delete
                tasks.push(fs.unlink(filePath).catch(() => {}));
              }
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeData(credsPath, creds),
  };
}
