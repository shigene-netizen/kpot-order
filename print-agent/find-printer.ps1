<#
.SYNOPSIS
    KPOT To Go - find the receipt printer on the shop network.

.DESCRIPTION
    Run this on the SHOP PC (the one running start.bat). It answers the three
    questions that decide whether a fixed IP will fix the printing:

      1. What network is this PC actually on? (IP, mask, gateway, wifi name)
      2. Is anything listening on port 9100 at the address in config.json?
      3. If not - where IS the printer? It sweeps the whole subnet for 9100,
         because a receipt printer always answers on 9100 and nothing else
         on a shop network does. That finds it even if its IP changed.

    Read-only. It opens TCP connections and pings; it changes nothing.

.USAGE
    Right-click PowerShell -> "Run as administrator" is NOT required.
    If Windows blocks the script, run this first (once):

        Set-ExecutionPolicy -Scope Process Bypass

    Then:

        .\find-printer.ps1                 # full check + subnet sweep
        .\find-printer.ps1 -TargetIP 192.168.1.50   # just test one address
        .\find-printer.ps1 -NoSweep        # skip the sweep (faster)

.NOTES
    Output is deliberately in plain English: PowerShell 5.1 mangles non-ASCII
    text unless the file has a BOM, and garbled output is worse than English.
#>

param(
    [string]$TargetIP = "",
    [int]   $Port     = 9100,
    [int]   $TimeoutMs = 400,
    [switch]$NoSweep,
    [switch]$ListAll      # also list every host that answers ping (slower)
)

$ErrorActionPreference = 'Continue'

function Line($t = '') { Write-Host $t }
function Head($t) {
    Line ''
    Line ('=== ' + $t + ' ' + ('=' * [Math]::Max(0, 58 - $t.Length)))
}

# --- 1. What network is this PC on? ------------------------------------------
function Get-NetInfo {
    try {
        $c = Get-NetIPConfiguration -ErrorAction Stop |
             Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } |
             Select-Object -First 1
        if ($c) {
            return @{
                IP      = $c.IPv4Address.IPAddress
                Mask    = $c.IPv4Address.PrefixLength
                Gateway = $c.IPv4DefaultGateway.NextHop
                Adapter = $c.NetAdapter.InterfaceDescription
            }
        }
    } catch { }

    # Fallback for older Windows: WMI.
    $w = Get-WmiObject Win32_NetworkAdapterConfiguration -Filter 'IPEnabled = True' |
         Select-Object -First 1
    if ($w) {
        return @{
            IP      = $w.IPAddress[0]
            Mask    = $w.IPSubnet[0]
            Gateway = $w.DefaultIPGateway
            Adapter = $w.Description
        }
    }
    return $null
}

function PrefixToMask([int]$prefix) {
    # Built from a bit string on purpose: the arithmetic version returned an
    # array on PowerShell 5.1 and then failed on '%'. This form cannot.
    if ($prefix -lt 0)  { $prefix = 0 }
    if ($prefix -gt 32) { $prefix = 32 }
    $bits   = ('1' * $prefix).PadRight(32, '0')
    $octets = @()
    for ($i = 0; $i -lt 4; $i++) {
        $octets += [Convert]::ToInt32($bits.Substring($i * 8, 8), 2)
    }
    return ($octets -join '.')
}

function MaskToPrefix([string]$mask) {
    $b = $mask.Split('.') | ForEach-Object { [int]$_ }
    $bits = 0
    foreach ($x in $b) { while ($x -gt 0) { $bits += ($x -band 1); $x = $x -shr 1 } }
    return $bits
}

# --- 2. TCP connect with a short timeout -------------------------------------
function Test-Port([string]$ip, [int]$port, [int]$ms) {
    $client = $null
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $async  = $client.BeginConnect($ip, $port, $null, $null)
        $done   = $async.AsyncWaitHandle.WaitOne($ms, $false)
        if ($done -and $client.Connected) { return $true }
        return $false
    } catch {
        return $false
    } finally {
        if ($client) { try { $client.Close() } catch { } }
    }
}

# --- 3. Hardware (MAC) lookup ------------------------------------------------
function Get-Mac([string]$ip) {
    try {
        $ping = Get-WmiObject Win32_PingStatus -Filter "Address='$ip'" -ErrorAction Stop
        if ($ping.StatusCode -ne 0) { return $null }
        $rows = (arp -a $ip) -join "`n"
        $m = [regex]::Match($rows, '([0-9a-f]{2}-[0-9a-f]{2}-[0-9a-f]{2}-[0-9a-f]{2}-[0-9a-f]{2}-[0-9a-f]{2})', 'IgnoreCase')
        if ($m.Success) { return $m.Groups[1].Value.ToLower() }
    } catch { }
    return $null
}

# ============================================================================
Line ''
Line '  KPOT To Go - printer finder'
Line '  This changes nothing. It only looks.'

# Config file address, if there is one.
$cfgIp = $null
$cfgFile = Join-Path $PSScriptRoot 'config.json'
if (Test-Path $cfgFile) {
    try {
        $raw = Get-Content $cfgFile -Raw | ConvertFrom-Json
        if ($raw.printerHost) { $cfgIp = [string]$raw.printerHost }
        if ($raw.printerPort) { $Port  = [int]$raw.printerPort }
    } catch { }
}

Head 'THIS PC'
$net = Get-NetInfo
if (-not $net) {
    Line '  Could not read this PC network configuration.'
    Line '  Run:  ipconfig /all     and read "Default Gateway" by hand.'
    exit 1
}

