param(
  [Parameter(Mandatory = $true)]
  [string]$InputDirectory,
  [Parameter(Mandatory = $true)]
  [string]$OutputPath
)

Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type -AssemblyName System.Drawing
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]

function Await-WinRt($Operation, [Type]$ResultType) {
  $method = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 } |
    Select-Object -First 1
  $task = $method.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
  $task.Wait()
  return $task.Result
}

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage(
  [Windows.Globalization.Language]::new('ko-KR')
)
if (-not $engine) { throw '한국어 Windows OCR 엔진을 사용할 수 없습니다.' }

$output = [System.Collections.Generic.List[string]]::new()
$files = Get-ChildItem -LiteralPath $InputDirectory -Filter 'KakaoTalk_20260928_210950552*.jpg' |
  Sort-Object Name

foreach ($file in $files) {
  $suffix = [System.IO.Path]::GetFileNameWithoutExtension($file.Name).Replace('KakaoTalk_20260928_210950552', '')
  $number = if ($suffix -match '^_(\d+)$') { [int]$Matches[1] } else { 0 }
  $ocrPath = $file.FullName
  $temporaryPath = $null

  if ($number -le 10) {
    $temporaryPath = Join-Path $env:TEMP ("ansimon-ocr-{0}.png" -f [guid]::NewGuid())
    $bitmap = [System.Drawing.Bitmap]::new($file.FullName)
    try {
      $bitmap.RotateFlip([System.Drawing.RotateFlipType]::Rotate180FlipNone)
      $bitmap.Save($temporaryPath, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
      $bitmap.Dispose()
    }
    $ocrPath = $temporaryPath
  }

  try {
    $storageFile = Await-WinRt ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ocrPath)) ([Windows.Storage.StorageFile])
    $stream = Await-WinRt ($storageFile.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    try {
      $decoder = Await-WinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
      $softwareBitmap = Await-WinRt ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
      try {
        $result = Await-WinRt ($engine.RecognizeAsync($softwareBitmap)) ([Windows.Media.Ocr.OcrResult])
        $output.Add("===== $($file.Name) =====")
        foreach ($line in $result.Lines) {
          $output.Add($line.Text)
        }
        $output.Add('')
      } finally {
        $softwareBitmap.Dispose()
      }
    } finally {
      $stream.Dispose()
    }
  } finally {
    if ($temporaryPath -and (Test-Path -LiteralPath $temporaryPath)) {
      Remove-Item -LiteralPath $temporaryPath -Force
    }
  }
}

[System.IO.File]::WriteAllLines($OutputPath, $output, [System.Text.UTF8Encoding]::new($false))
