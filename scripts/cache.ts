import { loadSetting } from "../Pages/Settings"
import { loadData, saveData } from "./data"

const path = loadSetting("cache.path",'cache.json')
const queuePath = loadSetting("queue.path",'queue.json')

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


export async function addCache(entry: Anime) {
  let cache: Anime[] = await loadData(path)

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

  await saveData(path, cache)
  return cache
}

export async function addQueue(entry: DownloadAnime): Promise<DownloadAnime[]>{
  let queue = await loadData<DownloadAnime[]>(queuePath)

  // find existing entry
  const index = queue.findIndex(a => a.name === entry.name)

  if (index !== -1) {
    // replace + move to front
    queue.splice(index, 1) // remove old
    queue.unshift(entry)   // add new at start
  } else {
    // add new at front
    queue.unshift(entry)
  }

  await saveData(queuePath, queue)
  return queue
}