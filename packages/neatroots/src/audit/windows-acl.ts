import { execFileSync } from "node:child_process";
import path from "node:path";

interface AclRule { sid: string; allow: boolean; full: boolean; inherit: boolean; here: boolean }
export interface DirectoryAcl { user: string; owner: string; protected: boolean; rules: AclRule[] }
const PRIVILEGED = ["S-1-5-18", "S-1-5-32-544"]; // SYSTEM and local Administrators can already take ownership.

export function privateDirectoryAcl(acl: DirectoryAcl): boolean {
  const allowed = new Set([acl.user, ...PRIVILEGED]);
  return !!acl.user && acl.protected && allowed.has(acl.owner)
    && acl.rules.every((rule) => !rule.allow || allowed.has(rule.sid))
    && acl.rules.some((rule) => rule.sid === acl.user && rule.allow && rule.full && rule.inherit && rule.here);
}

// The path travels only as JSON on stdin, never as interpolated PowerShell code.
// Set-Acl is used only after our exclusive mkdir succeeds, on that newly created empty directory.
const SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$directory = [string]$request.directory
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$item = Get-Item -LiteralPath $directory -Force
if (!$item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'not an ordinary directory' }
if ($request.mode -eq 'secure') {
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($value in @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')) {
    $identity = New-Object System.Security.Principal.SecurityIdentifier($value)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    [void]$acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $directory -AclObject $acl
}
$acl = Get-Acl -LiteralPath $directory
$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
  [ordered]@{ sid = $_.IdentityReference.Value; allow = $_.AccessControlType -eq 'Allow';
    full = ($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl;
    inherit = ($_.InheritanceFlags -band 3) -eq 3; here = ($_.PropagationFlags -band 2) -eq 0 }
})
[ordered]@{ user = $sid.Value; owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;
  protected = $acl.AreAccessRulesProtected; rules = $rules } | ConvertTo-Json -Depth 4 -Compress
`;

export function windowsDirectoryAcl(directory: string, mode: "secure" | "validate"): void {
  let acl: DirectoryAcl;
  try {
    const shell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const text = execFileSync(shell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(SCRIPT, "utf16le").toString("base64")], {
      encoding: "utf8", windowsHide: true, timeout: 15_000,
      env: { ...process.env, PSModulePath: path.join(path.dirname(shell), "Modules") },
      input: JSON.stringify({ directory, mode }), stdio: ["pipe", "pipe", "pipe"],
    });
    acl = JSON.parse(text.replace(/^\uFEFF/, "").trim());
  } catch {
    throw new Error("cannot establish or inspect the Windows archive ACL; use a local NTFS directory and ensure Windows PowerShell can run (no archive data was written)");
  }
  if (!privateDirectoryAcl(acl)) {
    throw new Error("Windows archive directory ACL is too broad or not inheritable: choose a new empty directory, or use Properties > Security > Advanced to disable inheritance and grant your account Full control for this folder, subfolders and files, with only SYSTEM and Administrators also allowed. Existing permissions were not changed.");
  }
}
