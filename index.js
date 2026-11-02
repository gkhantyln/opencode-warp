/**
 * opencode-warp — Cloudflare WARP egress guard for OpenCode.
 *
 * Ne yapar:
 *   - Açılışta çıkış IP'sini ve WARP durumunu doğrular, sonucu loglar.
 *   - `warp_status` aracı: model veya kullanıcı çıkış IP'sini sorgulayabilir.
 *   - `warp_rotate` aracı: WARP tünelini yeniden kurup yeni çıkış IP'si alır.
 *   - `/warp` komutu: durumu oturuma mesaj olarak basar.
 *   - (Opsiyonel) 429 alındığında IP'yi otomatik döndürür.
 *
 * Not: Bu eklenti trafiği WARP'a sokmaz. Tüm cihaz trafiği zaten WARP tünelinden
 * gittiği için (Traffic and DNS mode) OpenCode da otomatik olarak tünelden çıkar.
 * Eklenti bunu doğrular ve gerektiğinde IP'yi yeniler.
 */
import { Plugin } from "@opencode/plugin";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));

const TRACE_URL = "https://www.cloudflare.com/cdn-cgi/trace";
const WARP_CLI_CANDIDATES = [
  "C:\\Program Files\\Cloudflare\\Cloudflare WARP\\warp-cli.exe",
  "C:\\Program Files (x86)\\Cloudflare\\Cloudflare WARP\\warp-cli.exe",
  "warp-cli",
];

const DEFAULTS = {
  verifyOnStart: true,
  logEgress: true,
  rotateOnRateLimit: false,
  rotateCooldownMs: 45_000,
  rotateMaxPerHour: 6,
  rotateWaitMs: 25_000,
  traceTimeoutMs: 8_000,
  cliTimeoutMs: 20_000,
};

// warp.config.json varsa onu, sonra opencode.json içindeki `options` değerlerini uygula.
function loadConfig(options) {
  let file = {};
  try {
    file = JSON.parse(readFileSync(path.join(here, "warp.config.json"), "utf8"));
  } catch {
    file = {};
  }
  const merged = { ...DEFAULTS, ...file, ...(options ?? {}) };
  for (const key of Object.keys(DEFAULTS)) {
    if (typeof DEFAULTS[key] === "boolean" && typeof merged[key] !== "boolean") merged[key] = DEFAULTS[key];
    if (typeof DEFAULTS[key] === "number" && !Number.isFinite(merged[key])) merged[key] = DEFAULTS[key];
  }
  return merged;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...args) => console.log("[warp]", ...args);
const warn = (...args) => console.warn("[warp]", ...args);

/* ------------------------------------------------------------------ WARP CLI */

let resolvedCli;

async function warpCli(args, timeoutMs = DEFAULTS.cliTimeoutMs) {
  const candidates = resolvedCli ? [resolvedCli] : WARP_CLI_CANDIDATES;
  let last;
  for (const candidate of candidates) {
    try {
      const { stdout, stderr } = await run(candidate, args, {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        encoding: "utf8",
      });
      resolvedCli = candidate;
      return `${stdout ?? ""}${stderr ?? ""}`.trim();
    } catch (error) {
      last = error;
      // Komut bulunamadıysa sıradaki adayı dene; bulundu ama başarısız olduysa dur.
      if (error?.code !== "ENOENT") break;
    }
  }
  throw last ?? new Error("warp-cli bulunamadı");
}

async function cliStatus(timeoutMs) {
  try {
    const raw = await warpCli(["status"], timeoutMs);
    const connected = /connected/i.test(raw) && !/disconnected/i.test(raw);
    return { ok: true, connected, raw };
  } catch (error) {
    return { ok: false, connected: false, raw: String(error?.message ?? error) };
  }
}

/* --------------------------------------------------------------- Egress trace */

