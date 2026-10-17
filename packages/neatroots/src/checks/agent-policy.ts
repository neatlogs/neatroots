import { isRule, type Check } from "./types.js";

/**
 * A halt rule stops the user's agent with the user's authority, so a coding agent (MCP) may not
 * create one, turn a check into one, or change one the user made (#256).
 */
export function assertNoHaltFromAgent(next: Check, current: Check | undefined): void {
  const halts = (c: Check | undefined) => !!c && isRule(c) && c.action === "halt";
  if (halts(next)) throw new Error("halt rules must be created or enabled by you in the app or CLI; save it with action: flag, and the user can switch it to halt in the app");
  if (halts(current)) throw new Error(`"${next.id}" is a halt rule; halt rules must be created or changed by you in the app or CLI`);
}
