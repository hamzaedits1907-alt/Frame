// Frame launcher: installs the app into the user's profile, starts the local server and shows
// Frame in its own native window (WebView2). Falls back to a browser app window if WebView2
// is missing. Restarts the server after an in-app update (server exit code 42).
// Compiles with the C# compiler that ships with Windows (.NET Framework 4.x, C# 5).
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

[assembly: AssemblyTitle("Frame")]
[assembly: AssemblyProduct("Frame")]
[assembly: AssemblyDescription("Frame - video, photo and audio editor")]
[assembly: AssemblyCompany("Frame")]
[assembly: AssemblyVersion("%VERSION%.0")]
[assembly: AssemblyFileVersion("%VERSION%.0")]

static class Program
{
    public const int Port = 4719;
    public static string InstallDir;
    public static string BinDir;
    static Process server;
    static NotifyIcon tray;
    static volatile bool quitting;
    static bool noShortcuts;
    public static bool NativeMode;
    public static Form MainWindow;

    public static void Log(string m) { try { File.AppendAllText(Path.Combine(InstallDir, "launcher.log"), DateTime.Now.ToString("HH:mm:ss.fff") + " " + m + Environment.NewLine); } catch { } }

    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);

    [STAThread]
    static void Main(string[] args)
    {
        InstallDir = Environment.GetEnvironmentVariable("FRAME_INSTALL_DIR");
        if (string.IsNullOrEmpty(InstallDir)) InstallDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Frame");
        BinDir = Path.Combine(InstallDir, "bin");
        foreach (var a in args) if (a == "--no-shortcuts") noShortcuts = true;

        bool created;
        var mutex = new Mutex(true, "Frame-Editor-Launcher-" + InstallDir.ToLowerInvariant().GetHashCode(), out created);
        if (!created) { FocusExisting(); return; }

        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        Application.ThreadException += (o, e) => { Log("UI error: " + e.Exception); MessageBox.Show("Frame hit an error: " + e.Exception.Message, "Frame", MessageBoxButtons.OK, MessageBoxIcon.Error); };
        AppDomain.CurrentDomain.UnhandledException += (o, e) => Log("Fatal: " + e.ExceptionObject);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        AppDomain.CurrentDomain.AssemblyResolve += ResolveFromBin;
        RefreshPath();
        try { EnsureInstalled(); ExtractNative(); }
        catch (Exception e) { MessageBox.Show("Frame could not be installed:\n\n" + e.Message, "Frame", MessageBoxButtons.OK, MessageBoxIcon.Error); return; }
        CheckFfmpeg();

        NativeMode = string.IsNullOrEmpty(Environment.GetEnvironmentVariable("FRAME_BROWSER_MODE")) && WebViewAvailable();
        Log("Start " + Assembly.GetExecutingAssembly().GetName().Version + " native=" + NativeMode);
        var t = new Thread(ServerLoop);
        t.IsBackground = true;
        t.Start();

        if (NativeMode) RunNative();
        else { SetupTray(); Application.Run(); }
        Quit();
        GC.KeepAlive(mutex);
    }

    static void FocusExisting()
    {
        try
        {
            var me = Process.GetCurrentProcess();
            foreach (var p in Process.GetProcessesByName(me.ProcessName))
            {
                if (p.Id == me.Id || p.MainWindowHandle == IntPtr.Zero) continue;
                ShowWindow(p.MainWindowHandle, 9); // SW_RESTORE
                SetForegroundWindow(p.MainWindowHandle);
                return;
            }
        }
        catch { }
        OpenBrowser();
    }

    // ---------- Native WebView2 support ----------
    static Assembly ResolveFromBin(object sender, ResolveEventArgs e)
    {
        string name = new AssemblyName(e.Name).Name + ".dll";
        string p = Path.Combine(BinDir, name);
        return File.Exists(p) ? Assembly.LoadFrom(p) : null;
    }

    static void ExtractNative()
    {
        Directory.CreateDirectory(BinDir);
        foreach (var name in new[] { "Microsoft.Web.WebView2.Core.dll", "Microsoft.Web.WebView2.WinForms.dll", "WebView2Loader.dll" })
        {
            using (var s = Assembly.GetExecutingAssembly().GetManifestResourceStream(name))
            {
                if (s == null) continue;
                string dest = Path.Combine(BinDir, name);
                if (File.Exists(dest) && new FileInfo(dest).Length == s.Length) continue;
                try { using (var f = File.Create(dest)) s.CopyTo(f); } catch { }
            }
        }
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    static bool WebViewAvailable()
    {
        try { return NativeHost.Available(); }
        catch { return false; }
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    static void RunNative()
    {
        var form = NativeHost.CreateWindow();
        MainWindow = form;
        Application.Run(form);
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

        // Keep the launcher inside the install folder so shortcuts survive the download being deleted.
        string self = Assembly.GetExecutingAssembly().Location;
        string target = Path.Combine(InstallDir, "Frame.exe");
        if (!string.Equals(Path.GetFullPath(self), Path.GetFullPath(target), StringComparison.OrdinalIgnoreCase))
        {
            try
            {
                if (File.Exists(target))
                {
                    string old = Path.Combine(InstallDir, "Frame.old.exe");
                    try { if (File.Exists(old)) File.Delete(old); } catch { }
                    try { File.Move(target, old); } catch { }
                }
                File.Copy(self, target, true);
            }
            catch { target = self; }
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
        bool first = !NativeMode && string.IsNullOrEmpty(Environment.GetEnvironmentVariable("FRAME_NO_BROWSER"));
        int quickExits = 0;
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
            Log("Server exited with code " + code);
            first = false;
            if (quitting) return;
            if (code == 42) { ShowTip("Frame updated", "Frame has been updated."); continue; }
            if (code != 0) MessageBox.Show("Frame stopped unexpectedly (code " + code + ").", "Frame", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            else
            {
                // Exit code 0 right away = the port was busy. Another copy may be serving it, or it was
                // still being released: wait, and start again if nobody answers.
                if (WaitForServer(2500)) { if (NativeMode) return; break; }
                if (++quickExits < 5) { Thread.Sleep(800); continue; }
                MessageBox.Show("Frame could not start because port " + Port + " is in use by another program.", "Frame", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
            break;
        }
        if (!quitting) Quit();
    }

    public static bool WaitForServer(int ms)
    {
        var until = DateTime.UtcNow.AddMilliseconds(ms);
        while (DateTime.UtcNow < until)
        {
            try { using (var c = new TcpClient()) { c.Connect("127.0.0.1", Port); return true; } }
            catch { Thread.Sleep(150); }
        }
        return false;
    }

    // ---------- Browser fallback (tray) ----------
    static void SetupTray()
    {
        tray = new NotifyIcon();
        try { tray.Icon = Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location); } catch { tray.Icon = SystemIcons.Application; }
        tray.Text = "Frame";
        var menu = new ContextMenuStrip();
        menu.Items.Add("Open Frame", null, delegate { OpenBrowser(); });
        menu.Items.Add("Open exports folder", null, delegate { OpenExports(); });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Quit Frame", null, delegate { Quit(); });
        tray.ContextMenuStrip = menu;
        tray.DoubleClick += delegate { OpenBrowser(); };
        tray.Visible = true;
    }

    static void ShowTip(string title, string text)
    {
        try { if (tray != null) tray.ShowBalloonTip(3000, title, text, ToolTipIcon.Info); } catch { }
    }

    public static void OpenExports()
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

    public static void Quit()
    {
        Log("Quit");
        if (quitting) return;
        quitting = true;
        try { if (server != null && !server.HasExited) server.Kill(); } catch { }
        try { if (tray != null) tray.Visible = false; } catch { }
        Environment.Exit(0);
    }
}

/// <summary>Everything that touches WebView2 types lives here so the assemblies load only after they are extracted.</summary>
static class NativeHost
{
    public static bool Available()
    {
        Microsoft.Web.WebView2.Core.CoreWebView2Environment.SetLoaderDllFolderPath(Program.BinDir);
        return !string.IsNullOrEmpty(Microsoft.Web.WebView2.Core.CoreWebView2Environment.GetAvailableBrowserVersionString());
    }

    public static Form CreateWindow() { return new FrameWindow(); }
}

class FrameWindow : Form
{
    readonly Microsoft.Web.WebView2.WinForms.WebView2 web;
    readonly Label loading;
    readonly string boundsFile;
    bool allowClose, closing, fullScreen;
    FormWindowState prevState;
    const string Url = "http://localhost:4719/";

    public FrameWindow()
    {
        Text = "Frame";
        try { Icon = Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location); } catch { }
        BackColor = Color.FromArgb(8, 9, 12);
        MinimumSize = new Size(1000, 640);
        StartPosition = FormStartPosition.CenterScreen;
        Size = new Size(1440, 900);
        boundsFile = Path.Combine(Program.InstallDir, "window.txt");
        RestoreBounds_();

        loading = new Label();
        loading.Text = "Starting Frame…";
        loading.ForeColor = Color.FromArgb(150, 155, 170);
        loading.BackColor = BackColor;
        loading.Font = new Font("Segoe UI", 13f);
        loading.TextAlign = ContentAlignment.MiddleCenter;
        loading.Dock = DockStyle.Fill;

        web = new Microsoft.Web.WebView2.WinForms.WebView2();
        web.Dock = DockStyle.Fill;
        web.DefaultBackgroundColor = BackColor;
        var props = new Microsoft.Web.WebView2.WinForms.CoreWebView2CreationProperties();
        props.UserDataFolder = Path.Combine(Program.InstallDir, "webview");
        web.CreationProperties = props;
        Controls.Add(web);
        Controls.Add(loading);
        loading.BringToFront();
        Load += OnLoadAsync;
        FormClosing += OnClosing;
    }

    void RestoreBounds_()
    {
        try
        {
            var p = File.ReadAllText(boundsFile).Split(',');
            var r = new Rectangle(int.Parse(p[0]), int.Parse(p[1]), int.Parse(p[2]), int.Parse(p[3]));
            bool visible = false;
            foreach (var s in Screen.AllScreens) if (s.WorkingArea.IntersectsWith(r)) visible = true;
            if (visible && r.Width >= 800 && r.Height >= 500) { StartPosition = FormStartPosition.Manual; Bounds = r; }
            WindowState = p.Length > 4 && p[4] == "1" ? FormWindowState.Maximized : FormWindowState.Normal;
        }
        catch { WindowState = FormWindowState.Maximized; }
    }

    void SaveBounds()
    {
        try
        {
            var r = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
            File.WriteAllText(boundsFile, r.X + "," + r.Y + "," + r.Width + "," + r.Height + "," + (WindowState == FormWindowState.Maximized ? "1" : "0"));
        }
        catch { }
    }

    async void OnLoadAsync(object sender, EventArgs e)
    {
        try
        {
            await web.EnsureCoreWebView2Async(null);
            var core = web.CoreWebView2;
            var s = core.Settings;
            bool dev = !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("FRAME_DEVTOOLS"));
            s.AreDevToolsEnabled = dev;
            s.IsStatusBarEnabled = false;
            s.IsZoomControlEnabled = false;
            s.AreBrowserAcceleratorKeysEnabled = dev;
            s.IsPasswordAutosaveEnabled = false;
            s.IsGeneralAutofillEnabled = false;
            s.IsPinchZoomEnabled = false;
            core.DocumentTitleChanged += delegate { Text = string.IsNullOrEmpty(core.DocumentTitle) ? "Frame" : core.DocumentTitle; };
            core.NewWindowRequested += (o, a) => { a.Handled = true; OpenExternal(a.Uri); };
            core.NavigationStarting += (o, a) => { if (!a.Uri.StartsWith(Url, StringComparison.OrdinalIgnoreCase) && !a.Uri.StartsWith("about:", StringComparison.OrdinalIgnoreCase)) { a.Cancel = true; OpenExternal(a.Uri); } };
            core.NavigationCompleted += (o, a) =>
            {
                if (a.IsSuccess) { loading.Visible = false; }
                else if (!closing) { loading.Text = "Starting Frame…"; loading.Visible = true; RetryLater(); }
            };
            core.PermissionRequested += (o, a) => { if (a.Uri.StartsWith(Url, StringComparison.OrdinalIgnoreCase)) a.State = Microsoft.Web.WebView2.Core.CoreWebView2PermissionState.Allow; };
            core.ContextMenuRequested += (o, a) => { if (!a.ContextMenuTarget.IsEditable && !dev) a.Handled = true; };
            core.ContainsFullScreenElementChanged += delegate { SetFullScreen(core.ContainsFullScreenElement); };
            core.ProcessFailed += delegate { if (!closing) web.Reload(); };
            core.WebMessageReceived += (o, a) =>
            {
                string msg = a.TryGetWebMessageAsString();
                if (msg == "flushed" && closing) { allowClose = true; BeginInvoke(new Action(Close)); }
                else if (msg == "open-exports") Program.OpenExports();
            };
            await Task.Run(() => Program.WaitForServer(30000));
            web.Source = new Uri(Url);
        }
        catch (Exception ex)
        {
            Program.Log("Window init failed: " + ex);
            loading.Text = "Frame could not start its window:\n" + ex.Message;
        }
    }

    async void RetryLater()
    {
        await Task.Run(() => Program.WaitForServer(30000));
        if (!closing && web.CoreWebView2 != null) web.Reload();
    }

    static void OpenExternal(string uri)
    {
        try { if (uri.StartsWith("http://", StringComparison.OrdinalIgnoreCase) || uri.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) Process.Start(uri); } catch { }
    }

    void SetFullScreen(bool on)
    {
        if (on == fullScreen) return;
        fullScreen = on;
        if (on) { prevState = WindowState; FormBorderStyle = FormBorderStyle.None; WindowState = FormWindowState.Normal; WindowState = FormWindowState.Maximized; }
        else { FormBorderStyle = FormBorderStyle.Sizable; WindowState = prevState; }
    }

    async void OnClosing(object sender, FormClosingEventArgs e)
    {
        if (allowClose || web.CoreWebView2 == null) { SaveBounds(); return; }
        e.Cancel = true;
        if (closing) return;
        closing = true;
        SaveBounds();
        // Let the page save open projects, then close (max 4 seconds).
        try
        {
            await web.CoreWebView2.ExecuteScriptAsync(
                "(async()=>{try{if(window.__frameFlush)await window.__frameFlush();}catch(e){} window.chrome.webview.postMessage('flushed');})()");
        }
        catch { allowClose = true; }
        await Task.Delay(4000);
        if (!allowClose) { allowClose = true; Close(); }
    }
}