# Normalise mask / prefix.
if ($net.Mask -is [int] -or $net.Mask -match '^\d+$') {
    $prefix = [int]$net.Mask
    $mask   = PrefixToMask $prefix
} else {
    $mask   = [string]$net.Mask
    $prefix = MaskToPrefix $mask
}

Line ('  IP address     : ' + $net.IP)
Line ('  Subnet mask    : ' + $mask + '   (/' + $prefix + ')')
Line ('  Default gateway: ' + $net.Gateway + '      <-- this is your ROUTER, type it in a browser')
Line ('  Adapter        : ' + $net.Adapter)

# Wifi name - matters: a printer on a GUEST network is isolated and unreachable.
try {
    $ssid = (netsh wlan show interfaces 2>$null | Select-String -Pattern '^\s*SSID\s*:' | Select-Object -First 1)
    if ($ssid) { Line ('  Wifi network   : ' + ($ssid -replace '^\s*SSID\s*:\s*', '')) }
} catch { }

# Never let a bad mask kill the sweep: /24 covers virtually every shop router,
# and guessing wrong here is much worse than guessing right.
if (-not $mask -or $mask -notmatch '^\d+\.\d+\.\d+\.\d+$') {
    Line '  (could not read the subnet mask - assuming 255.255.255.0)'
    $mask   = '255.255.255.0'
    $prefix = 24
}

# Subnet maths, so the sweep only scans THIS network.
$ipBytes    = $net.IP.Split('.')   | ForEach-Object { [int]$_ }
$maskBytes  = $mask.Split('.')     | ForEach-Object { [int]$_ }
$netBytes   = @(0,1,2,3) | ForEach-Object { $ipBytes[$_] -band $maskBytes[$_] }
$base       = ($netBytes[0..2] -join '.') + '.'
$netPrefix  = $netBytes -join '.'

Line ('  Subnet         : ' + $netPrefix + '/' + $prefix)

# --- Is the configured address right? ---------------------------------------
Head 'THE ADDRESS IN config.json'
if ($cfgIp) {
    Line ('  printerHost is: ' + $cfgIp + ':' + $Port)
    $null = Get-WmiObject Win32_PingStatus -Filter "Address='$cfgIp'" | Out-Null
    if (Test-Port $cfgIp $Port 2000) {
        Line '  RESULT: OPEN. Something IS listening on 9100 there.'
        Line '  The printer is reachable - the problem is somewhere else.'
    } else {
        Line '  RESULT: nothing answered on that port.'
        $mac = Get-Mac $cfgIp
        if ($mac) { Line ('  (a device at that IP DID answer ping, MAC ' + $mac + ' - wrong port or wrong device)') }
        else      { Line '  No device at that address at all. Its IP has almost certainly changed.' }
    }
} else {
    Line '  No config.json next to this script (or printerHost is empty).'
}

# --- Sweep ------------------------------------------------------------------
$found = @()
if (-not $NoSweep) {
    Head ('SWEEPING ' + $base + '1-254 FOR PORT ' + $Port)
    Line '  A receipt printer is usually the only thing on 9100. Please wait.'
    Line ''
    for ($i = 1; $i -le 254; $i++) {
        $ip = $base + $i
        if ($i % 32 -eq 0) { Write-Host ('  ...' + $ip) -NoNewline; Write-Host "`r" -NoNewline }
        if (Test-Port $ip $Port $TimeoutMs) {
            $found += $ip
            Line ''
            Line ('  FOUND: ' + $ip + ':' + $Port + ' is open')
        }
    }
    Line ''
    if ($found.Count -eq 0) {
        Line '  Nothing on this network is listening on 9100.'
        Line ''
        Line '  That means one of these:'
        Line '   - the printer is OFF, or its network cable / wifi is not connected'
        Line '   - it is on a DIFFERENT network (a guest wifi, a second router,'
        Line '     the other band) - a fixed IP will NOT help until that is fixed'
        Line '   - it is USB-only and prints through a Windows printer share'
    } else {
        foreach ($ip in $found) {
            $mac = Get-Mac $ip
            if ($mac) { Line ('  PRINTER CANDIDATE: ' + $ip + '   MAC ' + $mac) }
            else      { Line ('  PRINTER CANDIDATE: ' + $ip) }
        }
        Line ''
        Line '  Write this IP down, and put it in config.json as printerHost.'
    }
}

if ($ListAll) {
    Head 'EVERY DEVICE ANSWERING PING (names come from the router)'
    Line '  (slow - this is only needed if 9100 found nothing)'
    for ($i = 1; $i -le 254; $i++) {
        $ip = $base + $i
        $p = Get-WmiObject Win32_PingStatus -Filter "Address='$ip'" |
             Where-Object { $_.StatusCode -eq 0 } | Select-Object -First 1
        if ($p) { Line ('  ' + $ip.PadRight(16) + ' up') }
    }
}

Head 'NEXT'
Line '  1. Note the printer IP above and its MAC if shown.'
Line '  2. Open a browser, type the DEFAULT GATEWAY address, log in to the router.'
Line '  3. Reserve that IP for that MAC (see PRINTER-FIXED-IP.md for screenshots'
Line '     by router brand).'
Line '  4. Power the printer off and on. Confirm with:  ping <printer-ip>'
Line '  5. printerHost in config.json must equal the reserved IP.'
Line '  6. Close the agent window and run start.bat again.'
Line ''
