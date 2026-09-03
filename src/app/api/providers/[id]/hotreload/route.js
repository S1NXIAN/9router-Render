// Ensure proxyFetch is loaded to patch globalThis.fetch
import "open-sse/index.js";

import { getProviderConnectionById, updateProviderConnection } from "@/lib/db/index.js";
import { getExecutor } from "open-sse/executors/index.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { refreshAndUpdateCredentials } from "@/app/api/usage/[connectionId]/route";
import { getUsageForProvider } from "open-sse/services/usage.js";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import { getHotReloadConfig } from "@/shared/constants/config";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";
import { getModelUpstreamId, PROVIDER_ID_TO_ALIAS } from "open-sse/config/providerModels.js";
import { applyThinking, stripThinkingSuffix } from "open-sse/translator/concerns/thinkingUnified.js";

const HOTRELOAD_TIMEOUT_MS = 10000;
const HOTRELOAD_RETRIES = 3; // connect failures retry up to 3x with backoff
const RETRY_BACKOFF_MS = 1200;
const USAGE_SETTLE_MS = 2500; // quota count moves after the poke lands
const USAGE_VERIFY_ATTEMPTS = 3; // quota updates are delayed; retry the probe before declaring failure
const USAGE_VERIFY_INTERVAL_MS = 4000;
const EXCERPT_TIMEOUT_MS = 3000;
const EXCERPT_MAX_CHARS = 300;

/**
 * One poke-plan entry per quota family. Older configs without `families`
 * fall back to one entry per model so new code keeps working with them.
 */
export function getHotReloadFamilies(cfg) {
  const families = cfg?.families;
  if (!families || typeof families !== "object") {
    return (cfg?.models || []).map((m) => ({ family: m, representative: m, fallback: null }));
  }
  return Object.entries(families).map(([family, f]) => ({
    family,
    representative: f.representative,
    fallback: f.fallback || null,
  }));
}

/** Flattened poke order: representative-first per family, de-duplicated. */
export function getHotReloadTargets(cfg) {
  const out = [];
  for (const { representative, fallback } of getHotReloadFamilies(cfg)) {
    for (const m of [representative, fallback]) {
      if (m && !out.includes(m)) out.push(m);
    }
  }
  return out;
}

function remainingOf(quota) {
  if (!quota) return null;
  if (quota.remaining != null) return Number(quota.remaining);
  if (quota.total != null || quota.used != null) {
    return Number(quota.total ?? 0) - Number(quota.used ?? 0);
  }
  return null;
}

/**
 * 429-aware verify predicate. A family counts as moving when it has quota
 * left (remaining > 0) OR an exhausted quota with a running countdown
 * (future resetAt) — an active countdown means the poke landed and the
 * window is rolling, which is the whole point of a hot reload.
 */
export function isQuotaActive(quota, nowMs = Date.now()) {
  if (!quota) return false;
  if (quota.unlimited) return true;
  const remaining = remainingOf(quota);
  if (remaining != null && remaining > 0) return true;
  const resetMs = quota.resetAt ? new Date(quota.resetAt).getTime() : NaN;
  if (Number.isFinite(resetMs) && resetMs > nowMs) return true;
  return false;
}

/**
 * Shape the POST response. `reloaded` is a per-model verdict: true when ANY
 * family both landed its poke and moved its counter — never all-or-nothing
 * across independent families. Legacy fields (`poked`, `pokedModels`,
 * `failedModels`, `quotaMoved`, `remainingByModel`, `error`) are kept so old
 * dashboard code keeps working; `perFamily`/`perModel` carry the detail.
 */
export function buildHotReloadResponse({ families, perModel = {}, remainingByModel = {}, connectionId }) {
  const perFamily = {};
  for (const f of families || []) {
    perFamily[f.family] = {
      representative: f.representative,
      fallback: f.fallback ?? null,
      poked: !!f.poked,
      moved: !!f.moved,
      reloaded: !!f.poked && !!f.moved,
      fallbackUsed: !!f.fallbackUsed,
    };
  }
  const pokedModels = Object.fromEntries(
    Object.entries(perModel).map(([m, d]) => [m, !!d?.poked]),
  );
  const failedModels = Object.entries(perModel)
    .filter(([, d]) => !d?.poked)
    .map(([m]) => m);
  const moved = (families || []).some((f) => f.moved);
  const reloaded = (families || []).some((f) => f.poked && f.moved);
  return {
    ok: true,
    reloaded,
    poked: failedModels.length === 0,
    pokedModels,
    failedModels,
    quotaMoved: moved,
    perFamily,
    perModel,
    remainingByModel,
    connectionId,
    error: reloaded
      ? null
      : (failedModels.length > 0
          ? `Poke failed after retries for: ${failedModels.join(", ")}.`
          : "Quota still 0/1000 — hot reload did not move the count."),
  };
}

// Best-effort upstream body excerpt for diagnostics (fail-open, time-boxed:
// SSE streams otherwise hang the read until the server closes them).
async function readExcerpt(res) {
  try {
    const text = await Promise.race([
      res.clone().text(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("excerpt-timeout")), EXCERPT_TIMEOUT_MS)),
    ]);
    return (text || "").slice(0, EXCERPT_MAX_CHARS);
  } catch {
    return "";
  }
}

