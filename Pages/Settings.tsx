// Pages/Settings.tsx
import { 
  Button, EditButton, ForEach, List, Navigation, NavigationStack, Picker, 
  Section, Text, Toggle, useState, HStack, useEffect 
} from "scripting"

type VideoPlayerType = "nPlayer" | "Outplayer"
type ProviderType = "Anilist" | "Animepahe"

const QualitiesOrder = [
  "-1080p BD", "-1080p", "-816p chi", "-720p",
  "-default", "-auto", "-480p", "-360p"
]

// Storage keys
export const STORAGE_KEYS = {
  VIDEO_PLAYER: "settings.videoPlayer",
  AUTO_QUALITY: "settings.autoQuality",
  QUALITY_ORDER: "settings.qualityOrder",
  PROVIDER: "settings.provider",
  CACHE_PATH: "cache.path",
  QUEUE_PATH: "queue.path"
}

// Simple storage helpers
export function loadSetting<T>(key: string, defaultValue: T): T {
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

export function saveSetting(key: string, value: any) {
  Storage.set(key, typeof value === "object" ? JSON.stringify(value) : value)
}

// ---------- Quality Order Sheet ----------
function Qualities({ isPresented }: { isPresented: boolean }) {
  const [qualityOrder, setQualityOrder] = useState<string[]>(
    loadSetting(STORAGE_KEYS.QUALITY_ORDER, QualitiesOrder)
  )

  // 🔹 reload from Storage whenever the sheet is opened
  useEffect(() => {
    if (isPresented) {
      const fresh = loadSetting(STORAGE_KEYS.QUALITY_ORDER, QualitiesOrder)
      setQualityOrder(fresh)
    }
  }, [isPresented])

  function onDelete(indices: number[]) {
    const newOrder = qualityOrder.filter((_, index) => !indices.includes(index))
    setQualityOrder(newOrder)
    saveSetting(STORAGE_KEYS.QUALITY_ORDER, newOrder)
  }

  function onMove(indices: number[], newOffset: number) {
    const movingItems = indices.map(index => qualityOrder[index])
    const newQualityOrder = qualityOrder.filter((_, index) => !indices.includes(index))
    newQualityOrder.splice(newOffset, 0, ...movingItems)
    setQualityOrder(newQualityOrder)
    saveSetting(STORAGE_KEYS.QUALITY_ORDER, newQualityOrder)
  }

  async function addQuality() {
    const input = await Dialog.prompt({
      title: "Add Quality",
      message: "Enter a new quality",
    })
    const value = ("-" + (input ?? "").trim())
    if (value && value !== "-") {
      const newOrder = [value, ...qualityOrder]
      setQualityOrder(newOrder)
      saveSetting(STORAGE_KEYS.QUALITY_ORDER, newOrder)
    }
  }

  return (
    <NavigationStack>
      <List
        key={`list-${qualityOrder.length}-${Date.now()}`} // Forces re-render
        navigationTitle={"Edit Quality Order"}
        navigationBarTitleDisplayMode={"inline"}
        toolbar={{
          cancellationAction: [<EditButton />],
          confirmationAction: [
            <Button
              title=""
              systemImage="plus"
              action={addQuality}
            />,
          ],
        }}
      >
        <ForEach
          count={qualityOrder.length}
          itemBuilder={index =>
            <Text key={qualityOrder[index]}>{qualityOrder[index]}</Text>
          }
          onDelete={onDelete}
          onMove={onMove}
        />
      </List>
    </NavigationStack>
  )
}

function SheetOrder() {
  const [isPresented, setIsPresented] = useState(false)

  return (
    <Section>
      <Button
        title={"Edit Quality Order"}
        action={() => setIsPresented(true)}
        sheet={{
          isPresented: isPresented,
          onChanged: setIsPresented,
          content: <Qualities isPresented={isPresented} />
        }}
      />
    </Section>
  )
}

// ---------- Main Settings Page ----------
export function SettingsPage() {
  const dismiss = Navigation.useDismiss()
  const [videoPlayer, setVideoPlayer] = useState<VideoPlayerType>(
    loadSetting(STORAGE_KEYS.VIDEO_PLAYER, "nPlayer")
  )
  const [Provider, setProvider] = useState<ProviderType>(
    loadSetting(STORAGE_KEYS.PROVIDER, "Anilist")
  )
  const [autoQuality, setAutoQuality] = useState(
    loadSetting(STORAGE_KEYS.AUTO_QUALITY, true)
  )

  function handleVideoPlayerChange(player: any) {
    setVideoPlayer(player)
    saveSetting(STORAGE_KEYS.VIDEO_PLAYER, player)
  }

  function handleProviderChange(provider: any) {
    setProvider(provider)
    saveSetting(STORAGE_KEYS.PROVIDER, provider)
  }

  function handleAutoQualityChange(enabled: boolean) {
    setAutoQuality(enabled)
    saveSetting(STORAGE_KEYS.AUTO_QUALITY, enabled)
  }

  return (
    <NavigationStack>
      <List navigationTitle={"Settings"}>
        <Section header={<Text>Quality</Text>}>
          <Toggle
            title={"Automatic Quality Selector"}
            value={autoQuality}
            onChanged={handleAutoQualityChange}
          />
          <SheetOrder />
        </Section>

        <Section header={<Text>Video</Text>}>
          <HStack>
            <Text>Video Player               </Text>
            <Picker
              title={"Video Player:"}
              pickerStyle={"palette"}
              value={videoPlayer}
              onChanged={handleVideoPlayerChange}
            >
              <Text tag={"nPlayer"}>nPlayer</Text>
              <Text tag={"Outplayer"}>Outplayer</Text>
            </Picker>
          </HStack>
        </Section>

        <Section header={<Text>Provider</Text>}>
          <HStack>
            <Text>Provider                      </Text>
            <Picker
              title={"Primary Provider:"}
              pickerStyle={"palette"}
              value={Provider}
              onChanged={handleProviderChange}
            >
              <Text tag={"Anilist"}>Anilist</Text>
              <Text tag={"Animepahe"}>Animepahe</Text>
            </Picker>
          </HStack>
        </Section>
      </List>
    </NavigationStack>
  )
}