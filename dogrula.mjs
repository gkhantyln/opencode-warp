/**
 * opencode-warp bagimsiz dogrulama betigi.
 *
 *   node dogrula.mjs           -> durumu goster
 *   node dogrula.mjs --rotate  -> once IP dondur, sonra goster
 *
 * Plugin'in kullandigi ayni kodu calistirir; OpenCode acmadan test etmek icin.
 * Cikis kodu 0 = trafik WARP uzerinden, 1 = degil / okunamadi.
 */
import { diagnostics } from "./index.js";

const cfg = diagnostics.loadConfig({});

if (process.argv.includes("--rotate")) {
  console.log("IP donduruluyor...");
  const result = await diagnostics.rotateEgress(cfg);
  const changed = String(result.changed);
  console.log(`  ${result.before ?? "?"} -> ${result.after ?? "?"} (degisti=${changed}, deneme=${result.attempts})`);
}

const info = await diagnostics.inspect({ timeoutMs: cfg.traceTimeoutMs });
console.log("");
console.log(diagnostics.formatInfo(info));

const ok = info.trace.ok && (info.trace.warp === "on" || info.trace.warp === "plus");
// process.exit kullanma: undici soketleri kapanirken Node 24'te assert tetikleyebiliyor.
process.exitCode = ok ? 0 : 1;
