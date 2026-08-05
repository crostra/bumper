import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const assets = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");

/*
 * Localization:
 * - Semantic locales (assets/locales/{en,ja}.json) are the Phase 6 SSOT for new/changed UI.
 * - Legacy English-source overlay (assets/i18n.ja.json + i18n.js) still covers unmigrated DOM.
 * Document remaining overlay debt in knowledge/product.md — do not leave half-broken overlay.
 */
const appHtml = readFileSync(join(assets, "app.html"), "utf8");
const i18nEngine = readFileSync(join(assets, "i18n.js"), "utf8");
const i18nJaOverlay = readFileSync(join(assets, "i18n.ja.json"), "utf8");
const localeEn = readFileSync(join(assets, "locales", "en.json"), "utf8");
const localeJa = readFileSync(join(assets, "locales", "ja.json"), "utf8");

const i18nSnippet = `
<script>
window.__BUMPER_LOCALES__ = { en: ${localeEn}, ja: ${localeJa} };
window.__BUMPER_I18N__ = { ja: ${i18nJaOverlay} };
window.__BUMPER_I18N_META__ = { semantic: true, overlayDebt: true };
</script>
<script>
${i18nEngine}
</script>
`;

export const APP_HTML = appHtml.replace("</body>", `${i18nSnippet}</body>`);
export const APP_CSS = readFileSync(join(assets, "app.css"), "utf8");
export const APP_JS = readFileSync(join(assets, "app.js"), "utf8");
export const GITHUB_APP_BADGE_SVG = readFileSync(join(assets, "github-app-badge.svg"), "utf8");
export const GITHUB_APP_BADGE_PNG = readFileSync(join(assets, "github-app-badge.png"));
/** Pure launch readiness shared by the renderer and behavioral tests. */
export const APP_LAUNCH_GATE_JS = readFileSync(join(assets, "launch-gate.js"), "utf8");
/** Fixed-size Electron utility window for sign-in / Room shell / debug attach. */
export const TERMINAL_HTML = readFileSync(join(assets, "terminal.html"), "utf8");
export const TERMINAL_JS = readFileSync(join(assets, "terminal.js"), "utf8");