/**
 * Poke one model. A poke's goal is that the request REACHES the upstream and
 * bills the connection's real project — not a clean 2xx. Google's transport
 * commonly answers 5xx or drops the stream AFTER processing ("operation was
 * aborted due to timeout" then it works). Any server response (2xx/429/5xx)
 * and any in-flight abort count as landed; only connect failures retry, auth
 * failures (401/403) never retry and are reported so the caller can try the
 * family's fallback model instead.
 *
 * The body is the executor's transformed request sent verbatim (same as the
 * real chat path), with the tiered-model upstream id + thinking level
 * resolved first — a bare echo of the public model id bills the wrong pool
 * or gets rejected for tiered models like gemini-3.8-flash-low(low).
 */
async function pokeModel(executor, model, connection, proxyOptions, alias) {
  const contents = [{ role: "user", parts: [{ text: "hi" }] }];
  const generationConfig = { maxOutputTokens: 1, temperature: 0 };
  let upstreamModel = model;
  try {
    const resolved = getModelUpstreamId(alias, model);
    if (resolved) upstreamModel = resolved;
  } catch {
    // fail-open: poke with the plain id
  }
  const body = { model: stripThinkingSuffix(upstreamModel), request: { contents, generationConfig } };
  try {
    applyThinking("antigravity", upstreamModel, body, "antigravity");
  } catch {
    // fail-open: poke without thinking config
  }
  let transformed;
  try {
    // Method calls, not destructured — transformRequest writes this._lastSessionId.
    transformed = executor.transformRequest(model, body, true, {
      accessToken: connection.accessToken,
      projectId: connection.projectId,
      email: connection.email || connection.name,
      connectionId: connection.id,
    });
  } catch (error) {
    return { ok: false, status: null, error: error?.message || "transform failed" };
  }
  const url = executor.buildUrl(model, true);
  const headers = executor.buildHeaders({ accessToken: connection.accessToken });
  // Verbatim transformed body — the real path stringifies transformRequest's
  // output as-is; re-wrapping the raw input here used to drop sessionId,
  // contents fixes and generationConfig caps.
  const bodyStr = JSON.stringify(transformed);

  let attempt = 0;
  while (attempt <= HOTRELOAD_RETRIES) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HOTRELOAD_TIMEOUT_MS);
    let res = null;
    let error = null;
    try {
      res = await proxyAwareFetch(url, { method: "POST", headers, body: bodyStr, signal: controller.signal }, proxyOptions);
    } catch (e) {
      error = e;
    } finally {
      clearTimeout(timer);
    }

    if (res) {
      const ok = res.status !== 401 && res.status !== 403;
      const excerpt = ok && res.status !== 429 ? "" : await readExcerpt(res);
      await res.body?.cancel?.().catch?.(() => {});
      return {
        ok,
        status: res.status,
        ...(ok ? {} : { error: `HTTP ${res.status}${excerpt ? `: ${excerpt}` : ""}` }),
      };
    }
    const msg = `${error?.message || ""} ${error?.cause?.message || ""}`.toLowerCase();
    if (error?.name === "AbortError" || msg.includes("aborted") || msg.includes("timeout")) {
      return { ok: true, status: null };
    }
    if (attempt >= HOTRELOAD_RETRIES) {
      return { ok: false, status: null, error: error?.message || "connect failed" };
    }
    attempt += 1;
    await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS));
  }
  return { ok: false, status: null, error: "connect failed" };
}

/**
 * Verify counters actually moved, per model. Quota updates lag (the
 * "in 7d 0h 0m" text takes a while to tick), so probe usage a few times
 * before declaring failure. Returns { movedByModel, remainingByModel, quotas }.
 */
async function verifyQuotaMoved(connection, proxyOptions, models) {
  const remainingByModel = {};
  const movedByModel = {};
  const quotas = {};
  for (const model of models) {
    remainingByModel[model] = null;
    movedByModel[model] = false;
    quotas[model] = null;
  }
  for (let attempt = 0; attempt < USAGE_VERIFY_ATTEMPTS; attempt += 1) {
    try {
      const usage = await getUsageForProvider(connection, proxyOptions);
      const fresh = usage?.quotas || {};
      let allMoved = true;
      for (const model of models) {
        const quota = fresh[model] || null;
        quotas[model] = quota;
        const moved = isQuotaActive(quota);
        movedByModel[model] = movedByModel[model] || moved;
        remainingByModel[model] = quota ? remainingOf(quota) : null;
        if (!movedByModel[model]) allMoved = false;
      }
      if (allMoved) return { movedByModel, remainingByModel, quotas };
    } catch {
      // upstream usage probe may be flaky too — retry
    }
    if (attempt < USAGE_VERIFY_ATTEMPTS - 1) {
      await new Promise((resolve) => setTimeout(resolve, USAGE_VERIFY_INTERVAL_MS));
    }
  }
  return { movedByModel, remainingByModel, quotas };
}

