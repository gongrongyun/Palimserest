[CmdletBinding()]
param(
    [string] $VoiceName = 'Microsoft Zira Desktop'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech

$outputFolder = Join-Path $PSScriptRoot 'demo-audio'
$clips = [ordered]@{
    subtle = 'subtle'
    yield = 'yield'
    'record-noun' = 'a record'
    'record-verb' = 'to record'
    ran = 'ran'
    run = 'run'
}
$format = [System.Speech.AudioFormat.SpeechAudioFormatInfo]::new(
    16000,
    [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
    [System.Speech.AudioFormat.AudioChannel]::Mono
)
$speaker = [System.Speech.Synthesis.SpeechSynthesizer]::new()
try {
    $speaker.SelectVoice($VoiceName)
    $speaker.Rate = -1
    New-Item -Path $outputFolder -ItemType Directory -Force | Out-Null
    foreach ($clip in $clips.GetEnumerator()) {
        $speaker.SetOutputToWaveFile((Join-Path $outputFolder ($clip.Key + '.wav')), $format)
        $speaker.Speak($clip.Value)
        $speaker.SetOutputToNull()
    }
} finally {
    $speaker.Dispose()
}
