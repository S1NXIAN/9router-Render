import { describe, expect, it } from "vitest";

import { getHotReloadConfig, getStuckFamilies } from "../../src/shared/constants/config.js";
import {
  buildHotReloadResponse,
  getHotReloadFamilies,
  getHotReloadTargets,
  isQuotaActive,
} from "../../src/app/api/providers/[id]/hotreload/route.js";

const FUTURE = new Date(Date.now() + 6 * 24 * 3600 * 1000).toISOString();
const PAST = new Date(Date.now() - 3600 * 1000).toISOString();

describe("antigravity hot reload: quota families", () => {
  it("groups antigravity into a gemini family and a claude-oss family", () => {
    const cfg = getHotReloadConfig("antigravity", "oauth");

    expect(cfg.families.gemini).toMatchObject({
      representative: "gemini-3.8-flash-low",
      fallback: "gemini-3.7-flash-low",
    });
    expect(cfg.families["claude-oss"]).toMatchObject({
      representative: "gpt-oss-120b-medium",
    });
  });

  it("keeps a flattened models list for existing callers", () => {
    const cfg = getHotReloadConfig("antigravity", "oauth");

    expect(cfg.models).toContain("gemini-3.8-flash-low");
    expect(cfg.models).toContain("gpt-oss-120b-medium");
  });

  it("orders poke targets representative-first per family", () => {
    const cfg = getHotReloadConfig("antigravity", "oauth");

    expect(getHotReloadTargets(cfg)).toEqual([
      "gemini-3.8-flash-low",
      "gemini-3.7-flash-low",
      "gpt-oss-120b-medium",
    ]);
  });

  it("returns one plan entry per family", () => {
    const cfg = getHotReloadConfig("antigravity", "oauth");

    expect(getHotReloadFamilies(cfg)).toEqual([
      {
        family: "gemini",
        representative: "gemini-3.8-flash-low",
        fallback: "gemini-3.7-flash-low",
      },
      {
        family: "claude-oss",
        representative: "gpt-oss-120b-medium",
        fallback: null,
      },
    ]);
  });

  it("stays unconfigured for other providers", () => {
    expect(getHotReloadConfig("openai", "apikey")).toBeNull();
  });

  it("names stuck families from a perFamily map", () => {
    expect(getStuckFamilies({
      gemini: { reloaded: true },
      "claude-oss": { reloaded: false },
    })).toEqual(["claude-oss"]);
    expect(getStuckFamilies({
      gemini: { reloaded: true },
      "claude-oss": { reloaded: true },
    })).toEqual([]);
    expect(getStuckFamilies(null)).toEqual([]);
    expect(getStuckFamilies(undefined)).toEqual([]);
  });
});

describe("antigravity hot reload: 429-aware verify predicate", () => {
  it("treats missing quota as stuck", () => {
    expect(isQuotaActive(null)).toBe(false);
    expect(isQuotaActive(undefined)).toBe(false);
  });

  it("treats untouched 0/1000 with no countdown as stuck", () => {
    expect(isQuotaActive({ used: 1000, total: 1000, resetAt: null })).toBe(false);
    expect(isQuotaActive({ remaining: 0, total: 1000, resetAt: null })).toBe(false);
  });

  it("treats a full untouched window as moving", () => {
    expect(isQuotaActive({ used: 0, total: 1000, resetAt: null })).toBe(true);
  });

  it("treats consumed quota as moving", () => {
    expect(isQuotaActive({ used: 150, total: 1000, resetAt: null })).toBe(true);
    expect(isQuotaActive({ remaining: 850, total: 1000, resetAt: null })).toBe(true);
  });

  it("treats exhausted quota with a running countdown as moving", () => {
    expect(isQuotaActive({ used: 1000, total: 1000, resetAt: FUTURE })).toBe(true);
  });

  it("treats exhausted quota with an expired countdown as stuck", () => {
    expect(isQuotaActive({ used: 1000, total: 1000, resetAt: PAST })).toBe(false);
  });

  it("treats unlimited quota as moving", () => {
    expect(isQuotaActive({ unlimited: true, used: 0, total: 1000 })).toBe(true);
  });
});

