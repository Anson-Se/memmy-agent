import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import type { ExternalBrowserName } from './external-browser-extension-install.js';

/** Public key in extensions/memmy-browser/manifest.json. */
export const MEMMY_BROWSER_EXTENSION_ID = 'mhodbgbbgalbhehapffidmdegokpoaom';

const MAX_PREFS_BYTES = 8_000_000;

function dictionary(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

type BrowserFiles = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  readFile?: (path: string) => string;
  fileExists?: (path: string) => boolean;
};

function pathJoin(platform: NodeJS.Platform, ...parts: string[]): string {
  return (platform === 'win32' ? win32.join : join)(...parts);
}

function userDataDir(browser: ExternalBrowserName, platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv, home: string): string | null {
  if (platform === 'darwin') {
    const folder = browser === 'chrome' ? pathJoin(platform, 'Google', 'Chrome') : 'Microsoft Edge';
    return pathJoin(platform, home, 'Library', 'Application Support', folder);
  }
  if (platform === 'win32') {
    if (!env.LOCALAPPDATA) return null;
    return browser === 'chrome'
      ? pathJoin(platform, env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data')
      : pathJoin(platform, env.LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data');
  }
  const config = env.XDG_CONFIG_HOME || pathJoin(platform, home, '.config');
  return pathJoin(platform, config, browser === 'chrome' ? 'google-chrome' : 'microsoft-edge');
}

function isProfileName(name: string): boolean {
  return name === 'Default' || /^Profile \d+$/.test(name);
}

function profileNames(root: string, readFile: (path: string) => string,
  fileExists: (path: string) => boolean, platform: NodeJS.Platform): string[] {
  const localState = pathJoin(platform, root, 'Local State');
  if (fileExists(localState)) {
    try {
      const parsed = JSON.parse(readFile(localState)) as { profile?: { info_cache?: Record<string, unknown> } };
      const names = Object.keys(parsed.profile?.info_cache ?? {}).filter(isProfileName);
      if (names.length > 0) return names;
    } catch { /* Use the default profile when Local State cannot be read. */ }
  }
  return fileExists(pathJoin(platform, root, 'Default')) ? ['Default'] : [];
}

function extensionRecord(prefsPath: string, readFile: (path: string) => string,
  fileExists: (path: string) => boolean): Record<string, unknown> | null {
  if (!fileExists(prefsPath)) return null;
  try {
    const parsed = JSON.parse(readFile(prefsPath)) as {
      extensions?: { settings?: Record<string, Record<string, unknown>> };
    };
    const record = parsed.extensions?.settings?.[MEMMY_BROWSER_EXTENSION_ID];
    return dictionary(record) ? record : null;
  } catch {
    return null;
  }
}

function recordEnabled(record: Record<string, unknown> | null): boolean {
  if (!record) return false;
  // Modern Chromium removes this obsolete field. When present, only the old
  // enabled value is acceptable; absence alone never establishes installation.
  if (record.state !== undefined && record.state !== 1) return false;
  const reasons = record.disable_reasons;
  if (reasons !== undefined && !(Array.isArray(reasons) && reasons.length === 0) && reasons !== 0) return false;
  if (!Number.isInteger(record.location) || Number(record.location) < 1 || Number(record.location) > 10) return false;
  if (typeof record.path !== 'string' || !record.path.trim() || record.path.includes('\0')) return false;
  return true;
}

function manifestMatches(directory: string, unpacked: boolean, readFile: (path: string) => string,
  fileExists: (path: string) => boolean, platform: NodeJS.Platform): boolean {
  const manifestPath = pathJoin(platform, directory, 'manifest.json');
  if (!fileExists(manifestPath)) return false;
  try {
    const manifest: unknown = JSON.parse(readFile(manifestPath));
    if (!dictionary(manifest) || ![2, 3].includes(manifest.manifest_version as number)
      || typeof manifest.name !== 'string' || !manifest.name.trim()
      || typeof manifest.version !== 'string' || !/^\d+(?:\.\d+){0,3}$/.test(manifest.version)) return false;
    if (manifest.key === undefined) return !unpacked;
    if (typeof manifest.key !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(manifest.key)) return false;
    const digest = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16);
    const id = [...digest].flatMap(byte => [byte >> 4, byte & 15]
      .map(nibble => String.fromCharCode(97 + nibble))).join('');
    return id === MEMMY_BROWSER_EXTENSION_ID;
  } catch { return false; }
}

function recordInstalled(record: Record<string, unknown> | null, profileDir: string,
  readFile: (path: string) => string, fileExists: (path: string) => boolean, platform: NodeJS.Platform): boolean {
  if (!recordEnabled(record)) return false;
  const paths = platform === 'win32' ? win32 : posix;
  const unpacked = record!.location === 4 || record!.location === 8;
  const recordedPath = record!.path as string;
  let directory: string;
  if (paths.isAbsolute(recordedPath)) directory = paths.normalize(recordedPath);
  else {
    // Chromium resolves packed paths against this profile's Extensions folder,
    // not the working directory or browser user-data root.
    if (unpacked) return false;
    const parts = recordedPath.split(platform === 'win32' ? /[\\/]/ : /\//);
    if (parts.length !== 2 || parts[0] !== MEMMY_BROWSER_EXTENSION_ID
      || !/^\d+(?:\.\d+){0,3}(?:_\d+)?$/.test(parts[1]!)) return false;
    directory = pathJoin(platform, profileDir, 'Extensions', ...parts);
  }
  if (!unpacked && paths.basename(paths.dirname(directory)) !== MEMMY_BROWSER_EXTENSION_ID) return false;
  return fileExists(directory) && manifestMatches(directory, unpacked, readFile, fileExists, platform);
}

function profileHasExtension(profileDir: string, readFile: (path: string) => string,
  fileExists: (path: string) => boolean, platform: NodeJS.Platform): boolean {
  const secure = extensionRecord(pathJoin(platform, profileDir, 'Secure Preferences'), readFile, fileExists);
  const prefs = extensionRecord(pathJoin(platform, profileDir, 'Preferences'), readFile, fileExists);
  // Empty Secure Preferences entries are residue, not an authoritative install
  // or disable decision. Explicit secure metadata (including disable reasons)
  // still takes precedence over an older ordinary Preferences record.
  const record = secure && Object.keys(secure).length > 0 ? secure : prefs;
  return recordInstalled(record, profileDir, readFile, fileExists, platform);
}

function defaultReadFile(path: string): string {
  if (statSync(path).size > MAX_PREFS_BYTES) throw new Error('Browser preferences are too large');
  return readFileSync(path, 'utf8');
}

/** Browsers whose everyday profile has the Memmy extension installed and enabled. */
export function installedExternalBrowsers({
  platform = process.platform,
  env = process.env,
  home = homedir(),
  readFile = defaultReadFile,
  fileExists = existsSync,
}: BrowserFiles = {}): ExternalBrowserName[] {
  const installed: ExternalBrowserName[] = [];
  for (const browser of ['chrome', 'edge'] as const) {
    const root = userDataDir(browser, platform, env, home);
    if (!root || !fileExists(root)) continue;
    const names = profileNames(root, readFile, fileExists, platform);
    if (names.some(name => profileHasExtension(pathJoin(platform, root, name), readFile, fileExists, platform))) {
      installed.push(browser);
    }
  }
  return installed;
}
