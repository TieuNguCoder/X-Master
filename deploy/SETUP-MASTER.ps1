param(
  [string]$AccountId = "",
  [string]$ApiToken = "",
  [string]$AdminPassword = "",
  [string]$CollectorSecret = "",
  [string]$OutputFile = "",
  [switch]$RuntimeSelfTest
)

$ErrorActionPreference = "Stop"
try {
  $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [Console]::OutputEncoding = $Utf8NoBom
  $OutputEncoding = $Utf8NoBom
} catch {}

$Root = Split-Path -Parent $PSScriptRoot
$RouterDir = Join-Path $Root "master-router"
$Config = Join-Path $RouterDir "wrangler.jsonc"
$WranglerVersion = "4.131.2"

function Log([string]$Step,[string]$Message) {
  Write-Host ("[" + $Step + "] " + $Message)
}

function Remove-Ansi([string]$Text) {
  if ($null -eq $Text) { return "" }
  $esc = [char]27
  return [regex]::Replace($Text, [regex]::Escape([string]$esc) + '\[[0-?]*[ -/]*[@-~]', "")
}

function New-RandomSecret([int]$Bytes = 48) {
  if ($Bytes -lt 16) { throw "Random secret size must be at least 16 bytes." }
  $data = New-Object byte[] $Bytes
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($data)
  } finally {
    if ($null -ne $rng) { $rng.Dispose() }
  }
  return [Convert]::ToBase64String($data)
}

function Get-D1Id([object]$Db) {
  if ($null -eq $Db) { return "" }
  foreach ($name in @("uuid", "id", "database_id")) {
    $prop = $Db.PSObject.Properties[$name]
    if ($null -ne $prop -and $prop.Value) { return [string]$prop.Value }
  }
  return ""
}

if ($RuntimeSelfTest) {
  $a = New-RandomSecret 48
  $b = New-RandomSecret 48
  if (-not $a -or -not $b -or $a -eq $b) { throw "Random secret self-test failed." }
  if ([Convert]::FromBase64String($a).Length -ne 48) { throw "Random secret length self-test failed." }
  $testId = Get-D1Id ([pscustomobject]@{ database_id = "db-test-id" })
  if ($testId -ne "db-test-id") { throw "D1 id compatibility self-test failed." }
  $ansiSample = ([char]27).ToString() + "[33mWARN" + ([char]27).ToString() + "[0m"
  if ((Remove-Ansi $ansiSample) -ne "WARN") { throw "ANSI sanitizer self-test failed." }

  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCmd) {
    $stdinEcho = ("stdin-ok" | & $nodeCmd.Source -e "let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>process.stdout.write(s.trim()))" | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $stdinEcho -ne "stdin-ok") { throw "Native stdin forwarding self-test failed." }
  }

  Write-Host ("RUNTIME SELF TEST PASS | WindowsPowerShell=" + $PSVersionTable.PSVersion.ToString())
  exit 0
}

if (-not $ApiToken) { $ApiToken = [string]$env:X_MASTER_CF_TOKEN }
if (-not $AdminPassword) { $AdminPassword = [string]$env:X_MASTER_ADMIN_PASSWORD }
if (-not $CollectorSecret) { $CollectorSecret = [string]$env:X_MASTER_COLLECTOR_SECRET }

if (-not $AccountId -or $AccountId.Length -lt 8) { throw "Cloudflare Account ID is required." }
if (-not $ApiToken) { throw "Cloudflare API Token is required." }
if (-not $AdminPassword -or $AdminPassword.Length -lt 8) { throw "Admin password must contain at least 8 characters." }

$BundledNode = Join-Path $Root "runtime\node\node.exe"
$BundledWranglerJs = Join-Path $Root "runtime\wrangler\node_modules\wrangler\bin\wrangler.js"
$UseBundled = (Test-Path $BundledNode) -and (Test-Path $BundledWranglerJs)

if ($UseBundled) {
  $Node = $BundledNode
  function Wrangler { & $Node $BundledWranglerJs @args }
} else {
  $NodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $NodeCmd) { throw "Node runtime not found. Use full X-Master Windows package." }
  $Node = $NodeCmd.Source
  function Wrangler { & npx --yes "wrangler@$WranglerVersion" @args }
}

$env:CLOUDFLARE_ACCOUNT_ID = $AccountId
$env:CLOUDFLARE_API_TOKEN = $ApiToken
$env:CI = "true"
$env:NO_COLOR = "1"
$env:FORCE_COLOR = "0"
$env:TERM = "dumb"

