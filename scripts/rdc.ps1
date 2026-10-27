param(
    [Parameter(Position=0)]
    [string]$Action,
    [Parameter(ValueFromRemainingArguments=$true)]
    [string[]]$Rest
)

$HomeDir = $HOME
$RdcRoot = "C:\Users\maico\Projects\rdc"
$TunnelExe = "C:\Users\maico\Downloads\tunnel-client-v0.0.18-windows-amd64\tunnel-client.exe"
$ProfileFile = "C:\Users\maico\AppData\Roaming\tunnel-client\desktop-commander.yaml"
$Cli = Join-Path $RdcRoot "scripts\rdc-terminal.mjs"
$EventFile = Join-Path $HomeDir ".rdc\logs\events.jsonl"
$RawFile = Join-Path $HomeDir ".rdc\logs\tunnel.log"

function Show-RdcHelp {
    Write-Host ""
    Write-Host "RDC - Remote Desktop Commander" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Uso:"
    Write-Host "  rdc                 Inicia o tunnel + interface no terminal"
    Write-Host "  rdc login           Salva/troca a Runtime API Key"
    Write-Host "  rdc logout          Remove a chave salva"
    Write-Host "  rdc status          Valida autenticação, build e configuração"
    Write-Host "  rdc logs            Mostra eventos estruturados recentes"
    Write-Host "  rdc logs --raw      Mostra o log bruto do tunnel"
    Write-Host "  rdc sessions        Resume sessões SSH observadas"
    Write-Host "  rdc chrome          Abre a página para habilitar Remote Debugging no Chrome atual"
    Write-Host "  rdc chrome status   Verifica se o Chrome atual está pronto para o MCP"
    Write-Host "  rdc --debug         Inicia mostrando diagnóstico do tunnel"
    Write-Host "  rdc --help          Mostra esta ajuda"
    Write-Host ""
}

function Ensure-Key {
    if (-not $env:CONTROL_PLANE_API_KEY) {
        $env:CONTROL_PLANE_API_KEY = [Environment]::GetEnvironmentVariable("CONTROL_PLANE_API_KEY", "User")
    }
    return [bool]$env:CONTROL_PLANE_API_KEY
}

