# Copyright 2026 Google LLC
# SPDX-License-Identifier: Apache-2.0

# Run from the checkout with PowerShell 7:
# ./scripts/diagnose-windows-startup.ps1 > startup-diagnostic.json
# This reads filesystem metadata and runs Node/Git. It changes no configuration.
[CmdletBinding()]
param(
    [string]$Workspace = (Get-Location).Path,
    [ValidateRange(1, 5)][int]$Samples = 2,
    [ValidateRange(1, 600)][int]$OperationTimeoutSeconds = 60,
    [ValidateRange(1, 1800)][int]$TotalTimeoutSeconds = 300
)

$ErrorActionPreference = 'Stop'
$nodeCommand = Get-Command node -CommandType Application -ErrorAction Stop
$diagnosticScript = Join-Path $PSScriptRoot 'diagnose-windows-startup.js'
& $nodeCommand.Source $diagnosticScript --workspace $Workspace --samples $Samples `
    --operation-timeout-ms ($OperationTimeoutSeconds * 1000) `
    --total-timeout-ms ($TotalTimeoutSeconds * 1000)
if ($LASTEXITCODE -ne 0) {
    throw "Startup diagnostic failed with exit code $LASTEXITCODE."
}
