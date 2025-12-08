import {
  useEffect, useState,
  List, ContentUnavailableView, Button, Text, NavigationStack,
  HStack, VStack, Spacer, Image, ZStack, RoundedRectangle,
Label
} from "scripting"
import { getQueue, saveQueue } from "../scripts/cache"

type DownloadAnime = {
  name: string
  source: string
  episodes: string
  img: string
  isUnread: boolean
  links: string[]
}


function loadSetting<T>(key: string, defaultValue: T): T {
  if (Storage.contains(key)) {
    try {
      const stored = Storage.get<any>(key)
      return typeof defaultValue === "object" ? JSON.parse(stored) : stored
    } catch { /* ignore */ }
  }
  return defaultValue
}
function saveSetting(key: string, value: any) {
  Storage.set(key, typeof value === "object" ? JSON.stringify(value) : value)
}

// normalize to avoid undefined fields from older saves
function normalizeQueueItem(x: Partial<DownloadAnime>): DownloadAnime {
  return {
    name: x.name ?? "(unknown)",
    source: x.source ?? "",
    episodes: x.episodes ?? "",
    img: x.img ?? "",
    isUnread: x.isUnread ?? true,
    links: x.links ?? [],
  }
}

function QueueCell({ item }: { item: DownloadAnime }) {
  // Calculate count from episode string (handles ranges like "1, 3 to 4, 5 to 9, 12")
  const calculateCount = (episodes: string): number => {
    if (!episodes || episodes.trim() === "") return 0
    
    let total = 0
    // Split by comma to handle multiple ranges
    const parts = episodes.split(",").map(s => s.trim())
    
    for (const part of parts) {
      if (part.includes(" to ")) {
        // Range like "3 to 4"
        const rangeParts = part.split(" to ").map(s => s.trim()).filter(s => s)
        if (rangeParts.length === 2) {
          const start = Number(rangeParts[0])
          const end = Number(rangeParts[1])
          if (!isNaN(start) && !isNaN(end) && end >= start) {
            total += (end - start + 1)
          }
        }
      } else {
        // Single episode
        const num = Number(part.trim())
        if (!isNaN(num) && num > 0) {
          total += 1
        }
      }
    }
    
    return total
  }
  
  const count = calculateCount(item.episodes)

  return (
    <HStack frame={{ height: 256 }}>
      <Image
        imageUrl={item.img}
        aspectRatio={{ contentMode: "fit", value: 2 / 3 }}
        frame={{ height: 225 }}
        resizable
        padding={12}
      />
      <VStack alignment="leading">
        <Text multilineTextAlignment="leading" foregroundStyle="white" font="headline">
          {item.name}
        </Text>
        <Text multilineTextAlignment="leading" foregroundStyle="lightGray" fontWeight="light">
          {item.source}
        </Text>

        <HStack>
          <Text multilineTextAlignment="leading" foregroundStyle="white">
            {item.episodes}
          </Text>

          <ZStack>
            <RoundedRectangle
              fill={"systemBlue"}
              cornerRadius={12}
              frame={{
                width: 24 + Math.max(0, String(count).length - 2) * 8,
                height: 24,
              }}
            />
            <Text font={14} foregroundStyle="white">
              {count}
            </Text>
          </ZStack>
        </HStack>
      </VStack>
      <Spacer />
    </HStack>
  )
}

export function QueuePage({ onBadgeChange }: { onBadgeChange?: (n: number) => void }) {
  // Distinct storage key for this page to avoid overrides
  const QUEUE_KEY = "queue.last.queuepage"

  // seed instantly from last save and normalize
  const [items, setItems] = useState<DownloadAnime[]>(
    (loadSetting<Partial<DownloadAnime>[]>(QUEUE_KEY, [])).map(normalizeQueueItem)
  )
  const [loading, setLoading] = useState(false)

  // Use ref to prevent loop - track if we're currently loading
  const isLoadingRef = { current: false }

  async function loadQueue() {
    if (isLoadingRef.current) return // Prevent concurrent loads
    try {
      isLoadingRef.current = true
      setLoading(true)
      const data = await getQueue()
      const next = Array.isArray(data) ? data.map(normalizeQueueItem) : []
      setItems(next)
      saveSetting(QUEUE_KEY, next)  // distinct key
    } finally {
      isLoadingRef.current = false
      setLoading(false)
    }
  }

  // Load only once on mount - no dependencies to prevent loops
  useEffect(() => {
    loadQueue()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 🔔 update badge count whenever items change
  useEffect(() => {
    const totalLinks = items.reduce((sum, q) => sum + (q.links?.length - 1 ?? 0), 0)
    onBadgeChange?.(totalLinks)
  }, [items, onBadgeChange])

  async function download() {
    const all = items.flatMap(item => item.links).join("\n")
    console.log(all)
    await Safari.openURL(`ashell://cd%0A${encodeURIComponent(all)}`)
    console.log("ashell open")
    clearQueue()
  }

  async function clearQueue() {
    const next: DownloadAnime[] = []
    setItems(next)
    saveSetting(QUEUE_KEY, next)        // distinct key
    await saveQueue(next)                // save to unified file
  }

  async function deleteItem(item: DownloadAnime) {
    const next = items.filter(q => q !== item)
    setItems(next)                        // optimistic UI
    saveSetting(QUEUE_KEY, next)        // distinct key (was incorrectly using cache.last)
    await saveQueue(next)                 // save to unified file
  }

  return (
    <NavigationStack>
      <List
        navigationTitle={"Queue"}
        navigationBarTitleDisplayMode={"inline"}
        overlay={
          items.length ? undefined : (
            <ContentUnavailableView
              title={loading ? "Loading…" : "Queue is empty"}
              systemImage="tray.fill"
            />
          )
        }
        toolbar={{
          confirmationAction: [<Button title="Download" action={() => download()} />],
          cancellationAction: [<Button title="Clear" role="destructive" action={() => clearQueue()} />]
        }}
      >
        {items.map((q, i) => (
          <QueueCell key={`${q.name}-${q.source}-${i}`} item={q} 
            
              trailingSwipeActions={{
                actions: [
                  <Button role="destructive" action={async () => await deleteItem(q)}>
                    <Label title="Delete" systemImage="trash" />
                  </Button>
                ]
              }}
            />
        ))}
      </List>
    </NavigationStack>
  )
}