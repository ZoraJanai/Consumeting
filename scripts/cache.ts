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

  // find existing entry
  const index = queue.findIndex(a => a.name === entry.name)

  if (index !== -1) {
    // Merge with existing entry
    const existing = queue[index]
    
    // Parse episode ranges
    const parseEpisodes = (epStr: string): { start: number, end: number } => {
      if (epStr.includes(" to ")) {
        const [start, end] = epStr.split(" to ").map(s => Number(s.trim()))
        return { start, end }
      } else {
        const num = Number(epStr.trim())
        return { start: num, end: num }
      }
    }

    const existingEp = parseEpisodes(existing.episodes)
    const newEp = parseEpisodes(entry.episodes)
    
    // Calculate merged range
    const mergedStart = Math.min(existingEp.start, newEp.start)
    const mergedEnd = Math.max(existingEp.end, newEp.end)
    
    // Merge links arrays
    // Keep mkdir from existing (first element), then merge unique links
    const mergedLinks: string[] = [existing.links[0]] // keep mkdir command
    const linkSet = new Set<string>()
    
    // Add all links from existing (skip mkdir)
    for (let i = 1; i < existing.links.length; i++) {
      if (!linkSet.has(existing.links[i])) {
        mergedLinks.push(existing.links[i])
        linkSet.add(existing.links[i])
      }
    }
    
    // Add all links from new entry (skip mkdir)
    for (let i = 1; i < entry.links.length; i++) {
      if (!linkSet.has(entry.links[i])) {
        mergedLinks.push(entry.links[i])
        linkSet.add(entry.links[i])
      }
    }
    
    // Create merged entry
    const mergedEpisodes = mergedStart === mergedEnd 
      ? String(mergedStart) 
      : `${mergedStart} to ${mergedEnd}`
    
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
    // add new at front
    queue.unshift(entry)
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