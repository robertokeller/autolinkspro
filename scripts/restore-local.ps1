# restore-local.ps1
# Restaura um backup local: banco PostgreSQL + arquivos de sessão
# Uso: npm run backup:restore
#   ou: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/restore-local.ps1
#
# Se quiser restaurar um backup específico, passe o nome do arquivo:
#   powershell ... -File scripts/restore-local.ps1 -BackupFile autolinks_2026-03-14_03-00-00.zip

param(
    [string]$BackupFile = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$BackupRoot  = Join-Path $ProjectRoot "backups"

function Write-Step([string]$msg) { Write-Host "[restore] $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg)   { Write-Host "[restore] OK  $msg" -ForegroundColor Green }
function Write-Warn([string]$msg) { Write-Host "[restore] WARN $msg" -ForegroundColor Yellow }
function Write-Err([string]$msg)  { Write-Host "[restore] ERRO $msg" -ForegroundColor Red }

# ── 1. Escolhe o arquivo de backup ───────────────────────────────────────────
if ($BackupFile -eq "") {
    $AllBackups = Get-ChildItem -Path $BackupRoot -Filter "autolinks_*.zip" -ErrorAction SilentlyContinue |
                  Sort-Object Name -Descending

    if ($AllBackups.Count -eq 0) {
        Write-Err "Nenhum backup encontrado em '$BackupRoot'."
        Write-Err "Execute 'npm run backup:local' primeiro."
        exit 1
    }

    Write-Host ""
    Write-Host "Backups disponiveis:" -ForegroundColor Yellow
    for ($i = 0; $i -lt $AllBackups.Count; $i++) {
        $SizeMB = [math]::Round($AllBackups[$i].Length / 1MB, 2)
        Write-Host "  [$($i+1)] $($AllBackups[$i].Name)  ($SizeMB MB)"
    }
    Write-Host ""

    $Choice = Read-Host "Escolha o numero do backup para restaurar (Enter = mais recente)"

    if ($Choice -eq "") {
        $SelectedItem = $AllBackups[0]
    } elseif ($Choice -match "^\d+$" -and [int]$Choice -ge 1 -and [int]$Choice -le $AllBackups.Count) {
        $SelectedItem = $AllBackups[[int]$Choice - 1]
    } else {
        Write-Err "Opcao invalida."
        exit 1
    }

    $BackupPath = $SelectedItem.FullName
} else {
    # Pode ser nome simples ou caminho completo
    if (Test-Path $BackupFile) {
        $BackupPath = $BackupFile
    } else {
        $BackupPath = Join-Path $BackupRoot $BackupFile
        if (-not (Test-Path $BackupPath)) {
            Write-Err "Arquivo nao encontrado: $BackupPath"
            exit 1
        }
    }
}

Write-Step "Backup selecionado: $(Split-Path -Leaf $BackupPath)"
Write-Host ""

# ── Confirmação de segurança ──────────────────────────────────────────────────
Write-Host "ATENCAO: Isso vai sobrescrever:" -ForegroundColor Red
Write-Host "  - Banco de dados PostgreSQL local" -ForegroundColor Red
Write-Host "  - Arquivos de sessao WhatsApp / Telegram / Mercado Livre" -ForegroundColor Red
Write-Host ""
$Confirm = Read-Host "Confirma? (s/N)"
if ($Confirm -notmatch "^[sS]$") {
    Write-Host "Operacao cancelada." -ForegroundColor Yellow
    exit 0
}
Write-Host ""

# ── 2. Extrai o ZIP para pasta temporária ─────────────────────────────────────
$Timestamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
$TempDir   = Join-Path $env:TEMP "autolinks-restore-$Timestamp"

Write-Step "Extraindo backup..."
Expand-Archive -Path $BackupPath -DestinationPath $TempDir -Force
Write-Ok "Extraido em $TempDir"

# ── 3. Restaura o banco PostgreSQL ────────────────────────────────────────────
$DumpFile = Join-Path $TempDir "database.sql"

if (Test-Path $DumpFile) {
    $ContainerName = (docker ps --format "{{.Names}}" 2>$null |
                      Where-Object { $_ -match "postgres" } | Select-Object -First 1)

    if (-not $ContainerName) {
        Write-Warn "Container PostgreSQL nao encontrado. Execute 'npm run db:dev' e tente novamente."
        Write-Warn "Pulando restauracao do banco. Sessoes serao restauradas."
    } else {
        Write-Step "Restaurando banco no container '$ContainerName'..."

        # Termina conexões ativas antes de recriar
        docker exec "$ContainerName" `
            psql -U autolinks -d postgres -c `
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='autolinks' AND pid <> pg_backend_pid();" `
            | Out-Null

        # Recria o banco
        docker exec "$ContainerName" `
            psql -U autolinks -d postgres -c `
            "DROP DATABASE IF EXISTS autolinks; CREATE DATABASE autolinks;" `
            | Out-Null

        # Carrega o dump (passa o arquivo via stdin usando Get-Content)
        Get-Content $DumpFile | docker exec -i "$ContainerName" `
            psql -U autolinks -d autolinks -q

        if ($LASTEXITCODE -ne 0) {
            Write-Warn "psql retornou codigo $LASTEXITCODE. Verifique o banco manualmente."
        } else {
            Write-Ok "Banco restaurado com sucesso."
        }
    }
} else {
    Write-Warn "database.sql nao encontrado no backup — banco nao sera restaurado."
}

# ── 4. Restaura arquivos de sessão ────────────────────────────────────────────
$SessionDestinations = @{
    "sessions-whatsapp"       = Join-Path $ProjectRoot "services\whatsapp-baileys\.sessions"
    "sessions-telegram"       = Join-Path $ProjectRoot "services\telegram-telegraph\.sessions"
    "sessions-mercadolivre"   = Join-Path $ProjectRoot "services\mercadolivre-rpa\.sessions"
}

$SessionsBackupDir = Join-Path $TempDir "sessions"

if (Test-Path $SessionsBackupDir) {
    foreach ($entry in $SessionDestinations.GetEnumerator()) {
        $Label   = $entry.Key
        $SrcDir  = Join-Path $SessionsBackupDir $Label
        $DestDir = $entry.Value

        if (Test-Path $SrcDir) {
            Write-Step "Restaurando $Label..."
            if (Test-Path $DestDir) {
                Remove-Item -Recurse -Force $DestDir
            }
            Copy-Item -Path $SrcDir -Destination $DestDir -Recurse -Force
            $FileCount = (Get-ChildItem $DestDir -Recurse -File).Count
            Write-Ok "$Label ($FileCount arquivo(s))"
        } else {
            Write-Warn "$Label nao estava no backup — pulando."
        }
    }
} else {
    Write-Warn "Pasta 'sessions' nao encontrada no backup — sessoes nao serao restauradas."
}

# ── 5. Remove pasta temporária ────────────────────────────────────────────────
Remove-Item -Recurse -Force $TempDir

# ── Resumo ────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "====================================================" -ForegroundColor Green
Write-Host " Restauracao concluida!" -ForegroundColor Green
Write-Host " Fonte: $(Split-Path -Leaf $BackupPath)" -ForegroundColor Green
Write-Host " Reinicie os servicos para aplicar as sessoes." -ForegroundColor Green
Write-Host "====================================================" -ForegroundColor Green
Write-Host ""
