import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";

export interface E2EState {
  url: string;
  home: string;
  mockUrl: string;
  supportRun: string;
  secondTurn: string;
  researchRun: string;
  failedRun: string;
  loopRun: string;
  cycleRun: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));

export function state(): E2EState {
  return JSON.parse(fs.readFileSync(path.join(here, ".state.json"), "utf8")) as E2EState;
}

/** Goes to a hash route and waits for the app shell. */
export async function open(page: Page, route: string): Promise<void> {
  await page.goto(`${state().url}/#/${route.replace(/^[#/]+/, "")}`);
  await expect(page.getByRole("link", { name: "neatroots home" })).toBeVisible();
}

/** Fails the test on uncaught page errors. */
export function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}

export async function api<T>(route: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${state().url}${route}`, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error(`${route}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}
