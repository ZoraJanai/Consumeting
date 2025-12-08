import {
  HStack, List, NavigationStack, Picker, RoundedRectangle, Section, Spacer, Text,
  VStack, useEffect, useState
} from "scripting"
import { AnimeCell, chosenAnime } from "./Cache"
import { searchAnilist, searchAnimepahe } from "../scripts/search"
import { NumberInputSheet } from "./numberPopout"
import { STORAGE_KEYS, loadSetting, saveSetting } from "./Settings"
import { QualitiesOrder, downloadEpisode, episodeNumber, getEpisode } from "../scripts/episode"
import { getCache, addCache, addQueue } from "../scripts/cache"
import { hideOverlay, showOverlay } from "./Loading"
import { QualityPickerSheet } from "./QualityPickerSheet"

type EntryType = {
  name: string
  ids: string[] 
  episode: string
  total: string
  id: string
  img: string
}
type Anime = {
  name: string
  source: string
  episodes: string
  img: string
  isUnread: boolean
}

export type DownloadAnimeType = {
  name: string
  source: string
  episodes: string
  img: string
  links: string[]
  isUnread: boolean
}

type ProviderType = 'Anilist' | 'Animepahe'

const PlaceholderAnime: Anime = {
  name: "Name of Anime",
  source: "id",
  episodes: "0/99",
  img: "https://i.ibb.co/Z1dTy8mC/New-Project.jpg",
  isUnread: true,
}

const PlaceholderEntry: EntryType = {
  name: "Name of Anime",
  ids: [],
  episode: "0",
  total: "99",
  id: "123456",
  img: ""
}



