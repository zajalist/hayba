param(
    [string]$Project, [string]$Engine,
    [string]$PackageRoot = (Split-Path -Parent $PSScriptRoot),
    [switch]$ClaudeCode, [switch]$ClaudeDesktop, [string]$DesktopConfig,
    [switch]$ReplaceExisting, [switch]$CheckOnly, [switch]$SkipCompile,
    [string]$RenderPreview
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/Installer.Core.ps1"
if ($Project) {
    $settings = @{ Project=$Project; Engine=$Engine; PackageRoot=$PackageRoot; ClaudeCode=$ClaudeCode; ClaudeDesktop=$ClaudeDesktop; ReplaceExisting=$ReplaceExisting; CheckOnly=$CheckOnly; SkipCompile=$SkipCompile }
    if ($DesktopConfig) { $settings.DesktopConfig = $DesktopConfig }
    Invoke-HaybaInstall @settings
    exit
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
try {
    $background = [Drawing.ColorTranslator]::FromHtml('#1d1b19')
    $raised = [Drawing.ColorTranslator]::FromHtml('#292623')
    $foreground = [Drawing.ColorTranslator]::FromHtml('#eae6e1')
    $secondary = [Drawing.ColorTranslator]::FromHtml('#bcb4ab')
    $accent = [Drawing.ColorTranslator]::FromHtml('#d0aa73')
    $form = New-Object Windows.Forms.Form
    $form.Text = 'Install Hayba'
    $form.ClientSize = New-Object Drawing.Size(720,670)
    $form.MinimumSize = New-Object Drawing.Size(736,709)
    $form.StartPosition = 'CenterScreen'
    $form.BackColor = $background
    $form.ForeColor = $foreground
    $form.Font = New-Object Drawing.Font('Segoe UI',10)
    $form.AutoScaleMode = 'Dpi'
    function Add-Label($text,$x,$y,$width,$height) {
        $label = New-Object Windows.Forms.Label
        $label.BackColor=$background; $label.ForeColor=$foreground; $label.Font=$form.Font
        $label.Text=$text; $label.SetBounds($x,$y,$width,$height); $form.Controls.Add($label)
        return $label
    }
    function Add-Button($text,$x,$y,$width,$height) {
        $button = New-Object Windows.Forms.Button
        $button.Font=$form.Font
        $button.Text=$text; $button.SetBounds($x,$y,$width,$height)
        $button.FlatStyle='Flat'; $button.BackColor=$raised; $button.ForeColor=$foreground
        $button.FlatAppearance.BorderColor=[Drawing.ColorTranslator]::FromHtml('#5e554d')
        $form.Controls.Add($button)
        return $button
    }
    function Add-TextBox($text,$x,$y,$width) {
        $box=New-Object Windows.Forms.TextBox
        $box.Font=$form.Font
        $box.Text=$text; $box.SetBounds($x,$y,$width,30); $box.BackColor=$raised; $box.ForeColor=$foreground
        $box.BorderStyle='FixedSingle'; $box.Anchor='Top,Left,Right'; $form.Controls.Add($box)
        return $box
    }
    function Add-Check($text,$y) {
        $box=New-Object Windows.Forms.CheckBox
        $box.BackColor=$background; $box.ForeColor=$foreground; $box.Font=$form.Font
        $box.Text=$text; $box.SetBounds(28,$y,650,26); $form.Controls.Add($box)
        return $box
    }
    $title=Add-Label 'Bring Hayba into your project' 28 24 660 40
    $title.Font=New-Object Drawing.Font('Segoe UI',21,[Drawing.FontStyle]::Bold)
    $subtitle=Add-Label 'Choose your Unreal project. Hayba compiles on this PC, then chat uses your API key.' 30 76 650 38
    $subtitle.ForeColor=$secondary
    $packageLabel=Add-Label '' 30 112 650 26
    $packageLabel.ForeColor=$accent
    $manifest=Read-HaybaJson (Join-Path $PackageRoot 'manifest.json')
    $packageLabel.Text="For Unreal $($manifest.engine.version) — compiles for the engine you select"
    $null=Add-Label 'Unreal project' 28 153 580 24
    $projectBox=Add-TextBox '' 28 179 554
    $projectBox.AccessibleName='Unreal project file'
    $projectBrowse=Add-Button 'Browse...' 594 177 98 30
    $projectBrowse.Anchor='Top,Right'
    $null=Add-Label 'Unreal Engine folder' 28 222 580 24
    $engineBox=Add-TextBox '' 28 248 554
    $engineBox.AccessibleName='Unreal Engine installation folder'
    $wantedSeries = if ([string]$manifest.engine.version -match '^(\d+\.\d+)') { $Matches[1] } else { [string]$manifest.engine.version }
    foreach ($candidate in @(Get-HaybaEngines | Sort-Object)) {
        try { if ((Get-HaybaEngineVersion $candidate).Series -eq $wantedSeries) { $engineBox.Text=$candidate; break } } catch { }
    }
    $engineBrowse=Add-Button 'Browse...' 594 246 98 30
    $engineBrowse.Anchor='Top,Right'
    $codeBox=Add-Check 'Connect Claude Code for this project' 291
    $desktopBox=Add-Check 'Connect Claude Desktop' 320
    $desktopPath=Add-TextBox (Join-Path $env:APPDATA 'Claude/claude_desktop_config.json') 48 353 534
    $desktopPath.AccessibleName='Claude Desktop config file'
    $desktopPath.Enabled=$false
    $desktopBrowse=Add-Button 'Config...' 594 351 98 30
    $desktopBrowse.Enabled=$false; $desktopBrowse.Anchor='Top,Right'
    $replaceBox=Add-Check 'Update existing Hayba (keep a backup)' 394
    $note=Add-Label 'Close Unreal first. Visual Studio C++ tools are required so Hayba can compile on this PC, even after an older install.' 28 427 660 40
    $note.ForeColor=$secondary
    $status=New-Object Windows.Forms.TextBox
    $status.Font=$form.Font
    $status.SetBounds(28,473,664,110); $status.Multiline=$true; $status.ReadOnly=$true; $status.ScrollBars='Vertical'
    $status.BackColor=$raised; $status.ForeColor=$foreground; $status.BorderStyle='FixedSingle'
    $status.Text='Ready. Select a project to begin.'; $status.Anchor='Top,Bottom,Left,Right'
    $status.AccessibleName='Installation progress'; $form.Controls.Add($status)
    $progress=New-Object Windows.Forms.ProgressBar
    $progress.SetBounds(28,591,664,5); $progress.Anchor='Bottom,Left,Right'; $progress.Visible=$false; $progress.Style='Marquee'
    $form.Controls.Add($progress)
    $close=Add-Button 'Close' 448 613 108 34
    $close.Anchor='Bottom,Right'; $close.Add_Click({ $form.Close() })
    $install=Add-Button 'Install Hayba' 568 613 124 34
    $install.Anchor='Bottom,Right'; $install.BackColor=$accent; $install.ForeColor=$background
    $install.Font=New-Object Drawing.Font('Segoe UI',10,[Drawing.FontStyle]::Bold)
    $form.AcceptButton=$install
    $projectBrowse.Add_Click({
        $dialog=New-Object Windows.Forms.OpenFileDialog
        $dialog.Filter='Unreal projects (*.uproject)|*.uproject'; $dialog.Title='Choose your Unreal project'
        if ($dialog.ShowDialog($form) -eq 'OK') { $projectBox.Text=$dialog.FileName }
        $dialog.Dispose()
    })
    $engineBrowse.Add_Click({
        $dialog=New-Object Windows.Forms.FolderBrowserDialog
        $dialog.Description='Select the Unreal installation folder containing Engine (for example UE_5.9).'
        $dialog.SelectedPath=$engineBox.Text
        if ($dialog.ShowDialog($form) -eq 'OK') { $engineBox.Text=$dialog.SelectedPath }
        $dialog.Dispose()
    })
    $desktopBox.Add_CheckedChanged({ $desktopPath.Enabled=$desktopBox.Checked; $desktopBrowse.Enabled=$desktopBox.Checked })
    $desktopBrowse.Add_Click({
        $dialog=New-Object Windows.Forms.OpenFileDialog
        $dialog.Filter='Claude config (*.json)|*.json'; $dialog.Title='Select the file from Claude Settings > Developer > Edit Config'
        if ($dialog.ShowDialog($form) -eq 'OK') { $desktopPath.Text=$dialog.FileName }
        $dialog.Dispose()
    })
    $script:installation=$null
    $timer=New-Object Windows.Forms.Timer
    $timer.Interval=250
    $install.Add_Click({
        if (-not $projectBox.Text.Trim() -or -not $engineBox.Text.Trim()) { $status.Text='Choose a .uproject file and the Unreal Engine folder first.'; return }
        $settings=@{ Project=$projectBox.Text.Trim(); Engine=$engineBox.Text.Trim(); PackageRoot=$PackageRoot; ClaudeCode=$codeBox.Checked; ClaudeDesktop=$desktopBox.Checked; DesktopConfig=$desktopPath.Text.Trim(); ReplaceExisting=$replaceBox.Checked }
        $worker=[PowerShell]::Create()
        $null=$worker.AddScript('param($core,$settings) . $core; Invoke-HaybaInstall @settings').AddArgument("$PSScriptRoot/Installer.Core.ps1").AddArgument($settings)
        $script:installation=@{ Worker=$worker; Handle=$worker.BeginInvoke(); Read=0 }
        foreach ($control in @($projectBox,$projectBrowse,$engineBox,$engineBrowse,$codeBox,$desktopBox,$desktopPath,$desktopBrowse,$replaceBox,$install,$close)) { $control.Enabled=$false }
        $progress.Visible=$true; $status.Text='Preparing installation...'; $timer.Start()
    })
    $timer.Add_Tick({
        $job=$script:installation
        if (-not $job) { return }
        while ($job.Read -lt $job.Worker.Streams.Information.Count) {
            $status.AppendText([Environment]::NewLine + [string]$job.Worker.Streams.Information[$job.Read]); $job.Read++
        }
        if (-not $job.Handle.IsCompleted) { return }
        $timer.Stop(); $progress.Visible=$false
        try {
            $results=$job.Worker.EndInvoke($job.Handle)
            if ($job.Worker.HadErrors) { throw $job.Worker.Streams.Error[-1].Exception.Message }
            $result=$results[-1]
            $status.AppendText("`r`n`r`nHayba compiled for this Unreal install. Open Plugins\HaybaMCPToolkit\Hayba.exe for the standalone chat app, or Tools > Hayba MCP Toolkit in Unreal. Enter your API key in Settings, then send a message.`r`nMCP server: $($result.ServerName)`r`nBackups: $($result.Backup)")
            $install.Text='Installed'; $status.ForeColor=[Drawing.ColorTranslator]::FromHtml('#9bc5a6')
        } catch {
            $status.AppendText("`r`n`r`n$($_.Exception.Message)")
            $status.ForeColor=[Drawing.ColorTranslator]::FromHtml('#e49790')
            foreach ($control in @($projectBox,$projectBrowse,$engineBox,$engineBrowse,$codeBox,$desktopBox,$replaceBox,$install)) { $control.Enabled=$true }
            $desktopPath.Enabled=$desktopBox.Checked; $desktopBrowse.Enabled=$desktopBox.Checked
        } finally { $job.Worker.Dispose(); $script:installation=$null; $close.Enabled=$true }
    })
    $form.Add_FormClosing({ if ($script:installation) { $_.Cancel=$true; $status.AppendText("`r`nPlease wait for installation or rollback to finish before closing.") } })
    if ($RenderPreview) {
        $projectBox.Text='C:\Projects\MyGame\MyGame.uproject'
        $form.CreateControl(); $form.PerformLayout()
        $bitmap=New-Object Drawing.Bitmap($form.Width,$form.Height)
        try {
            $form.DrawToBitmap($bitmap,(New-Object Drawing.Rectangle(0,0,$form.Width,$form.Height)))
            # Draw detached controls without ever showing a window on the user's desktop.
            $offsetX=($form.Width-$form.ClientSize.Width)/2
            $offsetY=$form.Height-$form.ClientSize.Height-$offsetX
            foreach ($control in @($form.Controls)) {
                if ($control -eq $progress) { continue }
                $bounds=$control.Bounds
                $form.Controls.Remove($control)
                $control.Visible=$true
                $control.DrawToBitmap($bitmap,(New-Object Drawing.Rectangle(($bounds.X+$offsetX),($bounds.Y+$offsetY),$bounds.Width,$bounds.Height)))
                $form.Controls.Add($control); $control.Bounds=$bounds
            }
            $bitmap.Save([IO.Path]::GetFullPath($RenderPreview))
        }
        finally { $bitmap.Dispose() }
    } else { [Windows.Forms.Application]::Run($form) }
    $timer.Dispose(); $form.Dispose()
} catch {
    if ($RenderPreview) { throw }
    [Windows.Forms.MessageBox]::Show($_.Exception.Message,'Hayba setup','OK','Error') | Out-Null
    exit 1
}
