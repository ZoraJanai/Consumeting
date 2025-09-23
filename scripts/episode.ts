// Animepahe.ts
// Handles fetching episode sources, selecting quality, and extracting HLS

import { fetch, useState } from "scripting"
import { loadSetting, saveSetting } from "../Pages/Settings"
import { hideOverlay, showOverlay } from "../Pages/Loading"
import { addCache, addQueue } from "./cache"
import { saveData } from "./data"
import { BaseInfo } from "./search"




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
  QUALITY_ORDER: "settings.qualityOrder"
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
  askQuality?: (options: string[]) => Promise<string>
): Promise<Anime> {
  showOverlay()

  const noDownload: Anime = { name: "", source: "", episodes: "", img: "", isUnread: false }
  if (index === -44) return noDownload

  const entry = loadSetting("entry", PlaceholderEntry)
  const autoQuality = loadSetting(STORAGE_KEYS.AUTO_QUALITY, true)
  let order = loadSetting(STORAGE_KEYS.QUALITY_ORDER, QualitiesOrder)
  const player = loadSetting(STORAGE_KEYS.VIDEO_PLAYER, "nPlayer")

  const sources = await getAnimepaheSources(entry.ids[index - 1])        // tag -> url
  const tags = Object.keys(sources)

  let selectedUrl: string | undefined

  if (autoQuality) {
    // try auto by current order
    selectedUrl = qualityAutoSelect(sources, order)
    if (!selectedUrl) {
      // not found → ask once
      if (!askQuality) throw new Error("askQuality callback not provided")
      const pickedTag = await askQuality(tags)

      // persist: put pickedTag at the front of order
      const filtered = order.filter(q => q !== pickedTag)
const newOrder = [
  ...filtered.slice(0, 2),   // keep first two as-is
  pickedTag,                 // insert chosen tag here
  ...filtered.slice(2)       // rest
]

saveSetting(STORAGE_KEYS.QUALITY_ORDER, newOrder)
order = newOrder

      selectedUrl = sources[pickedTag]   // must exist because it came from `tags`
    }
  } else {
    if (!askQuality) throw new Error("askQuality callback not provided")
    const pickedTag = await askQuality(tags)
    selectedUrl = sources[pickedTag]
  }

  // Build HLS
  const hls = await kwikExtractor(String(selectedUrl))
  hideOverlay()

  const finalUrl = player === "nPlayer" ? "-" + hls : hls.replace("https", "")
  console.log((player + finalUrl).toLowerCase())

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