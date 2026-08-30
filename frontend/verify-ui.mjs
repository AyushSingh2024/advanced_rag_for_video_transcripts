#!/usr/bin/env node
/**
 * Checks the things a browser would tell you, without a browser.
 *
 *   node frontend/verify-ui.mjs
 *
 * Four groups of checks:
 *
 *   contrast   Every text-on-surface pair in both themes, plus the wave band.
 *              The band matters because the page title sits on top of an
 *              animated image, so the number that has to pass is not the
 *              average pixel but the *brightest pixel the shader can produce*:
 *              crest colour, times brightness, at maximum alpha including the
 *              grain jitter. That is derived from the GLSL in waves.js rather
 *              than eyeballed.
 *
 *   stillness  The sheet claims to be static. Grep proves it: no transition,
 *              no animation, no @keyframes, no shadow, no blur, no @import.
 *
 *   integrity  Every id app.js reaches for exists in the HTML; every class the
 *              markup uses is styled; every custom property is both defined
 *              and used; nothing on the page is an emoji.
 *
 *   spoilers   The citation contract, executed rather than described: locator()
 *              is lifted out of app.js and called for a lesson behind the
 *              playhead, on it, and past it. The third must produce a bare
 *              chapter name and no popover element at all.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, "public");

const css = await readFile(join(PUBLIC, "styles.css"), "utf8");
const html = await readFile(join(PUBLIC, "index.html"), "utf8");
const app = await readFile(join(PUBLIC, "app.js"), "utf8");
const waves = await readFile(join(PUBLIC, "waves.js"), "utf8");

const cssBare = css.replace(/\/\*[\s\S]*?\*\//g, "");
const appBare = app.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

let pass = 0;
const failures = [];
const notes = [];

const ok = (label, condition, detail = "") => {
  if (condition) pass += 1;
  else failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
};

/* ----------------------------------------------------------------- colour --- */
const hex = (value) => {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(value.trim());
  if (!m) throw new Error(`not a hex colour: ${value}`);
  return [1, 2, 3].map((i) => parseInt(m[i], 16) / 255);
};

/** Browsers composite in gamma-encoded sRGB, so blending happens here too. */
const over = (src, dst, alpha) => src.map((c, i) => c * alpha + dst[i] * (1 - alpha));

const luminance = (rgb) => {
  const lin = rgb.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
};

const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const round = (n) => Math.round(n * 100) / 100;

/* --------------------------------------------------------------- tokens ----- */
function tokensFrom(block) {
  const out = {};
  for (const [, name, value] of block.matchAll(/(--vla-[a-z-]+)\s*:\s*([^;]+);/g)) {
    out[name] = value.trim();
  }
  return out;
}

