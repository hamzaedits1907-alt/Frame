// Frame launcher: installs the app next to the user's profile, starts the local server,
// keeps a tray icon, and restarts the server after an in-app update (exit code 42).
// Compiles with the C# compiler that ships with Windows (.NET Framework 4.x).
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("Frame")]
[assembly: AssemblyProduct("Frame")]
[assembly: AssemblyDescription("Frame - video, photo and audio editor")]
[assembly: AssemblyCompany("Frame")]
[assembly: AssemblyVersion("%VERSION%.0")]
[assembly: AssemblyFileVersion("%VERSION%.0")]

static class Program
{
    const int Port = 4719;
    static string InstallDir;
    static Process server;
    static NotifyIcon tray;
    static volatile bool quitting;
    static bool noShortcuts;

    [STAThread]
    static void Main(string[] args)
    {
        InstallDir = Environment.GetEnvironmentVariable("FRAME_INSTALL_DIR");
        if (string.IsNullOrEmpty(InstallDir)) InstallDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Frame");
        foreach (var a in args) if (a == "--no-shortcuts") noShortcuts = true;

        bool created;
        var mutex = new Mutex(true, "Frame-Editor-Launcher-" + InstallDir.GetHashCode(), out created);
        if (!created) { OpenBrowser(); return; }

        Application.EnableVisualStyles();
        RefreshPath();
        try { EnsureInstalled(); }
        catch (Exception e) { MessageBox.Show("Frame could not be installed:\n\n" + e.Message, "Frame", MessageBoxButtons.OK, MessageBoxIcon.Error); return; }
        CheckFfmpeg();
        SetupTray();
        var t = new Thread(ServerLoop);
        t.IsBackground = true;
        t.Start();
        Application.Run();
        GC.KeepAlive(mutex);
    }

    // ---------- Install ----------
    static string ReadVersion(string json)
    {
        var m = Regex.Match(json ?? "", "\"version\"\\s*:\\s*\"([^\"]+)\"");
        return m.Success ? m.Groups[1].Value : "0.0.0";
    }

    static int CompareVersions(string a, string b)
    {
        var pa = a.TrimStart('v').Split('.');
        var pb = b.TrimStart('v').Split('.');
        for (int i = 0; i < 3; i++)
        {
            int x = 0, y = 0;
            if (i < pa.Length) int.TryParse(Regex.Replace(pa[i], "\\D", ""), out x);
            if (i < pb.Length) int.TryParse(Regex.Replace(pb[i], "\\D", ""), out y);
            if (x != y) return x.CompareTo(y);
        }
        return 0;
    }

