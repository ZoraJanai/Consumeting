import { fetch } from "scripting"
import { loadSetting, STORAGE_KEYS } from "./storage"
import {
  apiHeaders,
  bootstrapAnimepaheSession,
  ensureAnimepaheSession,
  getBaseUrl,
  getStoredCookieHeader,
  isChallengePage,
  isLikelyJsonApi,
  isWebViewSessionActive,
  paheHeaders,
  mergeCookieHeaders,
  normalizePaheUrl,
  playPageHeaders,
  saveCookieHeader,
  webViewFetch,
} from "./animepaheSession"

type PaginationInfo = { lastPage?: number }

type StreamSource = {
  url: string
  resolution?: string
  isDub?: boolean
  isBD?: boolean
  fanSub?: string
}

function getApiBaseUrl(): string {
  return loadSetting(STORAGE_KEYS.ANIMEPAHE_API_URL, "").replace(/\/$/, "")
}

function useApiMode(): boolean {
  return getApiBaseUrl().length > 0
}

async function directFetch(
  requestUrl: string,
  headers: Record<string, string>,
  retried = false,
  expectJson = true
): Promise<string> {
  await ensureAnimepaheSession()

  if (isWebViewSessionActive()) {
    const referer = headers.Referer || getBaseUrl() + "/"
    const fetchMode = expectJson ? "cors" : "navigate"
    const result = await webViewFetch(requestUrl, referer, fetchMode)
    const body = result.body

    if (result.status >= 200 && result.status < 300) {
      if (!expectJson || isLikelyJsonApi(body)) return body
      if (!isChallengePage(body)) return body
    }

    // Rate limited — back off, don't re-bootstrap
    if (result.status === 429 || result.status === 503) {
      console.log(`[animepaheClient] HTTP ${result.status} rate-limit — waiting 10s`)
      await new Promise<void>(r => setTimeout(r, 10000))
      return directFetch(requestUrl, headers, retried, expectJson)
    }

    // Temporary block (no CF page) — back off once, don't re-bootstrap
    if (result.status === 403 && !isChallengePage(body)) {
      if (retried) throw new Error("Animepahe blocked 403")
      console.log("[animepaheClient] HTTP 403 temp block — waiting 8s")
      await new Promise<void>(r => setTimeout(r, 8000))
      return directFetch(requestUrl, headers, true, expectJson)
    }

    // Actual CF challenge — session truly expired, re-bootstrap
    if (!retried && isChallengePage(body)) {
      console.log("[animepaheClient] CF challenge — re-bootstrapping")
      await bootstrapAnimepaheSession()
      return directFetch(requestUrl, headers, true, expectJson)
    }

    if (result.status < 200 || result.status >= 300) {
      console.error("[animepaheClient] WebView HTTP", result.status, body.slice(0, 200))
      throw new Error("Animepahe error " + result.status)
    }

    return body
  }

  const response = await fetch(requestUrl, { headers })
  const body = await response.text()

  mergeResponseCookies(response)

  if (response.ok) {
    if (!expectJson || isLikelyJsonApi(body)) return body
    if (!isChallengePage(body)) return body
  }

  if (!retried && (response.status === 403 || response.status === 503 || isChallengePage(body))) {
    console.log("[animepaheClient] Session expired, re-bootstrapping")
    await bootstrapAnimepaheSession()
    const nextHeaders: Record<string, string> = {}
    for (const key of Object.keys(headers)) {
      nextHeaders[key] = headers[key]
    }
    const cookies = getStoredCookieHeader()
    if (cookies) nextHeaders.Cookie = cookies
    return directFetch(requestUrl, nextHeaders, true, expectJson)
  }

  if (!response.ok) {
    console.error("[animepaheClient] HTTP", response.status, body.slice(0, 200))
    throw new Error("Animepahe error " + response.status)
  }

  return body
}

async function directGet(requestUrl: string, sessionId?: string) {
  const body = await directFetch(requestUrl, apiHeaders(sessionId), false, true)
  return JSON.parse(body)
}

async function apiGet<T>(path: string): Promise<T> {
  const base = getApiBaseUrl()
  const pathPart = path.startsWith("/") ? path : "/" + path
  const requestUrl = base + pathPart

  const response = await fetch(requestUrl, { headers: { Accept: "application/json" } })
  if (!response.ok) {
    throw new Error("Animepahe API error " + response.status)
  }
  return response.json()
}

export function buildQualityTag(source: StreamSource): string | null {
  if (source.isDub || !source.url) return null

  const resolution = source.resolution || "default"
  const resTag = resolution === "default" ? "default" : resolution + "p"

  if (source.isBD) return "-" + resTag + " BD"
  if (source.fanSub && source.fanSub.toLowerCase().includes("chi")) return "-" + resTag + " chi"
  return "-" + resTag
}

function cleanSearchQuery(query: string): string {
  return query.replace(/[^a-zA-Z0-9\s\u0080-\uFFFF]/g, "").trim()
}

