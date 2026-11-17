param(
  [Parameter(Mandatory = $true)][string]$AccdbPath,
  [Parameter(Mandatory = $true)][string]$OutputJsonPath
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if (-not (Test-Path -LiteralPath $AccdbPath)) {
  throw "ACCDB file not found: $AccdbPath"
}

$resolvedAccdb = (Resolve-Path -LiteralPath $AccdbPath).Path
$outDir = Split-Path -Parent $OutputJsonPath
if ($outDir -and -not (Test-Path -LiteralPath $outDir)) {
  New-Item -ItemType Directory -Path $outDir -Force | Out-Null
}

$connStr = "Provider=Microsoft.ACE.OLEDB.12.0;Data Source=$resolvedAccdb;Mode=Read;"
$conn = New-Object System.Data.OleDb.OleDbConnection($connStr)
$conn.Open()

try {
  $schemaTables = $conn.GetSchema("Tables")
  $tableNames = @()
  foreach ($row in $schemaTables.Rows) {
    if ("$($row['TABLE_TYPE'])" -eq 'TABLE') {
      $tName = "$($row['TABLE_NAME'])"
      if (-not $tName.StartsWith('~') -and -not $tName.StartsWith('MSys')) {
        $tableNames += $tName
      }
    }
  }
  $tableNames = $tableNames | Sort-Object

  $tablesObj = [ordered]@{}
  foreach ($tName in $tableNames) {
    $cmd = $conn.CreateCommand()
    $cmd.CommandText = "SELECT * FROM [$tName]"
    $da = New-Object System.Data.OleDb.OleDbDataAdapter($cmd)
    $dt = New-Object System.Data.DataTable
    [void]$da.Fill($dt)

    $colNames = @()
    foreach ($col in $dt.Columns) {
      $colNames += $col.ColumnName
    }

    $rowsList = New-Object System.Collections.ArrayList
    foreach ($dr in $dt.Rows) {
      $rec = [ordered]@{}
      foreach ($cn in $colNames) {
        $val = $dr[$cn]
        if ($val -is [System.DBNull] -or $null -eq $val) {
          $rec[$cn] = $null
        } elseif ($val -is [DateTime]) {
          $rec[$cn] = $val.ToString('yyyy-MM-ddTHH:mm:ss')
        } elseif ($val -is [decimal] -or $val -is [double] -or $val -is [float]) {
          $rec[$cn] = [decimal]$val
        } elseif ($val -is [bool]) {
          $rec[$cn] = [bool]$val
        } elseif ($val -is [int] -or $val -is [long] -or $val -is [int16] -or $val -is [byte]) {
          $rec[$cn] = [long]$val
        } else {
          $rec[$cn] = "$val"
        }
      }
      [void]$rowsList.Add($rec)
    }
    $tablesObj[$tName] = [object[]]$rowsList.ToArray()
  }

  $payload = [ordered]@{
    exportedAt = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ssK')
    accdbPath  = $resolvedAccdb
    tableCount = $tableNames.Count
    tables     = $tablesObj
  }

  $json = $payload | ConvertTo-Json -Depth 6
  [System.IO.File]::WriteAllText($OutputJsonPath, $json, (New-Object System.Text.UTF8Encoding($false)))
  Write-Output "Exported $($tableNames.Count) tables to $OutputJsonPath"
} finally {
  $conn.Close()
}
