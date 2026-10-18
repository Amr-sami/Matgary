/**
 * Cron schedule pin (doc 15 spec 16 §7; 03 §B.7, §B.13).
 *
 * The production cron sidecar (docker-compose.prod.yml, service `cron`) builds
 * its crontab from `echo "$$X_CRON /usr/local/bin/poke-cron.sh /api/cron/<name>
 * <label> >> …"` lines. A route directory with no line never runs in
 * production; a line with no route 404s every tick (`curl: (22)` in cron.log).
 * Both halves must ship in the same deploy, so this test pins them together,
 * plus the "N jobs scheduled" banner, the collections-tick cadence against its
 * rate-limit bucket, the dev compose wiring, and the `.env.example`
 * documentation of every COLLECTIONS_* variable the app reads.
 *
 * Text-parses the YAML (no new dependency). Files are read relative to this
 * file, the pattern of idempotency-durable.test.ts.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const fromHere = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const REPO = fromHere("../../../../");
const WEB = fromHere("../../");
const readRepo = (rel: string) => readFileSync(path.join(REPO, rel), "utf8");
const readWeb = (rel: string) => readFileSync(path.join(WEB, rel), "utf8");

/** The text of one top-level compose service (2-space key) up to the next. */
function serviceBlock(yaml: string, name: string): string {
  const lines = yaml.split("\n");
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start < 0) throw new Error(`service "${name}" not found`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    // next service (2-space key) or next top-level key (volumes:, networks:)
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[i]) || /^[A-Za-z0-9_-]+:/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

interface PokeLine {
  cronVar: string;
  target: string;
  label: string;
}

const POKE_RE =
  /echo "\$\$([A-Z0-9_]+_CRON) \/usr\/local\/bin\/poke-cron\.sh \/api\/cron\/([a-z0-9-]+) ([a-z0-9-]+) >> \/var\/log\/cron\.log 2>&1"/g;

function pokeLines(block: string): PokeLine[] {
  return [...block.matchAll(POKE_RE)].map((m) => ({ cronVar: m[1], target: m[2], label: m[3] }));
}

/** `X_CRON: "<expr>"` entries of the service's environment block. */
function cronEnv(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of block.matchAll(/^ {6}([A-Z0-9_]+_CRON):\s*"([^"]*)"\s*$/gm)) out.set(m[1], m[2]);
  return out;
}

const CRON_FIELD = /^[0-9*/,-]+$/;
const isFiveFieldCron = (expr: string) => {
  const f = expr.trim().split(/\s+/);
  return f.length === 5 && f.every((x) => CRON_FIELD.test(x));
};

/** Directories under app/api/cron that hold a route handler. */
function cronRouteDirs(): string[] {
  const root = path.join(WEB, "app/api/cron");
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .filter((d) => {
      try {
        return statSync(path.join(root, d.name, "route.ts")).isFile();
      } catch {
        return false;
      }
    })
    .map((d) => d.name)
    .sort();
}

const dupes = (xs: string[]) => xs.filter((x, i) => xs.indexOf(x) !== i);

const PROD = serviceBlock(readRepo("docker-compose.prod.yml"), "cron");
const DEV = serviceBlock(readRepo("docker-compose.yml"), "cron");
const ENV_EXAMPLE = readWeb(".env.example");

describe("prod cron sidecar (docker-compose.prod.yml)", () => {
  const lines = pokeLines(PROD);
  const env = cronEnv(PROD);

  it("1. crontab targets = app/api/cron directories, both ways, no duplicates", () => {
    const targets = lines.map((l) => l.target);
    expect(dupes(targets)).toEqual([]);
    expect(dupes(lines.map((l) => l.label))).toEqual([]);
    expect([...targets].sort()).toEqual(cronRouteDirs());
  });

  it("2. every X_CRON a line uses is defined in environment: with a 5-field value", () => {
    expect(lines.length).toBeGreaterThan(0);
    for (const { cronVar } of lines) {
      expect(env.has(cronVar), `${cronVar} missing from the cron environment block`).toBe(true);
      expect(isFiveFieldCron(env.get(cronVar)!), `${cronVar}="${env.get(cronVar)}"`).toBe(true);
    }
    expect(dupes(lines.map((l) => l.cronVar))).toEqual([]);
  });

  it('3. the "— N jobs scheduled" banner equals the number of crontab lines', () => {
    const banners = [...PROD.matchAll(/— (\d+) jobs scheduled/g)];
    expect(banners).toHaveLength(1);
    expect(Number(banners[0][1])).toBe(lines.length);
    expect(Number(banners[0][1])).toBe(cronRouteDirs().length);
  });

  it('4. COLLECTIONS_TICK_CRON is pinned to "*/15 * * * *" and poked with label collections-tick', () => {
    expect(PROD).toMatch(/^ {6}COLLECTIONS_TICK_CRON: "\*\/15 \* \* \* \*"$/m);
    expect(lines).toContainEqual({
      cronVar: "COLLECTIONS_TICK_CRON",
      target: "collections-tick",
      label: "collections-tick",
    });
  });
});