export async function paheSearch(
  query: string
): Promise<{ title: string; session: string; poster: string; id?: string | number }[]> {
  const cleanQuery = cleanSearchQuery(query)
  const encodedQuery = encodeURIComponent(cleanQuery)

  if (useApiMode()) {
    const data = await apiGet<{ data: { title: string; session: string; poster: string; id?: string | number }[] }>(
      "/api/search?q=" + encodedQuery
    )
    return data.data ?? []
  }

  const baseUrl = getBaseUrl()
  const searchUrl = baseUrl + "/api?m=search&q=" + encodedQuery
  const data = await directGet(searchUrl)
  return (data.data ?? []).map(function (item: any) {
    return {
      title: item.title,
      session: item.session,
      poster: item.poster,
      id: item.id,
    }
  })
}

/** Fetch animepahe main page HTML for a numeric paheID: https://{base}/a/{paheID} */
export async function paheFetchAnimeMainPageById(paheId: string | number): Promise<string> {
  const baseUrl = getBaseUrl()
  const requestUrl = baseUrl + "/a/" + String(paheId)
  return directFetch(
    requestUrl,
    paheHeaders({ referer: baseUrl + "/", mode: "navigate", requestUrl: requestUrl }),
    false,
    false
  )
}

export async function paheFetchEpisodesPage(
  session: string,
  page: number
): Promise<{ episodes: { id: string; number: number }[]; lastPage: number }> {
  if (useApiMode()) {
    const data = await apiGet<{
      data: { episode: number; session: string }[]
      paginationInfo?: PaginationInfo
    }>("/api/" + encodeURIComponent(session) + "/releases?sort=episode_asc&page=" + String(page))

    return {
      episodes: (data.data ?? []).map(function (item) {
        return {
          id: session + "/" + item.session,
          number: item.episode,
        }
      }),
      lastPage: data.paginationInfo?.lastPage ?? 1,
    }
  }

  const baseUrl = getBaseUrl()
  const releasesUrl =
    baseUrl +
    "/api?m=release&id=" +
    encodeURIComponent(session) +
    "&sort=episode_asc&page=" +
    String(page)
  const data = await directGet(releasesUrl, session)

  return {
    episodes: (data.data ?? []).map(function (item: any) {
      return {
        id: session + "/" + item.session,
        number: item.episode,
      }
    }),
    lastPage: data.last_page ?? 1,
  }
}

export async function paheFetchAllEpisodes(session: string) {
  const firstPage = await paheFetchEpisodesPage(session, 1)
  const allEpisodes = firstPage.episodes.slice()

  for (let page = 2; page <= firstPage.lastPage; page++) {
    const pageData = await paheFetchEpisodesPage(session, page)
    for (let i = 0; i < pageData.episodes.length; i++) {
      allEpisodes.push(pageData.episodes[i])
    }
  }

  return allEpisodes.filter(function (ep) {
    const num = Number(ep.number)
    return Math.ceil(num) === num && num !== 0
  })
}

export async function directFetchPlayPage(episodeId: string): Promise<string> {
  const baseUrl = getBaseUrl()
  const animeSession = episodeId.split("/")[0]
  const playUrl = baseUrl + "/play/" + episodeId
  return directFetch(playUrl, playPageHeaders(animeSession), false, false)
}

export function getDirectBaseUrl(): string {
  return getBaseUrl()
}

export async function paheFetchStreamingSourcesFromApi(
  episodeId: string
): Promise<Record<string, string>> {
  const parts = episodeId.split("/")
  const animeSession = parts[0]
  const episodeSession = parts[1]
  if (!animeSession || !episodeSession) {
    throw new Error("Invalid episode id: " + episodeId)
  }

  const data = await apiGet<{ sources?: StreamSource[] }>(
    "/api/play/" +
      encodeURIComponent(animeSession) +
      "?episodeId=" +
      encodeURIComponent(episodeSession) +
      "&downloads=false"
  )

  const dict: Record<string, string> = {}
  const sources = data.sources ?? []
  for (let i = 0; i < sources.length; i++) {
    const tag = buildQualityTag(sources[i])
    if (tag && !dict[tag]) dict[tag] = sources[i].url
  }
  return dict
}

function mergeResponseCookies(response: any) {
  if (!response.cookies || !response.cookies.length) return

  const parts: string[] = []
  for (let i = 0; i < response.cookies.length; i++) {
    parts.push(response.cookies[i].name + "=" + response.cookies[i].value)
  }
  const incoming = parts.join("; ")
  if (incoming) {
    saveCookieHeader(mergeCookieHeaders(getStoredCookieHeader(), incoming))
  }
}

// ─── Anime Details — mirrors AnimePahe.kt#animeDetailsParse ──────────────────

export interface AnimeDetails {
  session: string
  title: string
  thumbnail: string
  status: string
  studios: string
  genres: string
  description: string
}

