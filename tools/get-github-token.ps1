# Read the GitHub credential through git credential fill and emit only its password.
try {
  $previousGcmInteractive = $env:GCM_INTERACTIVE
  $previousGitTerminalPrompt = $env:GIT_TERMINAL_PROMPT
  $env:GCM_INTERACTIVE = 'never'
  $env:GIT_TERMINAL_PROMPT = '0'
  $credential = @('protocol=https', 'host=github.com', '') | & git -c credential.interactive=false credential fill 2>$null
  $gitExitCode = $LASTEXITCODE
} catch {
  [Console]::Error.WriteLine('Unable to run git credential fill. Ensure Git is installed and available on PATH.')
  exit 1
} finally {
  if ($null -eq $previousGcmInteractive) {
    Remove-Item Env:GCM_INTERACTIVE -ErrorAction SilentlyContinue
  } else {
    $env:GCM_INTERACTIVE = $previousGcmInteractive
  }
  if ($null -eq $previousGitTerminalPrompt) {
    Remove-Item Env:GIT_TERMINAL_PROMPT -ErrorAction SilentlyContinue
  } else {
    $env:GIT_TERMINAL_PROMPT = $previousGitTerminalPrompt
  }
}

if ($gitExitCode -ne 0) {
  [Console]::Error.WriteLine('Unable to retrieve the GitHub credential. Sign in to https://github.com with Git Credential Manager first.')
  exit 1
}

$match = [regex]::Match(($credential -join "`n"), '(?m)^password=(.*)$')
if (-not $match.Success -or [string]::IsNullOrWhiteSpace($match.Groups[1].Value)) {
  [Console]::Error.WriteLine('Git returned no password for https://github.com.')
  exit 1
}

[Console]::Out.WriteLine($match.Groups[1].Value)
