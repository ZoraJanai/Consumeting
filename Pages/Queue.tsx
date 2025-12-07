import {
  useEffect, useState,
  List, ContentUnavailableView, Button, Text, NavigationStack,
  HStack, VStack, Spacer, Image, ZStack, RoundedRectangle,
Label
} from "scripting"
import { loadData, saveData } from "../scripts/data"

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
  
  const count = item.links.length - 1

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
  const queuePath = loadSetting("queue.path", "queue.json")

  // seed instantly from last save and normalize
  const [items, setItems] = useState<DownloadAnime[]>(
    (loadSetting<Partial<DownloadAnime>[]>("queue.last", [])).map(normalizeQueueItem)
  )
  const [loading, setLoading] = useState(false)

  async function loadQueue() {
    try {
      setLoading(true)
      const data = await loadData<Partial<DownloadAnime>[]>(queuePath)
      const next = Array.isArray(data) ? data.map(normalizeQueueItem) : []
      setItems(next)
      saveSetting("queue.last", next)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadQueue()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queuePath])

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
    saveSetting("queue.last", next)
    await saveData(queuePath, next)
  }

  async function deleteItem(item: DownloadAnime) {
    const next = items.filter(q => q !== item)
    setItems(next)                        // optimistic UI
    saveSetting("queue.last", next)
    await saveData(queuePath, next)
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