/** Cloudflare'in trace endpoint'i: ip / loc / colo / warp alanları. */
async function trace({ timeoutMs = DEFAULTS.traceTimeoutMs, signal } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch(TRACE_URL, {
    signal: combined,
    headers: { "cache-control": "no-store", accept: "text/plain" },
  });
  if (!response.ok) throw new Error(`trace HTTP ${response.status}`);
  const text = await response.text();
  const fields = {};
  for (const line of text.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) fields[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return fields;
}

/** WARP'ın bilinen çıkış aralıkları. Bilgi amaçlı: yanlış negatif vermesin diye geniş tutuldu. */
function looksLikeWarpIp(ip) {
  if (!ip) return false;
  if (/^2a09:bac[0-9a-f]:/i.test(ip)) return true; // 2a09:bac0::/29 civarı
  if (/^2606:4700:/i.test(ip)) return true; // Cloudflare edge aralığı
  if (/^104\.28\./.test(ip)) return true;
  if (/^172\.(6[4-9]|7[01])\./.test(ip)) return true;
  return false;
}

function verdictOf(info) {
  if (!info.trace.ok) return "UNKNOWN — çıkış IP'si okunamadı (ağ/trace hatası).";
  if (info.trace.warp === "on" || info.trace.warp === "plus") {
    if (!looksLikeWarpIp(info.trace.ip)) {
      return `OK (warp=on) — tünel üzerinden çıkıyor. IP (${info.trace.ip}) tanıdık WARP aralığında değil; bilgilendirme amaçlı.`;
    }
    return "OK — trafik Cloudflare WARP üzerinden çıkıyor.";
  }
  return "PROBLEM — warp=off: trafik tünelsiz çıkıyor. WARP bağlı mı ve split tunnel'da hedef hariç tutulmuş mu?";
}

async function inspect({ signal, timeoutMs } = {}) {
  const [cli, tr] = await Promise.all([
    cliStatus(timeoutMs),
    trace({ timeoutMs: timeoutMs ?? DEFAULTS.traceTimeoutMs, signal }).then(
      (fields) => ({ ok: true, ...fields }),
      (error) => ({ ok: false, error: String(error?.message ?? error) }),
    ),
  ]);
  const info = { cli, trace: tr, at: new Date().toISOString() };
  info.verdict = verdictOf(info);
  return info;
}

function formatInfo(info) {
  const t = info.trace ?? {};
  const lines = [
    "Cloudflare WARP çıkış durumu",
    `  zaman        : ${info.at}`,
    `  warp-cli     : ${info.cli.ok ? (info.cli.connected ? "Connected" : "Disconnected") : "erişilemiyor"}`,
    `  warp         : ${t.ok ? (t.warp ?? "?") : "okunamadı"}`,
    `  çıkış IP     : ${t.ok ? (t.ip ?? "?") : (t.error ?? "?")}`,
    `  konum / colo : ${t.ok ? `${t.loc ?? "?"} / ${t.colo ?? "?"}` : "?"}`,
    `  gateway      : ${t.ok ? (t.gateway ?? "?") : "?"}`,
    `  sonuç        : ${info.verdict}`,
  ];
  return lines.join("\n");
}

/** Tünel geri gelene ve geçerli bir çıkış IP'si görünene kadar bekle. */
async function waitForEgress({ timeoutMs, signal } = {}) {
  const deadline = Date.now() + (timeoutMs ?? DEFAULTS.rotateWaitMs);
  let last = null;
  while (Date.now() < deadline) {
    try {
      const fields = await trace({ timeoutMs: 6_000, signal });
      last = fields;
      if ((fields.warp === "on" || fields.warp === "plus") && fields.ip) return fields;
    } catch {
      // tünel yeniden kurulurken hata normal
    }
    await sleep(2_000);
  }
  return last;
}

/* ---------------------------------------------------------------- IP rotation */

const rotation = { inflight: null, lastAt: 0, history: [] };

function budget(cfg) {
  const now = Date.now();
  rotation.history = rotation.history.filter((at) => now - at < 3_600_000);
  if (rotation.inflight) return { allowed: false, reason: "zaten döndürülüyor" };
  if (rotation.history.length >= cfg.rotateMaxPerHour) return { allowed: false, reason: "saatlik limit doldu" };
  if (now - rotation.lastAt < cfg.rotateCooldownMs) return { allowed: false, reason: "cooldown" };
  return { allowed: true };
}

async function doRotate(cfg) {
  const before = await trace({ timeoutMs: cfg.traceTimeoutMs }).catch(() => null);
  let last = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await warpCli(["disconnect"], cfg.cliTimeoutMs);
    } catch (error) {
      warn("disconnect başarısız:", error?.message ?? error);
    }
    await sleep(1_500);
    try {
      await warpCli(["connect"], cfg.cliTimeoutMs);
    } catch (error) {
      warn("connect başarısız:", error?.message ?? error);
    }
    last = await waitForEgress({ timeoutMs: cfg.rotateWaitMs });
    if (last?.ip && last.ip !== before?.ip) {
      return { changed: true, attempts: attempt, before: before?.ip ?? null, after: last.ip, trace: last };
    }
    log(`deneme ${attempt}: IP değişmedi (${last?.ip ?? "bilinmiyor"})`);
  }

  return { changed: false, attempts: 3, before: before?.ip ?? null, after: last?.ip ?? null, trace: last };
}

/** Aynı anda iki oturum döndürme yapmasın. */
async function rotateEgress(cfg) {
  if (rotation.inflight) return rotation.inflight;
  rotation.inflight = doRotate(cfg)
    .then((result) => {
      rotation.lastAt = Date.now();
      rotation.history.push(rotation.lastAt);
      return result;
    })
    .finally(() => {
      rotation.inflight = null;
    });
  return rotation.inflight;
}

/* -------------------------------------------------------------------- Plugin */

/** Bağımsız doğrulama betiği (dogrula.mjs) için iç fonksiyonlar. */
export const diagnostics = { inspect, formatInfo, rotateEgress, loadConfig, trace, warpCli, waitForEgress };

