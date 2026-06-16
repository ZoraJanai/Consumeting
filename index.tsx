import {
  HStack, Button, Label, Navigation, Script, Spacer, TabView, Text,
  VStack, ZStack, TextField, useState, RoundedRectangle
} from "scripting"

import { SettingsPage } from "./Pages/Settings"
import { CachePage } from "./Pages/Cache"
import { QueuePage } from "./Pages/Queue"
import { HomePage } from "./Pages/Home"
import { OverlayHost } from "./Pages/Loading"
import { STORAGE_KEYS, loadSetting, saveSetting } from "./Pages/Settings"
import { copyFileFromDocumentsIfExists, loadData, saveData } from "./scripts/data"
import { bootstrapAnimepaheSession } from "./scripts/animepaheSession"


type TabChildProps = {
  onCacheSaved?: () => void
  onQueueSaved?: () => void
  onBadgeChange?: (n: number) => void
  tag?: number | string
  tabItem?: any
  badge?: any
}

function Example() {
  const [tabIndex, setTabIndex] = useState(0)

  // 🔔 every time cache is saved anywhere, bump this
  const [cacheVersion, setCacheVersion] = useState(0)
  const onCacheSaved = () => setCacheVersion(v => v + 1)
  const [cacheBadge, setCacheBadge] = useState<number>(0)
  const [queueVersion, setQueueVersion] = useState(0)
  const onQueueSaved = () => setQueueVersion(v => v + 1)
  const [queueBadge, setQueueBadge] = useState<number>(0)
  
  return (
    <TabView
      tabIndex={tabIndex}
      onTabIndexChanged={setTabIndex}
    >

      <HomeView
        key={`home-${cacheVersion}`}   // ⬅️ add this
        tag={0}
        tabItem={<Label title={"Home"} systemImage={"cube.transparent.fill"} />}
        onCacheSaved={onCacheSaved}
        onQueueSaved={onQueueSaved}
      />
      <CacheView
        badge={cacheBadge}
        key={`cache-${cacheVersion}`} // ⬅️ force CachePage to remount & reload after saves
        tag={1}
        tabItem={<Label title={"Cache"} systemImage={"clock.fill"} />}
        onCacheSaved={onCacheSaved}
        onQueueSaved={onQueueSaved}
        onBadgeChange={setCacheBadge}
      />
      

      <QueueView
        key={`queue-${queueVersion}`}
        tag={2}
        badge={queueBadge}
        tabItem={<Label title={"Queue"} systemImage={"square.grid.2x2.fill"} />}
        onBadgeChange={setQueueBadge}
      />
      <SettingsView
        key={`settings-${cacheVersion}`}
        tag={3}
        tabItem={<Label title={"Settings"} systemImage={"gearshape.fill"} />}
      />
    </TabView>
  )
}

function HomeView(props: TabChildProps) {
  return <HomePage onCacheSaved={props.onCacheSaved} 
                   onQueueSaved={props.onQueueSaved}
           />
}

function CacheView(props: TabChildProps) {
  return <CachePage onCacheSaved={props.onCacheSaved}
                    onQueueSaved={props.onQueueSaved}
                    onBadgeChange={props.onBadgeChange}
           />
}

// leave these as-is
function QueueView(props: { onBadgeChange?: (n: number) => void }) {
  return <QueuePage onBadgeChange={props.onBadgeChange} />
}
function SettingsView() { return <SettingsPage /> }


const MARK = "__init_v2"                // string key - bumped for unified system
const DEFAULTS = {
  [STORAGE_KEYS.VIDEO_PLAYER]: "nPlayer",
  [STORAGE_KEYS.AUTO_QUALITY]: true,
  [STORAGE_KEYS.QUALITY_ORDER]: [
    "-1080p BD","-1080p","-816p chi","-720p",
    "-default","-auto","-480p","-360p"
  ],
  [STORAGE_KEYS.PROVIDER]: "Anilist",
}

async function ensureUnifiedFile() {
  const unifiedPath = "lists.json"
  try { 
    await copyFileFromDocumentsIfExists(unifiedPath) 
  } catch {}
  try { 
    const data = await loadData<{ cache?: any[], queue?: any[] }>(unifiedPath)
    if (data && (Array.isArray(data.cache) || Array.isArray(data.queue))) {
      return // File exists and has valid structure
    }
  } catch {}
  // Create new unified file with empty arrays
  await saveData(unifiedPath, { cache: [], queue: [] })
}

export async function bootstrap() {
  // 👉 use a STRING marker; treat presence as initialized
  const inited = loadSetting<string>(MARK, "")
  if (!inited) {
    Object.entries(DEFAULTS).forEach(([k, v]) => saveSetting(k, v))
    saveSetting(MARK, "1") // store string, not boolean
    // Set unified file path
    saveSetting("unified.path", "lists.json")
    await ensureUnifiedFile()
  } else {
    // Even if already initialized, ensure unified file exists
    await ensureUnifiedFile()
  }
}

export async function run() {
  await bootstrap()
  // Kick off session verification AFTER the main UI mounts. The verification
  // WebView is presented as a sheet, which needs a live root view controller to
  // attach to — presenting it before Navigation.present() silently fails (no sheet).
  setTimeout(function () {
    bootstrapAnimepaheSession()
  }, 800)
  await Navigation.present({
    element: (
      <ZStack>
        <Example />
        <OverlayHost />
      </ZStack>
    )
  })
  Script.exit()
}
run()