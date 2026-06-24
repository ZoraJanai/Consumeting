// Pages/Settings.tsx
import { 
  Button, EditButton, ForEach, List, Navigation, NavigationStack, Picker, 
  Section, Text, Toggle, useState, HStack, useEffect 
} from "scripting"

type VideoPlayerType = "nPlayer" | "Outplayer"
type ProviderType = "Anilist" | "Animepahe" | "Anidap"

const QualitiesOrder = [
  "-1080p BD", "-1080p", "-816p chi", "-720p",
  "-default", "-auto", "-480p", "-360p"
]

export const AnidapProviderOrder = ["uwu", "mimi", "mochi", "beep"]
export const AnidapQualityOrder = ["-1080p", "-720p", "-480p", "-360p", "-auto"]

// Storage keys
export const STORAGE_KEYS = {
  VIDEO_PLAYER: "settings.videoPlayer",
  AUTO_QUALITY: "settings.autoQuality",
  QUALITY_ORDER: "settings.qualityOrder",
  PROVIDER: "settings.provider",
  CACHE_PATH: "cache.path",
  QUEUE_PATH: "queue.path",
  ANIDAP_PROVIDER_ORDER: "settings.anidapProviderOrder",
  ANIDAP_QUALITY_ORDER: "settings.anidapQualityOrder",
  AUTO_PROVIDER: "settings.autoProvider",
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

// ---------- Anidap Provider Order Sheet ----------
function AnidapProviders({ isPresented }: { isPresented: boolean }) {
  const [order, setOrder] = useState<string[]>(
    loadSetting(STORAGE_KEYS.ANIDAP_PROVIDER_ORDER, AnidapProviderOrder)
  )

  useEffect(() => {
    if (isPresented) setOrder(loadSetting(STORAGE_KEYS.ANIDAP_PROVIDER_ORDER, AnidapProviderOrder))
  }, [isPresented])

  function onDelete(indices: number[]) {
    const next = order.filter((_, i) => !indices.includes(i))
    setOrder(next)
    saveSetting(STORAGE_KEYS.ANIDAP_PROVIDER_ORDER, next)
  }

  function onMove(indices: number[], newOffset: number) {
    const moving = indices.map(i => order[i])
    const remaining = order.filter((_, i) => !indices.includes(i))
    remaining.splice(newOffset, 0, ...moving)
    setOrder(remaining)
    saveSetting(STORAGE_KEYS.ANIDAP_PROVIDER_ORDER, remaining)
  }

  async function addProvider() {
    const input = await Dialog.prompt({ title: "Add Provider", message: "Enter provider id (e.g. uwu)" })
    const value = (input ?? "").trim().toLowerCase()
    if (value) {
      const next = [value, ...order]
      setOrder(next)
      saveSetting(STORAGE_KEYS.ANIDAP_PROVIDER_ORDER, next)
    }
  }

  return (
    <NavigationStack>
      <List
        key={`list-${order.length}-${Date.now()}`}
        navigationTitle={"Anidap Provider Order"}
        navigationBarTitleDisplayMode={"inline"}
        toolbar={{
          cancellationAction: [<EditButton />],
          confirmationAction: [
            <Button title="" systemImage="plus" action={addProvider} />,
          ],
        }}
      >
        <ForEach
          count={order.length}
          itemBuilder={index => <Text key={order[index]}>{order[index]}</Text>}
          onDelete={onDelete}
          onMove={onMove}
        />
      </List>
    </NavigationStack>
  )
}

function SheetAnidapProviders() {
  const [isPresented, setIsPresented] = useState(false)
  return (
    <Button
      title={"Edit Provider Order"}
      action={() => setIsPresented(true)}
      sheet={{
        isPresented,
        onChanged: setIsPresented,
        content: <AnidapProviders isPresented={isPresented} />,
      }}
    />
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
  const [autoProvider, setAutoProvider] = useState(
    loadSetting(STORAGE_KEYS.AUTO_PROVIDER, true)
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

  function handleAutoProviderChange(enabled: boolean) {
    setAutoProvider(enabled)
    saveSetting(STORAGE_KEYS.AUTO_PROVIDER, enabled)
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
              <Text tag={"Anidap"}>Anidap</Text>
            </Picker>
          </HStack>
        </Section>

        {Provider === "Anidap" && (
          <Section header={<Text>Anidap</Text>}>
            <Toggle
              title={"Automatic Provider Selector"}
              value={autoProvider}
              onChanged={handleAutoProviderChange}
            />
            <SheetAnidapProviders />
          </Section>
        )}
      </List>
    </NavigationStack>
  )
}