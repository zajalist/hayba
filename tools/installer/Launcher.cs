using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

internal static class Launcher
{
    [STAThread]
    private static void Main()
    {
        try
        {
            string root = AppDomain.CurrentDomain.BaseDirectory;
            string script = Path.Combine(root, "installer", "Install.ps1");
            if (!File.Exists(script) || !File.Exists(Path.Combine(root, "manifest.json")))
                throw new InvalidOperationException("Extract the entire Hayba ZIP first, then run Install Hayba.exe from that folder.");
            string powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe");
            var start = new ProcessStartInfo(powershell, "-NoProfile -STA -ExecutionPolicy Bypass -File \"" + script + "\"");
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.WindowStyle = ProcessWindowStyle.Hidden;
            start.EnvironmentVariables.Remove("PSModulePath");
            Process.Start(start);
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "Hayba setup", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}
