import { fetch } from "scripting"

// ── Types ─────────────────────────────────────────────────────────────────────
export type SkipType = "op" | "ed" | "recap" | "mixed-op" | "mixed-ed"

export interface SkipInterval {
  startTime:  number    // seconds into episode
  endTime:    number
  skipType:   SkipType
}

// ── API ───────────────────────────────────────────────────────────────────────
const BASE = "https://api.aniskip.com"

/**
 * Fetch OP/ED/recap skip times for one episode.
 * @param malId         MyAnimeList anime ID  (NOT AniList ID — use getIdMal() below)
 * @param episodeNumber 1-based episode number
 * @param episodeLength Optional episode length in seconds for deduplication (0 = all)
 */
export async function fetchSkipTimes(
  malId:         number,
  episodeNumber: number,
  episodeLength  = 0,
): Promise<SkipInterval[]> {
  const url =
    `${BASE}/v2/skip-times/${malId}/${episodeNumber}` +
    `?types[]=op&types[]=ed&types[]=recap&episodeLength=${episodeLength}`

  console.log("[AniSkip] fetching:", url)
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "Consumeting/1.0" },
    })
    console.log("[AniSkip] status:", resp.status)
    if (!resp.ok) return []

    const data = await resp.json()
    if (!data.found || !Array.isArray(data.results)) {
      console.log("[AniSkip] not found for malId", malId, "ep", episodeNumber)
      return []
    }

    const intervals: SkipInterval[] = data.results.map((r: any) => ({
      startTime: Number(r.interval.startTime),
      endTime:   Number(r.interval.endTime),
      skipType:  r.skipType as SkipType,
    }))
    console.log("[AniSkip] found", intervals.length, "intervals:", intervals.map(i => i.skipType))
    return intervals
  } catch (e) {
    console.error("[AniSkip] fetch error:", e)
    return []
  }
}

/**
 * Resolve a MAL ID from an AniList media ID.
 * AniList's GraphQL API exposes idMal on every Media node.
 */
export async function getIdMalFromAnilist(anilistId: number): Promise<number | null> {
  const query = `query($id:Int){Media(id:$id,type:ANIME){idMal}}`
  try {
    const resp = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { id: anilistId } }),
    })
    const data = await resp.json()
    const idMal = data?.data?.Media?.idMal
    console.log("[AniSkip] AniList idMal for", anilistId, "→", idMal)
    return typeof idMal === "number" ? idMal : null
  } catch (e) {
    console.error("[AniSkip] AniList lookup error:", e)
    return null
  }
}

/**
 * Convenience: look up MAL ID by anime title (fuzzy search via AniList).
 * Returns the best match's MAL ID or null.
 */
export async function getIdMalByTitle(title: string): Promise<number | null> {
  const query = `query($s:String){Media(search:$s,type:ANIME){idMal}}`
  try {
    const resp = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { s: title } }),
    })
    const data = await resp.json()
    const idMal = data?.data?.Media?.idMal
    console.log("[AniSkip] title lookup:", title, "→ idMal", idMal)
    return typeof idMal === "number" ? idMal : null
  } catch (e) {
    console.error("[AniSkip] title lookup error:", e)
    return null
  }
}
