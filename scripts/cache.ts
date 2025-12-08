import { loadSetting } from "../Pages/Settings"
import { loadData, saveData } from "./data"

// Unified data structure
export type UnifiedData = {
  cache: Anime[]
  queue: DownloadAnime[]
}

export type Anime = {
  name: string
  source: string
  episodes: string
  img: string
  isUnread: boolean
}

export type DownloadAnime = {
  name: string
  source: string
  episodes: string
  img: string
  links: string[]
  isUnread: boolean
}

// Get unified file path (single file for both cache and queue)
function getUnifiedPath(): string {
  return loadSetting("unified.path", "lists.json")
}

// Load unified data with defaults
async function loadUnified(): Promise<UnifiedData> {
  try {
    const path = getUnifiedPath()
    const data = await loadData<UnifiedData>(path)
    return {
      cache: Array.isArray(data?.cache) ? data.cache : [],
      queue: Array.isArray(data?.queue) ? data.queue : []
    }
  } catch {
    return { cache: [], queue: [] }
  }
}

// Save unified data
async function saveUnified(data: UnifiedData): Promise<void> {
  const path = getUnifiedPath()
  await saveData(path, data)
}

export async function addCache(entry: Anime): Promise<Anime[]> {
  const unified = await loadUnified()
  let cache = unified.cache

  // find existing entry
  const index = cache.findIndex(a => a.name === entry.name)

  if (index !== -1) {
    // replace + move to front
    cache.splice(index, 1) // remove old
    cache.unshift(entry)   // add new at start
  } else {
    // add new at front
    cache.unshift(entry)
  }

  await saveUnified({ ...unified, cache })
  return cache
}

export async function addQueue(entry: DownloadAnime): Promise<DownloadAnime[]> {
  const unified = await loadUnified()
  let queue = unified.queue

  // find existing entry by name (case-sensitive exact match)
  const index = queue.findIndex(a => a.name === entry.name)

  if (index !== -1) {
    // Entry with same name exists - merge them into a single queue cell
    // Merge with existing entry
    const existing = queue[index]
    
    // Extract episode numbers from links
    // Links format: `ffmpeg -i "${hls}" -c copy ~/Documents/.../...\ -\ ${number}.mp4`
    const extractEpisodeFromLink = (link: string): number => {
      const match = link.match(/\\ -\ (\d+)\.mp4/)
      return match ? Number(match[1]) : 0
    }
    
    // Keep mkdir from existing (first element)
    const mergedLinks: string[] = [existing.links[0]] // keep mkdir command
    const linkMap = new Map<number, string>() // episode number -> link
    const episodeSet = new Set<number>() // all episode numbers
    
    // Add all links from existing (skip mkdir)
    for (let i = 1; i < existing.links.length; i++) {
      const epNum = extractEpisodeFromLink(existing.links[i])
      if (epNum > 0) {
        linkMap.set(epNum, existing.links[i])
        episodeSet.add(epNum)
      }
    }
    
    // Add all links from new entry (skip mkdir), overwriting if same episode
    for (let i = 1; i < entry.links.length; i++) {
      const epNum = extractEpisodeFromLink(entry.links[i])
      if (epNum > 0) {
        linkMap.set(epNum, entry.links[i])
        episodeSet.add(epNum)
      }
    }
    
    // Sort by episode number and add to merged links
    const sortedEpisodes = Array.from(episodeSet).sort((a, b) => a - b)
    for (const epNum of sortedEpisodes) {
      mergedLinks.push(linkMap.get(epNum)!)
    }
    
    // Group episodes into continuous ranges
    const formatEpisodes = (episodes: number[]): string => {
      if (episodes.length === 0) return ""
      if (episodes.length === 1) return String(episodes[0])
      
      const ranges: string[] = []
      let rangeStart = episodes[0]
      let rangeEnd = episodes[0]
      
      for (let i = 1; i < episodes.length; i++) {
        if (episodes[i] === rangeEnd + 1) {
          // Continuous, extend range
          rangeEnd = episodes[i]
        } else {
          // Gap found, save current range and start new one
          if (rangeStart === rangeEnd) {
            ranges.push(String(rangeStart))
          } else {
            ranges.push(`${rangeStart} to ${rangeEnd}`)
          }
          rangeStart = episodes[i]
          rangeEnd = episodes[i]
        }
      }
      
      // Add final range
      if (rangeStart === rangeEnd) {
        ranges.push(String(rangeStart))
      } else {
        ranges.push(`${rangeStart} to ${rangeEnd}`)
      }
      
      return ranges.join(", ")
    }
    
    const mergedEpisodes = formatEpisodes(sortedEpisodes)
    
    const mergedEntry: DownloadAnime = {
      ...entry, // use new entry's metadata (img, source, etc.)
      episodes: mergedEpisodes,
      links: mergedLinks,
      isUnread: true
    }
    
    // Remove old, add merged at front
    queue.splice(index, 1)
    queue.unshift(mergedEntry)
  } else {
    // New entry - format episodes consistently from links
    const extractEpisodeFromLink = (link: string): number => {
      const match = link.match(/\\ -\ (\d+)\.mp4/)
      return match ? Number(match[1]) : 0
    }
    
    const episodeSet = new Set<number>()
    for (let i = 1; i < entry.links.length; i++) {
      const epNum = extractEpisodeFromLink(entry.links[i])
      if (epNum > 0) {
        episodeSet.add(epNum)
      }
    }
    
    const sortedEpisodes = Array.from(episodeSet).sort((a, b) => a - b)
    
    // Format episodes into ranges
    const formatEpisodes = (episodes: number[]): string => {
      if (episodes.length === 0) return ""
      if (episodes.length === 1) return String(episodes[0])
      
      const ranges: string[] = []
      let rangeStart = episodes[0]
      let rangeEnd = episodes[0]
      
      for (let i = 1; i < episodes.length; i++) {
        if (episodes[i] === rangeEnd + 1) {
          rangeEnd = episodes[i]
        } else {
          if (rangeStart === rangeEnd) {
            ranges.push(String(rangeStart))
          } else {
            ranges.push(`${rangeStart} to ${rangeEnd}`)
          }
          rangeStart = episodes[i]
          rangeEnd = episodes[i]
        }
      }
      
      if (rangeStart === rangeEnd) {
        ranges.push(String(rangeStart))
      } else {
        ranges.push(`${rangeStart} to ${rangeEnd}`)
      }
      
      return ranges.join(", ")
    }
    
    const formattedEntry: DownloadAnime = {
      ...entry,
      episodes: formatEpisodes(sortedEpisodes)
    }
    
    queue.unshift(formattedEntry)
  }

  await saveUnified({ ...unified, queue })
  return queue
}

// Get cache array
export async function getCache(): Promise<Anime[]> {
  const unified = await loadUnified()
  return unified.cache
}

// Get queue array
export async function getQueue(): Promise<DownloadAnime[]> {
  const unified = await loadUnified()
  return unified.queue
}

// Save cache array
export async function saveCache(cache: Anime[]): Promise<void> {
  const unified = await loadUnified()
  await saveUnified({ ...unified, cache })
}

// Save queue array
export async function saveQueue(queue: DownloadAnime[]): Promise<void> {
  const unified = await loadUnified()
  await saveUnified({ ...unified, queue })
}