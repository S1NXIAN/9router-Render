let started = false;

// ponytail: single setInterval, native fetch, no deps. Keeps Render free tier warm (15m spin-down).
// Upgrade if needed: external cron (UptimeRobot) instead of in-process ping.
export function startSelfPing() {
  if (started) return;
  if (process.env.SELF_PING_ENABLED === "false") return;
  if (process.env.NODE_ENV !== "production") return;
  started = true;

  const intervalMs = Math.max(60_000, parseInt(process.env.SELF_PING_INTERVAL_MS || "840000", 10)); // 14m default, <free spin-down (15m)
  const url =
    process.env.SELF_PING_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    process.env.BASE_URL ||
    `http://127.0.0.1:${process.env.PORT || 10000}`;

  const pingUrl = url.replace(/\/$/, "") + "/health";

  const ping = async () => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      await fetch(pingUrl, { signal: ctrl.signal, cache: "no-store" });
      clearTimeout(t);
    } catch {}
  };

  // jitter 0-30s to avoid thundering herd if many instances
  const jitter = Math.floor(Math.random() * 30000);
  const timer = setInterval(ping, intervalMs);
  if (timer.unref) timer.unref();
  // first ping slightly delayed to let server fully boot
  setTimeout(ping, 30000 + jitter).unref?.();
}
