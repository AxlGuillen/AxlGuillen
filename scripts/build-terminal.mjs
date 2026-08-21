#!/usr/bin/env node
//
// Builds the animated terminal for the profile README as two
// self-contained SVGs (light and dark). No dependencies: Node 18+ only.
//
//   node scripts/build-terminal.mjs
//
// With GITHUB_TOKEN it uses the GraphQL API, which is exact and can
// include private contributions. Without a token it falls back to the
// public calendar, which always works but only counts public activity.

import { writeFile, mkdir } from 'node:fs/promises';

// ─────────────────────────────────────────────────────────────────────
// What the terminal says. This is the part you edit by hand.
// ─────────────────────────────────────────────────────────────────────

const PROFILE = {
  login: 'AxlGuillen',
  // Optional hostname for the prompt. Leave empty for a bare `user ~ $`.
  host: '',
  name: 'Axl Guillén',
  tagline: 'Frontend dev · interfaces that disappear into use',
  facts: [
    ['based', 'Morelia, Michoacán — MX'],
    ['study', 'Tec. de Morelia'],
    ['speaks', 'español (native) · english (B1)'],
    ['now', 'frontend at work · AI & algorithms after hours'],
  ],
  status: 'open to interesting things',
  stack: [
    ['language', 'typescript · javascript'],
    ['frameworks', 'next · react · vue · astro'],
    ['styling', 'tailwind · css · motion'],
    ['tools', 'figma · git · node'],
    ['learning', 'ai · algorithms · systems'],
  ],
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** The shell prompt, without the trailing `~ $`. */
const USER = PROFILE.host
  ? `${PROFILE.login.toLowerCase()}@${PROFILE.host}`
  : PROFILE.login.toLowerCase();

// ─────────────────────────────────────────────────────────────────────
// Palettes. `scene` is everything outside the window: the sky it floats
// in, the grid it floats over, and the faces of its extrusion.
// ─────────────────────────────────────────────────────────────────────

const THEMES = {
  dark: {
    name: 'dark',
    bg: '#0d1117',
    chrome: '#161b22',
    border: '#2b3440',
    fg: '#e6edf3',
    dim: '#7d8590',
    green: '#3fb950',
    cyan: '#56d4dd',
    blue: '#4493f7',
    purple: '#a371f7',
    yellow: '#d29922',
    dot: ['#ff7b72', '#d29922', '#3fb950'],
    ramp: ['#1c2333', '#1f4b8f', '#2c6ecb', '#4493f7', '#79c0ff'],
    scene: {
      sky0: '#111a2e',
      sky1: '#05070d',
      bloom: '#1f6feb',
      bloomOpacity: 0.5,
      grid: '#3d7fd6',
      gridOpacity: 0.55,
      star: '#9fb6d9',
      extrudeTop: '#22314f',
      extrudeBottom: '#090e18',
      edge: '#3a4d69',
      floorGlow: '#4493f7',
      shadow: '#000000',
      shadowOpacity: 0.55,
      scan: 0.16,
      vignette: 0.3,
      glare: 0.05,
    },
  },
  light: {
    name: 'light',
    bg: '#ffffff',
    chrome: '#f6f8fa',
    border: '#d1d9e0',
    fg: '#1f2328',
    dim: '#59636e',
    green: '#1a7f37',
    cyan: '#1b7c83',
    blue: '#0969da',
    purple: '#8250df',
    yellow: '#9a6700',
    dot: ['#cf222e', '#9a6700', '#1a7f37'],
    ramp: ['#dde3ea', '#aecbfa', '#6ba3ee', '#2f80ed', '#0969da'],
    scene: {
      sky0: '#f4f7fc',
      sky1: '#dbe3ef',
      bloom: '#7aa7e8',
      bloomOpacity: 0.35,
      grid: '#7d9cc6',
      gridOpacity: 0.65,
      star: '#93a8c4',
      extrudeTop: '#cdd8e6',
      extrudeBottom: '#9aabc2',
      edge: '#ffffff',
      floorGlow: '#7aa7e8',
      shadow: '#274060',
      shadowOpacity: 0.3,
      scan: 0.05,
      vignette: 0.08,
      glare: 0.28,
    },
  },
};

// ─────────────────────────────────────────────────────────────────────
// Geometry. The terminal is monospaced, so everything inside it is
// derived from the advance width of a single character. Around it sits
// a margin wide enough for the extrusion, the glow and the floor.
// ─────────────────────────────────────────────────────────────────────

const WIN = 820;        // width of the terminal window itself
const MX = 48;          // canvas margin left and right
const MT = 44;          // canvas margin above the window
const MB = 104;         // canvas margin below (floor + reflection)
const W = WIN + MX * 2; // total canvas width
const OX = MX;          // window origin
const OY = MT;
const DEPTH = 15;       // how far the window is extruded down-right
const R = 12;           // corner radius

const CH = 7.8;         // character advance at 13px
const FS = 13;          // font size
const LH = 21;          // line height
const PAD_X = 24;       // horizontal inner padding
const PAD_Y = 20;       // vertical inner padding
const CHROME = 36;      // title bar height
const GRAPH_H = 54;     // bar height
const AXIS_H = 16;      // month axis height

const FONT =
  "ui-monospace,SFMono-Regular,'SF Mono',Menlo,Monaco,Consolas," +
  "'DejaVu Sans Mono','Liberation Mono','Courier New',monospace";

// Animation pacing, in seconds.
const T = {
  lead: 0.3,       // pause before typing starts
  perChar: 0.028,  // typing speed
  enter: 0.3,      // pause after hitting enter
  perOut: 0.085,   // each output line
  blank: 0.12,     // blank line
  perBar: 0.024,   // each bar of the graph
};

// ─────────────────────────────────────────────────────────────────────
// Data
// ─────────────────────────────────────────────────────────────────────

const GQL = `query($login:String!){
  user(login:$login){
    contributionsCollection{
      totalCommitContributions
      restrictedContributionsCount
      contributionCalendar{
        totalContributions
        weeks{ contributionDays{ date contributionCount contributionLevel } }
      }
    }
  }
}`;

const LEVELS = {
  NONE: 0,
  FIRST_QUARTILE: 1,
  SECOND_QUARTILE: 2,
  THIRD_QUARTILE: 3,
  FOURTH_QUARTILE: 4,
};

async function fetchViaGraphQL(login, token) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'build-terminal',
    },
    body: JSON.stringify({ query: GQL, variables: { login } }),
  });
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(`GraphQL: ${json.errors[0].message}`);

  const c = json.data.user.contributionsCollection;
  const days = c.contributionCalendar.weeks.flatMap((w) =>
    w.contributionDays.map((d) => ({
      date: d.date,
      count: d.contributionCount,
      level: LEVELS[d.contributionLevel] ?? 0,
    })),
  );
  return {
    days,
    total: c.contributionCalendar.totalContributions,
    commits: c.totalCommitContributions,
    private: c.restrictedContributionsCount,
    source: 'graphql',
  };
}

