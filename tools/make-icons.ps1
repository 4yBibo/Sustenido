# Builds the app icon set from one generated master (assets/icon-source.png):
#   1. cuts the squircle out of its background with an anti-aliased superellipse mask,
#   2. recolors only the saturated pixels to each accent in src/accents.json (paper, ♯ and highlights stay intact),
#   3. writes web/icons/<id>.png (UI, splash) and icons/<id>.ico (window/taskbar), plus sustenido.ico for the exe.
# One generation, twenty colors — no extra image-model credits.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

public static class IconTool
{
    static void ToHsl(int r, int g, int b, out double h, out double s, out double l)
    {
        double R = r / 255.0, G = g / 255.0, B = b / 255.0;
        double max = Math.Max(R, Math.Max(G, B)), min = Math.Min(R, Math.Min(G, B));
        l = (max + min) / 2; h = 0; s = 0;
        if (max == min) return;
        double d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        if (max == R) h = (G - B) / d + (G < B ? 6 : 0);
        else if (max == G) h = (B - R) / d + 2;
        else h = (R - G) / d + 4;
        h /= 6;
    }

    static double Hue(double p, double q, double t)
    {
        if (t < 0) t += 1; if (t > 1) t -= 1;
        if (t < 1.0 / 6) return p + (q - p) * 6 * t;
        if (t < 0.5) return q;
        if (t < 2.0 / 3) return p + (q - p) * (2.0 / 3 - t) * 6;
        return p;
    }

    static void FromHsl(double h, double s, double l, out int r, out int g, out int b)
    {
        if (s <= 0) { r = g = b = (int)Math.Round(l * 255); return; }
        double q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
        r = (int)Math.Round(Hue(p, q, h + 1.0 / 3) * 255);
        g = (int)Math.Round(Hue(p, q, h) * 255);
        b = (int)Math.Round(Hue(p, q, h - 1.0 / 3) * 255);
    }

