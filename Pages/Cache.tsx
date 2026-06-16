import {
  Button, Circle, ContentUnavailableView, HStack, Image, Label, List, Menu,
  NavigationStack, RoundedRectangle, Section, Spacer, Text, useEffect, useState, VStack, ZStack
} from "scripting"

import { NumberInputSheet } from "./numberPopout"
import { getInfoAnilist, getInfoAnimepahe } from "../scripts/search"
import { normalizePaheUrl } from "../scripts/animepaheClient"
import { downloadEpisode, episodeNumber, getEpisode, queueEpisodeRange, QualitiesOrder } from "../scripts/episode"
import { getCache, getQueue, saveCache, saveQueue, addCache, addQueue } from "../scripts/cache"
import { hideOverlay, showOverlay } from "./Loading"
import { QualityPickerSheet } from "./QualityPickerSheet"
import { STORAGE_KEYS } from "./Settings"



type Anime = {
  name: string
  source: string
  episodes: string
  img: string
  isUnread: boolean
  paheID?: string
}

export type DownloadAnime = {
  name: string
  source: string
  episodes: string
  img: string
  links: string[]
  isUnread: boolean
}


type EntryType = {
  name: string
  ids: string[]
  episode: string
  total: string
  id: string
  img: string
}

const PlaceholderEntry: EntryType = {
  name: "Name of Anime",
  ids: [],
  episode: "0",
  total: "99",
  id: "123456",
  img: ""
}

// Simple storage helpers (local)
function loadSetting<T>(key: string, defaultValue: T): T {
  if (Storage.contains(key)) {
    try {
      const stored = Storage.get<any>(key)
      return typeof defaultValue === "object" ? JSON.parse(stored) : stored
    } catch {
      return defaultValue
    }
  }
  return defaultValue
}
function saveSetting(key: string, value: any) {
  Storage.set(key, typeof value === "object" ? JSON.stringify(value) : value)
}

export async function chosenAnime(anime: Anime) {
  console.log('[chosenAnime] START - anime:', anime.name, 'source:', anime.source);
  let info
  if (anime.source.includes("-")) {
    console.log('[chosenAnime] Source contains "-", calling getInfoAnimepahe');
    info = await getInfoAnimepahe(anime)
    console.log('[chosenAnime] getInfoAnimepahe returned');
  } else {
    console.log('[chosenAnime] Source is numeric, calling getInfoAnilist');
    info = await getInfoAnilist(anime)
    console.log('[chosenAnime] getInfoAnilist returned');
  }
  console.log('[chosenAnime] Saving entry');
  saveSetting("entry", info)
  console.log('[chosenAnime] DONE - returning info');
  return info
}

function TapMenu({
  anime,
  animeInfo
}: {
  anime: Anime
  animeInfo: (anime: Anime, action: string) => void
}): JSX.Element {
  if (anime.episodes !== "0") {
    // Check if current episode is 0 (from "0/total" format)
    const current = anime.episodes.includes("/")
      ? Number(anime.episodes.split("/")[0])
      : 0
    
    const isFirstEpisode = current === 0
    
    return (
      <>
        {isFirstEpisode ? (
          <Button title="Start"   action={() => animeInfo(anime, "Next")} />
        ) : (
          <>
            <Button title="Next"    action={() => animeInfo(anime, "Next")} />
            <Button title="Resume"  action={() => animeInfo(anime, "Resume")} />
          </>
        )}
        <Button title="Choose"  action={() => animeInfo(anime, "Choose")} />
        <Menu label={<Text>Download</Text>}>
          <Button title="Continue" action={() => animeInfo(anime, "Continue")} />
          <Button title="Jump"     action={() => animeInfo(anime, "Jump")} />
          <Button title="Download All" action={() => animeInfo(anime, "DownloadAll")} />
        </Menu>
      </>
    )
  } else {
    return (
      <>
        <Button title="Add"      action={() => animeInfo(anime, "Add")} />
        <Button title="Watch"    action={() => animeInfo(anime, "Watch")} />
        <Button title="Download" action={() => animeInfo(anime, "Download")} />
      </>
    )
  }
}