async function fetchViaPublicHTML(login) {
  const res = await fetch(`https://github.com/users/${login}/contributions`, {
    headers: { 'User-Agent': 'build-terminal' },
  });
  if (!res.ok) throw new Error(`public calendar HTTP ${res.status}`);
  const html = await res.text();

  // Each day is a <td data-date="…" data-level="…" id="…">, and its count
  // lives in the matching <tool-tip for="that-id">.
  const counts = new Map();
  for (const m of html.matchAll(/<tool-tip[^>]*for="([^"]+)"[^>]*>([^<]*)<\/tool-tip>/g)) {
    const n = /^(\d+)\s+contribution/.exec(m[2].trim());
    counts.set(m[1], n ? Number(n[1]) : 0);
  }

  const days = [];
  for (const m of html.matchAll(/<td[^>]*class="ContributionCalendar-day"[^>]*>/g)) {
    const tag = m[0];
    const date = /data-date="([^"]+)"/.exec(tag)?.[1];
    if (!date) continue;
    const id = /\bid="([^"]+)"/.exec(tag)?.[1] ?? '';
    days.push({
      date,
      count: counts.get(id) ?? 0,
      level: Number(/data-level="(\d)"/.exec(tag)?.[1] ?? 0),
    });
  }
  if (!days.length) throw new Error('could not read the public calendar');

  days.sort((a, b) => a.date.localeCompare(b.date));
  const total = days.reduce((s, d) => s + d.count, 0);
  return { days, total, commits: null, private: 0, source: 'public' };
}