export default Plugin.define({
  id: "warp",

  async setup(ctx) {
    const cfg = loadConfig(ctx.options);
    log(`yüklendi (OpenCode ${ctx.app?.version ?? "?"}) · rotateOnRateLimit=${cfg.rotateOnRateLimit}`);

    // Açılış doğrulaması: engellemeden arka planda çalışsın.
    if (cfg.verifyOnStart) {
      void inspect()
        .then((info) => {
          if (cfg.logEgress) log("\n" + formatInfo(info));
          if (!info.trace.ok || !(info.trace.warp === "on" || info.trace.warp === "plus")) {
            warn("DİKKAT: çıkış WARP üzerinden görünmüyor. `warp-cli status` ve split tunnel ayarlarını kontrol et.");
          }
        })
        .catch((error) => warn("açılış doğrulaması yapılamadı:", error?.message ?? error));
    }

    /* Araçlar ------------------------------------------------------------- */

    const tools = await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "warp",
        description: "Cloudflare WARP çıkış durumu ve IP döndürme araçları.",
      });

      editor.add({
        name: "status",
        description:
          "Cloudflare WARP çıkış durumunu gösterir: warp=on/off, çıkış IP'si, ülke ve colo. " +
          "Trafiğin gerçekten WARP tünelinden çıkıp çıkmadığını doğrulamak için kullan.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { namespace: "warp" },
        execute: async (_input, context) => {
          const info = await inspect({ signal: context?.signal, timeoutMs: cfg.traceTimeoutMs });
          return {
            content: formatInfo(info),
            metadata: {
              warp: info.trace.ok ? (info.trace.warp ?? null) : null,
              ip: info.trace.ok ? (info.trace.ip ?? null) : null,
              colo: info.trace.ok ? (info.trace.colo ?? null) : null,
              loc: info.trace.ok ? (info.trace.loc ?? null) : null,
              connected: info.cli.connected,
            },
          };
        },
      });

      editor.add({
        name: "rotate",
        description:
          "WARP tünelini yeniden kurar ve yeni bir çıkış IP'si almaya çalışır. " +
          "IP'ye bağlı rate limit (429) veya bölge engeli şüphesinde kullan.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { namespace: "warp" },
        execute: async (_input, context) => {
          const gate = budget(cfg);
          if (!gate.allowed) {
            return { content: `IP döndürülmedi: ${gate.reason}. Biraz bekleyip tekrar dene.` };
          }
          const result = await rotateEgress(cfg);
          const lines = [
            result.changed ? "Yeni WARP çıkış IP'si alındı." : "IP değişmedi (WARP aynı çıkış IP'sini verdi).",
            `  önce : ${result.before ?? "?"}`,
            `  sonra: ${result.after ?? "?"}`,
            `  deneme: ${result.attempts}`,
            `  warp : ${result.trace?.warp ?? "?"}`,
          ];
          if (!result.changed) {
            lines.push("Not: WARP aynı colo havuzundan aynı adresi verebilir; birkaç denemede değişmezse IP bazlı çözüm güvenilir değildir.");
          }
          return { content: lines.join("\n"), metadata: { ...result, trace: undefined } };
        },
      });
    });

    /* Komut --------------------------------------------------------------- */

    const commands = await ctx.command.transform((editor) => {
      editor.add({
        name: "warp",
        description: "WARP çıkış durumunu göster (IP, ülke, colo, warp on/off).",
        execute: async ({ sessionID }) => {
          const info = await inspect({ timeoutMs: cfg.traceTimeoutMs });
          const text = formatInfo(info);
          log("\n" + text);
          // Sohbette görünür bir bilgi satırı bırak; modeli çalıştırmaz.
          await ctx.session.synthetic({ sessionID, text, description: "WARP status", resume: false }).catch((error) => {
            warn("synthetic mesaj yazılamadı:", error?.message ?? error);
          });
        },
      });
    });

    /* 429 üzerine otomatik döndürme --------------------------------------- */

    let retryHook;
    if (cfg.rotateOnRateLimit) {
      retryHook = await ctx.session.hook("retry", async (event) => {
        const error = event.error ?? {};
        // Yalnızca IP'ye bağlı olabilecek hatalar. Kota/faturalandırma IP ile çözülmez.
        const looksRateLimited = error.status === 429;
        if (!looksRateLimited) return;

        const body = `${error.message ?? ""} ${error.response?.body ?? ""}`;
        if (/billing|quota|credit|balance|insufficient|payment|plan limit/i.test(body)) return;

        const gate = budget(cfg);
        if (!gate.allowed) {
          // Döndüremiyorsak en azından anlamlı bir bekleme ver.
          event.decision = { retry: true, delay: Math.max(cfg.rotateCooldownMs, error.retryAfterMs ?? 0) };
          return;
        }

        log(`429 alındı (deneme ${event.attempt}); WARP IP'si döndürülüyor`);
        const result = await rotateEgress(cfg);
        log(`döndürme sonucu: ${result.before ?? "?"} -> ${result.after ?? "?"} (değişti=${result.changed})`);

        event.decision = {
          retry: true,
          delay: result.changed ? 2_000 : Math.max(15_000, error.retryAfterMs ?? 0),
        };
      });
    } else {
      log("otomatik IP döndürme kapalı (warp.config.json → rotateOnRateLimit).");
    }

    return async () => {
      await tools?.dispose?.().catch(() => {});
      await commands?.dispose?.().catch(() => {});
      await retryHook?.dispose?.().catch(() => {});
    };
  },
});
