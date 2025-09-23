import { Script } from "scripting"
import { Anime } from "./cache"

const dataDir = `/scripts/${Script.name}/`

type DownloadAnime = Anime & {links:string[]}

function getDataDirectory() {
  if (FileManager.isiCloudEnabled) {
    return FileManager.iCloudDocumentsDirectory
  }
  return FileManager.appGroupDocumentsDirectory
}

export async function loadData<T>(
  relativeFilePath: string,
): Promise<T> {
  const documentDirectory = getDataDirectory()
  const filePath = documentDirectory + dataDir + relativeFilePath

  const content = await FileManager.readAsString(filePath)
  return JSON.parse(content) as T
}

export async function copyFileFromDocumentsIfExists(
  relativeFilePath: string,
) {
  const sourcePath = FileManager.documentsDirectory
    + dataDir
    + relativeFilePath

  if (!await FileManager.exists(
    sourcePath
  )) {
    return
  }

  const documentDirectory = getDataDirectory()
  const targetPath =
    documentDirectory
    + dataDir
    + relativeFilePath

  if (await FileManager.exists(
    targetPath
  )) {
    return
  }

  try {
    await FileManager.copyFile(
      sourcePath,
      targetPath
    )
  } catch (e) {
    console.error("Failed to copy file.", e, sourcePath, targetPath)
  }
}

export async function saveData<T>(
  relativeFilePath: string,
  data: T,
) {
  const documentDirectory = getDataDirectory()
  const fileDir = documentDirectory
    + dataDir
  const filePath = fileDir
    + relativeFilePath

  await
    FileManager
      .createDirectory(fileDir, true)
  await FileManager.writeAsString(
    filePath,
    JSON.stringify(
      data,
      // null, 2,
    ),
  )
}
