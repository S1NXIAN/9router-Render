# 9Router

Local AI routing gateway + Next.js dashboard. One OpenAI-compatible endpoint routes traffic across upstream providers with format translation, fallback, OAuth credential management, and quota tracking.

## Language

**Hot reload**:
Poking the upstream so a pending 7-day quota countdown starts now, not a data refresh.
_Avoid_: refresh, re-sync, quota reset

**Poke**:
One tiny upstream request (`hi` / `maxOutputTokens: 1`) billed to the connection's real project. Its goal is reaching upstream, not a clean 2xx.
_Avoid_: ping, probe, warm-up

**Landed**:
A poke that reached upstream: any 2xx/429/5xx or in-flight abort. Only 401/403 and retried connect failures count as not landed.
_Avoid_: success, 2xx

**Quota family**:
Models drawing from one shared counter. `gemini/*` is one family, `claude/* + gpt-oss/*` is another; one representative poke per family covers all.
_Avoid_: quota group, bucket, pool

**Reloaded**:
Per-family verdict: the poke landed and the counter shows moving (`remaining > 0` or an exhausted quota with a running countdown). Never all-or-nothing across families.
_Avoid_: reloaded (all-or-nothing), synced
