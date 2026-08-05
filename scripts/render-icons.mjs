/**
 * Rasterise assets/*.svg into the PNG/ICNS forms macOS and GitHub need.
 *
 * Rendering happens in Electron's Chromium, not in a CLI rasteriser, for a
 * reason worth keeping: ImageMagick's built-in SVG renderer silently dropped
 * every stroked path in these marks and emitted a PNG containing only the
 * centre dot. A rasteriser that fails loudly is fine; one that quietly ships a
 * wrong icon is not. Chromium is also exactly what renders the SVG inside the
 * app, so the two can never disagree.
 *
 * Run: npm run icons
 */
import { app, BrowserWindow, nativeImage } from "electron";
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");
const ICONSET = join(ASSETS, ".icon.iconset");

/** macOS wants both @1x and @2x for every listed size in an iconset. */
const ICNS_SIZES = [16, 32, 128, 256, 512];

/**
 * Rasterise one SVG at every requested size, through a canvas in the page.
 *
 * Not `capturePage`: a screenshot inherits the window's opacity, and a
 * `transparent: true` BrowserWindow fails to load a page at all on this macOS
 * build. Drawing into a canvas gives real alpha from an ordinary window, and
 * each size is rasterised from the vector rather than resampled from a bitmap.
 */
async function rasterise(win, svgName, sizes) {
  const svg = readFileSync(join(ASSETS, svgName), "utf8");
  {
    const results = await win.webContents.executeJavaScript(`(async () => {
      const svg = ${JSON.stringify(svg)};
      const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error("the SVG did not decode"));
        img.src = url;
      });
      const out = {};
      for (const size of ${JSON.stringify(sizes)}) {
        const canvas = document.createElement("canvas");
        canvas.width = size; canvas.height = size;
        const ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, size, size);
        ctx.drawImage(img, 0, 0, size, size);
        // A mark that rasterised to nothing must not be written out.
        const pixels = ctx.getImageData(0, 0, size, size).data;
        let ink = 0;
        for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 8) ink += 1;
        if (!ink) throw new Error("rasterised to a fully transparent image at " + size);
        out[size] = canvas.toDataURL("image/png").split(",")[1];
      }
      URL.revokeObjectURL(url);
      return out;
    })()`);
    return Object.fromEntries(
      Object.entries(results).map(([size, base64]) => [size, Buffer.from(base64, "base64")]),
    );
  }
}

async function main() {
  const iconSizes = [...new Set([1024, ...ICNS_SIZES.flatMap((s) => [s, s * 2])])];
  /*
   * One window for all three marks. Creating a second BrowserWindow after
   * destroying the first fails to load anything on this macOS build, so the
   * window is opened once and reused rather than per SVG.
   */
  const win = new BrowserWindow({ width: 200, height: 200, show: false });
  // about:blank, not a scratch file and not a data: URL: each SVG travels as a
  // JS string, so there is no path to resolve and no URL length to exceed.
  await win.loadURL("about:blank");

  // App icon: its own dark plate. Menu-bar template: black on transparent,
  // recoloured by macOS. Badge: white on transparent, on GitHub's own circle.
  const icon = await rasterise(win, "icon.svg", iconSizes);
  const tray = await rasterise(win, "trayTemplate.svg", [22, 44]);
  const badge = await rasterise(win, "github-app-badge.svg", [200]);
  win.destroy();

  writeFileSync(join(ASSETS, "icon.png"), icon[1024]);
  writeFileSync(join(ASSETS, "trayTemplate.png"), tray[22]);
  writeFileSync(join(ASSETS, "trayTemplate@2x.png"), tray[44]);
  writeFileSync(join(ASSETS, "github-app-badge.png"), badge[200]);

  rmSync(ICONSET, { recursive: true, force: true });
  mkdirSync(ICONSET, { recursive: true });
  for (const size of ICNS_SIZES) {
    for (const scale of [1, 2]) {
      writeFileSync(
        join(ICONSET, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`),
        icon[size * scale],
      );
    }
  }
  await exec("iconutil", ["-c", "icns", ICONSET, "-o", join(ASSETS, "icon.icns")]);
  rmSync(ICONSET, { recursive: true, force: true });

  // A silently empty icon is worse than a missing one — check, do not assume.
  const icns = readFileSync(join(ASSETS, "icon.icns"));
  if (icns.length < 20_000) throw new Error("icon.icns looks empty; refusing to ship it.");
  for (const name of ["icon.png", "trayTemplate.png", "trayTemplate@2x.png", "github-app-badge.png"]) {
    if (nativeImage.createFromPath(join(ASSETS, name)).isEmpty()) {
      throw new Error(`${name} did not render.`);
    }
  }
  console.log(`icons: icon.png, icon.icns (${icns.length}B), trayTemplate.png @1x/@2x, github-app-badge.png`);
}

app.disableHardwareAcceleration();
app.whenReady()
  .then(main)
  .then(() => app.exit(0))
  .catch((error) => { console.error(error); app.exit(1); });