/** Extract the session ID embedded in the anime page HTML. */
function extractSessionFromHtml(html: string): string {
  // API call pattern: ?m=release&id={session} (most reliable)
  const m1 = /m=release&(?:amp;)?id=([\w-]+)/.exec(html)
  if (m1) return m1[1]
  // Fallback: /anime/{session} href (breadcrumb / canonical)
  const m2 = /href="\/anime\/([\w-]+)"/.exec(html)
  if (m2) return m2[1]
  return ""
}

/** Parse anime details from a /a/{id} or /anime/{session} HTML page. */
function parseAnimeDetailsHtml(html: string, fallbackSession = ""): AnimeDetails {
  const session = extractSessionFromHtml(html) || fallbackSession

  // Title: div.title-wrapper > h1 > span (Aniyomi: selectFirst("div.title-wrapper > h1 > span"))
  const titleM = /class="title-wrapper"[\s\S]*?<h1[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i.exec(html)
  const title = titleM ? titleM[1].replace(/<[^>]+>/g, "").trim() : ""

  // Thumbnail: div.anime-poster a href (full-res poster)
  const thumbM = /class="anime-poster"[\s\S]*?<a[^>]+href="([^"]+)"/i.exec(html)
  const thumbnail = thumbM ? normalizePaheUrl(thumbM[1]) : ""

  // Status: p:contains(Status:) a
  const statusM = /Status:[\s\S]{0,200}?<a[^>]*>([^<]+)<\/a>/i.exec(html)
  const statusRaw = statusM ? statusM[1].trim() : ""
  const statusLower = statusRaw.toLowerCase()
  const status = statusLower.includes("airing") && !statusLower.includes("finish")
    ? "Currently Airing"
    : statusLower.includes("finish") || statusLower.includes("complet")
    ? "Finished Airing"
    : statusRaw || "Unknown"

  // Studios: p:contains(Studios:) a
  const studioM = /Studios:[\s\S]{0,200}?<a[^>]*>([^<]+)<\/a>/i.exec(html)
  const studios = studioM ? studioM[1].trim() : ""

  // Genres: div.anime-genre ul li a  +  Demographic / Theme a tags
  const genreItems: string[] = []
  const genreSectionM = /class="anime-genre"[\s\S]*?<\/ul>/i.exec(html)
  if (genreSectionM) {
    const liRe = /<a[^>]*>([^<]+)<\/a>/g
    let gm
    while ((gm = liRe.exec(genreSectionM[0])) !== null) genreItems.push(gm[1].trim())
  }
  for (const label of ["Demographic", "Theme"]) {
    const re = new RegExp(label + ":[\\s\\S]{0,200}?<a[^>]*>([^<]+)<\\/a>", "i")
    const lm = re.exec(html)
    if (lm) genreItems.push(lm[1].trim())
  }
  const genres = [...new Set(genreItems)].join(", ")

  // Description: div.anime-summary  (mirrors Aniyomi: select("div.anime-summary").text())
  const summaryM = /class="anime-summary"[^>]*>([\s\S]*?)<\/div>/i.exec(html)
  const descBase = summaryM
    ? summaryM[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
    : ""

  // Supplementary fields (Aniyomi appends Synonyms, Japanese, Aired, Season)
  const extras: string[] = []
  for (const label of ["Synonyms", "Japanese", "Aired", "Season"]) {
    const re = new RegExp("<p[^>]*>[^<]*" + label + ":[^<]*<\\/p>", "i")
    const lm = re.exec(html)
    if (lm) {
      const val = lm[0].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
      if (val) extras.push(val)
    }
  }
  const description = extras.length > 0 ? descBase + "\n\n" + extras.join("\n\n") : descBase

  return { session, title, thumbnail, status, studios, genres, description }
}

/**
 * Fetch full anime details by numeric paheID.
 * Mirrors Aniyomi's animeDetailsRequest + animeDetailsParse.
 * GET /a/{paheId} → redirects to /anime/{session} → parse HTML.
 */
export async function paheFetchAnimeDetails(paheId: string | number): Promise<AnimeDetails> {
  const html = await paheFetchAnimeMainPageById(paheId)
  return parseAnimeDetailsHtml(html)
}

/**
 * Fetch full anime details by session slug (when numeric ID is unavailable).
 * GET /anime/{session} → parse HTML.
 */
export async function paheFetchAnimeDetailsBySession(session: string): Promise<AnimeDetails> {
  const baseUrl = getBaseUrl()
  const url = baseUrl + "/anime/" + session
  const html = await directFetch(
    url,
    paheHeaders({ referer: baseUrl + "/", mode: "navigate", requestUrl: url }),
    false,
    false
  )
  return parseAnimeDetailsHtml(html, session)
}

export { bootstrapAnimepaheSession, ensureAnimepaheSession, normalizePaheUrl }
