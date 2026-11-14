using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Windows.Forms;

internal static class HaybaApp
{
    [STAThread]
    private static void Main()
    {
        try
        {
            string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            string plugin = Directory.Exists(Path.Combine(root, "ThirdParty", "node")) ? root : Path.Combine(root, "payload", "HaybaMCPToolkit");
            string node = Path.Combine(plugin, "ThirdParty", "node", "node.exe");
            string script = Path.Combine(plugin, "ThirdParty", "mcp_server", "run-app.cjs");
            if (!File.Exists(node) || !File.Exists(script))
                throw new InvalidOperationException("Install Hayba into your Unreal project first, then run Hayba.exe from Plugins\\HaybaMCPToolkit.");
            var start = new ProcessStartInfo(node, "\"" + script + "\"");
            DirectoryInfo project = Directory.GetParent(Path.GetDirectoryName(plugin) ?? plugin);
            start.WorkingDirectory = project != null && project.Exists ? project.FullName : plugin;
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.RedirectStandardOutput = true;
            start.RedirectStandardError = true;
            start.StandardOutputEncoding = Encoding.UTF8;
            start.EnvironmentVariables.Remove("PSModulePath");
            start.EnvironmentVariables["DASHBOARD_PORT"] = "7821";
            var process = Process.Start(start);
            if (process == null) throw new InvalidOperationException("Could not start Hayba.");
            string url = null;
            DataReceivedEventHandler read = (sender, args) =>
            {
                if (args.Data != null && args.Data.StartsWith("Hayba app: ", StringComparison.Ordinal))
                    url = args.Data.Substring("Hayba app: ".Length).Trim();
            };
            process.OutputDataReceived += read;
            process.ErrorDataReceived += read;
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            DateTime until = DateTime.UtcNow.AddSeconds(20);
            while (url == null && DateTime.UtcNow < until && !process.HasExited)
                System.Threading.Thread.Sleep(50);
            if (string.IsNullOrEmpty(url))
                throw new InvalidOperationException("Hayba started without a window URL. Rebuild the MCP server and reinstall.");
            OpenWindow(url);
            if (!process.HasExited) process.WaitForExit();
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "Hayba", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private static void OpenWindow(string url)
    {
        string[] browsers = {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"Microsoft\Edge\Application\msedge.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Microsoft\Edge\Application\msedge.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Google\Chrome\Application\chrome.exe")
        };
        foreach (string browser in browsers)
        {
            if (!File.Exists(browser)) continue;
            Process.Start(new ProcessStartInfo(browser, "--app=\"" + url + "\" --window-size=1100,780") { UseShellExecute = false });
            return;
        }
        Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
    }
}
