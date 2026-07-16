// Episode handling — direct animepahe scraping (animepahe-api repo style)
import { fetch } from "scripting"
import { loadSetting, saveSetting, STORAGE_KEYS } from "./storage"
import { hideOverlay, showOverlay } from "../Pages/Loading"
import { addCache, addQueue } from "./cache"
import { saveData } from "./data"
import { BaseInfo } from "./search"
import {
  captureKwikCookies,
  getStoredKwikCookies,
  HARDWIRED_UA,
  isWebViewSessionActive,
  paheHeaders,
  presentKwikEmbedPlayer,
} from "./animepaheSession"
import {
  directFetchPlayPage,
  getDirectBaseUrl,
  paheFetchStreamingSourcesFromApi,
} from "./animepaheClient"

// ---- Types ----

type Anime = {
  name: string
  source: string
  episodes: string
  img: string
  isUnread: boolean
  paheID?: string
}

export type StreamEntry = { url: string; referer: string }
export type QualityMap = Record<string, StreamEntry>

function streamUrl(entry: StreamEntry | undefined): string | undefined {
  return entry?.url
}

type EntryType = {
  name: string
  ids: string[]
  episode: string
  total: string
  id: string
  img: string
}

export type DownloadAnime = {
  name: string
  source: string
  episodes: string
  img: string
  links: string[]
  isUnread: boolean
  paheID?: string
}

// ---- Defaults & Storage Keys ----

export const PlaceholderEntry: EntryType = {
  name: "Name of Anime",
  ids: [],
  episode: "0",
  total: "99",
  id: "123456",
  img: ""
}

export const QualitiesOrder = [
  "-1080p BD",
  "-1080p",
  "-816p chi",
  "-720p",
  "-default",
  "-auto",
  "-480p",
  "-360p",
]

function sanitizeFilename(name: string): string {
  return name
    .replaceAll(":", " -")
    .replaceAll("/", "-")
    .replaceAll("\\", "-")
    .replaceAll("|", "-")
    .replaceAll("?", "")
    .replaceAll("*", "")
    .replaceAll("<", "")
    .replaceAll(">", "")
    .replaceAll('"', "")
    .replaceAll("'", "")
    .replaceAll("`", "")
    .replaceAll("$", "")
    .replaceAll("&", "and")
    .replaceAll(";", "")
    .replaceAll("(", "")
    .replaceAll(")", "")
    .replaceAll("[", "")
    .replaceAll("]", "")
    .replaceAll("{", "")
    .replaceAll("}", "")
    .replaceAll("#", "")
    .replaceAll("%", "")
    .trim()
}


function useApiMode(): boolean {
  return loadSetting(STORAGE_KEYS.ANIMEPAHE_API_URL, "").trim().length > 0
}

