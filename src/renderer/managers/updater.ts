import { init } from "../apis/settings";
import * as pluginManager from "./plugins";
import * as themeManager from "./themes";
import { Logger } from "../modules/logger";

const logger = Logger.coremod("Updater");

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type UpdateSettings = {
  available?: boolean;
  version?: string;
  url?: string;
  lastChecked?: number;
};

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
type MainUpdaterSettings = {
  // Todo: implement
  checkInterval?: number;
  lastChecked?: number;
};

const mainUpdaterDefaultSettings: Partial<MainUpdaterSettings> = {
  checkInterval: 1000 * 60 * 60,
};

const updaterSettings = await init<MainUpdaterSettings, keyof typeof mainUpdaterDefaultSettings>(
  "dev.replugged.Updater",
  mainUpdaterDefaultSettings,
);

const updaterState = await init<Record<string, UpdateSettings>>("dev.replugged.Updater.State");

const completedUpdates = new Set<string>();

export function getUpdateSettings(id: string): UpdateSettings {
  const setting = updaterState.get(id);
  if (!setting) return {};
  if (typeof setting !== "object") return {};
  if ("available" in setting && typeof (setting as { available: unknown }).available !== "boolean")
    return {};
  if ("id" in setting && typeof (setting as { id: unknown }).id !== "string") return {};
  if ("url" in setting && typeof (setting as { url: unknown }).url !== "string") return {};
  if (
    "lastChecked" in setting &&
    typeof (setting as { lastChecked: unknown }).lastChecked !== "number"
  )
    return {};
  return setting;
}

export function getMainUpdaterSettings(): MainUpdaterSettings {
  return updaterSettings.all();
}

/**
 * @param id Entity ID to check updates for
 */
export async function checkUpdate(id: string, verbose = true): Promise<void> {
  const entity = pluginManager.plugins.get(id) || (await themeManager.get(id));
  if (!entity) {
    logger.error(`Entity ${id} not found`);
    return;
  }
  if (!entity.path.endsWith(".asar")) {
    if (verbose) logger.log(`Entity ${id} is not an ASAR file, cannot be updated`);
    return;
  }

  const {
    manifest: { updater, version },
  } = entity;
  if (!updater) {
    logger.warn(`Entity ${id} has no updater info`);
    return;
  }

  const updateSettings = getUpdateSettings(id);

  if (
    updateSettings.version &&
    updateSettings.version !== version &&
    !updateSettings.available &&
    !completedUpdates.has(id)
  ) {
    if (verbose) logger.log(`Entity ${id} version differs from previous, forcing new update`);
    updaterState.set(id, {
      ...updateSettings,
      available: true,
    });
    return;
  }

  const res = await window.RepluggedNative.updater.check(updater.type, updater.id, id);

  if (!res.success) {
    logger.error(`Update check for entity ${id} failed: ${res.error}`);
    return;
  }

  const newVersion = res.manifest.version;

  if (newVersion === version) {
    if (verbose) logger.log(`Entity ${id} is up to date`);
    updaterState.set(id, {
      available: false,
      lastChecked: Date.now(),
      url: res.url,
      version: newVersion,
    });
    return;
  }

  logger.log(`Entity ${id} has an update available`);
  updaterState.set(id, {
    available: true,
    url: res.url,
    lastChecked: Date.now(),
    version: newVersion,
  });
}

export async function installUpdate(id: string, force = false, verbose = true): Promise<boolean> {
  const entity = pluginManager.plugins.get(id) || (await themeManager.get(id));
  if (!entity) {
    logger.error(`Entity ${id} not found`);
    return false;
  }
  if (!entity.path.endsWith(".asar")) {
    if (verbose) logger.log(`Entity ${id} is not an ASAR file, cannot be updated`);
    return false;
  }

  const updateSettings = getUpdateSettings(id);

  if (!force && !updateSettings.available) {
    if (verbose) logger.log(`Entity ${id} has no update available`);
    return false;
  }

  if (!updateSettings.url) {
    logger.error(`Entity ${id} has no update URL`);
    return false;
  }

  // install new
  const res = await window.RepluggedNative.updater.install(
    entity.manifest.type,
    entity.path,
    updateSettings.url,
  );

  if (!res.success) {
    logger.error(`Update install failed: ${res.error}`);
    return false;
  }

  // update settings
  updaterState.set(id, {
    ...updateSettings,
    available: false,
  });

  completedUpdates.add(id);

  // Temporarily disabled until we can figure out how to properly reload compiled plugins
  // try {
  //   switch (entity.manifest.type) {
  //     case "replugged-plugin":
  //       await pluginManager.reload(`${id}.asar`);
  //       break;
  //     case "replugged-theme":
  //       themeManager.reload(`${id}.asar`);
  //       break;
  //   }
  // } catch (err) {
  //   logger.error(`Update install failed: ${err}`);
  //   return;
  // }

  logger.log(`Entity ${id} updated successfully`);

  return true;
}

export async function checkAllUpdates(verbose = false): Promise<void> {
  const plugins = Array.from(pluginManager.plugins.values());
  const themes = await themeManager.list();

  logger.log("Checking for updates");

  await Promise.all([
    ...plugins.map((plugin) => checkUpdate(plugin.manifest.id, verbose)),
    ...themes.map((theme) => checkUpdate(theme.manifest.id, verbose)),
  ]);

  logger.log("All updates checked");
  updaterSettings.set("lastChecked", Date.now());
}

export function getAvailableUpdates(): Array<UpdateSettings & { id: string }> {
  return Object.entries(updaterState.all())
    .map(([id, state]) => ({ ...state, id }))
    .filter((state) => state.available || completedUpdates.has(state.id));
}

export function installAllUpdates(
  force = false,
  verbose = false,
): Record<string, Promise<boolean>> {
  const available = getAvailableUpdates();

  return Object.fromEntries(
    available.map((update) => [update.id, installUpdate(update.id, force, verbose)]),
  );
}
