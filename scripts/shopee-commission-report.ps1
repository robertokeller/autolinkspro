[CmdletBinding()]
Param(
  [Parameter(Mandatory = $true)]
  [string]$Email,

  [ValidateSet("conversion_report", "validation_report")]
  [string]$Type = "conversion_report",

  [string]$ApiUrl = "http://127.0.0.1:3116",
  [System.Management.Automation.PSCredential]$AdminCredential,
  [string]$StartDate,
  [string]$EndDate
)

$ErrorActionPreference = "Stop"

function ConvertTo-DateYmd {
  Param(
    [string]$Value,
    [string]$FieldName
  )

  $trimmed = ""
  if (-not [string]::IsNullOrWhiteSpace($Value)) {
    $trimmed = $Value.Trim()
  }
  if ([string]::IsNullOrWhiteSpace($trimmed)) {
    return ""
  }

  if ($trimmed -notmatch "^\d{4}-\d{2}-\d{2}$") {
    throw "$FieldName invalido. Use formato YYYY-MM-DD."
  }

  $parsed = [DateTime]::MinValue
  $ok = [DateTime]::TryParseExact(
    $trimmed,
    "yyyy-MM-dd",
    [System.Globalization.CultureInfo]::InvariantCulture,
    [System.Globalization.DateTimeStyles]::AssumeUniversal,
    [ref]$parsed
  )
  if (-not $ok) {
    throw "$FieldName invalido. Use formato YYYY-MM-DD."
  }

  return $parsed.ToString("yyyy-MM-dd")
}

function Read-RpcErrorMessage {
  Param([object]$InputValue)

  if ($null -eq $InputValue) { return "" }
  if ($InputValue -is [string]) { return $InputValue.Trim() }

  if ($InputValue -is [System.Collections.IDictionary]) {
    foreach ($key in @("message", "error", "reason", "details")) {
      if ($InputValue.Contains($key)) {
        $msg = Read-RpcErrorMessage -InputValue $InputValue[$key]
        if (-not [string]::IsNullOrWhiteSpace($msg)) { return $msg }
      }
    }
  }

  if ($InputValue -is [System.Collections.IEnumerable] -and -not ($InputValue -is [string])) {
    foreach ($item in $InputValue) {
      $msg = Read-RpcErrorMessage -InputValue $item
      if (-not [string]::IsNullOrWhiteSpace($msg)) { return $msg }
    }
  }

  return ([string]$InputValue).Trim()
}

if (-not $AdminCredential) {
  $fallbackEmail = [string]$env:AUTOLINKS_ADMIN_EMAIL
  $fallbackPassword = [string]$env:AUTOLINKS_ADMIN_PASSWORD
  if ([string]::IsNullOrWhiteSpace($fallbackEmail) -or [string]::IsNullOrWhiteSpace($fallbackPassword)) {
    throw "Credenciais admin ausentes. Defina AUTOLINKS_ADMIN_EMAIL e AUTOLINKS_ADMIN_PASSWORD, ou passe -AdminCredential."
  }

  $securePassword = ConvertTo-SecureString -String $fallbackPassword -AsPlainText -Force
  $AdminCredential = New-Object System.Management.Automation.PSCredential($fallbackEmail, $securePassword)
}

$adminEmail = $AdminCredential.UserName
$adminPassword = [System.Net.NetworkCredential]::new("", $AdminCredential.Password).Password
if ([string]::IsNullOrWhiteSpace($adminEmail) -or [string]::IsNullOrWhiteSpace($adminPassword)) {
  throw "Credenciais admin invalidas."
}

$today = (Get-Date).Date
$defaultEnd = $today.ToString("yyyy-MM-dd")
$defaultStart = $today.AddDays(-29).ToString("yyyy-MM-dd")

$resolvedStart = if ([string]::IsNullOrWhiteSpace($StartDate)) { $defaultStart } else { ConvertTo-DateYmd -Value $StartDate -FieldName "StartDate" }
$resolvedEnd = if ([string]::IsNullOrWhiteSpace($EndDate)) { $defaultEnd } else { ConvertTo-DateYmd -Value $EndDate -FieldName "EndDate" }

if ($resolvedStart -gt $resolvedEnd) {
  throw "Periodo invalido: StartDate deve ser menor ou igual a EndDate."
}

$apiBase = $ApiUrl.TrimEnd("/")
$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession

$signinBody = @{
  email = $adminEmail
  password = $adminPassword
} | ConvertTo-Json -Compress

$signinParams = @{
  UseBasicParsing = $true
  Method = "Post"
  Uri = "$apiBase/auth/signin"
  WebSession = $session
  ContentType = "application/json"
  Body = $signinBody
  TimeoutSec = 30
}
$signinResponse = Invoke-WebRequest @signinParams

$signinJson = $signinResponse.Content | ConvertFrom-Json
if ($signinJson.error) {
  $msg = Read-RpcErrorMessage -InputValue $signinJson.error
  if ([string]::IsNullOrWhiteSpace($msg)) { $msg = "Falha no login admin." }
  throw $msg
}

$rpcBody = @{
  name = "admin-shopee-commission-report"
  email = $Email
  reportType = $Type
  startDate = $resolvedStart
  endDate = $resolvedEnd
} | ConvertTo-Json -Compress

$rpcParams = @{
  UseBasicParsing = $true
  Method = "Post"
  Uri = "$apiBase/functions/v1/rpc"
  WebSession = $session
  ContentType = "application/json"
  Body = $rpcBody
  TimeoutSec = 60
}
$rpcResponse = Invoke-WebRequest @rpcParams

$rpcJson = $rpcResponse.Content | ConvertFrom-Json
if ($rpcJson.error) {
  $msg = Read-RpcErrorMessage -InputValue $rpcJson.error
  if ([string]::IsNullOrWhiteSpace($msg)) { $msg = "Falha ao consultar comissao Shopee." }
  throw $msg
}

if (-not $rpcJson.data -or -not $rpcJson.data.report) {
  throw "Resposta invalida do backend (report ausente)."
}

$target = $rpcJson.data.targetUser
$report = $rpcJson.data.report

$total = 0.0
if ($null -ne $report.totalCommission) {
  [void][double]::TryParse([string]$report.totalCommission, [ref]$total)
}
$currency = [string]$report.currency
if ([string]::IsNullOrWhiteSpace($currency)) { $currency = "BRL" }
$records = 0
$pages = 0
if ($null -ne $report.recordsCount) {
  [void][int]::TryParse([string]$report.recordsCount, [ref]$records)
}
if ($null -ne $report.pagesScanned) {
  [void][int]::TryParse([string]$report.pagesScanned, [ref]$pages)
}

Write-Host "CLIENT_EMAIL=$($target.email)"
Write-Host "REPORT_TYPE=$($report.type)"
Write-Host "PERIOD=$($report.startDate) -> $($report.endDate)"
Write-Host ("TOTAL_COMMISSION={0} {1}" -f $currency, $total.ToString("0.00", [System.Globalization.CultureInfo]::InvariantCulture))
Write-Host "RECORDS=$records"
Write-Host "PAGES_SCANNED=$pages"