describe("collections-tick route vs its schedule", () => {
  it('5. guardCronRequest(…, { bucket: "collections-tick" }) with room for */15 (≥ 5 per hour)', () => {
    const src = readWeb("app/api/cron/collections-tick/route.ts");
    const call = src.match(/guardCronRequest\(\s*req\s*,\s*\{([^}]*)\}\s*\)/);
    expect(call, "guardCronRequest(req, { … }) call").not.toBeNull();
    const opts = call![1];
    expect(opts).toMatch(/bucket:\s*"collections-tick"/);
    const limit = opts.match(/limit:\s*(\d+)/);
    if (limit) expect(Number(limit[1])).toBeGreaterThanOrEqual(5);
    // */15 lands at most 5 pokes in a sliding HOUR; a longer window would
    // hold more pokes than the limit allows.
    const win = opts.match(/windowSec:\s*([^,}\n]+)/);
    if (win) {
      const expr = win[1].trim();
      expect(expr, "windowSec must be a numeric literal or a product of literals").toMatch(
        /^[0-9_]+(\s*\*\s*[0-9_]+)*$/,
      );
      const secs = expr
        .split("*")
        .map((x) => Number(x.trim().replace(/_/g, "")))
        .reduce((a, b) => a * b, 1);
      expect(secs).toBeLessThanOrEqual(60 * 60);
    }
  });
});

describe("dev cron sidecar (docker-compose.yml)", () => {
  const lines = pokeLines(DEV);
  const env = cronEnv(DEV);

  it("6. the collections-tick line exists, its schedule is defined, every target is a route", () => {
    expect(lines).toContainEqual({
      cronVar: "COLLECTIONS_TICK_CRON",
      target: "collections-tick",
      label: "collections-tick",
    });
    expect(env.get("COLLECTIONS_TICK_CRON")).toBe("*/15 * * * *");
    const dirs = cronRouteDirs();
    for (const l of lines) {
      expect(dirs, `dev target /api/cron/${l.target}`).toContain(l.target);
      expect(env.has(l.cronVar), `${l.cronVar} missing from the dev cron environment`).toBe(true);
      expect(isFiveFieldCron(env.get(l.cronVar)!)).toBe(true);
    }
    expect(dupes(lines.map((l) => l.target))).toEqual([]);
    expect(DEV).toContain('echo "[cron] collections-tick   schedule: $$COLLECTIONS_TICK_CRON"');
  });
});

describe(".env.example documents the collections variables (03 §B.13)", () => {
  /** A `NAME=` or `# NAME=` line. */
  const hasKeyLine = (name: string) => new RegExp(`^(# )?${name}=`, "m").test(ENV_EXAMPLE);

  const APP_READ = [
    "COLLECTIONS_ENABLED",
    "COLLECTIONS_PILOT_TENANT_IDS",
    "COLLECTIONS_INGEST_PILOT_TENANT_IDS",
    "COLLECTIONS_INGEST_ENABLED",
    "COLLECTIONS_PROVIDERS_ENABLED",
    "COLLECTIONS_IOS_SHORTCUT_URL",
    "COLLECTIONS_IOS_SHORTCUT_URL_LEGACY",
    "COLLECTIONS_IOS_INTENT_SHORTCUT_URL",
    "COLLECTIONS_IOS_INTENT_SHORTCUT_URL_LEGACY",
    "COLLECTIONS_AUTO_CONFIRM_ENABLED",
    "COLLECTIONS_PROVIDERS_FAKE",
  ] as const;

  it("7. all twelve COLLECTIONS_* names (+ the four KASHIER_PLATFORM_*) are there", () => {
    for (const name of APP_READ) expect(hasKeyLine(name), name).toBe(true);
    // Not read by the app (pinned in compose), but named so an operator finds it.
    expect(ENV_EXAMPLE).toMatch(/\bCOLLECTIONS_TICK_CRON\b/);
    for (const k of ["MERCHANT_ID", "API_KEY", "SECRET_KEY", "ENVIRONMENT"]) {
      expect(hasKeyLine(`KASHIER_PLATFORM_${k}`), `KASHIER_PLATFORM_${k}`).toBe(true);
    }
    // The SECRET_KEY purpose-key note (rotation breaks raw text + phone HMAC).
    expect(ENV_EXAMPLE).toMatch(/collections\.raw/);
    expect(ENV_EXAMPLE).toMatch(/collections\.phone/);
  });

  it("8. every COLLECTIONS_* / KASHIER_PLATFORM_* env read in lib/ and app/ is documented", () => {
    const READ_RE =
      /process\.env(?:\.((?:COLLECTIONS|KASHIER_PLATFORM)_[A-Z0-9_]+)|\[\s*["'`]((?:COLLECTIONS|KASHIER_PLATFORM)_[A-Z0-9_]+)["'`]\s*\])/g;
    const found = new Map<string, string>();
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name)) {
          for (const m of readFileSync(p, "utf8").matchAll(READ_RE)) {
            found.set(m[1] ?? m[2], path.relative(WEB, p));
          }
        }
      }
    };
    walk(path.join(WEB, "lib"));
    walk(path.join(WEB, "app"));
    // flags.ts reads the gate variables today; guard against a vacuous pass.
    expect(found.has("COLLECTIONS_ENABLED")).toBe(true);
    for (const [name, file] of found) {
      expect(hasKeyLine(name), `${name} (read in ${file}) is not in .env.example`).toBe(true);
    }
  });
});
