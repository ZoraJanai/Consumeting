// Pages/Settings.tsx
import { 
  Button, EditButton, ForEach, List, Navigation, NavigationStack, Picker, 
  Section, Text, Toggle, useState, HStack, useEffect 
} from "scripting"
import {
  clearStoredSession,
  getStoredCookieHeader,
  hasStoredSession,
  importCookieHeader,
  refreshAnimepaheSession,
} from "../scripts/animepaheSession"

type VideoPlayerType = "nPlayer" | "Outplayer"
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
    loadSetting(STORAGE_KEYS.VIDEO_PLAYER, "nPlayer")
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
  const [animepaheApiUrl, setAnimepaheApiUrl] = useState(
    loadSetting(STORAGE_KEYS.ANIMEPAHE_API_URL, "")
  )
  const [sessionActive, setSessionActive] = useState(hasStoredSession())
  const [rustProxyUrl, setRustProxyUrl] = useState(
    loadSetting(STORAGE_KEYS.RUST_PROXY_URL, "https://rust-proxy-hvm4.onrender.com")
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

  async function editAnimepaheApiUrl() {
    const input = await Dialog.prompt({
      title: "Animepahe API URL (optional)",
      message: "Leave empty for direct scraping. Set only if you use a hosted animepahe-api instance.",
      value: animepaheApiUrl
    })
    if (input != null) {
      const newUrl = input.trim().replace(/\/$/, "")
      setAnimepaheApiUrl(newUrl)
      saveSetting(STORAGE_KEYS.ANIMEPAHE_API_URL, newUrl)
    }
  }

  async function verifyAnimepahe() {
    const ok = await refreshAnimepaheSession()
    setSessionActive(ok || hasStoredSession())
  }

  async function pasteAnimepaheCookies() {
    const input = await Dialog.prompt({
      title: "Animepahe cookies",
      message:
        "Paste the full Cookie header from browser DevTools (Application > Cookies, or Network request headers).",
      value: getStoredCookieHeader(),
    })
    if (input == null || !input.trim()) return

    const ok = await importCookieHeader(input)
    setSessionActive(ok || hasStoredSession())
  }

  function clearAnimepaheSession() {
    clearStoredSession()
    setSessionActive(false)
  }

  async function editRustProxyUrl() {
    const input = await Dialog.prompt({
      title: "Rust Proxy URL",
      message: "Enter the Rust proxy base URL",
      value: rustProxyUrl
    })
    if (input && input.trim()) {
      const newUrl = input.trim()
      setRustProxyUrl(newUrl)
      saveSetting(STORAGE_KEYS.RUST_PROXY_URL, newUrl)
    }
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
              {/* <Text tag={"Anilist"}>Anilist</Text> */}
              <Text tag={"Animepahe"}>Animepahe</Text>
            </Picker>
          </HStack>
        </Section>

        <Section header={<Text>URLs</Text>}>
          <Button
            title={`Animepahe: ${animepaheBaseUrl}`}
            action={editAnimepaheBaseUrl}
          />
          <Button
            title={sessionActive ? "Animepahe session: active" : "Animepahe session: not verified"}
            action={verifyAnimepahe}
          />
          <Button
            title="Paste Animepahe cookies"
            action={pasteAnimepaheCookies}
          />
          <Button
            title="Clear Animepahe session"
            role="destructive"
            action={clearAnimepaheSession}
          />
          <Button
            title={animepaheApiUrl ? `API: ${animepaheApiUrl}` : "API: off (direct scrape)"}
            action={editAnimepaheApiUrl}
          />
          <Button
            title={`Proxy: ${rustProxyUrl}`}
            action={editRustProxyUrl}
          />
        </Section>
      </List>
    </NavigationStack>
  )
}