export function AnimeCell({
  anime,
  animeInfo
}: {
  anime: Anime
  animeInfo: (anime: Anime, action: string) => void
}) {
  let diff: number
  if (anime.episodes.includes("/")) {
    const [cur, tot] = anime.episodes.split("/")
    diff = Number(tot) - Number(cur)
  } else {
    diff = 0
  }

  return (
    <Menu
      label={
        <HStack frame={{ height: 256 }}>
          <Image
            imageUrl={normalizePaheUrl(anime.img)}
            aspectRatio={{ contentMode: "fit", value: 2 / 3 }}
            frame={{ height: 225 }}
            resizable
            padding={12}
          />
          <VStack alignment="leading">
            
            <Text multilineTextAlignment="leading" foregroundStyle="white" font="headline">
              {anime.name}
            </Text>
            <Text multilineTextAlignment="leading" foregroundStyle="lightGray" fontWeight="light">
              {anime.source}
            </Text>
            {anime.paheID ? (
              <Text multilineTextAlignment="leading" foregroundStyle="lightGray" fontWeight="light">
                paheID: {anime.paheID}
              </Text>
            ) : null}
            <HStack>
              
            {anime.episodes !== "0"
              ? <Text multilineTextAlignment="leading" foregroundStyle="white">
                  {anime.episodes.replace("/", " of ")}
                </Text>
              : <Text multilineTextAlignment="leading" foregroundStyle="clear">anime.episodes</Text>}

              {anime.episodes !== "0" ? (
            <ZStack>
            <RoundedRectangle
              fill={anime.isUnread ? "systemRed" : "clear"}
              cornerRadius={12}   // capsule look
              frame={{
      
              width: 24 + Math.max(0, String(diff).length - 2) * 8,
              height: 24,
              }}
            />
              {String(diff) !== "0"
                ? <Text font={14} foregroundStyle="white">{diff}</Text>
                : <Text font={14} foregroundStyle="clear">{diff}</Text>
              }
            </ZStack>
              ) : null}
            </HStack>
            </VStack>
          <Spacer />
        </HStack>
      }
    >
      <TapMenu anime={anime} animeInfo={animeInfo} />
      <Button title="Cancel" role="destructive" action={() => console.log("Cancel")} />
    </Menu>
  )
}

export function CachePage({ onCacheSaved, onBadgeChange, onQueueSaved}: { onCacheSaved?: () => void; onBadgeChange?: (n:number) => void; onQueueSaved?: ()=> void}) {
  // Distinct storage keys for this page to avoid overrides
  const CACHE_KEY = "cache.last.cachepage"
  const QUEUE_KEY = "queue.last.cachepage"

  // 1) Seed UI immediately from last known cache (sync) to avoid empty flash on mount
  const [animes, setAnimes] = useState<Anime[]>(
    loadSetting<Anime[]>(CACHE_KEY, [])   // ← instant seed with distinct key
  )
  const [loadedOnce, setLoadedOnce] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false) // for fade
  // progress state (replace your isRefreshing usage)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshTotal, setRefreshTotal] = useState(0)
  const [refreshDone, setRefreshDone] = useState(0)

  const [downloading, setDownloading] = useState(false)
  const [downloadTotal, setDownloadTotal] = useState(0)
  const [downloadDone, setDownloadDone] = useState(0)
  
  const [queue, setQueue] = useState<DownloadAnime[]>(
    loadSetting<DownloadAnime[]>(QUEUE_KEY, [])
  )
  
  // Use ref to prevent loop - track if we're currently loading
  const isLoadingRef = { current: false }
  
  // Single loader used everywhere. Keeps old list visible while fading.
  const load = async () => {
    if (isLoadingRef.current) return // Prevent concurrent loads
    try {
      isLoadingRef.current = true
      setIsRefreshing(true)
      const cache = await getCache()
      const next = Array.isArray(cache) ? cache : []
      setAnimes(next)
      saveSetting(CACHE_KEY, next)       // persist for next mount with distinct key
    } catch {
      // if we have never loaded and nothing in seed, show empty; otherwise keep showing old list
      if (!loadedOnce && animes.length === 0) setAnimes([])
    } finally {
      isLoadingRef.current = false
      setLoadedOnce(true)
      setTimeout(() => setIsRefreshing(false), 120) // quick but noticeable fade
    }
  }

  // Load only once on mount - no dependencies to prevent loops
  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [showNumberSheet, setShowNumberSheet] = useState(false)
  const [entry, setEntry] = useState<EntryType>(loadSetting("entry", PlaceholderEntry))
  const [queueEntry, setQueueEntry] = useState<EntryType>(loadSetting("queueEntry", PlaceholderEntry))
  const [sheetTitle, setSheetTitle] = useState("Episode number")
  const [progressKey, setProgressKey] = useState(0)
  const [progressStarted, setProgressStarted] = useState(false)
  

  // ---- Quality Picker Sheet state ----
