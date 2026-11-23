<#
 Fast local mode: the production build served by `next start`. Pages open in a fraction of a second, unlike `npm run dev`,
 which compiles every page when it is first opened.

   powershell -ExecutionPolicy Bypass -File scripts\local-production.ps1 [-Port 3000] [-StaySignedIn] [-Webpack] [-SkipBuild]

 Football needs no database server: it uses a SQLite file at .local\workspaces.sqlite (override with SPORTOZEN_DATABASE_PATH).
 First run creates .local\auth-secret (random, never committed). See FAST_LOCAL_PRODUCTION.md.
#>
param(
  [int]$Port = 3000,
  [switch]$StaySignedIn,
  [switch]$Webpack,
  [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
$env:BETTER_AUTH_URL = "http://127.0.0.1:$Port"
# Browsers share cookies between ports of one host; a name per port keeps two local servers from signing each other out.
$env:SPORTOZEN_COOKIE_PREFIX = "sz-fb-$Port"
if ($StaySignedIn) { $env:SPORTOZEN_SESSION_PERSISTENT = '1' }
if (-not $SkipBuild) {
  if ($Webpack) { npx next build --webpack } else { npx next build }
  # `next build` can exit non-zero after a complete build when it prints an upgrade notice; the build id tells the truth.
  $dist = if ($env:SPORTOZEN_FINAL_QA -eq '1') { '.next-final-qa' } else { '.next' }
  if (-not (Test-Path "$dist\BUILD_ID")) { throw 'Build failed.' }
}
npx next start --hostname 127.0.0.1 --port $Port