switch ($Action) {
    { $_ -in @("--help","-h","help") } {
        Show-RdcHelp
        return
    }
    "login" {
        $secure = Read-Host "Cole sua Runtime API Key" -AsSecureString
        $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try {
            $value = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
            if ([string]::IsNullOrWhiteSpace($value)) {
                Write-Error "Nenhuma chave informada."
                return
            }
            [Environment]::SetEnvironmentVariable("CONTROL_PLANE_API_KEY", $value, "User")
            $env:CONTROL_PLANE_API_KEY = $value
            Write-Host "Login configurado." -ForegroundColor Green
        }
        finally {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
        }
        return
    }
    "logout" {
        [Environment]::SetEnvironmentVariable("CONTROL_PLANE_API_KEY", $null, "User")
        Remove-Item Env:CONTROL_PLANE_API_KEY -ErrorAction SilentlyContinue
        Write-Host "Logout concluído." -ForegroundColor Green
        return
    }
    "status" {
        $keyOk = Ensure-Key
        $checks = @(
            @{ Name="Autenticação"; Ok=$keyOk },
            @{ Name="tunnel-client"; Ok=(Test-Path $TunnelExe) },
            @{ Name="Profile"; Ok=(Test-Path $ProfileFile) },
            @{ Name="RDC build"; Ok=(Test-Path (Join-Path $RdcRoot "dist\index.js")) },
            @{ Name="Terminal UI"; Ok=(Test-Path $Cli) }
        )
        foreach ($check in $checks) {
            $mark = if ($check.Ok) { "✓" } else { "✗" }
            $color = if ($check.Ok) { "Green" } else { "Red" }
            Write-Host "$mark $($check.Name)" -ForegroundColor $color
        }
        if ($checks.Ok -contains $false) { return }
        Write-Host "RDC pronto para iniciar." -ForegroundColor Cyan
        return
    }
    "logs" {
        if ($Rest -contains "--raw") {
            if (Test-Path $RawFile) { Get-Content $RawFile -Tail 80 } else { Write-Host "Nenhum log bruto ainda." }
            return
        }
        if (-not (Test-Path $EventFile)) {
            Write-Host "Nenhum evento estruturado ainda."
            return
        }
        Get-Content $EventFile -Tail 40 | ForEach-Object {
            try {
                $e = $_ | ConvertFrom-Json
                $duration = if ($null -ne $e.durationMs) { " $($e.durationMs)ms" } else { "" }
                $target = if ($e.target) { " $($e.target)" } else { "" }
                "{0} {1,-8} {2,-22}{3}{4}" -f ([datetime]$e.timestamp).ToString("HH:mm:ss"), $e.status, $e.tool, $target, $duration
            } catch {
                $_
            }
        }
        return
    }
    "chrome" {
        $chromeExe = "C:\Program Files\Google\Chrome\Application\chrome.exe"
        $devToolsPortFile = Join-Path $env:LOCALAPPDATA "Google\Chrome\User Data\DevToolsActivePort"

        if ($Rest -contains "status") {
            $chromeRunning = [bool](Get-Process chrome -ErrorAction SilentlyContinue)
            $debugEnabled = Test-Path $devToolsPortFile
            $version = $null
            if (Test-Path $chromeExe) {
                $version = (Get-Item $chromeExe).VersionInfo.ProductVersion
            }

            Write-Host ("Chrome: {0}" -f $(if ($chromeRunning) { "rodando" } else { "fechado" })) -ForegroundColor $(if ($chromeRunning) { "Green" } else { "Yellow" })
            if ($version) { Write-Host "Versão: $version" }
            Write-Host ("Remote Debugging: {0}" -f $(if ($debugEnabled) { "ATIVO" } else { "DESATIVADO" })) -ForegroundColor $(if ($debugEnabled) { "Green" } else { "Yellow" })
            if (-not $debugEnabled) {
                Write-Host "Execute 'rdc chrome' e habilite Remote Debugging na página aberta." -ForegroundColor Cyan
            }
            return
        }

        if (-not (Test-Path $chromeExe)) {
            Write-Error "Google Chrome não encontrado em $chromeExe"
            return
        }

        Start-Process $chromeExe "chrome://inspect/#remote-debugging"
        Write-Host "Abri chrome://inspect/#remote-debugging no Chrome atual." -ForegroundColor Cyan
        Write-Host "Habilite Remote Debugging uma vez; depois use: rdc chrome status" -ForegroundColor Yellow
        return
    }
    "sessions" {
        if (-not (Test-Path $EventFile)) {
            Write-Host "Nenhuma sessão SSH observada ainda."
            return
        }
        $sessions = Get-Content $EventFile | ForEach-Object {
            try { $_ | ConvertFrom-Json } catch {}
        } | Where-Object { $_.category -eq "ssh" -and $_.sessionId } |
            Group-Object sessionId
        if (-not $sessions) {
            Write-Host "Nenhuma sessão SSH observada ainda."
            return
        }
        foreach ($group in $sessions) {
            $last = $group.Group | Select-Object -Last 1
            $first = $group.Group | Select-Object -First 1
            Write-Host ("SSH {0}  PID={1}  eventos={2}  início={3}" -f $last.target, $last.pid, $group.Count, $first.timestamp) -ForegroundColor Cyan
        }
        return
    }
}

if (-not (Ensure-Key)) {
    Write-Host "RDC sem autenticação. Use: rdc login" -ForegroundColor Yellow
    return
}

if (-not (Test-Path $Cli)) {
    Write-Error "Terminal UI não encontrada em $Cli"
    return
}

$arguments = @($Cli)
if ($Action -eq "--debug") { $arguments += "--debug" }
node @arguments