// ─── HLS extractor — mirrors Aniyomi getHlsVideo (kwik.cx/e/xxx embed) ──────
//
// Returns { url: owocdn/uwucdn m3u8, referer: kwik.cx/e/... } so downloadEpisode
// can emit: python3 hls_fix.py "<m3u8>" --referer "<kwik embed>" --session-file ...
async function extractKwikHlsUrl(kwikEmbedUrl: string, animepaheBase: string): Promise<StreamEntry> {
  const buildHeaders = () => {
    const h = paheHeaders({ referer: animepaheBase + "/", mode: "navigate" })
    const { cookies, userAgent } = getStoredKwikCookies()
    if (cookies) h["Cookie"] = cookies
    h["User-Agent"] = userAgent || HARDWIRED_UA
    return h
  }

  if (!getStoredKwikCookies().cookies && isWebViewSessionActive()) {
    console.log("[kwikHls] no saved kwik cookies — capturing session first")
    await captureKwikCookies()
  }

  let response = await fetch(kwikEmbedUrl, { headers: buildHeaders() })

  if (!response.ok && isWebViewSessionActive()) {
    console.log("[kwikHls] status", response.status, "— refreshing kwik session")
    await captureKwikCookies()
    response = await fetch(kwikEmbedUrl, { headers: buildHeaders() })
  }

  if (!response.ok) throw new Error(`[kwikHls] fetch failed: ${response.status}`)

  const html = await response.text()
  // Aniyomi: last eval(function(...)) in the page (earlier packs are noise)
  const lastEval = html.lastIndexOf("eval(function(")
  if (lastEval < 0) throw new Error("[kwikHls] packed script not found")
  const scriptTail = html.slice(lastEval)
  const endScript = scriptTail.search(/<\/script>/i)
  const packedBlock = endScript >= 0 ? scriptTail.slice(0, endScript) : scriptTail
  const expr = packedBlock.replace(/^eval/, "")
  const unpacked = eval(expr)
  const unpackedStr = typeof unpacked === "string" ? unpacked : String(unpacked)
  const sourceMatch = /const source=['"](https[^'"]+\.m3u8[^'"]*)['"]/.exec(unpackedStr)
  const m3u8Match = sourceMatch?.[1] || unpackedStr.match(/https[^"'\s\\]+?\.m3u8[^"'\s\\]*/i)?.[0]
  if (!m3u8Match) throw new Error("[kwikHls] m3u8 URL not found")

  // CDN CF needs the embed URL as Referer (not animepahe, not bare kwik.cx/)
  const referer = kwikEmbedUrl
  console.log("[kwikHls] m3u8:", m3u8Match.slice(0, 100), "referer:", referer.slice(0, 80))
  return { url: m3u8Match, referer }
}

function decodeHtmlEntities(text: string): string {
  const entities: Record<string, string> = {
    "&middot;": "·",
    "&nbsp;": " ",
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
  }
  return text.replace(/&[a-z0-9#]+;/gi, entity => entities[entity] || entity)
}

// Parse div#resolutionMenu buttons — extract kwikUrl (data-src) and quality label.
// Skips English-audio variants (data-audio="eng") exactly as Aniyomi does.
function parseResolutionMenu(html: string): { kwikUrl: string; quality: string }[] {
  const result: { kwikUrl: string; quality: string }[] = []
  const buttonRegex = /<button[^>]*class="dropdown-item[^"]*"[^>]*>([\s\S]*?)<\/button>/g
  let match

  while ((match = buttonRegex.exec(html)) !== null) {
    const fullButton = match[0]
    const innerText = match[1]
    const srcMatch = /data-src="([^"]*)"/.exec(fullButton)
    if (!srcMatch) continue

    const audioMatch = /data-audio="([^"]*)"/.exec(fullButton)
    if (audioMatch?.[1]?.toLowerCase() === "eng") continue

    const textMatch = /^\s*(.*?)\s*(?:<span|$)/.exec(innerText)
    const quality = decodeHtmlEntities(textMatch ? textMatch[1].trim() : innerText.trim())
    result.push({ kwikUrl: srcMatch[1], quality })
  }

  return result
}

async function scrapePlayPageSources(episodeId: string, qualityOrder?: string[]): Promise<QualityMap> {
  const html = await directFetchPlayPage(episodeId)
  const entries = parseResolutionMenu(html)
  const base = getDirectBaseUrl()

  // Build tag → kwikUrl map without hitting kwik yet
  const kwikMap: Record<string, string> = {}
  for (const entry of entries) {
    const parts = entry.quality.split(" · ")
    const tag = "-" + (parts[1] ?? parts[0]).trim()
    kwikMap[tag] = entry.kwikUrl
  }

  const tags = Object.keys(kwikMap)

  // Pick which tag to extract — use quality order if provided, else fetch all
  let tagsToFetch: string[]
  if (qualityOrder && qualityOrder.length > 0) {
    const chosen = qualityOrder.find(q => kwikMap[q]) ?? tags[0]
    tagsToFetch = chosen ? [chosen] : tags
    console.log("[getAnimepaheSources] pre-selected quality:", tagsToFetch[0])
  } else {
    tagsToFetch = tags
  }

  const dict: QualityMap = {}
  for (const tag of tagsToFetch) {
    try {
      dict[tag] = await extractKwikHlsUrl(kwikMap[tag], base)
    } catch (err) {
      console.error(`[getAnimepaheSources] Failed quality ${tag}:`, err)
    }
  }

  return dict
}