function Cf([string]$Method,[string]$Path,[object]$Body = $null) {
  $headers = @{ Authorization = "Bearer $ApiToken"; "Content-Type" = "application/json" }
  $uri = "https://api.cloudflare.com/client/v4/accounts/$AccountId$Path"
  try {
    if ($null -eq $Body) {
      return Invoke-RestMethod -Method $Method -Uri $uri -Headers $headers -TimeoutSec 45
    }
    return Invoke-RestMethod -Method $Method -Uri $uri -Headers $headers -Body ($Body | ConvertTo-Json -Compress) -TimeoutSec 45
  } catch {
    throw ("Cloudflare API " + $Path + " failed: " + $_.Exception.Message)
  }
}

function Ensure-Subdomain {
  $lastError = ""
  try {
    $current = Cf "GET" "/workers/subdomain"
    if ($current.success -and $current.result.subdomain) { return [string]$current.result.subdomain }
  } catch {
    $lastError = $_.Exception.Message
  }

  $tail = ($AccountId.ToLowerInvariant() -replace '[^a-z0-9]','')
  if ($tail.Length -gt 10) { $tail = $tail.Substring($tail.Length - 10) }

  foreach ($suffix in @("","-1","-2","-3","-4")) {
    try {
      $candidate = "xmaster-$tail$suffix"
      $created = Cf "PUT" "/workers/subdomain" @{ subdomain = $candidate }
      if ($created.success -and $created.result.subdomain) { return [string]$created.result.subdomain }
    } catch {
      $lastError = $_.Exception.Message
    }
  }
  $suffix = if ($lastError) { " Last error: " + $lastError } else { "" }
  throw ("Could not configure workers.dev subdomain." + $suffix)
}

function List-D1 {
  $raw = Remove-Ansi (Wrangler d1 list --json 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0) { throw ("Could not list D1: " + $raw.Trim()) }
  $start = $raw.IndexOf("[")
  $end = $raw.LastIndexOf("]")
  if ($start -lt 0 -or $end -lt $start) { throw ("D1 list did not return JSON: " + $raw.Trim()) }
  return @($raw.Substring($start, $end - $start + 1) | ConvertFrom-Json)
}

function Put-Secret([string]$Name,[string]$Value) {
  if (-not $Value) { throw "Secret value missing: $Name" }

  if ($UseBundled) {
    $Value | & $Node $BundledWranglerJs secret put $Name --config $Config
    $code = $LASTEXITCODE
  } else {
    $Value | & npx --yes "wrangler@$WranglerVersion" secret put $Name --config $Config
    $code = $LASTEXITCODE
  }

  if ($code -ne 0) { throw "Could not set Worker secret: $Name" }
}

function Secret-Names {
  $raw = Remove-Ansi (Wrangler secret list --config $Config --format json 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0) {
    throw ("Could not list Worker secrets. Existing encryption keys were NOT changed. Wrangler: " + $raw.Trim())
  }
  $start = $raw.IndexOf("[")
  $end = $raw.LastIndexOf("]")
  if ($start -lt 0 -or $end -lt $start) {
    throw ("Worker secret list did not return JSON. Existing encryption keys were NOT changed. Wrangler: " + $raw.Trim())
  }
  try {
    $parsed = $raw.Substring($start, $end - $start + 1) | ConvertFrom-Json
  } catch {
    throw ("Could not parse Worker secret list. Existing encryption keys were NOT changed: " + $_.Exception.Message)
  }
  return @($parsed | ForEach-Object { [string]$_.name })
}

