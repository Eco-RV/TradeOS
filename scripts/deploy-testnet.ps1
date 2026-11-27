# TradeOS - despliegue y demo en Stellar Testnet
# Uso (desde la raiz del repo):  powershell -ExecutionPolicy Bypass -File scripts\deploy-testnet.ps1

# Stellar CLI escribe sus mensajes en stderr; en PowerShell 5 eso no debe cortar el script.
$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Red = "testnet"

function Paso($texto) { Write-Host "`n==> $texto" -ForegroundColor Cyan }
function Revisar($que) {
    if ($LASTEXITCODE -ne 0) { Write-Host "Fallo: $que" -ForegroundColor Red; exit 1 }
}

if (-not (Get-Command stellar -ErrorAction SilentlyContinue)) {
    Write-Host "No se encontro Stellar CLI. Instalalo con:  winget install --id Stellar.StellarCLI" -ForegroundColor Red
    exit 1
}

Paso "Compilando el contrato"
rustup target add wasm32v1-none | Out-Null
stellar contract build
Revisar "compilar el contrato"
$Wasm = "target\wasm32v1-none\release\tradeos.wasm"

Paso "Preparando cuentas de prueba (cliente y maestro)"
$Existentes = @(stellar keys ls) | ForEach-Object { $_.Trim() }
foreach ($cuenta in @("cliente", "maestro")) {
    if ($Existentes -notcontains $cuenta) {
        stellar keys generate $cuenta --network $Red
        Revisar "crear la cuenta $cuenta"
    }
    stellar keys fund $cuenta --network $Red
    Revisar "fondear la cuenta $cuenta"
}
$Cliente = (stellar keys address cliente).Trim()
$Maestro = (stellar keys address maestro).Trim()

Paso "Desplegando TradeOS"
$Contrato = (stellar contract deploy --wasm $Wasm --source cliente --network $Red --alias tradeos | Select-Object -Last 1).Trim()
Revisar "desplegar el contrato"
Write-Host "Contrato: $Contrato" -ForegroundColor Green

Paso "Obteniendo el token XLM nativo"
$Xlm = (stellar contract id asset --asset native --network $Red | Select-Object -Last 1).Trim()
Revisar "obtener el token XLM"

Paso "Creando una obra de ejemplo (Piso 3 XLM + Paredes 4 XLM, plazo 30 dias)"
$Tmp = New-Item -ItemType Directory -Force -Path (Join-Path $env:TEMP "tradeos")
'["Piso","Paredes"]'           | Set-Content -NoNewline -Encoding ascii "$Tmp\descripciones.json"
'["30000000","40000000"]'      | Set-Content -NoNewline -Encoding ascii "$Tmp\montos.json"
$Plazo = [DateTimeOffset]::UtcNow.AddDays(30).ToUnixTimeSeconds()

$ObraId = (stellar contract invoke --id tradeos --source cliente --network $Red -- `
    crear_obra --cliente $Cliente --maestro $Maestro --token $Xlm `
    --descripciones-file-path "$Tmp\descripciones.json" `
    --montos-file-path "$Tmp\montos.json" `
    --plazo $Plazo | Select-Object -Last 1).Trim()
Revisar "crear la obra"
Write-Host "Obra creada: $ObraId" -ForegroundColor Green

Paso "Aprobando el primer hito (se le pagan 3 XLM al maestro)"
stellar contract invoke --id tradeos --source cliente --network $Red -- `
    aprobar_hito --obra_id $ObraId --indice 0
Revisar "aprobar el hito"

Paso "Estado de la obra"
stellar contract invoke --id tradeos --source cliente --network $Red -- obra --obra_id $ObraId

$Info = @"
Red:      Stellar Testnet
Contrato: $Contrato
Cliente:  $Cliente
Maestro:  $Maestro
Token:    $Xlm (XLM nativo)
Obra:     $ObraId
Explorer: https://stellar.expert/explorer/testnet/contract/$Contrato
"@
New-Item -ItemType Directory -Force -Path "deployments" | Out-Null
$Info | Set-Content -Encoding utf8 "deployments\testnet.txt"

Paso "Listo"
Write-Host $Info -ForegroundColor Green
Write-Host "Se guardo en deployments\testnet.txt"