function normalizeApiSources(raw: Record<string, string>): QualityMap {
  const dict: QualityMap = {}
  for (const tag of Object.keys(raw)) {
    dict[tag] = { url: raw[tag], referer: "https://kwik.cx/" }
  }
  return dict
}

export async function getAnimepaheSources(episodeId: string, qualityOrder?: string[]): Promise<QualityMap> {
  if (useApiMode()) {
    return normalizeApiSources(await paheFetchStreamingSourcesFromApi(episodeId))
  }

  return scrapePlayPageSources(episodeId, qualityOrder)
}

// ---- Quality Selection ----

export function qualityAutoSelect(
  qualities: QualityMap,
  qualityOrder: string[],
): StreamEntry | undefined {
  for (const q of qualityOrder) {
    if (qualities[q]) return qualities[q]
  }
  return undefined
}

// ---- Episode Number Logic ----

export function episodeNumber(number: number, total: number, action: string) {
  let output;

  switch (action) {
    case 'Next':
      if (total >= (number + 1)) {
        number++;
        output = number;
      } else {
        return -5;
      }
      break;
    
    case 'Resume':
      output = number;
      break;

    case 'Add':
      output = 0;
      break;
    
    case 'Jump':
      output = -2;
      break;

    case 'Continue':
      if (total == (number + 1)) {
        output = -3;
      } else {
        output = -1;
      }
      break;
      
    case 'Choose':
      output = -1;
      break;
    
    case 'Watch':
      if (total > 1) {
        output = -1;
      } else {
        output = 1;
      }
      break;
    
    case 'Download':
      if (total === 1) {
        output = -3;
      } else {
        output = -1;
      }
      break;

    case 'DownloadAll':
      if (number >= total) {
        output = -5;
      } else {
        output = -6;
      }
      break;

    default:
      return output;
  }
  
  return output;
}

// ---- Get Episode ----

export async function getEpisode(
  index: number,
  askQuality?: (options: string[]) => Promise<string>
): Promise<Anime> {
  console.log("[getEpisode] index:", index)
  showOverlay()

  const noDownload: Anime = { name: "", source: "", episodes: "", img: "", isUnread: false }
  if (index === -44) return noDownload

  const entry = loadSetting("entry", PlaceholderEntry)
  const autoQuality = loadSetting(STORAGE_KEYS.AUTO_QUALITY, true)
  let order = loadSetting(STORAGE_KEYS.QUALITY_ORDER, QualitiesOrder)
  const player = loadSetting<"nPlayer" | "Outplayer" | "Safari">(
    STORAGE_KEYS.VIDEO_PLAYER,
    "nPlayer",
  )

  const episodeId = entry.ids[index - 1]
  console.log("[getEpisode] episodeId:", episodeId)

  const sources = await getAnimepaheSources(episodeId, autoQuality ? order : undefined)
  console.log("[getEpisode] sources:", Object.keys(sources))

  const tags = Object.keys(sources)
  let selected: StreamEntry | undefined

  if (autoQuality) {
    selected = qualityAutoSelect(sources, order)
    if (!selected) {
      if (!askQuality) throw new Error("askQuality callback not provided")
      const pickedTag = await askQuality(tags)
      const filtered = order.filter(q => q !== pickedTag)
      const newOrder = [
        ...filtered.slice(0, 2),
        pickedTag,
        ...filtered.slice(2)
      ]
      saveSetting(STORAGE_KEYS.QUALITY_ORDER, newOrder)
      order = newOrder
      selected = sources[pickedTag]
    }
  } else {
    if (!askQuality) throw new Error("askQuality callback not provided")
    const pickedTag = await askQuality(tags)
    selected = sources[pickedTag]
  }

  hideOverlay()

  const openUrl = streamUrl(selected)
  if (!openUrl) throw new Error("No stream URL selected")

  if (player === "Safari") {
    // Kwik embed only — play page is a Referer stepping stone (see test_safari_player.py)
    const kwikEmbed = selected?.referer || ""
    if (!kwikEmbed.includes("kwik.cx/e/")) {
      throw new Error(
        "Safari player needs a kwik.cx/e/... embed URL (use direct animepahe mode, not API-only)",
      )
    }
    const playPageUrl = getDirectBaseUrl() + "/play/" + episodeId
    console.log("[getEpisode] Safari → kwik embed:", kwikEmbed.slice(0, 80))
    await presentKwikEmbedPlayer(playPageUrl, kwikEmbed)
  } else {
    console.log("[getEpisode] m3u8:", openUrl.substring(0, 100))
    const finalUrl = player === "nPlayer" ? "-" + openUrl : "://" + openUrl
    console.log("[getEpisode] opening:", (player + finalUrl).substring(0, 100))
    await Safari.openURL((player + finalUrl).toLowerCase())
  }

  const stillUnread = index !== Number(entry.total)
  const cacheEntry: Anime = {
    name: entry.name,
    source: entry.id,
    episodes: String(index) + "/" + entry.total,
    img: entry.img,
    isUnread: stillUnread
  }
  addCache(cacheEntry)
  return cacheEntry
}