const [showQualitySheet, setShowQualitySheet] = useState(false)
const [qualityTitle, setQualityTitle] = useState("Which quality?")
const [qualityOptions, setQualityOptions] = useState<string[]>([])

function askQualityOnce(title: string, options: string[]): Promise<string> {
  return new Promise<string>((resolve) => {
    setQualityTitle(title)
    setQualityOptions(options)
    ;(setQualityOptions as any).resolve = resolve
    setShowQualitySheet(true)
  })
}

  useEffect(() => {
    const total = animes.reduce((sum, a) => {
      if (!a || typeof a.episodes !== "string") return sum
      if (!a.episodes.includes("/")) return sum
      const [curStr, totStr] = a.episodes.split("/")
      const cur = Number(curStr)
      const tot = Number(totStr)
      if (Number.isFinite(cur) && Number.isFinite(tot) && tot > cur) {
        return sum + (tot - cur)
      }
      return sum
    }, 0)
    onBadgeChange?.(total)      // 👈 tell parent
  }, [animes, onBadgeChange])

  async function animeInfo(anime: Anime, action: string) {
    console.log('[animeInfo] START - anime:', anime.name, 'action:', action);
    showOverlay()
    console.log('[animeInfo] Overlay shown, fetching anime info...');
    
    const info = await chosenAnime(anime)
    console.log('[animeInfo] Info received:', info);

    const current = anime.episodes.includes("/")
      ? Number(anime.episodes.split("/")[0])
      : 0
    console.log('[animeInfo] Current episode:', current);

    const auto = episodeNumber(current, Number(info.total), action)
    console.log('[animeInfo] Auto value:', auto);

    // 1) Known exact index
    if (auto! >= 1) {
      console.log('[animeInfo] Path 1: Known exact index >= 1');
      info.episode = String(auto)
      setEntry(info)
      saveSetting("entry", info)
      console.log('[animeInfo] Calling episodeThenUpdate with index:', auto);
      await episodeThenUpdate(auto!)
      console.log('[animeInfo] episodeThenUpdate returned');
      return
    }

    // 2) First-time add
    if (auto === 0) {
      console.log('[animeInfo] Path 2: First-time add (auto === 0)');
      info.episode = "0"
      setEntry(info)
      const cacheEntry: Anime = {
        name: info.name,
        source: info.id,
        episodes: `0/${info.total}`,
        img: info.img || anime.img,
        isUnread: true
      }
      console.log('[animeInfo] Adding to cache:', cacheEntry);
      const next = await addCache(cacheEntry)
      setAnimes(next)
      saveSetting(CACHE_KEY, next)
      onCacheSaved?.()
      hideOverlay()
      console.log('[animeInfo] Path 2 complete');
      return
    }

    // 3) Ask once (-1)
    if (auto === -1) {
      console.log('[animeInfo] Path 3: Ask once (auto === -1)');
      const title = action === "Choose"
        ? `Episode number for ${info.name}`
        : `End episode for ${info.name}`
      console.log('[animeInfo] Asking user for number, title:', title);

      let picked = await askNumberOnce(title, info.total, String(current + 1))
      console.log('[animeInfo] User picked:', picked);
      
      if (action === "Choose") {
        console.log('[animeInfo] Path 3a: Choose action');
        info.episode = String(picked)
        setEntry(info)
        console.log('[animeInfo] Calling episodeThenUpdate with picked:', picked);
        await episodeThenUpdate(picked)
        console.log('[animeInfo] Path 3a complete');
      } else { // download
        console.log('[animeInfo] Path 3b: Download action');

        if (picked > Number(info.total) || 0>= picked){
          console.log('[animeInfo] Path 3b: Invalid pick, hiding overlay');
          hideOverlay()
          return
        }else{
          console.log('[animeInfo] Path 3b: Valid pick, processing download');
          info.episode= String(picked)
          setEntry(info)
          saveSetting("entry", info)
          console.log('[animeInfo] Path 3b: Entry saved');

          info.episode = String(current+1)
          info.total = String(picked)
          if(current===0){ 
            console.log('[animeInfo] Path 3b: current is 0, incrementing picked');
            picked++;
          }
          info.ids = info.ids.slice(Math.max(0, current - 1), Math.max(0, picked-1))
          console.log('[animeInfo] Path 3b: Queue info prepared:', info);
          setQueueEntry(info)
          saveSetting("queueEntry", info)
          console.log('[animeInfo] Path 3b: Calling episodeThenUpdate(-44)');
          await episodeThenUpdate(-44)
          console.log('[animeInfo] Path 3b complete');
        }
        return
      }
    }

    // 4) Ask twice (-2)
    if (auto === -2) {
      console.log('[animeInfo] Path 4: Ask twice (auto === -2)');
      const start = await askNumberOnce(`Start episode for ${info.name}`, info.total, String(current + 1))
      console.log('[animeInfo] Start episode:', start);
      const end = await askNumberOnce(`End episode for ${info.name}`, info.total, String(start))
      console.log('[animeInfo] End episode:', end);
      
      if (start > Number(info.total) || end > Number(info.total) || start > end || 0 >= start ){
        console.log('[animeInfo] Invalid range, hiding overlay');
        hideOverlay()
        return
      }else{
        console.log('[animeInfo] Valid range, processing...');
        info.episode = String(end)
        setEntry(info)
        saveSetting("entry", info)
        
        info.ids = info.ids.slice(Math.max(0, start - 1), Math.max(0, end))
        info.episode = String(start)
        info.total = String(end)
        
        setQueueEntry(info)
        saveSetting("queueEntry", info)
        console.log('[animeInfo] Calling episodeThenUpdate(-44)');
        await episodeThenUpdate(-44)
        console.log('[animeInfo] Path 4 complete');
        return
      }
    }

    // 5) Single current only (-3)
    if (auto === -3) {
      console.log('[animeInfo] Path 5: Single current only (auto === -3)');
      info.episode = String(current+1)
      setEntry(info)
      saveSetting("entry", info)
      
      info.ids = info.ids.slice(current, current + 1)
      info.episode=String(current+1)
      info.total=String(current+1)
      setQueueEntry(info)
      console.log('[animeInfo] Calling episodeThenUpdate(-44)');
      await episodeThenUpdate(-44)
      console.log('[animeInfo] Path 5 complete');
      return
    }

    // 6) Confirm resume (-5)
    if (auto === -5) {
      console.log('[animeInfo] Path 6: Last episode warning (auto === -5)');
      if (action === "DownloadAll") {
        await Dialog.alert({
          title: "All caught up",
          message: "No unwatched episodes left.",
          buttonLabel: "Dismiss",
        })
      } else {
        await Dialog.alert({
          title: 'That was the last episode.',
          message: 'Use resume to play it again.',
          buttonLabel: 'Dismiss'
        })
      }
      hideOverlay()
      console.log('[animeInfo] Path 6 complete');
      return
    }

    // 7) Download all unwatched (-6)
    if (auto === -6) {
      console.log('[animeInfo] Path 7: Download all unwatched (auto === -6)');
      const start = current + 1
      const end = Number(info.total)
      if (start > end) {
        hideOverlay()
        return
      }

      setProgressKey(k => k + 1)
      setDownloadDone(0)
      setDownloadTotal(0)
      setProgressStarted(false)
      setDownloading(true)

      const tuple = await queueEpisodeRange(
        info,
        current,
        start,
        end,
        (done, total) => {
          if (!progressStarted) setProgressStarted(true)
          setDownloadDone(done)
          setDownloadTotal(total)
        },
        (total) => {
          setDownloadDone(0)
          setDownloadTotal(total)
        },
        async (options) => await askQualityOnce("Which quality?", options)
      )

      setDownloading(false)
      if (!tuple) {
        hideOverlay()
        return
      }

      const [cacheItem, queueItem] = tuple
      const updatedCache = await addCache(cacheItem)
      setAnimes(updatedCache)
      saveSetting(CACHE_KEY, updatedCache)
      onCacheSaved?.()

      const updatedQueue = await addQueue(queueItem)
      setQueue(updatedQueue)
      saveSetting(QUEUE_KEY, updatedQueue)
      onQueueSaved?.()

      hideOverlay()
      console.log('[animeInfo] Path 7 complete');
      return
    }
    
    console.log('[animeInfo] No path matched! auto =', auto);
  }

  function askNumberOnce(title: string, total: string, initial: string): Promise<number> {
    return new Promise<number>((resolve) => {
      setSheetTitle(title)
      setEntry({
        ...entry,
        total,
        episode: initial,
      })
      ;(setEntry as any).resolve = resolve
      setShowNumberSheet(true)
    })
  }

  function cancelInput(){
    setShowNumberSheet(false)
    hideOverlay()
  }

  async function episodeThenUpdate(index: number) {
      if (index === -44) {
    setProgressKey(k => k + 1)       // remount
    setDownloadDone(0)
    setDownloadTotal(0)              // ← don’t show any stale total
    setProgressStarted(false)
    setDownloading(true)

    const tuple = await downloadEpisode(
      (done, total) => {             // onProgress
        if (!progressStarted) setProgressStarted(true)
        setDownloadDone(done)
        setDownloadTotal(total)
      },
      (total) => {                   // onStart
        setDownloadDone(0)
        setDownloadTotal(total)      // show 0/<real total> immediately
      },
      async (options) => await askQualityOnce("Which quality?", options)  
    )

    console.log('[episodeThenUpdate] downloadEpisode returned');
    setDownloading(false)
    const [cacheItem, queueItem] = tuple
    console.log('[episodeThenUpdate] Tuple extracted - cache:', cacheItem.name, 'queue:', queueItem.name);

    // 1) update CACHE (Anime[])
    console.log('[episodeThenUpdate] Updating cache...');
    const updatedCache = await addCache(cacheItem)
    setAnimes(updatedCache)
    saveSetting(CACHE_KEY, updatedCache)
    onCacheSaved?.()
    console.log('[episodeThenUpdate] Cache updated');

    // 2) update QUEUE (DownloadAnime[])
    console.log('[episodeThenUpdate] Updating queue...');
    const updatedQueue = await addQueue(queueItem)
    setQueue(updatedQueue)
    saveSetting(QUEUE_KEY, updatedQueue)
    onQueueSaved?.()
    console.log('[episodeThenUpdate] Queue updated');

    hideOverlay()
    console.log('[episodeThenUpdate] Download path complete');
    return
  } else {
    console.log('[episodeThenUpdate] Path: Watch episode (index:', index, ')');
    console.log('[episodeThenUpdate] Calling getEpisode...');
    
    const anime = await getEpisode(index, async (options) => {
      return await askQualityOnce("Which quality?", options)
    })
    console.log('[episodeThenUpdate] getEpisode returned:', anime);
    
    console.log('[episodeThenUpdate] Adding to cache...');
    const next = await addCache(anime)
    setAnimes(next)
    saveSetting(CACHE_KEY, next)
    onCacheSaved?.()
    console.log('[episodeThenUpdate] Watch path complete');
  }
  console.log('[episodeThenUpdate] END');
  }

  async function toggleUnread(anime: Anime) {
    const total = anime.episodes.split("/")[1]
    const next = animes.map(item =>
      item !== anime
        ? item
        : { ...anime, isUnread: !item.isUnread, episodes: `${total}/${total}` }
    )
    setAnimes(next)                        // optimistic UI
    saveSetting(CACHE_KEY, next)          // distinct key
    await saveCache(next)                  // save to unified file
    onCacheSaved?.()
  }

  async function deleteAnime(anime: Anime) {
    const next = animes.filter(item => item !== anime)
    setAnimes(next)                        // optimistic UI
    saveSetting(CACHE_KEY, next)          // distinct key
    await saveCache(next)                  // save to unified file
    onCacheSaved?.()
  }

  async function downloadAllUnwatched() {
    const candidates = animes.filter(function (a) {
      if (!a || typeof a.episodes !== "string" || !a.episodes.includes("/")) return false
      const parts = a.episodes.split("/")
      const cur = Number(parts[0])
      const tot = Number(parts[1])
      return Number.isFinite(cur) && Number.isFinite(tot) && cur < tot
    })

    if (!candidates.length) {
      await Dialog.alert({
        title: "Nothing to download",
        message: "No unwatched episodes in cache.",
        buttonLabel: "Dismiss",
      })
      return
    }

    let totalEps = 0
    for (let i = 0; i < candidates.length; i++) {
      const parts = candidates[i].episodes.split("/")
      totalEps += Number(parts[1]) - Number(parts[0])
    }

    showOverlay()
    setProgressKey(function (k) { return k + 1 })
    setDownloadDone(0)
    setDownloadTotal(totalEps)
    setProgressStarted(false)
    setDownloading(true)

    let doneEps = 0
    let updatedQueue = queue

    for (let i = 0; i < candidates.length; i++) {
      const anime = candidates[i]
      try {
        const info = await chosenAnime(anime)
        const current = anime.episodes.includes("/")
          ? Number(anime.episodes.split("/")[0])
          : 0
        const start = current + 1
        const end = Number(info.total)
        if (start > end) continue

        const tuple = await queueEpisodeRange(
          info,
          current,
          start,
          end,
          function (done) {
            setProgressStarted(true)
            setDownloadDone(doneEps + done)
            setDownloadTotal(totalEps)
          },
          undefined,
          async function (options) {
            return await askQualityOnce("Which quality?", options)
          }
        )

        if (tuple) {
          const queueItem = tuple[1]
          updatedQueue = await addQueue(queueItem)
          doneEps += end - start + 1
          setDownloadDone(doneEps)
        }
      } catch (err) {
        console.log("[downloadAllUnwatched] failed for", anime.name, err)
      }
    }

    setQueue(updatedQueue)
    saveSetting(QUEUE_KEY, updatedQueue)
    onQueueSaved?.()
    setDownloading(false)
    hideOverlay()
  }

  async function refresh() {
  // show a local progress bar instead of a full-screen overlay
  setRefreshing(true)
  setRefreshTotal(animes.length)
  setRefreshDone(0)

  const updated: Anime[] = []

  for (let i = 0; i < animes.length; i++) {
    const anime = animes[i]
    try {
      // fresh info (EntryType)
      const info = await chosenAnime(anime)

      // keep current progress (cur) from "cur/total"
      let cur = 0
      if (anime.episodes.includes("/")) {
        const [curStr] = anime.episodes.split("/")
        cur = Number(curStr) || 0
      }
      const newTotal = Number(info.total) || 0

      updated.push({
        ...anime,
        // update the total with the new value, keep current watched count
        episodes: `${cur}/${newTotal}`,
        isUnread: cur < newTotal
      })
    } catch (err) {
      console.log(`refresh failed for ${anime.name}`, err)
      updated.push(anime) // keep old item if refresh fails
    } finally {
      setRefreshDone(d => d + 1)
    }
  }

  setAnimes(updated)
  saveSetting(CACHE_KEY, updated)        // distinct key
  await saveCache(updated)                // save to unified file
  onCacheSaved?.()

  setRefreshing(false)
}

  function SegmentedProgress({
  done, total, label
}: { done: number; total: number; label?: string }) {
  const steps = 20
  const pct = total > 0 ? done / total : 0
  const filled = Math.max(0, Math.min(steps, Math.round(pct * steps)))

  const segments = []
  for (let i = 0; i < steps; i++) {
    segments.push(
      <RoundedRectangle
        key={`seg-${i}`}
        fill={i < filled ? "systemBlue" : "secondarySystemFill"}
        cornerRadius={2}
        frame={{ width: 8, height: 6 }}
      />
    )
  }

  return (
    <VStack padding={12} spacing={8}>
      <HStack spacing={2}>{segments}</HStack>
      <Text font={12} foregroundStyle="lightGray">
        {label ?? "Refreshing"} {done}/{total}
      </Text>
    </VStack>
  )
}

  
function cleanupAfterQualityCancel() {
  hideOverlay()
  setDownloading(false)
  setProgressStarted(false)
  setDownloadDone(0)
  setDownloadTotal(0)
}  
  
