// Pages/Settings.tsx
import { 
  Button, EditButton, ForEach, List, Navigation, NavigationStack, Picker, 
  Section, Text, Toggle, useState, HStack, useEffect 
} from "scripting"
import {
  clearStoredSession,
  isSessionReady,
  presentKwikEmbedPlayer,
  refreshAnimepaheSession,
} from "../scripts/animepaheSession"

type VideoPlayerType = "nPlayer" | "Outplayer" | "Safari"
type ProviderType = "Anilist" | "Animepahe"

import { STORAGE_KEYS, loadSetting, saveSetting } from "../scripts/storage"

export { STORAGE_KEYS, loadSetting, saveSetting }

const QualitiesOrder = [
  "-1080p BD", "-1080p", "-816p chi", "-720p",
  "-default", "-auto", "-480p", "-360p"
]

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
    loadSetting<VideoPlayerType>(STORAGE_KEYS.VIDEO_PLAYER, "nPlayer")
  )
  const [Provider, setProvider] = useState<ProviderType>(
    loadSetting(STORAGE_KEYS.PROVIDER, "Anilist")
  )
  const [autoQuality, setAutoQuality] = useState(
    loadSetting(STORAGE_KEYS.AUTO_QUALITY, true)
  )
  const [animepaheBaseUrl, setAnimepaheBaseUrl] = useState(
    loadSetting(STORAGE_KEYS.ANIMEPAHE_BASE_URL, "https://animepahe.pw")
  )
  const [sessionActive, setSessionActive] = useState(isSessionReady())
  const [hlsWorkers, setHlsWorkers] = useState(
    Number(loadSetting(STORAGE_KEYS.HLS_WORKERS, 3)) || 3
  )
  const [hlsSegmentsPerMinute, setHlsSegmentsPerMinute] = useState(
    Number(loadSetting(STORAGE_KEYS.HLS_SEGMENTS_PER_MINUTE, 540)) || 540
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

  async function editAnimepaheBaseUrl() {
    const input = await Dialog.prompt({
      title: "Animepahe Base URL",
      message: "Default is https://animepahe.pw",
      value: animepaheBaseUrl
    })
    if (input != null && input.trim()) {
      const newUrl = input.trim().replace(/\/$/, "")
      setAnimepaheBaseUrl(newUrl)
      saveSetting(STORAGE_KEYS.ANIMEPAHE_BASE_URL, newUrl)
    }
  }

  async function verifyAnimepahe() {
    const ok = await refreshAnimepaheSession()
    setSessionActive(ok || isSessionReady())
  }

  function clearAnimepaheSession() {
    clearStoredSession()
    setSessionActive(false)
  }

  async function testGesturePlayer() {
    const PLAY_PAGE  = "https://animepahe.pw/play/543a863c-810e-731e-34f0-b2fb125c4da4/f64b17e345d1e97a7"
    const KWIK_EMBED = "https://kwik.cx/e/YTOeTqn5zcgv"
    // animeName triggers auto MAL ID lookup via AniList + AniSkip — swap for any title
    await presentKwikEmbedPlayer(PLAY_PAGE, KWIK_EMBED, "Gesture Player Test", undefined, 1, "Demon Slayer")
  }

  async function editHlsWorkers() {
    const input = await Dialog.prompt({
      title: "HLS workers",
      message: "Parallel segment downloads (default 3)",
      value: String(hlsWorkers),
    })
    if (input == null) return
    const n = Math.max(1, Math.min(16, parseInt(String(input).trim(), 10) || 3))
    setHlsWorkers(n)
    saveSetting(STORAGE_KEYS.HLS_WORKERS, n)
  }

  async function editHlsSegmentsPerMinute() {
    const input = await Dialog.prompt({
      title: "Segments per minute",
      message: "Rate limit for HLS segment fetches (default 540)",
      value: String(hlsSegmentsPerMinute),
    })
    if (input == null) return
    const n = Math.max(1, Math.min(5000, parseInt(String(input).trim(), 10) || 540))
    setHlsSegmentsPerMinute(n)
    saveSetting(STORAGE_KEYS.HLS_SEGMENTS_PER_MINUTE, n)
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
              <Text tag={"Safari"}>Safari</Text>
            </Picker>
          </HStack>
        </Section>

        <Section header={<Text>Download (a-Shell)</Text>}>
          <Button
            title={`Workers: ${hlsWorkers}`}
            action={editHlsWorkers}
          />
          <Button
            title={`Segments / min: ${hlsSegmentsPerMinute}`}
            action={editHlsSegmentsPerMinute}
          />
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
              {/* <Text tag={"Anilist"}>Anilist</Text> */}
              <Text tag={"Animepahe"}>Animepahe</Text>
            </Picker>
          </HStack>
        </Section>

        <Section header={<Text>Animepahe</Text>}>
          <Button
            title={`Base URL: ${animepaheBaseUrl}`}
            action={editAnimepaheBaseUrl}
          />
          <Button
            title={sessionActive ? "Animepahe session: active" : "Re-verify Animepahe (Cloudflare)"}
            action={verifyAnimepahe}
          />
          <Button
            title="Clear Animepahe session"
            role="destructive"
            action={clearAnimepaheSession}
          />
        </Section>

        <Section header={<Text>Player Test</Text>}>
          <Button
            title={"🎮  Test Gesture Player"}
            action={testGesturePlayer}
          />
        </Section>
      </List>
    </NavigationStack>
  )
}