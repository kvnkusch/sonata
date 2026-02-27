import os from "os"
import path from "path"
import { xdgCache, xdgConfig, xdgData, xdgState } from "xdg-basedir"

const app = "sonata"

export type SonataPaths = {
  home: string
  data: string
  cache: string
  config: string
  state: string
}

export function paths(): SonataPaths {
  const home = os.homedir()
  // xdg-basedir returns string | undefined; on macOS it should be set,
  // but provide a safe fallback.
  const dataRoot = xdgData ?? path.join(home, ".local", "share")
  const cacheRoot = xdgCache ?? path.join(home, ".cache")
  const configRoot = xdgConfig ?? path.join(home, ".config")
  const stateRoot = xdgState ?? path.join(home, ".local", "state")
  return {
    home,
    data: path.join(dataRoot, app),
    cache: path.join(cacheRoot, app),
    config: path.join(configRoot, app),
    state: path.join(stateRoot, app),
  }
}
