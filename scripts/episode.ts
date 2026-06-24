// Animepahe.ts
// Handles fetching episode sources, selecting quality, and extracting HLS

import { fetch, useState } from "scripting"
import { loadSetting, saveSetting } from "../Pages/Settings"
import { hideOverlay, showOverlay, setProviderBar, clearProviderBar } from "../Pages/Loading"
import { addCache, addQueue } from "./cache"
import { saveData } from "./data"
import { BaseInfo } from "./search"
import { anidapFetchProviders, anidapFetchSourcesByProvider } from "./anidapClient"
import { AnidapProviderOrder, AnidapQualityOrder } from "../Pages/Settings"




// ---- Types ----

type Anime = {
  name: string
  source: string
  episodes: string
  img: string
  isUnread: boolean
}

export type QualityMap = Record<string, string> // "-1080p", etc => URL

export type AnimepaheSource = {
  quality: string // e.g. "HLS · 1080p eng"
  url: string
}

export type AnimepaheWatchResponse = {
  sources: AnimepaheSource[]
}

export type CurrentEntry = {
  name: string
  ids: string[] // episode ids (index = episode-1)
  number: number // current episode number (1-based)
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

export const STORAGE_KEYS = {
  VIDEO_PLAYER: "settings.videoPlayer",
  AUTO_QUALITY: "settings.autoQuality",
  QUALITY_ORDER: "settings.qualityOrder",
  ANIDAP_PROVIDER_ORDER: "settings.anidapProviderOrder",
  ANIDAP_QUALITY_ORDER: "settings.anidapQualityOrder",
  AUTO_PROVIDER: "settings.autoProvider",
}

const baseUrl: string = "https://consumet-srgm.vercel.app"

// ---- 1. Get Animepahe Sources ----

export async function getAnimepaheSources(id: string): Promise<QualityMap> {
  //console.log(id)
  const url = `${baseUrl}/anime/animepahe/watch?episodeId=${encodeURIComponent(id)}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`getAnimepaheSources failed: ${res.status}`)

  const body = (await res.json()) as AnimepaheWatchResponse
  const dict: QualityMap = {}

  for (const src of body.sources) {
    const parts = src.quality.split(" · ")
    const tag = "-" + (parts[1] ?? "").trim() // "-1080p eng"
    // skip "eng" suffix
    if (!tag.endsWith("eng")) {
      dict[tag] = src.url
    }
  }
  //console.log(dict)
  return dict
}

// ---- 1b. Get Anidap Sources ----
// Episode ID format: "anidap:{slug}:{episodeNumber}"
export async function getAnidapSources(
  episodeId: string,
  askProvider?: (ids: string[]) => Promise<string>
): Promise<QualityMap> {
  console.log("[getAnidapSources] episodeId:", episodeId)
  const parts = episodeId.split(":")
  const slug = parts.slice(1, -1).join(":")
  const ep = Number(parts[parts.length - 1])
  if (!slug || isNaN(ep)) throw new Error(`[anidap] invalid episode id: ${episodeId}`)

  console.log("[getAnidapSources] slug:", slug, "ep:", ep)

  // ── 1. Fetch available sub providers ──────────────────────────────────────
  const available = await anidapFetchProviders(slug, ep)
  const availableIds = new Set(available.map(p => p.id))
  console.log("[getAnidapSources] available providers:", [...availableIds].join(", "))

  // ── 2. Build ordered provider list (sub only, never dub) ──────────────────
  const providerOrder = loadSetting(STORAGE_KEYS.ANIDAP_PROVIDER_ORDER, AnidapProviderOrder)
  const ordered: string[] = [
    ...providerOrder.filter(id => availableIds.has(id)),
    ...available.filter(p => !providerOrder.includes(p.id)).map(p => p.id),
  ]
  console.log("[getAnidapSources] ordered providers:", ordered.join(" → "))

  // ── 3. Auto or manual provider selection ──────────────────────────────────
  // Coerce to boolean — iOS Storage may return "false" (string) which is truthy
  const autoProvider = String(loadSetting(STORAGE_KEYS.AUTO_PROVIDER, true)) !== "false"
  console.log("[getAnidapSources] autoProvider:", autoProvider)

  let providersToTry: string[]
  if (!autoProvider && askProvider && ordered.length > 0) {
    const chosen = await askProvider(ordered)
    console.log("[getAnidapSources] user chose provider:", chosen)
    providersToTry = [chosen]
  } else {
    providersToTry = ordered
  }

  // ── 4. Two-stage fetch ────────────────────────────────────────────────────
  // Stage 1: silently try the first (highest-priority) provider alone
  // Stage 2: only if stage 1 fails → parallel-race the rest with the bar

  function buildMap(variants: { label: string; url: string }[]): QualityMap {
    const map: QualityMap = {}
    for (const v of variants) map[`-${v.label}`] = v.url
    if (!map["-auto"]) map["-auto"] = variants[0].url
    return map
  }

  // ── Stage 1: try first provider, no UI ────────────────────────────────────
  if (providersToTry.length > 0) {
    const first = providersToTry[0]
    console.log("[getAnidapSources] stage1 trying:", first)
    try {
      const variants = await anidapFetchSourcesByProvider(slug, ep, first)
      if (variants && variants.length) {
        console.log("[getAnidapSources] stage1 hit:", first, variants.map(v => v.label).join(", "))
        return buildMap(variants)
      }
      console.log("[getAnidapSources] stage1 miss:", first)
    } catch (err) {
      console.log("[getAnidapSources] stage1 error:", first, String(err))
    }
  }

  // ── Stage 2: parallel-race the remaining providers with progress bar ───────
  const fallbacks = providersToTry.slice(1)
  if (!fallbacks.length) throw new Error(`[anidap] no working sub provider found for ep ${ep}`)

  const total2 = fallbacks.length
  setProviderBar(0, total2, "Trying fallback providers…")

  let completedCount = 0
  let raceResolved = false  // guards stale callbacks after winner is found
  const settled = new Array<boolean>(total2).fill(false)
  const results = new Array<QualityMap | null>(total2).fill(null)

  type Stage2Result = { map: QualityMap; providerId: string } | null
  const winnerResult = await new Promise<Stage2Result>((resolve) => {
    let resolved = false

    function tryResolve() {
      if (resolved) return
      for (let i = 0; i < total2; i++) {
        if (!settled[i]) return          // higher-priority slot still pending
        if (results[i] !== null) {       // first settled non-null wins
          resolved = true
          resolve({ map: results[i]!, providerId: fallbacks[i] })
          return
        }
      }
      resolved = true
      resolve(null) // all settled as null
    }

    fallbacks.forEach((providerId, i) => {
      anidapFetchSourcesByProvider(slug, ep, providerId)
        .then(variants => {
          if (raceResolved) return  // winner already found — discard late result
          if (variants && variants.length) {
            results[i] = buildMap(variants)
            console.log("[getAnidapSources] stage2", providerId, "qualities:", variants.map(v => v.label).join(", "))
            setProviderBar(++completedCount, total2, `${providerId} ✓`)
          } else {
            console.log("[getAnidapSources] stage2 miss:", providerId)
            setProviderBar(++completedCount, total2, `${providerId} ✗`)
          }
        })
        .catch(err => {
          if (raceResolved) return
          console.log("[getAnidapSources] stage2 error:", providerId, String(err))
          setProviderBar(++completedCount, total2, `${providerId} ✗`)
        })
        .finally(() => {
          settled[i] = true
          tryResolve()
        })
    })
  })

  raceResolved = true
  clearProviderBar()

  if (!winnerResult) throw new Error(`[anidap] no working sub provider found for ep ${ep}`)

  // Bubble winner to position 1 (right after the stage-1 slot) so next time
  // it's tried first in stage 1 before going parallel.
  const winner = winnerResult.providerId
  console.log("[getAnidapSources] bubbling winner to slot 1:", winner)
  const next = providerOrder.filter(id => id !== winner)
  next.splice(1, 0, winner)
  saveSetting(STORAGE_KEYS.ANIDAP_PROVIDER_ORDER, next)

  return winnerResult.map
}

// ---- 2. Pick First Match From Quality Order ----

export function qualityAutoSelect(
  qualities: QualityMap,
  qualityOrder: string[],
): string | undefined {
  for (const q of qualityOrder) {
    if (qualities[q]) return qualities[q]
  }
  return undefined
}

// ---- 3. Extract HLS From Kwik ----

export async function kwikExtractor(episodeLink: string): Promise<string> {
  const res = await fetch(episodeLink, {
    headers: { Referer: "https://animepahe.com" },
  })
  if (!res.ok) throw new Error(`kwikExtractor failed: ${res.status}`)

  const html = await res.text()
  const packedMatch = /(eval)(\(f.*?)(\n<\/script>)/s.exec(html)
  if (!packedMatch) throw new Error("kwikExtractor: packed script not found")

  const unpacked = eval(packedMatch[2].replace("eval", "")) as string
  const hlsMatch = unpacked.match(/https.*?m3u8/)
  if (!hlsMatch) throw new Error("kwikExtractor: m3u8 url not found")

  return hlsMatch[0]
}

export function episodeNumber(number:number, total:number, action:string){
	let output;

  switch (action){
    case 'Next':
    		if (total>=(number+1)){
        number++ 
      		output = number 
      }else{return -5}      
      break;
    
    case 'Resume':
      output = number 
    		break;

    case 'Add':
      output = 0
      break;
    	
    case 'Jump':
      output = -2
      break;

    case 'Continue':
      if (total==(number+1)){
        output = -3
      }else{
        output = -1
      }
      break;
      
    case 'Choose':
      output = -1
      break;
    
    case 'Watch':
      if (total>1){
        output = -1 
      }else{
        output = 1
      }
      break;
    
    case 'Download':
      if (total===1){
        output = -3
      }else{
        output = -1
      }
      break;
    default:
			return output
  }
  
  return output

  
}


// ---- 4. Build HLS URL ----
export async function getEpisode(
  index: number,
  askQuality?: (options: string[]) => Promise<string>,
  askProvider?: (options: string[]) => Promise<string>
): Promise<Anime> {
  console.log("[getEpisode] index:", index)
  showOverlay()

  const noDownload: Anime = { name: "", source: "", episodes: "", img: "", isUnread: false }
  if (index === -44) return noDownload

  const entry = loadSetting("entry", PlaceholderEntry)
  const autoQuality = loadSetting(STORAGE_KEYS.AUTO_QUALITY, true)
  let order = loadSetting(STORAGE_KEYS.QUALITY_ORDER, QualitiesOrder)
  const player = loadSetting(STORAGE_KEYS.VIDEO_PLAYER, "nPlayer")

  const episodeId = entry.ids[index - 1]
  console.log("[getEpisode] episodeId:", episodeId, "player:", player)

  const isAnidap = episodeId?.startsWith("anidap:")
  const sources = isAnidap
    ? await getAnidapSources(episodeId, askProvider)
    : await getAnimepaheSources(episodeId)        // tag -> url
  const tags = Object.keys(sources)

  let selectedUrl: string | undefined

  if (isAnidap) {
    const anidapQualityOrder = loadSetting(STORAGE_KEYS.ANIDAP_QUALITY_ORDER, AnidapQualityOrder)
    if (autoQuality) {
      selectedUrl = qualityAutoSelect(sources, anidapQualityOrder) ?? sources[tags[0]]
    } else {
      if (!askQuality) throw new Error("askQuality callback not provided")
      const pickedTag = await askQuality(tags)
      selectedUrl = sources[pickedTag]
    }
  } else if (autoQuality) {
    // try auto by current order
    selectedUrl = qualityAutoSelect(sources, order)
    if (!selectedUrl) {
      // not found → ask once
      if (!askQuality) throw new Error("askQuality callback not provided")
      const pickedTag = await askQuality(tags)

      // persist: put pickedTag at the front of order
      const filtered = order.filter(q => q !== pickedTag)
      const newOrder = [
        ...filtered.slice(0, 2),
        pickedTag,
        ...filtered.slice(2),
      ]
      saveSetting(STORAGE_KEYS.QUALITY_ORDER, newOrder)
      order = newOrder

      selectedUrl = sources[pickedTag]
    }
  } else {
    if (!askQuality) throw new Error("askQuality callback not provided")
    const pickedTag = await askQuality(tags)
    selectedUrl = sources[pickedTag]
  }

  if (!selectedUrl) throw new Error("[episode] could not determine stream URL")

  hideOverlay()

  let streamUrl: string
  if (isAnidap) {
    // Anidap: quality-specific CDN m3u8, opened directly by native player
    streamUrl = String(selectedUrl)
  } else {
    // Animepahe: extract HLS from kwik
    streamUrl = await kwikExtractor(String(selectedUrl))
  }

  const finalUrl = player === "nPlayer" ? "-" + streamUrl : streamUrl.replace("https", "")
  await Safari.openURL((player + finalUrl).toLowerCase())

  const stillUnread = index !== Number(entry.total)
  const cacheEntry: Anime = {
    name: entry.name,
    source: entry.id,
    episodes: String(index) + "/" + entry.total,
    img: entry.img,
    isUnread: stillUnread
  }

  saveSetting("entry", entry)
  addCache(cacheEntry)
  return cacheEntry
}


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

  const links: string[] = [`mkdir ${entry.name.replaceAll(" ", "\\ ")}`]

  // if we prompt, only ask once and reuse the same tag for whole batch
  let chosenTag: string | null = null

  for (let i = 0; i < total; i++) {
    const sources = await getAnimepaheSources(ids[i])   // tag -> url
    const tags = Object.keys(sources)

    let url = qualityAutoSelect(sources, order)

    if (!url) {
      if (autoQuality) {
        // try previously chosen tag if already asked this batch
        if (chosenTag) {
          url = sources[chosenTag]
        }

        if (!url) {
          if (!askQuality) throw new Error("askQuality callback not provided")
          chosenTag = await askQuality(tags)

          // insert chosenTag at 3rd position in order
          const filtered = order.filter(q => q !== chosenTag)
          const newOrder = [
            ...filtered.slice(0, 2),
            chosenTag,
            ...filtered.slice(2),
          ]
          saveSetting(STORAGE_KEYS.QUALITY_ORDER, newOrder)
          order = newOrder

          url = sources[chosenTag]
        }
      } else {
        // manual mode fallback
        if (!askQuality) throw new Error("askQuality callback not provided")
        chosenTag = await askQuality(tags)
        url = sources[chosenTag]
      }
    }

    const hls = await kwikExtractor(String(url))
    const number = Number(entry.episode) + i
    const link = `ffmpeg -i "${hls}" -c copy ~/Documents/${entry.name.replaceAll(" ","\\ ")}/${entry.name.replaceAll(" ","\\ ")}\\ -\\ ${number}.mp4`
    links.push(link)

    onProgress?.(i + 1, total)
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