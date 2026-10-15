# Read the GitHub token that Git Credential Manager stored for https://github.com
# and print it, so callers can do:  $env:GITHUB_TOKEN = & get-github-token.ps1
# Why: on this machine 'git credential fill' fails ("interactivity has been disabled"),
# but the secret is still readable straight from the Windows Credential Manager.
# Pure ASCII on purpose (a UTF-8 BOM would confuse Windows PowerShell 5.1).
$cs = @'
using System;
using System.Runtime.InteropServices;
public class WinCred {
  [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredRead(string target, int type, int flags, out IntPtr credential);
  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern void CredFree(IntPtr cred);
}
'@
Add-Type -TypeDefinition $cs
$p = [IntPtr]::Zero
if (-not [WinCred]::CredRead('git:https://github.com', 1, 0, [ref]$p)) {
  Write-Error "No stored credential for git:https://github.com"
  exit 2
}
$size = [System.Runtime.InteropServices.Marshal]::ReadInt32($p, 32)
$ptr  = [System.Runtime.InteropServices.Marshal]::ReadIntPtr($p, 40)
$bytes = New-Object byte[] $size
[System.Runtime.InteropServices.Marshal]::Copy($ptr, $bytes, 0, $size)
[WinCred]::CredFree($p)
$txt = ([Text.Encoding]::Unicode.GetString($bytes) -replace "`0", '').Trim()
# GCM stores "protocol=https\nhost=github.com\nusername=<user>\npassword=<token>"
$tok = ($txt -split "`n" | Where-Object { $_ -like 'password=*' } | Select-Object -First 1)
if ($tok) { $tok = $tok.Substring(9).Trim() } else { $tok = ($txt -split "`n")[-1].Trim() }
if (-not $tok) { Write-Error 'Credential blob had no password field'; exit 3 }
Write-Output $tok