try {
  Log "0/8" "Validate Cloudflare + Workers access"
  $null = Cf "GET" "/workers/scripts"

  Log "1/8" "Create / reuse D1"
  $dbs = List-D1
  $db = $dbs | Where-Object { $_.name -eq "x-master" } | Select-Object -First 1
  if (-not $db) {
    Wrangler d1 create x-master --location apac
    if ($LASTEXITCODE -ne 0) { throw "Could not create x-master D1." }
    $dbs = List-D1
    $db = $dbs | Where-Object { $_.name -eq "x-master" } | Select-Object -First 1
  }
  $dbId = Get-D1Id $db
  if (-not $dbId) { throw "D1 database_id not found in Wrangler output." }

  Log "2/8" "Generate Wrangler config"
  $template = Get-Content (Join-Path $RouterDir "wrangler.example.jsonc") -Raw
  $template = $template.Replace("REPLACE_WITH_D1_DATABASE_ID", $dbId)
  [IO.File]::WriteAllText($Config, $template, (New-Object Text.UTF8Encoding($false)))

  Log "3/8" "Apply D1 schema"
  Push-Location $RouterDir
  try {
    Wrangler d1 execute x-master --remote --file schema.sql --config wrangler.jsonc
    if ($LASTEXITCODE -ne 0) { throw "D1 schema failed." }
  } finally { Pop-Location }

  Log "4/8" "Deploy Master Router + Web"
  $subdomain = Ensure-Subdomain
  Push-Location $RouterDir
  try {
    Wrangler deploy --config wrangler.jsonc
    if ($LASTEXITCODE -ne 0) { throw "Master Router deploy failed." }
  } finally { Pop-Location }

  Log "5/8" "Configure / preserve secrets"
  $existing = Secret-Names

  if ($existing -notcontains "MASTER_KEY") { Put-Secret "MASTER_KEY" (New-RandomSecret 64) }
  if ($existing -notcontains "SESSION_PEPPER") { Put-Secret "SESSION_PEPPER" (New-RandomSecret 64) }

  $env:X_MASTER_ADMIN_PASSWORD = $AdminPassword
  $hash = (& $Node (Join-Path $RouterDir "tools\hash-admin-password.mjs") 2>&1 | Out-String).Trim()
  $hashExitCode = $LASTEXITCODE
  Remove-Item Env:X_MASTER_ADMIN_PASSWORD -ErrorAction SilentlyContinue
  if ($hashExitCode -ne 0 -or -not $hash.StartsWith("pbkdf2-sha256$")) {
    throw ("Could not hash Admin password: " + $hash)
  }
  Put-Secret "ADMIN_PASSWORD_HASH" $hash

  $collectorWasGenerated = $false
  if ($CollectorSecret) {
    Put-Secret "COLLECTOR_SECRET" $CollectorSecret
  } else {
    $CollectorSecret = New-RandomSecret 48
    $collectorWasGenerated = $true
    Put-Secret "COLLECTOR_SECRET" $CollectorSecret
    if ($existing -contains "COLLECTOR_SECRET") {
      Log "5/8" "Local Collector secret was missing; rotated Worker secret safely."
    }
  }

  Log "6/8" "Health check"
  $rootUrl = "https://x-master-router.$subdomain.workers.dev"
  $health = $null
  $healthLastError = ""
  for ($i=0; $i -lt 12; $i++) {
    Start-Sleep -Seconds 1
    try {
      $health = Invoke-RestMethod -Uri ($rootUrl + "/api/health") -TimeoutSec 15
      if ($health.ok) { break }
      $healthLastError = "Health endpoint returned ok=false."
    } catch {
      $healthLastError = $_.Exception.Message
    }
  }
  if (-not $health.ok) {
    throw ("Master Router health check failed." + $(if ($healthLastError) { " Last error: " + $healthLastError } else { "" }))
  }

  Log "7/8" "Save local deployment result"
  $state = [ordered]@{
    ok = $true
    version = "0.2.2"
    master_root = $rootUrl
    master_web = $rootUrl + "/"
    d1_database_id = $dbId
    collector_secret = $CollectorSecret
    collector_secret_generated = $collectorWasGenerated
  }

  if ($OutputFile) {
    $parent = Split-Path -Parent $OutputFile
    if ($parent) { New-Item -ItemType Directory -Force $parent | Out-Null }
    [IO.File]::WriteAllText($OutputFile, ($state | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))
  }

  Log "8/8" "MASTER READY"
  Write-Host ($state | ConvertTo-Json -Depth 5)
}
finally {
  Remove-Item Env:CLOUDFLARE_ACCOUNT_ID -ErrorAction SilentlyContinue
  Remove-Item Env:CLOUDFLARE_API_TOKEN -ErrorAction SilentlyContinue
  Remove-Item Env:X_MASTER_ADMIN_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:X_MASTER_CF_TOKEN -ErrorAction SilentlyContinue
  Remove-Item Env:X_MASTER_COLLECTOR_SECRET -ErrorAction SilentlyContinue
  Remove-Item Env:FORCE_COLOR -ErrorAction SilentlyContinue
  Remove-Item Env:TERM -ErrorAction SilentlyContinue
}
