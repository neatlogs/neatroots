import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Command } from "commander";
import { rootsHome, loadConfig } from "../config.js";
import { api, port, running } from "./util.js";
import { bundleDir, cliPath, sourceDir } from "../util/install.js";

const LABEL = "com.neatlogs.neatroots";


function logFile(): string {
  return path.join(rootsHome(), "logs", "neatroots.log");
}

function plistPath(): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

function unitPath(): string {
  return path.join(os.homedir(), ".config", "systemd", "user", "neatroots.service");
}

function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The environment the service runs with: this shell's PATH (so Ollama and uv are found) and neatroots' own settings. */
function serviceEnv(): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" };
  for (const k of ["NEATROOTS_HOME", "NEATROOTS_PORT", "HF_HOME"]) if (process.env[k]) env[k] = process.env[k]!;
  return env;
}

function installMac(): void {
  const env = Object.entries(serviceEnv())
    .map(([k, v]) => `      <key>${xml(k)}</key><string>${xml(v)}</string>`)
    .join("\n");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${xml(process.execPath)}</string>
      <string>${xml(cliPath())}</string>
      <string>start</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${env}
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
    <key>ThrottleInterval</key><integer>10</integer>
    <key>StandardOutPath</key><string>${xml(logFile())}</string>
    <key>StandardErrorPath</key><string>${xml(logFile())}</string>
  </dict>
</plist>
`;
  fs.mkdirSync(path.dirname(plistPath()), { recursive: true });
  fs.writeFileSync(plistPath(), plist);
  const domain = `gui/${process.getuid?.() ?? 501}`;
  spawnSync("launchctl", ["bootout", `${domain}/${LABEL}`], { stdio: "ignore" });
  execFileSync("launchctl", ["bootstrap", domain, plistPath()]);
}

/** A value for a systemd unit, quoted: backslashes and quotes escaped, and % (a unit specifier) doubled. */
export function systemdQuoted(v: string): string {
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
}

/** An ExecStart= argument: quoted like any value, and $ doubled, since systemd expands $NAME there. */
export function systemdExecArg(v: string): string {
  return systemdQuoted(v.replace(/\$/g, () => "$$"));
}

function installLinux(): void {
  const env = Object.entries(serviceEnv())
    .map(([k, v]) => `Environment=${systemdQuoted(`${k}=${v}`)}`)
    .join("\n");
  const unit = `[Unit]
Description=neatroots
After=network.target

[Service]
ExecStart=${systemdExecArg(process.execPath)} ${systemdExecArg(cliPath())} start
${env}
Restart=on-failure
RestartSec=10
StandardOutput=append:${logFile()}
StandardError=append:${logFile()}

[Install]
WantedBy=default.target
`;
  fs.mkdirSync(path.dirname(unitPath()), { recursive: true });
  fs.writeFileSync(unitPath(), unit);
  execFileSync("systemctl", ["--user", "daemon-reload"]);
  execFileSync("systemctl", ["--user", "enable", "--now", "neatroots.service"]);
}

function installed(): boolean {
  return fs.existsSync(process.platform === "darwin" ? plistPath() : unitPath());
}

function restartService(): void {
  if (!installed()) return;
  if (process.platform === "darwin") spawnSync("launchctl", ["kickstart", "-k", `gui/${process.getuid?.() ?? 501}/${LABEL}`], { stdio: "ignore" });
  else spawnSync("systemctl", ["--user", "restart", "neatroots.service"], { stdio: "ignore" });
}

/** neatroots service (start at login) and neatroots update. */
export function registerServiceCommands(program: Command): void {
  const service = program.command("service").description("Run neatroots in the background and start it at login");

  service
    .command("install")
    .description(process.platform === "darwin" ? "Install a launchd agent (~/Library/LaunchAgents)" : "Install a systemd user service")
    .action(async () => {
      if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("background service is supported on macOS and Linux");
      const p = port();
      if ((await running(p)) && !installed()) throw new Error(`neatroots is already running on port ${p}. Stop it first (Ctrl+C in its terminal), then run this again.`);
      fs.mkdirSync(path.dirname(logFile()), { recursive: true });
      if (process.platform === "darwin") installMac();
      else installLinux();
      for (let i = 0; i < 30 && !(await running(p)); i++) await new Promise((r) => setTimeout(r, 500));
      const up = await running(p);
      console.log(up ? `✓ neatroots runs in the background and starts at login: http://localhost:${p}` : `Service installed but neatroots did not answer yet. Logs: ${logFile()}`);
      console.log(`Logs: ${logFile()} · Remove: neatroots service uninstall`);
      process.exitCode = up ? 0 : 1;
    });

  service
    .command("uninstall")
    .description("Stop the background service and remove it")
    .action(() => {
      if (process.platform === "darwin") {
        spawnSync("launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}/${LABEL}`], { stdio: "ignore" });
        fs.rmSync(plistPath(), { force: true });
      } else if (process.platform === "linux") {
        spawnSync("systemctl", ["--user", "disable", "--now", "neatroots.service"], { stdio: "ignore" });
        fs.rmSync(unitPath(), { force: true });
        spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
      }
      console.log("✓ background service removed (your runs and settings in ~/.neatroots are kept)");
    });

  service
    .command("status")
    .action(async () => {
      const p = port();
      console.log(`service: ${installed() ? "installed" : "not installed"} · neatroots ${(await running(p)) ? `answering on http://localhost:${p}` : "not running"}`);
      console.log(`logs: ${logFile()}`);
    });

  service
    .command("restart")
    .action(() => {
      if (!installed()) throw new Error("no background service; neatroots service install");
      restartService();
      console.log("✓ restarted");
    });

  program
    .command("update")
    .description("Update neatroots to the latest version")
    .option("--version <tag>", "release to install, e.g. v0.2.0 (prebuilt installs)")
    .option("--ref <ref>", "branch or tag to build (source installs)")
    .action(async (opts) => {
      const bundle = bundleDir();
      const dir = bundle ? undefined : sourceDir();
      if (!bundle && !dir) throw new Error("this copy of neatroots wasn't installed with the install script; reinstall with it to get updates");
      // Keep the Node this runs on, and rewrite the command where it was installed.
      const env: NodeJS.ProcessEnv = { ...process.env, NEATROOTS_UPDATE: "1", NEATROOTS_NODE: process.execPath };
      if (process.env.NEATROOTS_WRAPPER) env.NEATROOTS_BIN_DIR = path.dirname(process.env.NEATROOTS_WRAPPER);
      if (bundle) {
        env.NEATROOTS_INSTALL_DIR = path.dirname(bundle);
        if (opts.version) env.NEATROOTS_VERSION = opts.version;
      } else {
        env.NEATROOTS_SOURCE_DIR = dir;
        if (opts.ref) env.NEATROOTS_REF = opts.ref;
      }
      const r = spawnSync("sh", [path.join(bundle ?? dir!, "install.sh")], { stdio: "inherit", env });
      if (r.status !== 0) {
        process.exitCode = r.status ?? 1;
        return;
      }
      if (installed()) {
        restartService();
        console.log(`✓ restarted the background service on port ${loadConfig().port}`);
        return;
      }
      // A neatroots started by hand keeps running the old code until it's restarted; say so.
      const p = loadConfig().port;
      if (!(await running(p))) return;
      const cli = bundle ? path.join(bundle, "neatroots", "dist", "cli.js") : path.join(dir!, "packages", "neatroots", "dist", "cli.js");
      const fresh = spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8" }).stdout.trim();
      const live = await api<{ version: string }>(p, "/api/status").then((s) => s.version).catch(() => "");
      if (fresh && live && live !== fresh) console.log(`! neatroots ${live} is still running on port ${p}. Restart it to use ${fresh}: Ctrl+C in its terminal, then neatroots start`);
    });
}