    static byte[] Pixels(Bitmap bmp)
    {
        var data = bmp.LockBits(new Rectangle(0, 0, bmp.Width, bmp.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        var bytes = new byte[data.Stride * bmp.Height];
        Marshal.Copy(data.Scan0, bytes, 0, bytes.Length);
        bmp.UnlockBits(data);
        return bytes;
    }

    static Bitmap FromPixels(byte[] bytes, int w, int h)
    {
        var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
        var data = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
        Marshal.Copy(bytes, 0, data.Scan0, bytes.Length);
        bmp.UnlockBits(data);
        return bmp;
    }

    /// Crops the squircle (bounding box of saturated pixels) and masks it onto a transparent square canvas.
    public static Bitmap Master(string path, int size, double fill)
    {
        using (var src = new Bitmap(path)) return Master(src, size, fill);
    }

    /// Cell (col,row) of a cols×rows contact sheet, as its own bitmap.
    public static Bitmap Cell(Bitmap sheet, int cols, int rows, int col, int row)
    {
        int cw = sheet.Width / cols, ch = sheet.Height / rows;
        return sheet.Clone(new Rectangle(col * cw, row * ch, cw, ch), PixelFormat.Format32bppArgb);
    }

    public static Bitmap Master(Bitmap src, int size, double fill)
    {
        {
            var px = Pixels(src);
            int w = src.Width, h = src.Height, minX = w, minY = h, maxX = 0, maxY = 0;
            // Background is the corner pixel; the tile is anything far from it (soft shadows are not).
            int br = px[2], bg = px[1], bb = px[0];
            for (int y = 0; y < h; y++)
                for (int x = 0; x < w; x++)
                {
                    int i = (y * w + x) * 4;
                    int dr = px[i + 2] - br, dg = px[i + 1] - bg, db = px[i] - bb;
                    if (dr * dr + dg * dg + db * db > 100 * 100)
                    {
                        if (x < minX) minX = x; if (x > maxX) maxX = x;
                        if (y < minY) minY = y; if (y > maxY) maxY = y;
                    }
                }
            int side = Math.Max(maxX - minX, maxY - minY) + 1;
            int cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
            var crop = new Rectangle(cx - side / 2, cy - side / 2, side, side);

            var outBmp = new Bitmap(size, size, PixelFormat.Format32bppArgb);
            int inner = (int)Math.Round(size * fill), off = (size - inner) / 2;
            using (var g = Graphics.FromImage(outBmp))
            {
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.DrawImage(src, new Rectangle(off, off, inner, inner), crop, GraphicsUnit.Pixel);
            }

            // Superellipse |x|^5 + |y|^5 <= 1 (Apple-like squircle), 4x4 supersampled, inset 1px against fringe.
            var o = Pixels(outBmp);
            double r = inner / 2.0 - 1, c = size / 2.0;
            for (int y = 0; y < size; y++)
                for (int x = 0; x < size; x++)
                {
                    int hits = 0;
                    for (int sy = 0; sy < 4; sy++)
                        for (int sx = 0; sx < 4; sx++)
                        {
                            double nx = Math.Abs((x + (sx + 0.5) / 4 - c) / r), ny = Math.Abs((y + (sy + 0.5) / 4 - c) / r);
                            if (Math.Pow(nx, 5) + Math.Pow(ny, 5) <= 1) hits++;
                        }
                    int i = (y * size + x) * 4;
                    o[i + 3] = (byte)(o[i + 3] * hits / 16);
                }
            outBmp.Dispose();
            return FromPixels(o, size, size);
        }
    }

    /// Moves every saturated pixel's hue to the target and rescales saturation/lightness relative to the base color.
    public static Bitmap Tint(Bitmap master, string hex, string baseHex)
    {
        double th, ts, tl, bh, bs, bl;
        var t = ColorTranslator.FromHtml(hex);
        var bc = ColorTranslator.FromHtml(baseHex);
        ToHsl(t.R, t.G, t.B, out th, out ts, out tl);
        ToHsl(bc.R, bc.G, bc.B, out bh, out bs, out bl);
        var px = Pixels(master);
        for (int i = 0; i < px.Length; i += 4)
        {
            if (px[i + 3] == 0) continue;
            double h, s, l;
            ToHsl(px[i + 2], px[i + 1], px[i], out h, out s, out l);
            // Only the violet tile and glass are tinted; the faintly blue-white paper and the ♯ stay untouched.
            double hueDist = Math.Abs(h - bh); if (hueDist > 0.5) hueDist = 1 - hueDist;
            if (s < 0.04 || hueDist > 0.15) continue;
            // Near-neutral pixels only rotate hue (paper stays white); saturated ones also take the accent's depth.
            double satW = Math.Min(1, Math.Max(0, (s - 0.22) / 0.18));
            double ns = s + (Math.Min(1, s * ts / bs) - s) * satW;
            double nl = Math.Min(0.95, Math.Max(0.05, l + (tl - bl) * 0.6 * satW));
            int r, g, b;
            FromHsl(th, ns, nl, out r, out g, out b);
            px[i + 2] = (byte)Math.Min(255, Math.Max(0, r));
            px[i + 1] = (byte)Math.Min(255, Math.Max(0, g));
            px[i] = (byte)Math.Min(255, Math.Max(0, b));
        }
        return FromPixels(px, master.Width, master.Height);
    }

    public static Bitmap Resize(Bitmap img, int size)
    {
        var b = new Bitmap(size, size, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(b))
        {
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.CompositingQuality = CompositingQuality.HighQuality;
            g.DrawImage(img, 0, 0, size, size);
        }
        return b;
    }

    /// ICO with PNG-compressed entries (Vista+), one per size.
    public static void SaveIco(Bitmap img, string path, int[] sizes)
    {
        var pngs = new byte[sizes.Length][];
        for (int i = 0; i < sizes.Length; i++)
            using (var r = Resize(img, sizes[i]))
            using (var ms = new MemoryStream()) { r.Save(ms, ImageFormat.Png); pngs[i] = ms.ToArray(); }
        using (var fs = File.Create(path))
        using (var w = new BinaryWriter(fs))
        {
            w.Write((ushort)0); w.Write((ushort)1); w.Write((ushort)sizes.Length);
            int offset = 6 + 16 * sizes.Length;
            for (int i = 0; i < sizes.Length; i++)
            {
                w.Write((byte)(sizes[i] >= 256 ? 0 : sizes[i])); w.Write((byte)(sizes[i] >= 256 ? 0 : sizes[i]));
                w.Write((byte)0); w.Write((byte)0); w.Write((ushort)1); w.Write((ushort)32);
                w.Write((uint)pngs[i].Length); w.Write((uint)offset);
                offset += pngs[i].Length;
            }
            foreach (var p in pngs) w.Write(p);
        }
    }
}
'@

$accents = Get-Content (Join-Path $root 'src\accents.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$webIcons = Join-Path $root 'web\icons'
$icoDir = Join-Path $root 'icons'
New-Item -ItemType Directory -Force $webIcons, $icoDir | Out-Null

$master = [IconTool]::Master((Join-Path $root 'assets\icon-source.png'), 1024, 0.88)
$master.Save((Join-Path $root 'assets\icon-master.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$sizes = [int[]](16, 20, 24, 32, 40, 48, 64, 128, 256)
$baseHex = '#7c4dff' # the violet the master was generated in

# Preferred source: one generated 5×4 contact sheet with every accent rendered by the model, in accents.json order.
$gridPath = Join-Path $root 'assets\icon-grid.png'
$grid = if (Test-Path $gridPath) { New-Object System.Drawing.Bitmap $gridPath } else { $null }

$index = 0
foreach ($a in $accents) {
    $tinted = if ($grid) {
        $cell = [IconTool]::Cell($grid, 5, 4, $index % 5, [math]::Floor($index / 5))
        [IconTool]::Master($cell, 1024, 0.88)
        $cell.Dispose()
    } elseif ($a.id -eq 'roxo') { $master } else { [IconTool]::Tint($master, $a.light, $baseHex) }
    $index++
    $png = [IconTool]::Resize($tinted, 256)
    $png.Save((Join-Path $webIcons "$($a.id).png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $png.Dispose()
    [IconTool]::SaveIco($tinted, (Join-Path $icoDir "$($a.id).ico"), $sizes)
    if ($a.id -eq 'roxo') { [IconTool]::SaveIco($tinted, (Join-Path $root 'sustenido.ico'), $sizes) }
    if ($tinted -ne $master) { $tinted.Dispose() }
}
$master.Dispose()
if ($grid) { $grid.Dispose() }
Write-Host "Ícones gerados para $($accents.Count) cores."