/**
 * The longest streak in the period. Preferred over the current streak:
 * just as honest, and it does not depend on whether today has a commit yet.
 */
function bestStreak(days) {
  let best = 0;
  let run = 0;
  for (const day of days) {
    run = day.count > 0 ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}

/** Groups days into Sunday-to-Saturday weeks. */
function toWeeks(days) {
  const weeks = [];
  let week = null;
  for (const day of days) {
    const dow = new Date(`${day.date}T00:00:00Z`).getUTCDay();
    if (dow === 0 || !week) {
      week = { start: day.date, total: 0, level: 0 };
      weeks.push(week);
    }
    week.total += day.count;
    week.level = Math.max(week.level, day.level);
  }
  return weeks;
}

// ─────────────────────────────────────────────────────────────────────
// SVG construction
// ─────────────────────────────────────────────────────────────────────

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const n = (v) => Math.round(v * 100) / 100;

/** Seeded, so two runs over the same data produce the same file. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Collects elements while tracking the current time and line. */
class Session {
  constructor(theme) {
    this.t = 0;
    this.theme = theme;
    this.parts = [];
    this.defs = [];
    this.y = OY + CHROME + PAD_Y + FS; // baseline of the first line
    this.clipId = 0;
  }

  get promptWidth() {
    return `${USER} ~ $ `.length * CH;
  }

  /** The prompt, as coloured tspans. */
  prompt(y) {
    const { theme } = this;
    return (
      `<text x="${OX + PAD_X}" y="${n(y)}">` +
      `<tspan fill="${theme.green}">${esc(USER)}</tspan>` +
      `<tspan fill="${theme.dim}"> </tspan>` +
      `<tspan fill="${theme.cyan}">~</tspan>` +
      `<tspan fill="${theme.dim}"> $</tspan>` +
      `</text>`
    );
  }

  /** A command line: the prompt appears, then the command types itself. */
  command(cmd) {
    const { theme, y } = this;
    const cmdX = OX + PAD_X + this.promptWidth;
    const cmdW = cmd.length * CH;
    const start = n(this.t + T.lead);
    const dur = n(Math.max(0.2, cmd.length * T.perChar));
    const end = n(start + dur);
    const id = `t${this.clipId++}`;

    this.defs.push(
      `<clipPath id="${id}"><rect x="${n(cmdX)}" y="${n(y - FS)}" height="${FS + 5}" width="0">` +
        `<animate attributeName="width" from="0" to="${n(cmdW)}" begin="${start}s" dur="${dur}s" fill="freeze"/>` +
        `</rect></clipPath>`,
    );

    this.parts.push(
      `<g opacity="0"><set attributeName="opacity" to="1" begin="${n(this.t)}s"/>` +
        this.prompt(y) +
        `</g>`,
    );

    // the command, revealed character by character
    this.parts.push(
      `<g clip-path="url(#${id})"><text x="${n(cmdX)}" y="${n(y)}" fill="${theme.fg}">${esc(cmd)}</text></g>`,
    );

    // cursor that rides along with the typing and switches off at the end
    this.parts.push(
      `<g opacity="0">` +
        `<set attributeName="opacity" to="1" begin="${start}s"/>` +
        `<set attributeName="opacity" to="0" begin="${end}s"/>` +
        `<rect y="${n(y - FS + 2)}" width="${n(CH)}" height="${FS + 2}" fill="${theme.purple}" x="${n(cmdX)}">` +
        `<animate attributeName="x" from="${n(cmdX)}" to="${n(cmdX + cmdW)}" begin="${start}s" dur="${dur}s" fill="freeze"/>` +
        `</rect></g>`,
    );

    this.t = n(end + T.enter);
    this.y += LH;
    return this;
  }

  /** An output line. `spans` is [[text, colour], …]. */
  out(spans) {
    let x = OX + PAD_X;
    const body = spans
      .map(([text, fill]) => {
        const el = `<tspan x="${n(x)}" fill="${fill}">${esc(text)}</tspan>`;
        x += text.length * CH;
        return el;
      })
      .join('');
    this.parts.push(
      `<g opacity="0"><set attributeName="opacity" to="1" begin="${n(this.t)}s"/>` +
        `<text y="${n(this.y)}">${body}</text></g>`,
    );
    this.t = n(this.t + T.perOut);
    this.y += LH;
    return this;
  }

  /** A `key: value` output line, with the values lined up in a column. */
  pair(key, value, pad, valueSpans) {
    const { theme } = this;
    return this.out([
      [`${key}:`, theme.blue],
      [' '.repeat(pad - key.length + 2), theme.dim],
      ...(valueSpans ?? [[value, theme.fg]]),
    ]);
  }

  blank() {
    this.t = n(this.t + T.blank);
    this.y += LH * 0.55;
    return this;
  }

  /** The graph: one bar per week, growing from left to right. */
  graph(weeks) {
    const { theme } = this;
    const inner = WIN - PAD_X * 2;
    const gap = 4.4;
    const bw = (inner - gap * (weeks.length - 1)) / weeks.length;
    const base = this.y + GRAPH_H - FS;
    const max = Math.max(1, ...weeks.map((w) => w.total));
    const start = this.t;

    weeks.forEach((week, i) => {
      const x = OX + PAD_X + i * (bw + gap);
      // Square-root scale, so one peak week does not flatten all the others.
      const h = week.total === 0 ? 2.5 : Math.max(5, Math.sqrt(week.total / max) * GRAPH_H);
      const begin = n(start + i * T.perBar);
      this.parts.push(
        `<rect x="${n(x)}" width="${n(bw)}" rx="1.4" fill="${theme.ramp[week.level]}" y="${n(base)}" height="0">` +
          `<animate attributeName="y" from="${n(base)}" to="${n(base - h)}" begin="${begin}s" dur="0.42s" fill="freeze"/>` +
          `<animate attributeName="height" from="0" to="${n(h)}" begin="${begin}s" dur="0.42s" fill="freeze"/>` +
          `</rect>`,
      );
    });

    // axis: the month abbreviation on the week where it starts
    const axisY = base + AXIS_H;
    let last = -1;
    weeks.forEach((week, i) => {
      const month = new Date(`${week.start}T00:00:00Z`).getUTCMonth();
      if (month === last) return;
      last = month;
      // The last month repeats the first one as the year closes, so we drop
      // it when there is barely any room left to draw it.
      if (weeks.length - i < 3) return;
      const x = OX + PAD_X + i * (bw + gap);
      this.parts.push(
        `<g opacity="0"><set attributeName="opacity" to="1" begin="${n(start + i * T.perBar)}s"/>` +
          `<text x="${n(x)}" y="${n(axisY)}" font-size="10" fill="${theme.dim}">${MONTHS[month]}</text></g>`,
      );
    });

    this.t = n(start + weeks.length * T.perBar + 0.5);
    this.y = axisY + LH;
    return this;
  }

  /** The final cursor, left blinking. */
  idle() {
    const { theme, y } = this;
    this.parts.push(
      `<g opacity="0"><set attributeName="opacity" to="1" begin="${n(this.t)}s"/>` +
        this.prompt(y) +
        `<rect class="cursor" x="${n(OX + PAD_X + this.promptWidth)}" y="${n(y - FS + 2)}" ` +
        `width="${n(CH)}" height="${FS + 2}" fill="${theme.purple}"/>` +
        `</g>`,
    );
    this.y += LH;
    return this;
  }

  // ── the world the window sits in ───────────────────────────────────

  /** Sky, bloom and a few stars, behind everything else. */
  sky(H, winH) {
    const { scene } = this.theme;
    const cx = W / 2;
    const cy = OY + winH / 2;
    const rand = rng(0x5eed);

    this.defs.push(
      `<linearGradient id="sky" x1="0" y1="0" x2="0.35" y2="1">` +
        `<stop offset="0" stop-color="${scene.sky0}"/>` +
        `<stop offset="1" stop-color="${scene.sky1}"/></linearGradient>`,
      `<radialGradient id="bloom">` +
        `<stop offset="0" stop-color="${scene.bloom}" stop-opacity="${scene.bloomOpacity}"/>` +
        `<stop offset="1" stop-color="${scene.bloom}" stop-opacity="0"/></radialGradient>`,
    );

    const bg = [
      `<rect width="${W}" height="${H}" fill="url(#sky)"/>`,
      `<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(W * 0.62)}" ry="${n(winH * 0.72)}" fill="url(#bloom)"/>`,
    ];

    // Stars, only where the window will not cover them.
    for (let i = 0; i < 160 && bg.length < 36; i++) {
      const x = rand() * W;
      const y = rand() * H;
      const inside =
        x > OX - 16 && x < OX + WIN + DEPTH + 16 && y > OY - 16 && y < OY + winH + DEPTH + 40;
      if (inside) continue;
      const r = 0.6 + rand() * 1.1;
      const o = 0.25 + rand() * 0.5;
      const dur = n(2.6 + rand() * 3.4);
      const begin = n(rand() * 4);
      bg.push(
        `<circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}" fill="${scene.star}" opacity="${n(o)}">` +
          `<animate attributeName="opacity" values="${n(o)};${n(o * 0.15)};${n(o)}" ` +
          `dur="${dur}s" begin="${begin}s" repeatCount="indefinite"/></circle>`,
      );
    }
    return bg.join('\n');
  }

  /** A grid receding under the window, and the glow where they meet. */
  floor(H, winH) {
    const { scene } = this.theme;
    const y0 = OY + winH + DEPTH;   // horizon: the base of the window
    const y1 = H;                   // front edge of the floor
    const cx = W / 2;
    const vy = y0 - 230;            // vanishing point, above the horizon
    const lines = [];

    // rails converging on the vanishing point
    for (let k = -9; k <= 9; k++) {
      if (k === 0) continue;
      const bx = cx + k * 86;
      const t = (y0 - vy) / (y1 - vy);
      const x0 = cx + (bx - cx) * t;
      lines.push(
        `<line x1="${n(x0)}" y1="${n(y0)}" x2="${n(bx)}" y2="${n(y1)}" ` +
          `stroke="${scene.grid}" stroke-width="1"/>`,
      );
    }

    // rungs, spaced so they open up as they come toward the viewer
    for (let d = 5, i = 0; y0 + d < y1 && i < 12; i++, d *= 1.62) {
      lines.push(
        `<line x1="0" y1="${n(y0 + d)}" x2="${W}" y2="${n(y0 + d)}" ` +
          `stroke="${scene.grid}" stroke-width="1"/>`,
      );
    }

    this.defs.push(
      `<linearGradient id="floorFade" x1="0" y1="0" x2="0" y2="1">` +
        `<stop offset="0" stop-color="#fff" stop-opacity="0.9"/>` +
        `<stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>`,
      `<mask id="floorMask"><rect x="0" y="${n(y0)}" width="${W}" height="${n(y1 - y0)}" ` +
        `fill="url(#floorFade)"/></mask>`,
      `<radialGradient id="horizon">` +
        `<stop offset="0" stop-color="${scene.floorGlow}" stop-opacity="0.55"/>` +
        `<stop offset="1" stop-color="${scene.floorGlow}" stop-opacity="0"/></radialGradient>`,
    );

    return (
      `<g mask="url(#floorMask)" opacity="${scene.gridOpacity}">${lines.join('')}</g>\n` +
      `<ellipse cx="${n(cx)}" cy="${n(y0)}" rx="${n(WIN * 0.56)}" ry="26" fill="url(#horizon)"/>`
    );
  }

  /** The window's silhouette, mirrored below the floor and faded out. */
  reflection(winH) {
    const { theme } = this;
    const base = OY + winH + DEPTH;
    this.defs.push(
      `<linearGradient id="mirror" x1="0" y1="0" x2="0" y2="1">` +
        `<stop offset="0" stop-color="${theme.chrome}" stop-opacity="0.45"/>` +
        `<stop offset="0.5" stop-color="${theme.bg}" stop-opacity="0.14"/>` +
        `<stop offset="1" stop-color="${theme.bg}" stop-opacity="0"/></linearGradient>`,
    );
    return (
      `<rect x="${OX + 8}" y="${n(base)}" width="${WIN - 16 + DEPTH}" height="76" rx="${R}" ` +
      `fill="url(#mirror)"/>`
    );
  }

  /** The extruded body: the window is a slab, not a sticker. */
  slab(winH) {
    const { scene } = this.theme;
    this.defs.push(
      `<linearGradient id="side" x1="0" y1="0" x2="1" y2="1">` +
        `<stop offset="0" stop-color="${scene.extrudeTop}"/>` +
        `<stop offset="1" stop-color="${scene.extrudeBottom}"/></linearGradient>`,
      `<filter id="drop" x="-30%" y="-30%" width="170%" height="180%">` +
        `<feDropShadow dx="8" dy="22" stdDeviation="20" flood-color="${scene.shadow}" ` +
        `flood-opacity="${scene.shadowOpacity}"/></filter>`,
    );
    // Two offset copies read as one continuous side face once the front
    // panel lands on top of them.
    return (
      `<g filter="url(#drop)">` +
      `<rect x="${OX + DEPTH}" y="${OY + DEPTH}" width="${WIN}" height="${n(winH)}" rx="${R}" fill="url(#side)"/>` +
      `<rect x="${n(OX + DEPTH / 2)}" y="${n(OY + DEPTH / 2)}" width="${WIN}" height="${n(winH)}" rx="${R}" fill="url(#side)"/>` +
      `</g>`
    );
  }

  /** Scanlines, vignette and a glass glare, laid over the text. */
  overlay(winH) {
    const { scene } = this.theme;
    this.defs.push(
      `<pattern id="scan" width="4" height="3" patternUnits="userSpaceOnUse">` +
        `<rect width="4" height="1" fill="#000"/></pattern>`,
      `<radialGradient id="vig" cx="0.5" cy="0.5" r="0.75">` +
        `<stop offset="0.45" stop-color="#000" stop-opacity="0"/>` +
        `<stop offset="1" stop-color="#000" stop-opacity="${scene.vignette}"/></radialGradient>`,
      `<linearGradient id="glare" x1="0" y1="0" x2="0.9" y2="1">` +
        `<stop offset="0" stop-color="#fff" stop-opacity="${scene.glare}"/>` +
        `<stop offset="0.4" stop-color="#fff" stop-opacity="0"/></linearGradient>`,
      `<clipPath id="screen"><rect x="${OX}" y="${OY}" width="${WIN}" height="${n(winH)}" rx="${R}"/></clipPath>`,
    );
    const box = `x="${OX}" y="${OY}" width="${WIN}" height="${n(winH)}"`;
    return (
      `<g clip-path="url(#screen)">` +
      `<rect ${box} fill="url(#scan)" opacity="${scene.scan}"/>` +
      `<rect ${box} fill="url(#vig)"/>` +
      `<rect ${box} fill="url(#glare)"/>` +
      `</g>`
    );
  }

  render() {
    const { theme } = this;
    const winH = Math.round(this.y - FS + PAD_Y - OY);
    const H = OY + winH + DEPTH + MB;
    const title = `${PROFILE.login.toLowerCase()} — zsh`;
    const dots = theme.dot
      .map((c, i) => `<circle cx="${OX + 20 + i * 17}" cy="${OY + CHROME / 2}" r="5.5" fill="${c}"/>`)
      .join('');

    // These fill `this.defs` as they go, so build them before rendering.
    const sky = this.sky(H, winH);
    const floor = this.floor(H, winH);
    const reflection = this.reflection(winH);
    const slab = this.slab(winH);
    const overlay = this.overlay(winH);

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}" font-size="${FS}" role="img" aria-label="Terminal showing the profile and contribution history of ${esc(PROFILE.name)}">
<title>${esc(PROFILE.name)} — ${esc(PROFILE.tagline)}</title>
<style>
@keyframes blink{0%,49%{opacity:1}50%,100%{opacity:0}}
.cursor{animation:blink 1.06s steps(1) infinite}
@media (prefers-reduced-motion:reduce){.cursor{animation:none}}
text{white-space:pre;dominant-baseline:alphabetic}
</style>
<defs>
${this.defs.join('\n')}
</defs>
${sky}
${floor}
${reflection}
${slab}
<rect x="${OX}" y="${OY}" width="${WIN}" height="${winH}" rx="${R}" fill="${theme.bg}"/>
<path d="M${OX} ${OY + R}a${R} ${R} 0 0 1 ${R} -${R}h${WIN - R * 2}a${R} ${R} 0 0 1 ${R} ${R}V${OY + CHROME}H${OX}Z" fill="${theme.chrome}"/>
<line x1="${OX}" y1="${OY + CHROME}" x2="${OX + WIN}" y2="${OY + CHROME}" stroke="${theme.border}"/>
${dots}
<text x="${W / 2}" y="${OY + CHROME / 2 + 4}" text-anchor="middle" font-size="11" fill="${theme.dim}">${esc(title)}</text>
${this.parts.join('\n')}
${overlay}
<rect x="${OX + 0.5}" y="${OY + 0.5}" width="${WIN - 1}" height="${winH - 1}" rx="${R}" fill="none" stroke="${theme.border}"/>
<path d="M${OX + R} ${OY + 1}h${WIN - R * 2}" stroke="${theme.scene.edge}" stroke-opacity="0.75" stroke-width="1.4" fill="none"/>
</svg>
`;
  }
}

function buildSVG(theme, data) {
  const { total, streak, active, weeks } = data;
  const s = new Session(theme);
  const nf = new Intl.NumberFormat('en-US');

  s.command('whoami')
    .out([[PROFILE.name, theme.fg]])
    .out([[PROFILE.tagline, theme.dim]])
    .blank();

  s.command('cat profile.yml');
  const padF = Math.max(...PROFILE.facts.map(([k]) => k.length), 'status'.length);
  for (const [key, value] of PROFILE.facts) s.pair(key, value, padF);
  s.pair('status', null, padF, [
    ['●', theme.green],
    [` ${PROFILE.status}`, theme.fg],
  ]);
  s.blank();

  s.command('cat stack.yml');
  const padS = Math.max(...PROFILE.stack.map(([k]) => k.length));
  for (const [key, value] of PROFILE.stack) s.pair(key, value, padS);
  s.blank();

  s.command('gh contrib --summary').out([
    [nf.format(total), theme.yellow],
    [' contributions   ', theme.dim],
    [String(active), theme.yellow],
    [' active days   ', theme.dim],
    ['best streak ', theme.dim],
    [String(streak), theme.yellow],
    [streak === 1 ? ' day' : ' days', theme.dim],
  ]);
  s.blank();

  s.command(`gh contrib --graph --last ${weeks.length}w`).graph(weeks).blank();

  s.idle();
  return s.render();
}

// ─────────────────────────────────────────────────────────────────────

async function main() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  let raw;
  if (token) {
    raw = await fetchViaGraphQL(PROFILE.login, token);
  } else {
    console.warn('· no GITHUB_TOKEN: using the public calendar (public activity only)');
    raw = await fetchViaPublicHTML(PROFILE.login);
  }

  const data = {
    ...raw,
    streak: bestStreak(raw.days),
    active: raw.days.filter((d) => d.count > 0).length,
    weeks: toWeeks(raw.days),
  };

  await mkdir('assets', { recursive: true });
  for (const theme of Object.values(THEMES)) {
    const file = `assets/terminal-${theme.name}.svg`;
    await writeFile(file, buildSVG(theme, data));
    console.log(`✓ ${file}`);
  }

  console.log(
    `  source: ${data.source} · ${data.total} contributions · ` +
      `${data.active} active days · best streak ${data.streak} · ${data.weeks.length} weeks`,
  );
}

main().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});