function shellWriteJsonFile(filename: string, payload: object): string {
  const json = JSON.stringify(payload)
  const b64 = btoa(unescape(encodeURIComponent(json)))
  return `python3 -c "import base64, pathlib; pathlib.Path('${filename}').write_bytes(base64.b64decode('${b64}'))"`
}

/** Escape a value for use inside double quotes in ashell / zsh. */
function shellQuote(value: string): string {
  return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$") + '"'
}

/**
 * Build the Mac-side download pair for one episode.
 * hls_fix.py must use curl + kwik embed Referer (urllib gets CF 403).
 */
function buildHlsDownloadCommands(
  m3u8Url: string,
  kwikReferer: string,
  escapedName: string,
  episodeNumber: number,
): string[] {
  const referer = kwikReferer.includes("kwik.cx/e/")
    ? kwikReferer
    : kwikReferer || "https://kwik.cx/"
  return [
    `python3 hls_fix.py ${shellQuote(m3u8Url)} --referer ${shellQuote(referer)} --session-file kwik_session.json`,
    `ffmpeg -allowed_extensions ALL -i hls_fixed/local.m3u8 -c copy ~/Documents/${escapedName}/${escapedName}\\ -\\ ${episodeNumber}.mp4`,
  ]
}

// ---- Download Episode ----

