#Requires -RunAsAdministrator
param(
    [ValidateRange(1,65535)][int]$Port = 8443,
    [ValidateRange(1,65535)][int]$HttpPort = 8000
)
$ErrorActionPreference = 'Stop'
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$lanInterfaces = @(Get-NetAdapter -Physical | Where-Object { $_.Status -eq 'Up' } | Select-Object -ExpandProperty Name)
if ($lanInterfaces.Count -eq 0) { throw 'No active physical network adapters found.' }
$ruleName = "EquipmentArUcoLAN-$Port-$HttpPort"
if (-not (Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -Name $ruleName -DisplayName "Equipment ArUco LAN ($Port, $HttpPort)" `
        -Direction Inbound -Action Allow -Protocol TCP -LocalPort @($Port, $HttpPort) `
        -Program $nodePath -RemoteAddress LocalSubnet -InterfaceAlias $lanInterfaces `
        -Profile Any -EdgeTraversalPolicy Block | Out-Null
}
$resultDirectory = Join-Path $PSScriptRoot '.lan-tls'
New-Item -ItemType Directory -Path $resultDirectory -Force | Out-Null
@{ ruleName = $ruleName; ports = @($Port, $HttpPort); interfaces = $lanInterfaces; node = $nodePath } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $resultDirectory 'firewall-result.json') -Encoding UTF8
Write-Output "LAN access enabled for Node.js on ports $Port and $HttpPort (local subnet only)."
