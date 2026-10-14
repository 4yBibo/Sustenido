using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Win32;

namespace Sustenido
{
    static class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            MainForm.Boot = Stopwatch.StartNew();
            Directory.CreateDirectory(MainForm.DataDir);
            // The browser runtime is the slowest part of startup: launch it first and overlap it with WinForms init.
            MainForm.EnvTask = CoreWebView2Environment.CreateAsync(null, Path.Combine(MainForm.DataDir, "WebView2"));
            var files = args.Where(a => !a.StartsWith("--")).Select(Path.GetFullPath).ToArray();
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            if (args.Contains("--new-window"))
            {
                Application.Run(new MainForm(files, primary: false));
                return;
            }

            using (var instance = new SingleInstance())
            {
                // Like Notepad: a second launch becomes a new tab in the window that is already open.
                if (!instance.IsPrimary && instance.TryForward(files)) return;
                var form = new MainForm(files, primary: instance.IsPrimary);
                if (instance.IsPrimary)
                    form.Shown += (s, e) => instance.Listen(paths => form.BeginInvoke(new Action(() => form.OpenFromOutside(paths))));
                Application.Run(form);
            }
        }
    }

    /// <summary>Per-user single instance: a named mutex elects the primary window, a named pipe forwards files to it.</summary>
    sealed class SingleInstance : IDisposable
    {
        static readonly SecurityIdentifier User = WindowsIdentity.GetCurrent().User;
        static readonly string Id = "Sustenido." + User.Value;
        readonly Mutex mutex;
        public bool IsPrimary { get; }

        public SingleInstance()
        {
            mutex = new Mutex(true, @"Local\" + Id, out bool created);
            IsPrimary = created;
        }

        public bool TryForward(string[] files)
        {
            try
            {
                using (var pipe = new NamedPipeClientStream(".", Id, PipeDirection.Out))
                {
                    pipe.Connect(3000);
                    AllowSetForegroundWindow(-1); // let the primary window come to the front
                    var bytes = Encoding.UTF8.GetBytes(string.Join("\n", files) + "\n");
                    pipe.Write(bytes, 0, bytes.Length);
                    pipe.Flush();
                }
                return true;
            }
            catch (Exception ex) when (ex is TimeoutException || ex is IOException || ex is UnauthorizedAccessException)
            {
                return false; // primary is unresponsive: open our own window rather than lose the request
            }
        }

        public void Listen(Action<string[]> onOpen)
        {
            var security = new PipeSecurity();
            security.AddAccessRule(new PipeAccessRule(User, PipeAccessRights.ReadWrite, AccessControlType.Allow));
            new Thread(() =>
            {
                while (true)
                {
                    try
                    {
                        using (var server = new NamedPipeServerStream(Id, PipeDirection.In, 1, PipeTransmissionMode.Byte, PipeOptions.None, 0, 0, security))
                        {
                            server.WaitForConnection();
                            using (var reader = new StreamReader(server, Encoding.UTF8))
                                onOpen(reader.ReadToEnd().Split(new[] { '\n' }, StringSplitOptions.RemoveEmptyEntries));
                        }
                    }
                    catch (IOException) { }
                    catch (InvalidOperationException) { return; } // window is gone
                }
            }) { IsBackground = true, Name = "Sustenido single instance" }.Start();
        }

        public void Dispose()
        {
            if (IsPrimary) mutex.ReleaseMutex();
            mutex.Dispose();
        }

        [DllImport("user32.dll")] static extern bool AllowSetForegroundWindow(int processId);
    }

    sealed class MainForm : Form
    {
        const string AppHost = "sustenido.app";
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
        static readonly Encoding StrictUtf8 = new UTF8Encoding(false, true);
        public static readonly string DataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Sustenido");
        static readonly string SessionFile = Path.Combine(DataDir, "session.json");
        static readonly string SettingsFile = Path.Combine(DataDir, "settings.json");
        public static Stopwatch Boot;
        public static Task<CoreWebView2Environment> EnvTask;
        static readonly string[] ImageExt = { ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".avif" };
        static readonly string[] OpenableExt = { ".md", ".markdown", ".txt", ".html", ".htm", ".pdf" };

        readonly WebView2 web = new WebView2 { Dock = DockStyle.Fill };
        readonly Dictionary<string, Func<Dictionary<string, object>, Task<object>>> handlers;
        // Note folders are served by the host itself (WebResourceRequested) as https://docs.sustenido.app/<index>/...
        const string DocHost = "docs.sustenido.app";
        readonly List<string> docFolders = new List<string>();
        readonly string[] launchFiles;
        readonly string settingsJson;
        // Acrylic needs Windows 11 22H2+ and the user's "Transparency effects" switch.
        readonly bool osGlass = Environment.OSVersion.Version.Build >= 22621 && TransparencyEnabled();
        readonly StringBuilder bootLog = new StringBuilder();
        bool dark, glass, pageLoaded, closeApproved;
        DateTime closeRequested;

        public bool Primary { get; }

        public MainForm(string[] files, bool primary)
        {
            launchFiles = files;
            Primary = primary;
            // Settings are read before the window exists, so it opens in the right theme, color and icon — no flash.
            var prefs = LoadSettings();
            settingsJson = prefs.Count > 0 ? Json.Serialize(prefs) : "null"; // null = first run: the page seeds the file
            var theme = prefs.TryGetValue("theme", out var t) ? t as string : null;
            dark = theme == "dark" || (theme != "light" && IsSystemDark());
            glass = osGlass && !(prefs.TryGetValue("glass", out var g) && g is bool wantGlass && !wantGlass);
            Text = "Sustenido";
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            SetAccentIcon(prefs.TryGetValue("accent", out var accent) ? accent as string : null);
            var area = Screen.PrimaryScreen.WorkingArea;
            Size = new Size((int)(area.Width * 0.62), (int)(area.Height * 0.86));
            MinimumSize = new Size(560, 420);
            StartPosition = FormStartPosition.CenterScreen;
            ApplyChrome(dark, glass, null);
            Controls.Add(web);

            handlers = new Dictionary<string, Func<Dictionary<string, object>, Task<object>>>
            {
                ["init"] = m => Done(new { primary = Primary, glass = osGlass, session = Primary ? ReadSession() : null, files = launchFiles }),
                ["writeSettings"] = m => { WriteAtomic(SettingsFile, Encoding.UTF8.GetBytes(Str(m, "json") ?? "{}")); return Done(null); },
                ["ready"] = m =>
                {
                    Mark("ready");
                    bootLog.Append("js ").Append(m.TryGetValue("js", out var js) ? js : "?").Append("ms");
                    try { File.WriteAllText(Path.Combine(DataDir, "startup.log"), bootLog.ToString()); } catch (IOException) { }
                    return Done(null);
                },
                ["read"] = m => Done(Read(Str(m, "path"))),
                ["pickOpen"] = m => Done(PickOpen(Str(m, "dir"))),
                ["save"] = m => Done(Save(m)),
                ["confirmClose"] = m => Done(ConfirmClose(Str(m, "name"))),
                ["writeSession"] = m => Done(WriteSession(Str(m, "json"))),
                ["closingAck"] = m => { closeRequested = default; return Done(null); },
                ["closeWindow"] = m => { closeApproved = true; BeginInvoke(new Action(Close)); return Done(null); },
                ["list"] = m => Done(List(Str(m, "dir"))),
                ["pickFolder"] = m => Done(PickFolder(Str(m, "start"))),
                ["resolveLink"] = m => Done(ResolveLink(Str(m, "href"), Str(m, "from"), Str(m, "root"))),
                ["export"] = Export,
                ["attachImage"] = m => Done(AttachImage(m)),
                ["pickImage"] = m => Done(PickImage(Str(m, "doc"))),
                ["rename"] = m => Done(Rename(Str(m, "path"), Str(m, "name"))),
                ["theme"] = m => { ApplyChrome((bool)m["dark"], Flag(m, "glass"), Str(m, "chrome")); return Done(null); },
                ["emoji"] = m => { OpenEmojiPanel(); return Done(null); },
                ["newWindow"] = m => { Process.Start(Application.ExecutablePath, "--new-window"); return Done(null); },
                ["title"] = m => { Text = Str(m, "text"); return Done(null); },
                ["icon"] = m => { SetAccentIcon(Str(m, "accent")); return Done(null); },
                ["reveal"] = m => { Reveal(Str(m, "path")); return Done(null); },
            };

            Load += async (s, e) => await InitAsync();
        }

        static Task<object> Done(object value) => Task.FromResult(value);
        void Mark(string phase) => bootLog.Append(phase).Append(' ').Append(Boot.ElapsedMilliseconds).Append("ms  ");

        static Dictionary<string, object> LoadSettings()
        {
            try
            {
                if (File.Exists(SettingsFile)) return Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(SettingsFile, Encoding.UTF8)) ?? new Dictionary<string, object>();
            }
            catch (Exception ex) when (ex is IOException || ex is ArgumentException || ex is InvalidOperationException) { }
            return new Dictionary<string, object>();
        }
        static string Str(Dictionary<string, object> m, string key) => m.TryGetValue(key, out var v) ? v as string : null;
        static bool Flag(Dictionary<string, object> m, string key) => m.TryGetValue(key, out var v) && v is bool b && b;

        async Task InitAsync()
        {
            CoreWebView2 core;
            try
            {
                var env = await EnvTask;
                Mark("env");
                await web.EnsureCoreWebView2Async(env);
                Mark("webview");
                core = web.CoreWebView2;
                // Settings are injected before any page script runs: no round trip, no flash of the default theme.
                await core.AddScriptToExecuteOnDocumentCreatedAsync("window.__sustenido={settings:" + settingsJson + "}");
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "Não foi possível iniciar o componente de navegador (WebView2).\n\n" + ex.Message, "Sustenido", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsZoomControlEnabled = false; // the app zooms text itself, like Notepad
            core.Settings.IsGeneralAutofillEnabled = false;
            core.Settings.IsPasswordAutosaveEnabled = false;
            core.SetVirtualHostNameToFolderMapping(AppHost, Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "web"), CoreWebView2HostResourceAccessKind.Deny);
            core.AddWebResourceRequestedFilter($"https://{DocHost}/*", CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += OnDocResource;
            core.NavigationStarting += OnNavigationStarting;
            core.NavigationCompleted += (s, e) => { pageLoaded = true; Mark("page"); };
            core.NewWindowRequested += (s, e) => { e.Handled = true; OpenExternal(e.Uri); };
            core.PermissionRequested += (s, e) =>
            {
                if (e.PermissionKind == CoreWebView2PermissionKind.ClipboardRead && e.Uri.StartsWith($"https://{AppHost}/"))
                    e.State = CoreWebView2PermissionState.Allow;
            };
            core.WebMessageReceived += OnMessage;
            core.Navigate($"https://{AppHost}/index.html");
        }

        async void OnMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            Dictionary<string, object> m;
            try { m = Json.Deserialize<Dictionary<string, object>>(e.WebMessageAsJson); }
            catch (ArgumentException) { return; }
            var type = Str(m, "type") ?? "";
            m.TryGetValue("rid", out var rid);
            object result = null;
            string error = null;
            try
            {
                if (type == "drop") result = e.AdditionalObjects.OfType<CoreWebView2File>().Select(f => f.Path).ToArray();
                else if (handlers.TryGetValue(type, out var handler)) result = await handler(m);
                else error = "Mensagem desconhecida: " + type;
            }
            catch (Exception ex) { error = ex.Message; }
            if (rid != null) Post(new { type = "reply", rid, result, error });
        }

        void Post(object message) => web.CoreWebView2?.PostWebMessageAsJson(Json.Serialize(message));

        public void OpenFromOutside(string[] paths)
        {
            Post(new { type = "open", paths });
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Activate();
            SetForegroundWindow(Handle);
        }

        // ── Documents ───────────────────────────────────

        object Read(string path)
        {
            path = Path.GetFullPath(path);
            var dir = Path.GetDirectoryName(path);
            var ext = Path.GetExtension(path).ToLowerInvariant();
            var bytes = File.ReadAllBytes(path);
            if (ext == ".pdf" || ext == ".html" || ext == ".htm")
            {
                return new
                {
                    kind = "import", name = Path.GetFileNameWithoutExtension(path), dir,
                    format = ext == ".pdf" ? "pdf" : "html", data = Convert.ToBase64String(bytes), @base = MapFolder(dir),
                };
            }
            var (text, encoding) = Decode(bytes);
            var eol = text.Contains("\r\n") ? "crlf" : text.Contains("\n") ? "lf" : "crlf";
            return new
            {
                kind = "doc", path, name = Path.GetFileNameWithoutExtension(path), dir,
                text = text.Replace("\r\n", "\n").Replace('\r', '\n'), encoding, eol, @base = MapFolder(dir),
            };
        }

        static (string, string) Decode(byte[] b)
        {
            if (b.Length >= 3 && b[0] == 0xEF && b[1] == 0xBB && b[2] == 0xBF) return (StrictUtf8.GetString(b, 3, b.Length - 3), "utf-8-bom");
            if (b.Length >= 2 && b[0] == 0xFF && b[1] == 0xFE) return (Encoding.Unicode.GetString(b, 2, b.Length - 2), "utf-16le");
            if (b.Length >= 2 && b[0] == 0xFE && b[1] == 0xFF) return (Encoding.BigEndianUnicode.GetString(b, 2, b.Length - 2), "utf-16be");
            try { return (StrictUtf8.GetString(b), "utf-8"); }
            catch (DecoderFallbackException) { return (Encoding.Default.GetString(b), "ansi"); } // legacy files keep their code page
        }

        static Encoding EncodingFor(string name)
        {
            switch (name)
            {
                case "utf-8-bom": return new UTF8Encoding(true);
                case "utf-16le": return new UnicodeEncoding(false, true);
                case "utf-16be": return new UnicodeEncoding(true, true);
                case "ansi": return Encoding.GetEncoding(Encoding.Default.CodePage, EncoderFallback.ExceptionFallback, DecoderFallback.ReplacementFallback);
                default: return new UTF8Encoding(false);
            }
        }

        string[] PickOpen(string dir)
        {
            using (var dialog = new OpenFileDialog
            {
                Multiselect = true,
                Filter = "Documentos (*.md;*.txt;*.html;*.pdf)|*.md;*.markdown;*.txt;*.html;*.htm;*.pdf|Markdown (*.md)|*.md;*.markdown|Texto (*.txt)|*.txt|HTML (*.html)|*.html;*.htm|PDF (*.pdf)|*.pdf|Todos os arquivos (*.*)|*.*",
            })
            {
                if (Directory.Exists(dir)) dialog.InitialDirectory = dir;
                return dialog.ShowDialog(this) == DialogResult.OK ? dialog.FileNames : null;
            }
        }

        object Save(Dictionary<string, object> m)
        {
            var path = Str(m, "path");
            var text = Str(m, "text") ?? "";
            var encodingName = Str(m, "encoding") ?? "utf-8";
            var eol = Str(m, "eol") ?? "crlf";

            if (path == null || Flag(m, "saveAs"))
            {
                using (var dialog = new SaveFileDialog { Filter = "Markdown (*.md)|*.md|Texto (*.txt)|*.txt|Todos os arquivos (*.*)|*.*", DefaultExt = "md" })
                {
                    var name = Str(m, "name") ?? "Sem título";
                    dialog.FileName = path != null ? Path.GetFileName(path) : name + ".md";
                    var dir = path != null ? Path.GetDirectoryName(path) : Str(m, "dir");
                    if (Directory.Exists(dir)) dialog.InitialDirectory = dir;
                    if (dialog.ShowDialog(this) != DialogResult.OK) return null;
                    path = dialog.FileName;
                }
            }

            var encoding = EncodingFor(encodingName);
            if (encodingName == "ansi" && !CanEncode(encoding, text))
            {
                var answer = MessageBox.Show(this,
                    "Este texto tem caracteres que não existem em ANSI e seriam perdidos.\n\nSalvar em UTF-8?",
                    "Sustenido", MessageBoxButtons.OKCancel, MessageBoxIcon.Warning);
                if (answer != DialogResult.OK) return null;
                encodingName = "utf-8";
                encoding = EncodingFor(encodingName);
            }

            WriteAtomic(path, eol == "crlf" ? text.Replace("\n", "\r\n") : text, encoding);
            var folder = Path.GetDirectoryName(path);
            return new { path, name = Path.GetFileNameWithoutExtension(path), dir = folder, encoding = encodingName, @base = MapFolder(folder) };
        }

        static bool CanEncode(Encoding encoding, string text)
        {
            try { encoding.GetByteCount(text); return true; }
            catch (EncoderFallbackException) { return false; }
        }

        // Write-then-swap: a crash or a full disk mid-save never leaves a truncated file behind.
        static void WriteAtomic(string path, string text, Encoding encoding) => WriteAtomic(path, encoding.GetPreamble().Concat(encoding.GetBytes(text)).ToArray());

        static void WriteAtomic(string path, byte[] bytes)
        {
            var tmp = path + ".sustenido-tmp";
            try
            {
                File.WriteAllBytes(tmp, bytes);
                if (File.Exists(path)) File.Replace(tmp, path, null);
                else File.Move(tmp, path);
            }
            catch
            {
                try { File.Delete(tmp); } catch (IOException) { }
                throw;
            }
        }

        string ConfirmClose(string name)
        {
            var answer = MessageBox.Show(this, $"Deseja salvar as alterações em \"{name}\"?", "Sustenido", MessageBoxButtons.YesNoCancel, MessageBoxIcon.Warning);
            return answer == DialogResult.Yes ? "save" : answer == DialogResult.No ? "discard" : "cancel";
        }

        object Rename(string path, string name)
        {
            name = name?.Trim();
            if (string.IsNullOrEmpty(name) || name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || name.EndsWith("."))
                throw new ArgumentException("Nome inválido. Evite os caracteres \\ / : * ? \" < > |");
            var dir = Path.GetDirectoryName(path);
            var target = Path.Combine(dir, name + Path.GetExtension(path));
            if (File.Exists(target) && !string.Equals(target, path, StringComparison.OrdinalIgnoreCase))
                throw new IOException($"Já existe uma nota chamada \"{name}\" nesta pasta.");
            File.Move(path, target);
            return new { path = target, name, dir, @base = MapFolder(dir) };
        }

        // ── Session ─────────────────────────────────────

        static string ReadSession()
        {
            try { return File.Exists(SessionFile) ? File.ReadAllText(SessionFile, Encoding.UTF8) : null; }
            catch (IOException) { return null; }
        }

        object WriteSession(string json)
        {
            if (Primary && json != null) WriteAtomic(SessionFile, Encoding.UTF8.GetBytes(json));
            return null;
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            base.OnFormClosing(e);
            if (closeApproved || !pageLoaded || e.CloseReason == CloseReason.WindowsShutDown || e.CloseReason == CloseReason.TaskManagerClosing) return;
            // The page normally acknowledges at once; if it never did, a later close must not trap the user.
            if (closeRequested != default && (DateTime.Now - closeRequested).TotalSeconds > 4) return;
            e.Cancel = true;
            closeRequested = DateTime.Now;
            Post(new { type = "closing" });
        }

        // ── Folders & links ─────────────────────────────

        string MapFolder(string dir)
        {
            if (string.IsNullOrEmpty(dir)) return null;
            int i = docFolders.FindIndex(d => string.Equals(d, dir, StringComparison.OrdinalIgnoreCase));
            if (i < 0) { docFolders.Add(dir); i = docFolders.Count - 1; }
            return $"https://{DocHost}/{i}/";
        }

        // Serves a note's relative images/attachments. Paths are confined to the note's folder: a note cannot read
        // files elsewhere on disk, and nothing served here can run (CSP), only be displayed.
        void OnDocResource(object sender, CoreWebView2WebResourceRequestedEventArgs e)
        {
            var env = web.CoreWebView2.Environment;
            try
            {
                var segments = new Uri(e.Request.Uri).AbsolutePath.Split(new[] { '/' }, 2, StringSplitOptions.RemoveEmptyEntries);
                if (segments.Length == 2 && int.TryParse(segments[0], out var i) && i >= 0 && i < docFolders.Count)
                {
                    var root = Path.GetFullPath(docFolders[i]).TrimEnd('\\') + "\\";
                    var file = Path.GetFullPath(Path.Combine(root, Uri.UnescapeDataString(segments[1]).Replace('/', '\\')));
                    if (file.StartsWith(root, StringComparison.OrdinalIgnoreCase) && File.Exists(file))
                    {
                        e.Response = env.CreateWebResourceResponse(new MemoryStream(File.ReadAllBytes(file)), 200, "OK", "Content-Type: " + MimeOf(file));
                        return;
                    }
                }
            }
            catch (Exception ex) when (ex is IOException || ex is UriFormatException || ex is ArgumentException || ex is UnauthorizedAccessException) { }
            e.Response = env.CreateWebResourceResponse(null, 404, "Not Found", "");
        }

        static string MimeOf(string file)
        {
            switch (Path.GetExtension(file).ToLowerInvariant())
            {
                case ".png": return "image/png";
                case ".jpg": case ".jpeg": return "image/jpeg";
                case ".gif": return "image/gif";
                case ".webp": return "image/webp";
                case ".svg": return "image/svg+xml";
                case ".bmp": return "image/bmp";
                case ".avif": return "image/avif";
                case ".mp4": return "video/mp4";
                case ".webm": return "video/webm";
                case ".mp3": return "audio/mpeg";
                case ".wav": return "audio/wav";
                case ".pdf": return "application/pdf";
                default: return "application/octet-stream";
            }
        }

        static bool SkipFolder(DirectoryInfo d) =>
            d.Name.StartsWith(".") || d.Name == "node_modules" || (d.Attributes & (FileAttributes.Hidden | FileAttributes.System)) != 0;

        static bool IsNote(string file)
        {
            var ext = Path.GetExtension(file).ToLowerInvariant();
            return ext == ".md" || ext == ".markdown";
        }

        static object List(string dir)
        {
            var di = new DirectoryInfo(dir);
            var folders = new List<DirectoryInfo>();
            var notes = new List<FileInfo>();
            try
            {
                if (di.Exists)
                {
                    folders.AddRange(di.EnumerateDirectories().Where(d => !SkipFolder(d)));
                    notes.AddRange(di.EnumerateFiles().Where(f => IsNote(f.Name) && (f.Attributes & FileAttributes.Hidden) == 0));
                }
            }
            catch (UnauthorizedAccessException) { }
            catch (IOException) { }
            int Natural(string a, string b) => StrCmpLogicalW(a, b); // Explorer ordering: "Nota 2" before "Nota 10"
            folders.Sort((a, b) => Natural(a.Name, b.Name));
            notes.Sort((a, b) => Natural(a.Name, b.Name));
            return folders.Select(d => new { name = d.Name, path = d.FullName, dir = true })
                .Concat(notes.Select(f => new { name = Path.GetFileNameWithoutExtension(f.Name), path = f.FullName, dir = false }))
                .ToArray();
        }

        object ResolveLink(string href, string from, string root)
        {
            if (string.IsNullOrEmpty(href)) return null;
            if (Uri.TryCreate(href, UriKind.Absolute, out var uri) && !uri.IsFile)
            {
                OpenExternal(href);
                return null;
            }
            if (from == null) return null;
            var relative = Uri.UnescapeDataString(href.Split('#')[0]).Replace('/', '\\');
            if (relative.Length == 0) return null;

            string target;
            try { target = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(from), relative)); }
            catch (ArgumentException) { return null; }

            if (File.Exists(target))
            {
                if (OpenableExt.Contains(Path.GetExtension(target).ToLowerInvariant())) return new { path = target };
                Reveal(target); // never execute: a link in a note must not be able to launch a program
                return null;
            }
            if (IsNote(target) && root != null)
            {
                // Obsidian resolves [[Nota]] anywhere in the vault, not only next to the current note.
                var found = File.Exists(Path.Combine(root, relative)) ? Path.Combine(root, relative) : FindByName(root, Path.GetFileName(relative));
                if (found != null) return new { path = found };
            }
            return new { missing = Path.GetFileNameWithoutExtension(relative) };
        }

        static string FindByName(string root, string fileName)
        {
            var queue = new Queue<DirectoryInfo>();
            queue.Enqueue(new DirectoryInfo(root));
            for (int visited = 0; queue.Count > 0 && visited < 20000; visited++)
            {
                var dir = queue.Dequeue();
                try
                {
                    var candidate = Path.Combine(dir.FullName, fileName);
                    if (File.Exists(candidate)) return candidate;
                    foreach (var sub in dir.EnumerateDirectories()) if (!SkipFolder(sub)) queue.Enqueue(sub);
                }
                catch (UnauthorizedAccessException) { }
                catch (IOException) { }
            }
            return null;
        }

        void OnNavigationStarting(object sender, CoreWebView2NavigationStartingEventArgs e)
        {
            // Only the first load of the app is allowed: no reloads (state lives in the page), no navigating away.
            if (!pageLoaded && e.Uri.StartsWith($"https://{AppHost}/", StringComparison.OrdinalIgnoreCase)) return;
            e.Cancel = true;
            if (Uri.TryCreate(e.Uri, UriKind.Absolute, out var uri) && uri.IsFile && OpenableExt.Contains(Path.GetExtension(uri.LocalPath).ToLowerInvariant()))
                Post(new { type = "open", paths = new[] { uri.LocalPath } });
        }

        static void OpenExternal(string href)
        {
            if (Uri.TryCreate(href, UriKind.Absolute, out var uri) && (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps || uri.Scheme == Uri.UriSchemeMailto))
                Process.Start(uri.AbsoluteUri);
        }

        static void Reveal(string path)
        {
            if (File.Exists(path) || Directory.Exists(path)) Process.Start("explorer.exe", $"/select,\"{path}\"");
        }

        string PickFolder(string start)
        {
            var dialog = (IFileOpenDialog)new FileOpenDialogCom();
            try
            {
                dialog.SetOptions(FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
                dialog.SetTitle("Escolher pasta de notas");
                if (Directory.Exists(start))
                {
                    SHCreateItemFromParsingName(start, IntPtr.Zero, typeof(IShellItem).GUID, out var folder);
                    dialog.SetFolder(folder);
                }
                if (dialog.Show(Handle) != 0) return null; // cancelled
                dialog.GetResult(out var item);
                item.GetDisplayName(SIGDN_FILESYSPATH, out var path);
                return path;
            }
            finally { Marshal.ReleaseComObject(dialog); }
        }

        // ── Images ──────────────────────────────────────

        string AttachImage(Dictionary<string, object> m)
        {
            var doc = Str(m, "doc") ?? throw new InvalidOperationException("Salve a nota antes de inserir imagens.");
            var docDir = Path.GetDirectoryName(doc);
            var attachments = Path.Combine(docDir, "attachments");
            var source = Str(m, "source");
            string target;
            if (source != null)
            {
                if (!ImageExt.Contains(Path.GetExtension(source).ToLowerInvariant())) throw new ArgumentException("Formato de imagem não suportado.");
                if (IsInside(source, docDir)) target = source;
                else
                {
                    Directory.CreateDirectory(attachments);
                    target = Unique(Path.Combine(attachments, Path.GetFileName(source)));
                    File.Copy(source, target);
                }
            }
            else
            {
                var ext = "." + (Str(m, "ext") ?? "png").ToLowerInvariant();
                if (!ImageExt.Contains(ext)) ext = ".png";
                Directory.CreateDirectory(attachments);
                target = Unique(Path.Combine(attachments, $"Imagem {DateTime.Now:yyyy-MM-dd HH.mm.ss}{ext}"));
                File.WriteAllBytes(target, Convert.FromBase64String(Str(m, "data")));
            }
            var rel = new Uri(docDir.TrimEnd('\\') + "\\").MakeRelativeUri(new Uri(target));
            return Uri.UnescapeDataString(rel.ToString());
        }

        string PickImage(string doc)
        {
            if (doc == null) throw new InvalidOperationException("Salve a nota antes de inserir imagens.");
            using (var dialog = new OpenFileDialog { Filter = "Imagens|*.png;*.jpg;*.jpeg;*.gif;*.webp;*.svg;*.bmp;*.avif" })
            {
                dialog.InitialDirectory = Path.GetDirectoryName(doc);
                if (dialog.ShowDialog(this) != DialogResult.OK) return null;
                return AttachImage(new Dictionary<string, object> { ["doc"] = doc, ["source"] = dialog.FileName });
            }
        }

        static bool IsInside(string file, string dir) =>
            Path.GetFullPath(file).StartsWith(Path.GetFullPath(dir).TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase);

        static string Unique(string path)
        {
            var dir = Path.GetDirectoryName(path);
            var name = Path.GetFileNameWithoutExtension(path);
            var ext = Path.GetExtension(path);
            for (int i = 2; File.Exists(path); i++) path = Path.Combine(dir, $"{name} {i}{ext}");
            return path;
        }

        // ── Export ──────────────────────────────────────

        async Task<object> Export(Dictionary<string, object> m)
        {
            var format = Str(m, "format");
            string filter;
            switch (format)
            {
                case "pdf": filter = "PDF (*.pdf)|*.pdf"; break;
                case "docx": filter = "Documento do Word (*.docx)|*.docx"; break;
                case "html": filter = "Página da web (*.html)|*.html"; break;
                default: format = "md"; filter = "Markdown (*.md)|*.md"; break;
            }
            string target;
            using (var dialog = new SaveFileDialog { Filter = filter, DefaultExt = format, FileName = (Str(m, "name") ?? "Sem título") + "." + format })
            {
                var dir = Str(m, "dir");
                if (Directory.Exists(dir)) dialog.InitialDirectory = dir;
                if (dialog.ShowDialog(this) != DialogResult.OK) return null;
                target = dialog.FileName;
            }

            switch (format)
            {
                case "pdf":
                    var settings = web.CoreWebView2.Environment.CreatePrintSettings();
                    settings.ShouldPrintHeaderAndFooter = false;
                    settings.ShouldPrintBackgrounds = true;
                    settings.MarginTop = settings.MarginBottom = 0.8;
                    settings.MarginLeft = settings.MarginRight = 0.9;
                    if (!await web.CoreWebView2.PrintToPdfAsync(target, settings)) throw new IOException("O mecanismo de impressão não gerou o PDF.");
                    break;
                case "docx":
                    WriteAtomic(target, Convert.FromBase64String(Str(m, "data")));
                    break;
                case "html":
                    WriteAtomic(target, Str(m, "html"), new UTF8Encoding(false));
                    break;
                default:
                    var text = Str(m, "text") ?? "";
                    WriteAtomic(target, Str(m, "eol") == "lf" ? text : text.Replace("\n", "\r\n"), EncodingFor(Str(m, "encoding")));
                    break;
            }
            return target;
        }

        // ── Window chrome ───────────────────────────────

        Color SolidBackground() => dark ? Color.FromArgb(24, 22, 28) : Color.FromArgb(246, 241, 247);

        /// <summary>Window frame follows the page: dark/light, acrylic on/off, and a title bar that is never the system gray.</summary>
        /// <param name="chrome">The page's solid chrome color as "r,g,b", or null before the page reports it.</param>
        void ApplyChrome(bool isDark, bool glassOn, string chrome)
        {
            dark = isDark;
            glass = osGlass && glassOn;
            var solid = ParseRgb(chrome) ?? SolidBackground();
            BackColor = glass ? Color.Black : solid;
            web.DefaultBackgroundColor = glass ? Color.Transparent : solid;
            if (!IsHandleCreated) return;
            int on = dark ? 1 : 0;
            DwmSetWindowAttribute(Handle, DWMWA_USE_IMMERSIVE_DARK_MODE, ref on, sizeof(int));
            if (Environment.OSVersion.Version.Build < 22000) return;
            int backdrop = glass ? DWMSBT_TRANSIENTWINDOW : DWMSBT_NONE;
            DwmSetWindowAttribute(Handle, DWMWA_SYSTEMBACKDROP_TYPE, ref backdrop, sizeof(int));
            // Title bar: transparent over the glass, or painted in the page's own chrome color.
            int caption = glass ? DWMWA_COLOR_NONE : ColorRef(solid);
            DwmSetWindowAttribute(Handle, DWMWA_CAPTION_COLOR, ref caption, sizeof(int));
            int text = dark ? 0x00F2F2F2 : 0x001F1D1D;
            DwmSetWindowAttribute(Handle, DWMWA_TEXT_COLOR, ref text, sizeof(int));
        }

        static Color? ParseRgb(string rgb)
        {
            var parts = rgb?.Split(',');
            if (parts?.Length != 3) return null;
            try { return Color.FromArgb(int.Parse(parts[0]), int.Parse(parts[1]), int.Parse(parts[2])); }
            catch (Exception ex) when (ex is FormatException || ex is ArgumentException) { return null; }
        }

        static int ColorRef(Color c) => c.R | (c.G << 8) | (c.B << 16);

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            if (osGlass)
            {
                // Acrylic behind the whole window; the page paints its own translucent tint over it.
                var margins = new MARGINS { Left = -1, Right = -1, Top = -1, Bottom = -1 };
                DwmExtendFrameIntoClientArea(Handle, ref margins);
            }
            ApplyChrome(dark, glass, null);
        }

        // Window and taskbar icon follow the accent color (icons\<accent>.ico ships next to the exe).
        void SetAccentIcon(string accent)
        {
            if (accent == null || !System.Text.RegularExpressions.Regex.IsMatch(accent, "^[a-z]+$")) return;
            var file = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "icons", accent + ".ico");
            if (File.Exists(file)) Icon = new Icon(file);
        }

        void OpenEmojiPanel()
        {
            web.Focus();
            keybd_event(VK_LWIN, 0, 0, UIntPtr.Zero);
            keybd_event(VK_OEM_PERIOD, 0, 0, UIntPtr.Zero);
            keybd_event(VK_OEM_PERIOD, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
            keybd_event(VK_LWIN, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
        }

        static bool IsSystemDark() =>
            Registry.GetValue(@"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", "AppsUseLightTheme", 1) is int light && light == 0;

        static bool TransparencyEnabled() =>
            !(Registry.GetValue(@"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", "EnableTransparency", 1) is int on && on == 0);

        // ── Win32 ───────────────────────────────────────

        const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20, DWMWA_CAPTION_COLOR = 35, DWMWA_TEXT_COLOR = 36, DWMWA_SYSTEMBACKDROP_TYPE = 38;
        const int DWMSBT_NONE = 1, DWMSBT_TRANSIENTWINDOW = 3;
        const int DWMWA_COLOR_NONE = unchecked((int)0xFFFFFFFE);
        const byte VK_LWIN = 0x5B, VK_OEM_PERIOD = 0xBE;
        const uint KEYEVENTF_KEYUP = 2;
        const uint FOS_PICKFOLDERS = 0x20, FOS_FORCEFILESYSTEM = 0x40, FOS_PATHMUSTEXIST = 0x800;
        const uint SIGDN_FILESYSPATH = 0x80058000;

        [StructLayout(LayoutKind.Sequential)] struct MARGINS { public int Left, Right, Top, Bottom; }

        [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);
        [DllImport("dwmapi.dll")] static extern int DwmExtendFrameIntoClientArea(IntPtr hwnd, ref MARGINS margins);
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
        [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
        [DllImport("shlwapi.dll", CharSet = CharSet.Unicode)] static extern int StrCmpLogicalW(string a, string b);
        [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
        static extern void SHCreateItemFromParsingName(string path, IntPtr bindContext, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IShellItem item);

        [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialogCom { }

        // IFileDialog vtable prefix, in declaration order (only the members up to GetResult are needed).
        [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IFileOpenDialog
        {
            [PreserveSig] int Show(IntPtr parent);
            void SetFileTypes(uint count, IntPtr specs);
            void SetFileTypeIndex(uint index);
            void GetFileTypeIndex(out uint index);
            void Advise(IntPtr sink, out uint cookie);
            void Unadvise(uint cookie);
            void SetOptions(uint options);
            void GetOptions(out uint options);
            void SetDefaultFolder(IShellItem item);
            void SetFolder(IShellItem item);
            void GetFolder(out IShellItem item);
            void GetCurrentSelection(out IShellItem item);
            void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
            void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
            void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
            void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
            void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
            void GetResult(out IShellItem item);
        }

        [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IShellItem
        {
            void BindToHandler(IntPtr bindContext, ref Guid handler, ref Guid riid, out IntPtr result);
            void GetParent(out IShellItem parent);
            void GetDisplayName(uint type, [MarshalAs(UnmanagedType.LPWStr)] out string name);
            void GetAttributes(uint mask, out uint attributes);
            void Compare(IShellItem other, uint hint, out int order);
        }
    }
}
