import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { rootsHome } from "../config.js";
import { providerById } from "../models/providers.js";

const run = promisify(execFile);
const SERVICE = "neatroots";
/** Keychain services used before the rename to neatroots. Read as a fallback, removed on logout. */
const LEGACY_SERVICES = ["neatlogs-bolt", "neatlogs-bolts"];

/** llm-api-key-<provider> holds the key for one external LLM provider. */
export type SecretName = "cloud-api-key" | "cloud-service-token" | "jev-api-key" | `llm-api-key-${string}`;

/** Environment variables that override a stored secret, first match wins. */
function envNames(name: SecretName): string[] {
  if (name === "cloud-api-key") return ["NEATLOGS_CLOUD_API_KEY"];
  if (name === "cloud-service-token") return ["NEATLOGS_SERVICE_TOKEN"];
  if (name === "jev-api-key") return ["TYPESAFE_API_KEY"];
  const provider = name.slice("llm-api-key-".length);
  return ["NEATROOTS_LLM_API_KEY", ...(providerById(provider)?.keyEnv ?? [])];
}

/** Where a secret would come from, without reading the Keychain value into logs. */
export function secretEnvSource(name: SecretName): string | undefined {
  return envNames(name).find((e) => process.env[e]);
}

function fallbackFile(name: SecretName): string {
  return path.join(rootsHome(), name);
}

/**
 * Secrets live in the macOS login Keychain (service "neatroots"); elsewhere in a 0600
 * file under ~/.neatroots. They never enter the database or logs.
 */
export async function getSecret(name: SecretName): Promise<string | undefined> {
  const env = secretEnvSource(name);
  if (env) return process.env[env];
  if (process.platform === "darwin") {
    try {
      for (const service of [SERVICE, ...LEGACY_SERVICES]) {
        try {
          const { stdout } = await run("security", ["find-generic-password", "-s", service, "-a", name, "-w"]);
          const key = stdout.trim();
          if (key) return key;
        } catch {
          /* not stored under this name */
        }
      }
    } catch {
      /* not stored */
    }
  }
  try {
    return fs.readFileSync(fallbackFile(name), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function setSecret(name: SecretName, value: string): Promise<"keychain" | "file"> {
  if (process.platform === "darwin") {
    try {
      await run("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", name, "-w", value]);
      return "keychain";
    } catch {
      /* fall through to the file */
    }
  }
  fs.mkdirSync(rootsHome(), { recursive: true });
  fs.writeFileSync(fallbackFile(name), value, { encoding: "utf8", mode: 0o600 });
  return "file";
}

export async function deleteSecret(name: SecretName): Promise<void> {
  if (process.platform === "darwin") {
    try {
      for (const service of [SERVICE, ...LEGACY_SERVICES]) await run("security", ["delete-generic-password", "-s", service, "-a", name]).catch(() => undefined);
    } catch {
      /* nothing stored */
    }
  }
  try {
    fs.unlinkSync(fallbackFile(name));
  } catch {
    /* nothing stored */
  }
}

export const getCloudKey = () => getSecret("cloud-api-key");
export const setCloudKey = (key: string) => setSecret("cloud-api-key", key);
export const deleteCloudKey = () => deleteSecret("cloud-api-key");
/** Reading from Neatlogs Cloud (imports) takes a service-account token (nlsa_…), not the project key that sends runs. */
export const getCloudToken = () => getSecret("cloud-service-token");
export const setCloudToken = (token: string) => setSecret("cloud-service-token", token);
export const deleteCloudToken = () => deleteSecret("cloud-service-token");
