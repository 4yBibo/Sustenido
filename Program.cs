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
        static readonly string DataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Sustenido");
        static readonly string SessionFile = Path.Combine(DataDir, "session.json");
        static readonly string[] ImageExt = { ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".avif" };
        static readonly string[] OpenableExt = { ".md", ".markdown", ".txt", ".html", ".htm", ".pdf" };

        readonly WebView2 web = new WebView2 { Dock = DockStyle.Fill };
        readonly Dictionary<string, Func<Dictionary<string, object>, Task<object>>> handlers;
        readonly Dictionary<string, string> folderHosts = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        readonly string[] launchFiles;
        // Acrylic needs Windows 11 22H2+ and the user's "Transparency effects" switch.
        readonly bool glass = Environment.OSVersion.Version.Build >= 22621 && TransparencyEnabled();
        bool dark = IsSystemDark(), pageLoaded, closeApproved;
        DateTime closeRequested;

        public bool Primary { get; }

        public MainForm(string[] files, bool primary)
        {
            launchFiles = files;
            Primary = primary;
            Text = "Sustenido";
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            var area = Screen.PrimaryScreen.WorkingArea;
            Size = new Size((int)(area.Width * 0.62), (int)(area.Height * 0.86));
            MinimumSize = new Size(560, 420);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = glass ? Color.Black : SolidBackground();
            web.DefaultBackgroundColor = glass ? Color.Transparent : BackColor;
            Controls.Add(web);

            handlers = new Dictionary<string, Func<Dictionary<string, object>, Task<object>>>
            {
                ["init"] = m => Done(new { primary = Primary, glass, session = Primary ? ReadSession() : null, files = launchFiles }),
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
                ["theme"] = m => { ApplyTheme((bool)m["dark"]); return Done(null); },
                ["emoji"] = m => { OpenEmojiPanel(); return Done(null); },
                ["newWindow"] = m => { Process.Start(Application.ExecutablePath, "--new-window"); return Done(null); },
                ["title"] = m => { Text = Str(m, "text"); return Done(null); },
                ["icon"] = m => { SetAccentIcon(Str(m, "accent")); return Done(null); },
                ["reveal"] = m => { Reveal(Str(m, "path")); return Done(null); },
            };

            Load += async (s, e) => await InitAsync();
        }

        static Task<object> Done(object value) => Task.FromResult(value);
        static string Str(Dictionary<string, object> m, string key) => m.TryGetValue(key, out var v) ? v as string : null;
        static bool Flag(Dictionary<string, object> m, string key) => m.TryGetValue(key, out var v) && v is bool b && b;

        async Task InitAsync()
        {
            Directory.CreateDirectory(DataDir);
            var env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(DataDir, "WebView2"));
            await web.EnsureCoreWebView2Async(env);
            var core = web.CoreWebView2;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsZoomControlEnabled = false; // the app zooms text itself, like Notepad
            core.Settings.IsGeneralAutofillEnabled = false;
            core.Settings.IsPasswordAutosaveEnabled = false;
            core.SetVirtualHostNameToFolderMapping(AppHost, Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "web"), CoreWebView2HostResourceAccessKind.Deny);
            core.NavigationStarting += OnNavigationStarting;
            core.NavigationCompleted += (s, e) => pageLoaded = true;
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
            if (string.IsNullOrEmpty(dir) || web.CoreWebView2 == null) return null;
            if (!folderHosts.TryGetValue(dir, out var host))
            {
                host = $"d{folderHosts.Count + 1}.sustenido";
                web.CoreWebView2.SetVirtualHostNameToFolderMapping(host, dir, CoreWebView2HostResourceAccessKind.DenyCors);
                folderHosts[dir] = host;
            }
            return $"https://{host}/";
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

        void ApplyTheme(bool isDark)
        {
            dark = isDark;
            if (!glass)
            {
                BackColor = SolidBackground();
                web.DefaultBackgroundColor = BackColor;
            }
            if (!IsHandleCreated) return;
            int on = dark ? 1 : 0;
            DwmSetWindowAttribute(Handle, DWMWA_USE_IMMERSIVE_DARK_MODE, ref on, sizeof(int));
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            ApplyTheme(dark);
            if (!glass) return;
            // Acrylic behind the whole window; the page paints its own translucent tint over it.
            var margins = new MARGINS { Left = -1, Right = -1, Top = -1, Bottom = -1 };
            DwmExtendFrameIntoClientArea(Handle, ref margins);
            int backdrop = DWMSBT_TRANSIENTWINDOW;
            DwmSetWindowAttribute(Handle, DWMWA_SYSTEMBACKDROP_TYPE, ref backdrop, sizeof(int));
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

        const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20, DWMWA_SYSTEMBACKDROP_TYPE = 38, DWMSBT_TRANSIENTWINDOW = 3;
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