/**
 * POST /api/providers/[id]/hotreload
 * Poke one connection with a tiny upstream request so the provider rolls its
 * quota window forward immediately. Targets driven by HOT_RELOAD_CONFIG
 * families: one representative poke per quota family (plus a 401/403-only
 * fallback inside the family), verified per family.
 */
export async function POST(_request, { params }) {
  const { id } = await params;
  const connection = await getProviderConnectionById(id);
  if (!connection) {
    return Response.json({ ok: false, error: "Connection not found", connectionId: id }, { status: 404 });
  }

  const cfg = getHotReloadConfig(connection.provider, connection.authType);
  if (!cfg || !cfg.models?.length) {
    return Response.json({ ok: false, error: `Hot reload is not configured for ${connection.provider} (${connection.authType}).`, connectionId: id }, { status: 400 });
  }

  try {
    const proxyCfg = await resolveConnectionProxyConfig(connection.providerSpecificData || {});
    const proxyOptions = {
      connectionProxyEnabled: proxyCfg.connectionProxyEnabled === true,
      connectionProxyUrl: proxyCfg.connectionProxyUrl || "",
      connectionNoProxy: proxyCfg.connectionNoProxy || "",
      vercelRelayUrl: proxyCfg.vercelRelayUrl || "",
      strictProxy: false,
    };

    const refreshed = await refreshAndUpdateCredentials(connection, false, proxyOptions);
    // Pin the real project id like the chat path does: a random generated id
    // bills a throwaway project while the verifier reads the real one, so the
    // count can never move. Refuse loudly instead of poking nowhere.
    let pinned = refreshed.connection;
    if (!pinned.projectId) {
      let pid = null;
      try {
        pid = await getProjectIdForConnection(pinned.id, pinned.accessToken, pinned.provider);
      } catch {
        pid = null;
      }
      if (!pid) {
        return Response.json({ ok: false, error: "could not resolve projectId, refusing random-project poke", connectionId: id }, { status: 500 });
      }
      try {
        await updateProviderConnection(pinned.id, { projectId: pid });
      } catch {
        // fail-open: poke with the in-memory id even if persisting failed
      }
      pinned = { ...pinned, projectId: pid };
    }

    const alias = PROVIDER_ID_TO_ALIAS[pinned.provider] || pinned.provider;
    const executor = getExecutor(pinned.provider);
    const plan = getHotReloadFamilies(cfg);

    // Best-effort before-snapshot for diagnostics (fail-open).
    let beforeQuotas = {};
    try {
      beforeQuotas = (await getUsageForProvider(pinned, proxyOptions))?.quotas || {};
    } catch {
      beforeQuotas = {};
    }

    const perModel = {};
    const families = [];
    for (const { family, representative, fallback } of plan) {
      const rep = await pokeModel(executor, representative, pinned, proxyOptions, alias);
      perModel[representative] = {
        poked: rep.ok,
        httpStatus: rep.status ?? null,
        ...(rep.error ? { error: rep.error } : {}),
        remainingBefore: remainingOf(beforeQuotas[representative] || null),
        fallbackUsed: false,
      };
      let familyPoke = rep;
      let fallbackUsed = false;
      // Model renamed/retired (not quota): try the family's fallback once.
      if (!rep.ok && (rep.status === 401 || rep.status === 403) && fallback && fallback !== representative) {
        fallbackUsed = true;
        const fb = await pokeModel(executor, fallback, pinned, proxyOptions, alias);
        perModel[fallback] = {
          poked: fb.ok,
          httpStatus: fb.status ?? null,
          ...(fb.error ? { error: fb.error } : {}),
          remainingBefore: remainingOf(beforeQuotas[fallback] || null),
          fallbackUsed: true,
        };
        if (fb.ok) familyPoke = fb;
      }
      families.push({
        family,
        representative,
        fallback,
        poked: familyPoke.ok,
        fallbackUsed,
        moved: false,
      });
      perModel[representative].fallbackUsed = fallbackUsed;
    }

    await new Promise((resolve) => setTimeout(resolve, USAGE_SETTLE_MS));
    const verifyModels = getHotReloadTargets(cfg);
    const { movedByModel, remainingByModel, quotas } = await verifyQuotaMoved(pinned, proxyOptions, verifyModels);

    for (const [model, entry] of Object.entries(perModel)) {
      entry.moved = !!movedByModel[model];
      entry.remainingAfter = remainingByModel[model] ?? null;
      entry.resetAt = quotas[model]?.resetAt || null;
    }
    for (const f of families) {
      const repMoved = !!movedByModel[f.representative];
      const fbMoved = f.fallback ? !!movedByModel[f.fallback] : false;
      // One shared counter per family: either reading moving proves the poke.
      f.moved = repMoved || fbMoved;
    }

    return Response.json(buildHotReloadResponse({ families, perModel, remainingByModel, connectionId: id }));
  } catch (error) {
    console.warn(`[HotReload] ${connection.provider}:${connection.id}: ${error.message}`);
    return Response.json({ ok: false, error: error.message, connectionId: connection.id }, { status: 500 });
  }
}