export function HomePage({ onCacheSaved,onQueueSaved }: { onCacheSaved?: () => void;onQueueSaved?:()=>void }) {
  // Distinct storage keys for this page to avoid overrides
  const CACHE_KEY = "cache.last.homepage"
  const QUEUE_KEY = "queue.last.homepage"

  const [showNumberSheet, setShowNumberSheet] = useState(false)
  const [provider, setProvider] = useState<ProviderType>(loadSetting('settings.provider','Anilist'))

  const [animes, setAnimes] = useState<Anime[]>([PlaceholderAnime])
  const [queue, setQueue] = useState<DownloadAnimeType[]>(loadSetting<DownloadAnimeType[]>(QUEUE_KEY, []))
  const [cacheUpdateTrigger, setCacheUpdateTrigger] = useState(0)

  // Use ref to prevent loop - track if we're currently loading
  const isLoadingRef = { current: false }

  // Reload cache entry function
  const reloadCacheEntry = async () => {
    if (isLoadingRef.current) return // Prevent concurrent loads
    try {
      isLoadingRef.current = true
      const cache = await getCache()
      if (Array.isArray(cache) && cache.length) {
        setAnimes([cache[0] as Anime])
        saveSetting(CACHE_KEY, [cache[0] as Anime])  // distinct key
      }
    } catch { /* ignore */ } finally {
      isLoadingRef.current = false
    }
  }

  useEffect(() => {
    reloadCacheEntry()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])  // Load on mount

  // Reload when cache update trigger changes (triggered by onCacheSaved)
  useEffect(() => {
    if (cacheUpdateTrigger > 0) {
      reloadCacheEntry()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheUpdateTrigger])

  // Wrapper for onCacheSaved that also triggers reload
  const handleCacheSaved = () => {
    setCacheUpdateTrigger(v => v + 1)
    onCacheSaved?.()
  }

  const [searchText, setSearchText] = useState("")
  const [results, setResults] = useState<Anime[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)
  const [sheetTitle, setSheetTitle] = useState("Episode number")
  const [queueEntry, setQueueEntry] = useState<EntryType>(loadSetting("queueEntry", PlaceholderEntry))
  const [downloading, setDownloading] = useState(false)
  const [downloadTotal, setDownloadTotal] = useState(0)
  const [downloadDone, setDownloadDone] = useState(0)
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


  const [entry, setEntry] = useState<EntryType>(
    loadSetting("entry", {
      name: "Name of Anime",
      ids: [],
      episode: "0",
      total: "99",
      id: "123456",
      img: ""
    } as EntryType)
  )

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

    setDownloading(false)
    const [cacheItem, queueItem] = tuple

    // 1) update CACHE (Anime[])
    const updatedCache = await addCache(cacheItem)            // returns Anime[]
    setAnimes([updatedCache[0]])  // Update to show first entry
    saveSetting(CACHE_KEY, [updatedCache[0]])                   // ✅ distinct key
    handleCacheSaved()

    // 2) update QUEUE (DownloadAnime[])
    const updatedQueue = await addQueue(queueItem)            // returns DownloadAnime[]
    setQueue(updatedQueue)
    saveSetting(QUEUE_KEY, updatedQueue)                   // ✅ distinct key
    onQueueSaved?.()

    hideOverlay()
    return
  }else{
      const anime = await getEpisode(index, async (options) => await askQualityOnce("Which quality?", options)   // 👈 add this
)
      const next = await addCache(anime)
      setAnimes([next[0]])                        // optimistic UI - show first entry
      saveSetting(CACHE_KEY, [next[0]])          // distinct key
      handleCacheSaved()
    }
  }

  // unified search effect
  useEffect(() => {
    const q = searchText.trim()
    if (!q) {
      setResults([])
      setHasSearched(false)
      return
    }

    let cancelled = false
    setIsLoading(true)

    const handle = setTimeout(async () => {
      try {
        const raw = provider === "Anilist"
          ? await searchAnilist(q.toLowerCase())
          : await searchAnimepahe(q.toLowerCase())

        if (cancelled) return
        setResults(typeof raw === "string" ? [] : (raw as Anime[]))
        setHasSearched(true)
      } catch {
        if (!cancelled) setResults([])
        setHasSearched(true)
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }, 666)

    return () => { cancelled = true; clearTimeout(handle) }
  }, [searchText, provider])

  async function animeInfo(anime: Anime, action: string) {
    showOverlay()
    const info = await chosenAnime(anime)
    console.log(info)

    const current = anime.episodes.includes("/")
      ? Number(anime.episodes.split("/")[0])
      : 0

    const auto = episodeNumber(current, Number(info.total), action)
    console.log(auto)

    // 1) Known exact index
    if (auto! >= 1) {
      info.episode = String(auto)
      setEntry(info)
      saveSetting("entry", info)
      await episodeThenUpdate(auto!)
      return
    }

    // 2) First-time add
    if (auto === 0) {
      info.episode = "0"
      setEntry(info)
      const cacheEntry: Anime = {
        name: info.name,
        source: info.id,
        episodes: `0/${info.total}`,
        img: anime.img,
        isUnread: true
      }
      const next = await addCache(cacheEntry)
      setAnimes([next[0]])                      // optimistic UI - show first entry
      saveSetting(CACHE_KEY, [next[0]])        // distinct key
      handleCacheSaved()
      hideOverlay()
      return
    }

    // 3) Ask once (-1)
    if (auto === -1) {
      const title = action === "Choose"
        ? `Episode number for ${info.name}`
        : `End episode for ${info.name}`

      let picked = await askNumberOnce(title, info.total, String(current + 1))
      if (action === "Choose") {
        info.episode = String(picked)
        setEntry(info)
        await episodeThenUpdate(picked)
      } else { // download

        if (picked > Number(info.total) || 0>= picked){
          hideOverlay()
          return
        }else{
        console.log('inside -1')
        info.episode= String(picked)
        setEntry(info)
        saveSetting("entry", info)

        
        info.episode = String(current+1)
        info.total = String(picked)
        if(current===0){ picked++}
        info.ids = info.ids.slice(Math.max(0, current - 1), Math.max(0, picked-1))
        console.log(info)
        setQueueEntry(info)
        saveSetting("queueEntry", info)
        await episodeThenUpdate(-44)
      }
      return
      }
    }

    // 4) Ask twice (-2)
    if (auto === -2) {
      const start = await askNumberOnce(`Start episode for ${info.name}`, info.total, String(current + 1))
      const end = await askNumberOnce(`End episode for ${info.name}`, info.total, String(start))
      if (start > Number(info.total) || end > Number(info.total) || start > end || 0 >= start ){
        hideOverlay()
        return
      }else{
      info.episode = String(end)
      setEntry(info)
      saveSetting("entry", info)
      
      info.ids = info.ids.slice(Math.max(0, start - 1), Math.max(0, end))
      info.episode = String(start)
      info.total = String(end)
      
      setQueueEntry(info)
      saveSetting("queueEntry", info)
      await episodeThenUpdate(-44)
      return
    }
    }

    // 5) Single current only (-3)
    if (auto === -3) {
      info.episode = String(current+1)
      setEntry(info)
      saveSetting("entry", info)
      
      info.ids = info.ids.slice(current, current + 1)
      info.episode=String(current+1)
      info.total=String(current+1)
      setQueueEntry(info)
      await episodeThenUpdate(-44)
      return
    }

    // 6) Confirm resume (-5)
    if (auto === -5) {
      await Dialog.alert({
        title: 'That was the last episode.',
        message: 'Use resume to play it again.',
        buttonLabel: 'Dismiss'
      })
      hideOverlay()
      return
    }
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

  const isSearching = searchText.trim().length > 0

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
        navigationTitle={"Home"}
        searchable={{
          value: searchText,
          onChanged: setSearchText,
          placement: "navigationBarDrawerAlwaysDisplay",
        }}
      >
        {isSearching ? (
          <Section
            header={
              <HStack>
                <Text>Search Results</Text>
                <Spacer />
                <Picker
                  title={"Provider:"}
                  pickerStyle={"automatic"}
                  value={provider}
                  onChanged={(v: any) => setProvider(v as ProviderType)}
                >
                  <Text tag={"Anilist"}>Anilist</Text>
                  <Text tag={"Animepahe"}>Animepahe</Text>
                </Picker>
              </HStack>
            }>
            {isLoading ? (
              <Text>Searching…</Text>
            ) : !hasSearched ? (
              <></>
            ) : results.length === 0 ? (
              <Text>No results</Text>
            ) : (
              results.map((anime, i) => (
                <AnimeCell
                  key={`res-${i}-${anime.name}`}
                  anime={anime}
                  animeInfo={animeInfo}
                />
              ))
            )}
          </Section>
        ) : (
          <Section header={<Text>Last Cache Entry</Text>}>
            {animes.length > 0 ? (
              <AnimeCell
                key={`cache-last-${animes[0].name}`}
                anime={animes[0]}
                animeInfo={animeInfo}
              />
            ) : <></>}
          </Section>
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
        onClose={() => setShowQualitySheet(false)}
      />
    )
  }}
/>
    </NavigationStack>
  )
}