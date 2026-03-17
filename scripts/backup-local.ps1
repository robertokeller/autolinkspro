# backup-local.ps1
# Backup local de desenvolvimento: banco PostgreSQL + arquivos de sessão
# Uso: npm run backup:local
#   ou: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/backup-local.ps1
#
# O que é salvo:
#   - Dump do PostgreSQL local (docker container autolinks-postgres-dev)
#   - Diretórios .sessions de WhatsApp, Telegram e Mercado Livre
#
# Os backups ficam em: backups/autolinks_YYYY-MM-DD_HH-mm-ss.zip
# Por padrão, mantém os últimos 10 backups.

param(
    [int]$KeepLast = 10
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── Caminho raiz do projeto (um nível acima de scripts/) ──────────────────────
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$BackupRoot  = Join-Path $ProjectRoot "backups"
$Timestamp   = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
$TempDir     = Join-Path $env:TEMP "autolinks-backup-$Timestamp"

function Write-Step([string]$msg) {
    Write-Host "[backup] $msg" -ForegroundColor Cyan
}
function Write-Ok([string]$msg) {
    Write-Host "[backup] OK  $msg" -ForegroundColor Green
}
function Write-Warn([string]$msg) {
    Write-Host "[backup] WARN $msg" -ForegroundColor Yellow
}

# ── Cria pastas temporárias ───────────────────────────────────────────────────
New-Item -ItemType Directory -Force -Path $BackupRoot  | Out-Null
New-Item -ItemType Directory -Force -Path $TempDir     | Out-Null

# ── 1. Backup do PostgreSQL local ─────────────────────────────────────────────
Write-Step "Verificando container PostgreSQL local..."

$ContainerName = (docker ps --format "{{.Names}}" 2>$null | Where-Object { $_ -match "postgres" } | Select-Object -First 1)

if (-not $ContainerName) {
    Write-Warn "Container PostgreSQL não encontrado. Execute 'npm run db:dev' primeiro."
    Write-Warn "Pulando backup do banco. Apenas sessões serão incluídas."
} else {
    Write-Step "Fazendo dump do banco '$ContainerName'..."
    $DumpFile = Join-Path $TempDir "database.sql"

    docker exec "$ContainerName" `
        pg_dump -U autolinks -d autolinks --no-owner --no-acl `
        | Out-File -FilePath $DumpFile -Encoding utf8

    if ($LASTEXITCODE -ne 0) {
        Write-Warn "pg_dump falhou (código: $LASTEXITCODE). Banco pode estar vazio ou inacessível."
    } else {
        $DumpSizeKB = [math]::Round((Get-Item $DumpFile).Length / 1KB, 1)
        Write-Ok "database.sql ($DumpSizeKB KB)"
    }
}

# ── 2. Backup dos diretórios de sessão ────────────────────────────────────────
$SessionPaths = @{
    "sessions-whatsapp"  = Join-Path $ProjectRoot "services\whatsapp-baileys\.sessions"
    "sessions-telegram"  = Join-Path $ProjectRoot "services\telegram-telegraph\.sessions"
    "sessions-mercadolivre" = Join-Path $ProjectRoot "services\mercadolivre-rpa\.sessions"
}

$SessionsDir = Join-Path $TempDir "sessions"
New-Item -ItemType Directory -Force -Path $SessionsDir | Out-Null

foreach ($entry in $SessionPaths.GetEnumerator()) {
    $Label = $entry.Key
    $SrcPath = $entry.Value

    if (Test-Path $SrcPath) {
        $Dest = Join-Path $SessionsDir $Label
        Write-Step "Copiando $Label..."
        Copy-Item -Path $SrcPath -Destination $Dest -Recurse -Force
        $FileCount = (Get-ChildItem $Dest -Recurse -File).Count
        Write-Ok "$Label ($FileCount arquivo(s))"
    } else {
        Write-Warn "$Label não encontrado — pulando ($SrcPath)"
    }
}

# ── 3. Salva metadados ────────────────────────────────────────────────────────
$Meta = @{
    created_at   = (Get-Date -Format "o")
    computer     = $env:COMPUTERNAME
    node_version = (node --version 2>$null)
    project_root = $ProjectRoot
} | ConvertTo-Json
$Meta | Out-File -FilePath (Join-Path $TempDir "backup-meta.json") -Encoding utf8

# ── 4. Compacta tudo em .zip ──────────────────────────────────────────────────
$ZipPath = Join-Path $BackupRoot "autolinks_$Timestamp.zip"
Write-Step "Compactando $ZipPath..."

Compress-Archive -Path "$TempDir\*" -DestinationPath $ZipPath -Force

$ZipSizeMB = [math]::Round((Get-Item $ZipPath).Length / 1MB, 2)
Write-Ok "Backup criado: autolinks_$Timestamp.zip ($ZipSizeMB MB)"

# ── 5. Remove pasta temporária ────────────────────────────────────────────────
Remove-Item -Recurse -Force $TempDir

# ── 6. Rotação: mantém apenas os últimos $KeepLast backups ───────────────────
$AllBackups = Get-ChildItem -Path $BackupRoot -Filter "autolinks_*.zip" |
              Sort-Object Name -Descending

if ($AllBackups.Count -gt $KeepLast) {
    $ToDelete = $AllBackups | Select-Object -Skip $KeepLast
    foreach ($f in $ToDelete) {
        Remove-Item $f.FullName -Force
        Write-Warn "Removido backup antigo: $($f.Name)"
    }
}

# ── Resumo ────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "====================================================" -ForegroundColor Green
Write-Host " Backup concluido: backups\autolinks_$Timestamp.zip" -ForegroundColor Green
Write-Host " Total armazenado: $($AllBackups.Count) backup(s) em $BackupRoot" -ForegroundColor Green
Write-Host "====================================================" -ForegroundColor Green
Write-Host ""