describe("antigravity hot reload: response shape", () => {
  const families = [
    {
      family: "gemini",
      representative: "gemini-3.8-flash-low",
      fallback: "gemini-3.7-flash-low",
      poked: true,
      moved: true,
      fallbackUsed: false,
    },
    {
      family: "claude-oss",
      representative: "gpt-oss-120b-medium",
      fallback: null,
      poked: true,
      moved: true,
      fallbackUsed: false,
    },
  ];
  const perModel = {
    "gemini-3.8-flash-low": { poked: true, httpStatus: 200, moved: true, remainingBefore: 0, remainingAfter: 999, resetAt: FUTURE, fallbackUsed: false },
    "gpt-oss-120b-medium": { poked: true, httpStatus: 200, moved: true, remainingBefore: 0, remainingAfter: 999, resetAt: FUTURE, fallbackUsed: false },
  };
  const remainingByModel = { "gemini-3.8-flash-low": 999, "gpt-oss-120b-medium": 999 };

  it("reports reloaded with per-family detail when every family moved", () => {
    const res = buildHotReloadResponse({ families, perModel, remainingByModel, connectionId: "c1" });

    expect(res).toMatchObject({ ok: true, reloaded: true, error: null, connectionId: "c1" });
    expect(res.perFamily.gemini).toMatchObject({ reloaded: true, moved: true, poked: true });
    expect(res.perFamily["claude-oss"]).toMatchObject({ reloaded: true });
    expect(res.failedModels).toEqual([]);
  });

  it("reports reloaded when any family moved (per-model verdict, not all-or-nothing)", () => {
    const partial = families.map((f) => (f.family === "claude-oss" ? { ...f, moved: false } : f));
    const res = buildHotReloadResponse({
      families: partial,
      perModel: { ...perModel, "gpt-oss-120b-medium": { poked: true, httpStatus: 429, moved: false, remainingBefore: 0, remainingAfter: 0, resetAt: null, fallbackUsed: false } },
      remainingByModel: { "gemini-3.8-flash-low": 999, "gpt-oss-120b-medium": 0 },
      connectionId: "c1",
    });

    expect(res.reloaded).toBe(true);
    expect(res.perFamily["claude-oss"]).toMatchObject({ reloaded: false, moved: false });
  });

  it("keeps the legacy stuck-count error when pokes landed but nothing moved", () => {
    const stuck = families.map((f) => ({ ...f, moved: false }));
    const res = buildHotReloadResponse({
      families: stuck,
      perModel: {},
      remainingByModel: { "gemini-3.8-flash-low": 0, "gpt-oss-120b-medium": 0 },
      connectionId: "c1",
    });

    expect(res).toMatchObject({
      ok: true,
      reloaded: false,
      error: "Quota still 0/1000 — hot reload did not move the count.",
    });
  });

  it("names the failed models when a poke never landed", () => {
    const failed = [
      { ...families[0], poked: false, moved: false },
      families[1],
    ];
    const res = buildHotReloadResponse({
      families: failed,
      perModel: { "gemini-3.8-flash-low": { poked: false, httpStatus: 401, moved: false, remainingBefore: 0, remainingAfter: null, resetAt: null, fallbackUsed: false } },
      remainingByModel: { "gemini-3.8-flash-low": null, "gpt-oss-120b-medium": 999 },
      connectionId: "c1",
    });

    expect(res.reloaded).toBe(true);
    expect(res.poked).toBe(false);
    expect(res.failedModels).toEqual(["gemini-3.8-flash-low"]);
    // Partial success: no top-level error (legacy null-on-reloaded contract);
    // the failed family is visible in perFamily/perModel detail.
    expect(res.error).toBeNull();
    expect(res.perFamily.gemini).toMatchObject({ reloaded: false, poked: false });
    expect(res.perFamily["claude-oss"]).toMatchObject({ reloaded: true });
  });

  it("names the failed models when nothing moved and a poke never landed", () => {
    const failed = families.map((f) => ({ ...f, poked: false, moved: false }));
    const res = buildHotReloadResponse({
      families: failed,
      perModel: {
        "gemini-3.8-flash-low": { poked: false, httpStatus: 401, moved: false, remainingBefore: 0, remainingAfter: null, resetAt: null, fallbackUsed: false },
        "gpt-oss-120b-medium": { poked: false, httpStatus: null, moved: false, remainingBefore: 0, remainingAfter: null, resetAt: null, fallbackUsed: false },
      },
      remainingByModel: { "gemini-3.8-flash-low": null, "gpt-oss-120b-medium": null },
      connectionId: "c1",
    });

    expect(res).toMatchObject({ ok: true, reloaded: false, poked: false });
    expect(res.failedModels).toEqual(["gemini-3.8-flash-low", "gpt-oss-120b-medium"]);
    expect(res.error).toContain("Poke failed after retries for:");
  });
});