export async function downloadEpisode(
  onProgress?: (done: number, total: number) => void,
  onStart?: (total: number) => void,
  askQuality?: (options: string[]) => Promise<string>
): Promise<[Anime, DownloadAnime]> {
  showOverlay()

  const ogEntry = loadSetting("entry", PlaceholderEntry)
  const entry = loadSetting("queueEntry", PlaceholderEntry)

  const autoQuality = loadSetting(STORAGE_KEYS.AUTO_QUALITY, true)
  let order = loadSetting(STORAGE_KEYS.QUALITY_ORDER, QualitiesOrder)

  const ids = entry.ids
  const total = ids.length
  onStart?.(total)

  const safeName = sanitizeFilename(entry.name)
  // Escape all shell-special chars; alphanumerics, dash, dot, underscore, colon, equals, @ are safe unquoted
  const escapedName = safeName.replace(/([^a-zA-Z0-9.\-_:=@])/g, '\\$1')
  const links: string[] = [`mkdir -p "${safeName}"`]

  // Ensure kwik CF session exists before we scrape embeds / write session file
  if (!getStoredKwikCookies().cookies && isWebViewSessionActive()) {
    console.log("[downloadEpisode] capturing kwik.cx CF session for hls_fix.py")
    try {
      await captureKwikCookies()
    } catch (e) {
      console.log("[downloadEpisode] kwik capture failed (Referer alone may still work):", String(e))
    }
  }

  const kwikSession = getStoredKwikCookies()
  // Always write session JSON — UA is required; cookies help but Referer is the main CF gate
  links.push(
    shellWriteJsonFile("kwik_session.json", {
      cookies: kwikSession.cookies || "",
      userAgent: kwikSession.userAgent || HARDWIRED_UA,
    }),
  )

  // Phase 1: fetch all episode sources (gated to avoid rate limits)
  const allSources: QualityMap[] = new Array(total)
  let fetchDone = 0
  let cursor = 0
  let lastFetch = 0   // timestamp of last request start (ms)

  const gatedFetch = async (episodeId: string): Promise<QualityMap> => {
    const now = Date.now()
    const wait = lastFetch + 1800 - now
    if (wait > 0) await new Promise<void>(r => setTimeout(r, wait))
    lastFetch = Date.now()
    return getAnimepaheSources(episodeId, autoQuality ? order : undefined)
  }

  await Promise.all(
    Array.from({ length: Math.min(1, total) }, async () => {
      while (true) {
        const i = cursor++
        if (i >= total) break
        allSources[i] = await gatedFetch(ids[i])
        fetchDone++
        onProgress?.(fetchDone, total)
      }
    })
  )

  // Phase 2: build links in order (quality selection is single-prompt, reused across episodes)
  let chosenTag: string | null = null

  for (let i = 0; i < total; i++) {
    const sources = allSources[i]
    const tags = Object.keys(sources)

    let selected = qualityAutoSelect(sources, order)

    if (!selected) {
      if (autoQuality) {
        if (chosenTag) {
          selected = sources[chosenTag]
        }
        if (!selected) {
          if (!askQuality) throw new Error("askQuality callback not provided")
          chosenTag = await askQuality(tags)
          const filtered = order.filter(q => q !== chosenTag)
          const newOrder = [...filtered.slice(0, 2), chosenTag, ...filtered.slice(2)]
          saveSetting(STORAGE_KEYS.QUALITY_ORDER, newOrder)
          order = newOrder
          selected = sources[chosenTag]
        }
      } else {
        if (!askQuality) throw new Error("askQuality callback not provided")
        chosenTag = await askQuality(tags)
        selected = sources[chosenTag]
      }
    }

    const url = streamUrl(selected)
    const referer = selected?.referer || "https://kwik.cx/"
    if (!url) continue

    const number = Number(entry.episode) + i
    links.push(...buildHlsDownloadCommands(url, referer, escapedName, number))
  }

  const episodeString =
    entry.episode === entry.total ? entry.episode : `${entry.episode} to ${entry.total}`

  const entryBool = ogEntry.episode != ogEntry.total

  const cacheEntry: Anime = {
    name: entry.name,
    source: entry.id,
    episodes: `${ogEntry.episode}/${ogEntry.total}`,
    img: entry.img,
    isUnread: entryBool
  }

  const queueEntry: DownloadAnime = {
    name: entry.name,
    source: entry.id,
    episodes: episodeString,
    img: entry.img,
    links,
    isUnread: true
  }

  return [cacheEntry, queueEntry]
}

/** Queue a range of episodes for download without advancing watch progress. */
export async function queueEpisodeRange(
  info: EntryType,
  current: number,
  start: number,
  end: number,
  onProgress?: (done: number, total: number) => void,
  onStart?: (total: number) => void,
  askQuality?: (options: string[]) => Promise<string>
): Promise<[Anime, DownloadAnime] | null> {
  if (start > end) return null

  const ogEntry: EntryType = {
    ...info,
    episode: String(current),
    total: String(end),
  }
  saveSetting("entry", ogEntry)

  const queueInfo: EntryType = {
    ...info,
    episode: String(start),
    total: String(end),
    ids: info.ids.slice(start - 1, end),
  }
  saveSetting("queueEntry", queueInfo)

  return downloadEpisode(onProgress, onStart, askQuality)
}