    static void EnsureInstalled()
    {
        byte[] payload;
        using (var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
        using (var ms = new MemoryStream())
        {
            s.CopyTo(ms);
            payload = ms.ToArray();
        }
        string embedded;
        using (var z = new ZipArchive(new MemoryStream(payload)))
        using (var r = new StreamReader(z.GetEntry("version.json").Open()))
            embedded = ReadVersion(r.ReadToEnd());

        string vf = Path.Combine(InstallDir, "version.json");
        string installed = File.Exists(vf) ? ReadVersion(File.ReadAllText(vf)) : null;
        bool first = installed == null;
        if (first || CompareVersions(embedded, installed) > 0)
        {
            Directory.CreateDirectory(InstallDir);
            foreach (var d in new[] { "app", "server" })
            {
                var p = Path.Combine(InstallDir, d);
                if (Directory.Exists(p)) Directory.Delete(p, true);
            }
            using (var z = new ZipArchive(new MemoryStream(payload)))
            {
                foreach (var e in z.Entries)
                {
                    var dest = Path.Combine(InstallDir, e.FullName.Replace('/', '\\'));
                    if (e.FullName.EndsWith("/")) { Directory.CreateDirectory(dest); continue; }
                    Directory.CreateDirectory(Path.GetDirectoryName(dest));
                    e.ExtractToFile(dest, true);
                }
            }
        }

        // Keep a copy of the launcher in the install folder so shortcuts survive the download being deleted.
        string self = Assembly.GetExecutingAssembly().Location;
        string target = Path.Combine(InstallDir, "Frame.exe");
        if (!string.Equals(Path.GetFullPath(self), Path.GetFullPath(target), StringComparison.OrdinalIgnoreCase))
        {
            try { File.Copy(self, target, true); } catch { target = self; }
        }
        if (!noShortcuts)
        {
            CreateShortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Frame.lnk"), target);
            if (first) CreateShortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "Frame.lnk"), target);
        }
    }

    static void CreateShortcut(string lnkPath, string target)
    {
        try
        {
            Type t = Type.GetTypeFromProgID("WScript.Shell");
            object shell = Activator.CreateInstance(t);
            object lnk = t.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { lnkPath });
            Type lt = lnk.GetType();
            lt.InvokeMember("TargetPath", BindingFlags.SetProperty, null, lnk, new object[] { target });
            lt.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, lnk, new object[] { InstallDir });
            lt.InvokeMember("IconLocation", BindingFlags.SetProperty, null, lnk, new object[] { target + ",0" });
            lt.InvokeMember("Description", BindingFlags.SetProperty, null, lnk, new object[] { "Frame - video, photo and audio editor" });
            lt.InvokeMember("Save", BindingFlags.InvokeMethod, null, lnk, null);
        }
        catch { }
    }

    // ---------- FFmpeg ----------
    static void RefreshPath()
    {
        string m = Environment.GetEnvironmentVariable("Path", EnvironmentVariableTarget.Machine) ?? "";
        string u = Environment.GetEnvironmentVariable("Path", EnvironmentVariableTarget.User) ?? "";
        Environment.SetEnvironmentVariable("Path", m + ";" + u);
    }

    static bool HasFfmpeg()
    {
        if (File.Exists(Path.Combine(InstallDir, "tools\\ffmpeg.exe"))) return true;
        foreach (var dir in (Environment.GetEnvironmentVariable("Path") ?? "").Split(';'))
        {
            try { if (dir.Length > 0 && File.Exists(Path.Combine(dir.Trim(), "ffmpeg.exe"))) return true; } catch { }
        }
        return false;
    }

    static void CheckFfmpeg()
    {
        if (HasFfmpeg() || File.Exists(Path.Combine(InstallDir, ".no-ffmpeg-prompt"))) return;
        var r = MessageBox.Show("Frame uses FFmpeg (free) to save videos as MP4, GIF and MP3.\n\nInstall it now? This takes about a minute.\n\n(You can still edit without it.)",
            "Frame - one more thing", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
        if (r != DialogResult.Yes) { try { File.WriteAllText(Path.Combine(InstallDir, ".no-ffmpeg-prompt"), "1"); } catch { } return; }
        try
        {
            var p = Process.Start(new ProcessStartInfo("winget", "install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements") { UseShellExecute = true });
            p.WaitForExit();
            RefreshPath();
        }
        catch (Exception e) { MessageBox.Show("Could not run winget: " + e.Message, "Frame"); }
    }

    // ---------- Server ----------
    static void ServerLoop()
    {
        bool first = string.IsNullOrEmpty(Environment.GetEnvironmentVariable("FRAME_NO_BROWSER"));
        while (!quitting)
        {
            var psi = new ProcessStartInfo("powershell.exe",
                "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + Path.Combine(InstallDir, "server\\server.ps1") + "\" -Port " + Port + (first ? " -Open" : ""));
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.WorkingDirectory = InstallDir;
            try { server = Process.Start(psi); }
            catch (Exception e) { MessageBox.Show("Could not start Frame: " + e.Message, "Frame"); break; }
            server.WaitForExit();
            int code = server.ExitCode;
            first = false;
            if (quitting) break;
            if (code == 42) { ShowTip("Frame updated", "Frame has been updated and restarted."); continue; }
            if (code != 0) MessageBox.Show("Frame stopped unexpectedly (code " + code + ").", "Frame", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            break;
        }
        Quit();
    }

    // ---------- Tray ----------
    static void SetupTray()
    {
        tray = new NotifyIcon();
        try { tray.Icon = Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location); } catch { tray.Icon = SystemIcons.Application; }
        tray.Text = "Frame";
        var menu = new ContextMenuStrip();
        menu.Items.Add("Open Frame", null, delegate { OpenBrowser(); });
        menu.Items.Add("Open exports folder", null, delegate { OpenExports(); });
        menu.Items.Add("Open install folder", null, delegate { Process.Start("explorer.exe", "\"" + InstallDir + "\""); });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Quit Frame", null, delegate { Quit(); });
        tray.ContextMenuStrip = menu;
        tray.DoubleClick += delegate { OpenBrowser(); };
        tray.Visible = true;
    }

    static void ShowTip(string title, string text)
    {
        try { tray.ShowBalloonTip(3000, title, text, ToolTipIcon.Info); } catch { }
    }

    static void OpenExports()
    {
        string p = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyVideos), "Frame");
        Directory.CreateDirectory(p);
        Process.Start("explorer.exe", "\"" + p + "\"");
    }

    static void OpenBrowser()
    {
        string url = "http://localhost:" + Port + "/";
        string pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        string pf86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
        string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        string[] browsers = {
            Path.Combine(pf, "Google\\Chrome\\Application\\chrome.exe"), Path.Combine(pf86, "Google\\Chrome\\Application\\chrome.exe"),
            Path.Combine(local, "Google\\Chrome\\Application\\chrome.exe"), Path.Combine(pf86, "Microsoft\\Edge\\Application\\msedge.exe"),
            Path.Combine(pf, "Microsoft\\Edge\\Application\\msedge.exe") };
        foreach (var b in browsers)
        {
            if (File.Exists(b)) { Process.Start(b, "--app=" + url + " --start-maximized"); return; }
        }
        Process.Start(url);
    }

    static void Quit()
    {
        quitting = true;
        try { if (server != null && !server.HasExited) server.Kill(); } catch { }
        try { if (tray != null) tray.Visible = false; } catch { }
        Application.Exit();
        Environment.Exit(0);
    }
}
