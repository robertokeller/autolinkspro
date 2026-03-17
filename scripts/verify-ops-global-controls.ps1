Param(
  [string]$BaseUrl = "http://127.0.0.1:3115",
  [string]$OpsToken = "autolinks-local-webhook-secret",
  [int]$StartWaitSeconds = 10,
  [int]$RestartWaitSeconds = 10,
  [int]$StopWaitSeconds = 4
)

$ErrorActionPreference = "Stop"

function Get-Headers {
  if ([string]::IsNullOrWhiteSpace($OpsToken)) {
    return @{}
  }
  return @{ "x-ops-token" = $OpsToken }
}

function Invoke-JsonGet([string]$Url) {
  return Invoke-RestMethod -Method Get -Uri $Url -Headers (Get-Headers) -TimeoutSec 20
}

function Invoke-JsonPost([string]$Url) {
  return Invoke-RestMethod -Method Post -Uri $Url -Headers (Get-Headers) -TimeoutSec 90
}

function Get-ServiceStates {
  $svc = Invoke-JsonGet "$BaseUrl/api/services"
  $rows = @()
  foreach ($s in $svc.services) {
    $rows += [PSCustomObject]@{
      id = [string]$s.id
      online = [bool]$s.online
      processOnline = [bool]$s.processOnline
      componentOnline = [bool]$s.componentOnline
      processStatus = [string]$s.processStatus
      uptimeSec = $s.uptimeSec
    }
  }
  return $rows
}

function Assert-AllState([array]$Rows, [bool]$ExpectedOnline, [string]$StepName) {
  $bad = @($Rows | Where-Object {
      $_.online -ne $ExpectedOnline -or $_.processOnline -ne $ExpectedOnline -or $_.componentOnline -ne $ExpectedOnline
    })

  if ($bad.Count -gt 0) {
    Write-Host "[FAIL] $StepName - divergencia detectada" -ForegroundColor Red
    $bad | Format-Table -AutoSize | Out-String | Write-Output
    throw "Falha no passo: $StepName"
  }

  Write-Host "[PASS] $StepName" -ForegroundColor Green
}

function Show-State([string]$Label, [array]$Rows) {
  Write-Host "=== $Label ===" -ForegroundColor Cyan
  $Rows | Sort-Object id | Format-Table id, online, processOnline, componentOnline, processStatus, uptimeSec -AutoSize | Out-String | Write-Output
}

Write-Host "Iniciando validacao de controles globais em $BaseUrl" -ForegroundColor Yellow

$health = Invoke-JsonGet "$BaseUrl/health"
$system = Invoke-JsonGet "$BaseUrl/api/system/health"

if (-not $health.online) {
  throw "Ops /health retornou online=false"
}
if (-not $system.online) {
  throw "Ops /api/system/health retornou online=false"
}

Write-Host "[PASS] Atualizar saude (health + system health)" -ForegroundColor Green
Write-Host "Pressao do host: $($system.system.pressure)" -ForegroundColor Gray

$baseline = Get-ServiceStates
Show-State "BASELINE" $baseline

$stopResult = Invoke-JsonPost "$BaseUrl/api/services/all/stop"
if (-not $stopResult.ok) {
  throw "Comando stop all retornou ok=false"
}
Start-Sleep -Seconds $StopWaitSeconds
$afterStop = Get-ServiceStates
Show-State "AFTER STOP ALL" $afterStop
Assert-AllState -Rows $afterStop -ExpectedOnline $false -StepName "Desligar todos"

$startResult = Invoke-JsonPost "$BaseUrl/api/services/all/start"
if (-not $startResult.ok) {
  throw "Comando start all retornou ok=false"
}
Start-Sleep -Seconds $StartWaitSeconds
$afterStart = Get-ServiceStates
Show-State "AFTER START ALL" $afterStart
Assert-AllState -Rows $afterStart -ExpectedOnline $true -StepName "Ligar todos"

$restartResult = Invoke-JsonPost "$BaseUrl/api/services/all/restart"
if (-not $restartResult.ok) {
  throw "Comando restart all retornou ok=false"
}
Start-Sleep -Seconds $RestartWaitSeconds
$afterRestart = Get-ServiceStates
Show-State "AFTER RESTART ALL" $afterRestart
Assert-AllState -Rows $afterRestart -ExpectedOnline $true -StepName "Reiniciar todos"

Write-Host "[PASS] Todos os controles globais obedeceram o estado esperado." -ForegroundColor Green