const rootBlock = /:root\s*\{([\s\S]*?)\n\}/.exec(cssBare);
const lightBlock = /@media \(prefers-color-scheme: light\)\s*\{\s*:root\s*\{([\s\S]*?)\n  \}/.exec(cssBare);
ok("styles.css has a :root block", Boolean(rootBlock));
ok("styles.css has a light-scheme override", Boolean(lightBlock));

const dark = tokensFrom(rootBlock[1]);
const light = { ...dark, ...tokensFrom(lightBlock[1]) };

const THEMES = [["dark", dark], ["light", light]];

/* AA: 4.5 for body text, 3.0 for large text and for UI component boundaries. */
const TEXT_PAIRS = [
  ["--vla-text", "--vla-shell", 4.5], ["--vla-dim", "--vla-shell", 4.5], ["--vla-faint", "--vla-shell", 4.5],
  ["--vla-text", "--vla-surface", 4.5], ["--vla-dim", "--vla-surface", 4.5], ["--vla-faint", "--vla-surface", 4.5],
  ["--vla-text", "--vla-raised", 4.5], ["--vla-dim", "--vla-raised", 4.5], ["--vla-faint", "--vla-raised", 4.5],
  ["--vla-ember", "--vla-ember-wash", 4.5],   // .loc, covered
  ["--vla-cold", "--vla-cold-wash", 4.5],     // .loc.ahead
  ["--vla-ember", "--vla-surface", 4.5],      // .kind.core
  ["--vla-cold", "--vla-surface", 4.5],       // .ahead-flag, .kind.background
  ["--vla-ok", "--vla-surface", 3.0],         // status dot, not text
  ["--vla-alarm", "--vla-surface", 4.5],      // used as text in course-meta
  ["--vla-ink", "--vla-ember", 4.5],          // button.go label
  ["--vla-line", "--vla-surface", 1.2],       // hairline: visible, not loud
];

for (const [theme, tokens] of THEMES) {
  for (const [fg, bg, min] of TEXT_PAIRS) {
    const ratio = contrast(hex(tokens[fg]), hex(tokens[bg]));
    ok(`${theme}: ${fg} on ${bg} >= ${min}`, ratio >= min, `measured ${round(ratio)}:1`);
  }
}

/* ------------------------------------------------------------- wave band ----
 * Worst case, straight out of the shader:
 *     fragColor = vec4(col * alpha, alpha)
 *     col   = clamp(mix(horizon, mix(wave, crest, _), t) * brightness, 0, 1)
 *     alpha = clamp(t * opacity + (grain - 0.5) * grainIntensity, 0, 1)
 * so the extreme pixel is the crest colour at brightness, drawn at
 * opacity + grainIntensity/2, over whatever the CSS fallback gradient paints.
 */
const config = (name) => {
  const m = new RegExp(`${name}:\\s*([0-9.]+|"#[0-9a-fA-F]{3,6}"|'#[0-9a-fA-F]{3,6}')`).exec(waves);
  if (!m) throw new Error(`waves.js: could not read ${name}`);
  return m[1].replace(/['"]/g, "");
};

const themeBlock = (name) => {
  const m = new RegExp(`${name}:\\s*\\{\\s*brightness:\\s*([0-9.]+),\\s*opacity:\\s*([0-9.]+)`).exec(waves);
  if (!m) throw new Error(`waves.js: could not read the ${name} theme block`);
  return { brightness: Number(m[1]), opacity: Number(m[2]) };
};

const grainIntensity = Number(config("grainIntensity"));
const crest = hex(config("crestColor"));
const horizon = hex(config("horizonColor"));

/* Body of a rule, picked by occurrence: 0 is the base sheet, 1 is the
   light-scheme override. Worth the helper — an earlier version scoped the light
   case as "first light media query onward", and since the first light media
   query is the :root one, the lazy match walked into the *dark* scrim and
   measured dark text on a darkened band. It reported 1.23:1, which is
   arithmetically impossible against pale peach. */
function ruleBody(selector, which) {
  const needle = `${selector} {`;
  const starts = [];
  for (let at = cssBare.indexOf(needle); at !== -1; at = cssBare.indexOf(needle, at + 1)) starts.push(at);
  const start = starts[which];
  if (start === undefined) throw new Error(`styles.css: no ${which ? "light override" : "base rule"} for ${selector}`);
  const open = cssBare.indexOf("{", start);
  return cssBare.slice(open + 1, cssBare.indexOf("}", open));
}

/* The gradient painted on .waves, which is what the canvas composites onto.
   Dark mode needs its brightest stop and light mode its darkest; in both sheets
   that is the top one. */
const bandBase = (theme) => {
  const stops = [...ruleBody(".waves", theme === "light" ? 1 : 0).matchAll(/#[0-9a-f]{6}/gi)].map((m) => m[0]);
  return hex(stops[0]);
};

/* The scrim in .waves::after, sampled at its three declared stops. */
const scrimStops = (theme) => {
  const scope = ruleBody(".waves::after", theme === "light" ? 1 : 0);
  const colour = /rgb\((\d+) (\d+) (\d+)/.exec(scope);
  const alphas = [...scope.matchAll(/\/\s*\.(\d+)\)/g)].map((m) => Number(`0.${m[1]}`));
  return { colour: [1, 2, 3].map((i) => Number(colour[i]) / 255), alphas };
};

for (const [theme, tokens] of THEMES) {
  const { brightness, opacity } = themeBlock(theme);
  const alpha = Math.min(1, opacity + grainIntensity / 2);
  const base = bandBase(theme);
  const scrim = scrimStops(theme);

  // Dark theme: the danger is a bright crest under light text.
  // Light theme: the danger is the dark horizon under dark text. Deliberately
  // pessimistic there: `t` scales colour and alpha together in the shader, so
  // the horizon colour at full alpha is not a pixel the band can actually
  // paint. A bound that cannot be exceeded is the useful kind.
  const extreme = theme === "dark" ? crest : horizon;
  const painted = over(extreme.map((c) => Math.min(1, c * brightness)), base, alpha);
  const behind = (stop) => over(scrim.colour, painted, scrim.alphas[stop]);

  /* The title is the only thing over the band, so it is the only thing that has
     to clear AA there — but it is checked at every scrim stop, because a
     clamp()ed heading occupies most of the band's height. */
  scrim.alphas.forEach((_, stop) => {
    const ratio = contrast(hex(tokens["--vla-text"]), behind(stop));
    ok(`${theme}: band title (--vla-text) at scrim stop ${stop} >= 4.5`, ratio >= 4.5,
      `measured ${round(ratio)}:1 against the worst pixel the shader can draw`);
  });

  notes.push(`${theme}: band worst pixel brightness=${brightness} opacity=${opacity} alpha=${round(alpha)}`
    + `, title clears ${round(Math.min(...scrim.alphas.map((_, s) => contrast(hex(tokens["--vla-text"]), behind(s)))))}:1`);
  /* Why nothing small sits on the band. Reported, not asserted: these numbers
     are the reason for a layout decision, and a future change that made them
     pass would be an improvement rather than a regression. */
  for (const token of ["--vla-dim", "--vla-faint"]) {
    const ratio = round(contrast(hex(tokens[token]), behind(0)));
    notes.push(`${theme}: ${token} measures ${ratio}:1 on the band`
      + (ratio < 4.5 ? " — short of 4.5, which is why the small type sits below the band" : ""));
  }
}

/* Sanity: the values in waves.js must actually be the dimmed ones, not the
   originals from the spec, which measured about 1.1:1 under the title. */
ok("waves.js dims the dark theme below the supplied brightness 0.9",
  themeBlock("dark").brightness < 0.9);
ok("waves.js dims the dark theme below the supplied opacity 1.0",
  themeBlock("dark").opacity < 1.0);

/* ------------------------------------------------------------- stillness --- */
for (const [label, pattern] of [
  ["transition", /transition\s*:/], ["animation", /animation(?:-[a-z]+)?\s*:/],
  ["@keyframes", /@keyframes/], ["box-shadow", /box-shadow\s*:/],
  ["text-shadow", /text-shadow\s*:/], ["backdrop-filter", /backdrop-filter\s*:/],
  ["@import", /@import/], ["remote url()", /url\(\s*['"]?https?:/],
]) {
  ok(`styles.css declares no ${label}`, !pattern.test(cssBare));
}
ok("app.js no longer animates anything", !/style\.animation|animation-delay|scaleY\(|behavior: "smooth"/.test(appBare));
ok("app.js no longer writes the playhead bloom", !/--reach|--bloom|applyLight/.test(appBare));
ok("app.js no longer measures a sliding tab indicator", !/moveTabInk|tab-ink/.test(appBare));
ok("waves.js honours prefers-reduced-motion", /prefers-reduced-motion/.test(waves) && /drawStill/.test(waves));
ok("waves.js parks the loop when offscreen or hidden",
  /IntersectionObserver/.test(waves) && /visibilitychange/.test(waves));
ok("waves.js caps the device pixel ratio", /Math\.min\(window\.devicePixelRatio \|\| 1, 2\)/.test(waves));
ok("waves.js releases the GL context on teardown", /WEBGL_lose_context/.test(waves));

/* -------------------------------------------------------------- no emoji --- */
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/u;
for (const [name, text] of [["index.html", html], ["app.js", app], ["styles.css", css], ["waves.js", waves]]) {
  const line = text.split("\n").findIndex((l) => EMOJI.test(l));
  ok(`${name} contains no emoji`, line === -1, line === -1 ? "" : `line ${line + 1}`);
}

/* ------------------------------------------------------------- integrity --- */
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const wantedIds = new Set([...app.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]));
for (const id of wantedIds) ok(`index.html defines #${id}`, htmlIds.has(id));
ok("index.html defines the wave band host",
  htmlIds.has("waves") && /getElementById\("waves"\)/.test(waves));
ok("index.html loads waves.js and app.js", /src="waves\.js"/.test(html) && /src="app\.js"/.test(html));
ok("index.html no longer preconnects to a font CDN", !/fonts\.g(oogleapis|static)/.test(html));

const cssClasses = new Set();
for (const [, name] of cssBare.matchAll(/\.(-?[a-z][a-z0-9-]*)/gi)) cssClasses.add(name);

const NAME = /^-?[a-z][a-z0-9-]*$/i;
const usedClasses = new Set();
const add = (text) => String(text).split(/\s+/).forEach((c) => NAME.test(c) && usedClasses.add(c));

const collect = (text) => {
  // The value can contain a ${...} carrying its own quotes, so this is not
  // simply [^"]* — reading it that way produced class names like `.${ok`.
  for (const [, value] of text.matchAll(/class="((?:[^"$]|\$\{[^}]*\}|\$)*)"/g)) {
    // Names hiding inside an interpolation, e.g. ${health.postgres ? "ok" : "bad"}.
    for (const [, expr] of value.matchAll(/\$\{([^}]*)\}/g)) {
      for (const [, quoted] of expr.matchAll(/"([a-z][a-z0-9 -]*)"/gi)) add(quoted);
    }
    add(value.replace(/\$\{[^}]*\}/g, " "));
  }
  // Built up in a variable and joined later, which is how the rail draws a tick.
  for (const [, list] of text.matchAll(/classes = \[([^\]]*)\]/g)) {
    for (const [, name] of list.matchAll(/"([^"]+)"/g)) add(name);
  }
  for (const [, value] of text.matchAll(/classes\.push\("([^"]+)"\)/g)) add(value);
  for (const [, value] of text.matchAll(/className = "([^"]+)"/g)) add(value);
};
collect(html);
collect(app);

/* .kind takes concept.kind straight from the API, so these three are never
   literals in the source. .detail deliberately has no rule of its own: a
   one-off detail should look like the default, not like a third state. */
const DATA_DRIVEN = new Set(["core", "detail", "background"]);
const UNSTYLED_ON_PURPOSE = new Set(["detail"]);
for (const name of usedClasses) {
  ok(`styles.css styles .${name}`, cssClasses.has(name) || UNSTYLED_ON_PURPOSE.has(name));
}

const STRUCTURAL = new Set(["waves", "wrap", "sr", "tab-panel", "mono", "clickable"]);
const orphans = [...cssClasses].filter((name) =>
  !usedClasses.has(name) && !STRUCTURAL.has(name) && !DATA_DRIVEN.has(name));
ok("styles.css has no rules for classes nothing renders", orphans.length === 0, orphans.join(", "));

/* The band's box is the title's box, and both halves of that are checked: the
   CSS gives .waves no height of its own, and the markup puts nothing but the
   title inside the masthead. This is what keeps the contrast result true as the
   header grows — see the band notes above for the numbers it depends on. */
const titlebar = /<div class="titlebar">([\s\S]*?)\n<\/div>/.exec(html);
ok("index.html has a masthead block", Boolean(titlebar));
ok(".waves takes its height from the masthead rather than a number of its own",
  /inset:\s*0;/.test(ruleBody(".waves", 0)) && !/height\s*:/.test(ruleBody(".waves", 0)));
ok("the masthead sets its own floor", /min-height:\s*var\(--vla-band\)/.test(ruleBody(".titlebar", 0)));
ok("the masthead holds the title", /<h1/.test(titlebar[1]));
for (const stray of ["greeting-text", "streak-badge", 'id="health"', "course-meta"]) {
  ok(`the masthead keeps ${stray} off the waves`, !titlebar[1].includes(stray));
}

const defined = new Set(Object.keys(dark).concat(Object.keys(tokensFrom(lightBlock[1]))));
const usedTokens = new Set([...`${cssBare}${html}${app}`.matchAll(/var\((--vla-[a-z-]+)/g)].map((m) => m[1]));
for (const token of usedTokens) ok(`${token} is defined`, defined.has(token));
const unusedTokens = [...defined].filter((token) => !usedTokens.has(token));
ok("every token defined is used somewhere", unusedTokens.length === 0, unusedTokens.join(", "));

/* -------------------------------------------------------------- spoilers ---
 * locator() is the whole contract, so it gets called rather than read. It is
 * lifted out of app.js with its three helpers and given a fake `state`.
 */
function lift(...names) {
  const bodies = names.map((name) => {
    const m = new RegExp(`\\n(?:function ${name}\\(|const ${name} = )`).exec(app);
    if (!m) throw new Error(`could not find ${name} in app.js`);
    const start = m.index + 1;
    const end = app.indexOf("\n}\n", start) + 2;
    const isConst = app.slice(start).startsWith("const");
    return app.slice(start, isConst ? app.indexOf(";\n", start) + 1 : end);
  });
  return new Function("state", `${bodies.join("\n")}\nreturn { ${names.join(", ")} };`);
}

const lifted = lift("esc", "scopeOf", "formatTime", "locator");
const atLesson = (position) => lifted({ position, lessons: new Array(87) });

const citation = (order) => ({
  number: 1, lessonOrder: order, lessonLabel: `Module 5 · Lesson ${order}`,
  sourceTitle: "Navigation basics", startTime: 754,
  quote: "This is the part people get wrong, so watch it twice.",
});

{
  const { locator } = atLesson(40);

  const covered = locator(citation(12));
  ok("covered citation names the chapter and the minute",
    covered.includes("Module 5") && covered.includes("12:34"), covered);
  ok("covered citation carries the quote in a popover", covered.includes("cite-pop") && covered.includes("watch it twice"));

  const current = locator(citation(40));
  ok("citation on the current lesson gives the minute alone",
    current.includes("12:34") && !current.includes("Module 5"), current);

  const ahead = locator(citation(55));
  ok("citation past the playhead is marked cold", ahead.includes('class="loc ahead"'), ahead);
  ok("citation past the playhead has no timestamp", !/\d+:\d\d/.test(ahead), ahead);
  ok("citation past the playhead has no quote", !ahead.includes("watch it twice"), ahead);
  ok("citation past the playhead has no popover element at all", !ahead.includes("cite-pop"), ahead);
  ok("citation past the playhead is not focusable", !ahead.includes("tabindex"), ahead);
}
{
  // Position 0 means no spoiler bound at all, so full locators everywhere.
  const { locator } = atLesson(0);
  const unbounded = locator(citation(55));
  ok("with no position set, a later lesson still gets a full locator",
    unbounded.includes("Module 5") && unbounded.includes("12:34") && !unbounded.includes("ahead"), unbounded);
}
{
  // Transcript text is untrusted: it must arrive escaped, not as markup.
  const { locator } = atLesson(40);
  const nasty = locator({ ...citation(12), quote: '<img src=x onerror="alert(1)">' });
  ok("a quote cannot inject markup", !nasty.includes("<img") && nasty.includes("&lt;img"), nasty);
}

/* ----------------------------------------------------------------- report --- */
for (const note of notes) console.log(`note  ${note}`);
console.log(`\n${pass} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL  ${failure}`);
process.exit(failures.length ? 1 : 0);