return (
  <NavigationStack>
    <VStack spacing={0}>
      {/* progress bar strip shown above the list */}
      {refreshing ? (
        <VStack
          alignment="leading"
          padding={{ top: 8, horizontal: 12, bottom: 8 }}
        >
          <SegmentedProgress
            done={refreshDone}
            total={refreshTotal}
            label="Refreshing"
          />
        </VStack>
      ) : null}

      {downloading ? (
  <VStack
    alignment="leading"
    padding={{ top: 8, horizontal: 12, bottom: 8 }}
  >
    <SegmentedProgress
      key={progressKey}
      done={downloadDone}
      total={downloadTotal}
      label={progressStarted ? "Adding to Queue..." : "Preparing..."}
    />
  </VStack>
) : null}

      <List
        navigationTitle="Cache"
        navigationBarTitleDisplayMode="inline"
        listStyle="inset"
        refreshable={refresh}
        toolbar={{
          confirmationAction: [
            <Button title="Download All" action={() => downloadAllUnwatched()} />,
          ],
        }}
        overlay={
          loadedOnce && animes.length === 0
            ? <ContentUnavailableView title="Nothing here to check" systemImage="aqi.medium" />
            : undefined
        }
      >
        {animes.map(anime =>
          <AnimeCell
            key={`${anime.name}-${anime.source}-${anime.episodes}`}
            anime={anime}
            animeInfo={animeInfo}
            leadingSwipeActions={{
              allowsFullSwipe: false,
              actions: [
                anime.isUnread
                  ? <Button action={async () => await toggleUnread(anime)} tint="systemBlue">
                      <Label title="Watch" systemImage="eye.fill" />
                    </Button>
                  : <></>
              ]
            }}
            trailingSwipeActions={{
              actions: [
                <Button role="destructive" action={async () => await deleteAnime(anime)}>
                  <Label title="Delete" systemImage="trash" />
                </Button>
              ]
            }}
          />
        )}
      </List>
    </VStack>

    <VStack
      frame={{ height: 0 }}
      sheet={{
        isPresented: showNumberSheet,
        onChanged: setShowNumberSheet,
        content: (
          <NumberInputSheet
            title={sheetTitle}
            total={entry.total}
            initial={entry.episode}
            onPicked={async (n) => {
              const resolver = (setEntry as any).resolve as ((n: number) => void) | undefined
              if (resolver) {
                resolver(n)
                ;(setEntry as any).resolve = undefined
              } else {
                await episodeThenUpdate(n)
              }
              setShowNumberSheet(false)
            }}
            onClose={() => cancelInput()}
          />
        )
      }}
    />

  <VStack
  frame={{ height: 0 }}
  sheet={{
    isPresented: showQualitySheet,
    onChanged: (presented: boolean) => {
      setShowQualitySheet(presented)

      // If the sheet just CLOSED and no selection was made, it's a cancel/dismiss
      if (!presented) {
        const resolver = (setQualityOptions as any).resolve as
          | ((val: string) => void)
          | undefined

        if (resolver) {
          // user dismissed (tap outside or swipe down) → clear pending resolver and cleanup
          ;(setQualityOptions as any).resolve = undefined
          cleanupAfterQualityCancel()
        }
        // if no resolver, it closed because we already picked; do nothing
      }
    },
    content: (
      <QualityPickerSheet
        title={qualityTitle}
        options={qualityOptions}
        order={loadSetting(STORAGE_KEYS.QUALITY_ORDER, QualitiesOrder)} // live order from settings
        onPicked={(q) => {
          const resolver = (setQualityOptions as any).resolve as ((val: string) => void) | undefined
          if (resolver) {
            resolver(q)
            ;(setQualityOptions as any).resolve = undefined
          }
          setShowQualitySheet(false)
        }}
        onClose={() => {
  setShowQualitySheet(false)
  hideOverlay()           // 🔹 close the global overlay
  setDownloading(false)   // 🔹 hide progress bar
  setProgressStarted(false)
  setDownloadDone(0)
  setDownloadTotal(0)
}}
      />
    )
  }}
/>
  </NavigationStack>
)
}