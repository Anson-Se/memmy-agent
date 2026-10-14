import { readFileSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { installedExternalBrowsers, MEMMY_BROWSER_EXTENSION_ID } from '../src/main/installed-external-browsers.js';

const manifest = JSON.parse(readFileSync(new URL('../extensions/memmy-browser/manifest.json', import.meta.url), 'utf8'));
const extensionPath = '/Applications/Memmy.app/Contents/Resources/browser-extension';
const chromeRoot = '/fixture/Library/Application Support/Google/Chrome';
const edgeRoot = '/fixture/Library/Application Support/Microsoft Edge';

function io(entries: Record<string, unknown>, existing = new Set<string>()) {
  const stored = new Map(Object.entries(entries).map(([path, value]) => [path, JSON.stringify(value)]));
  return {
    fileExists: (path: string) => existing.has(path) || [...stored.keys()].some(file =>
      file === path || file.startsWith(path + (path.includes('\\') ? '\\' : '/'))),
    readFile: (path: string) => {
      const value = stored.get(path);
      if (value === undefined) throw new Error(`missing fixture ${path}`);
      return value;
    },
  };
}

function prefs(record: unknown) {
  return { extensions: { settings: record === null ? {} : { [MEMMY_BROWSER_EXTENSION_ID]: record } } };
}
function enabled(extra: Record<string, unknown> = {}) {
  return { location: 4, path: extensionPath, disable_reasons: [], ...extra };
}
function mac(entries: Record<string, unknown>) {
  return installedExternalBrowsers({ platform: 'darwin', home: '/fixture', ...io(entries) });
}
function chromeRecord(record: unknown, extra: Record<string, unknown> = {}) {
  return {
    [join(chromeRoot, 'Default', 'Secure Preferences')]: prefs(record),
    [join(extensionPath, 'manifest.json')]: manifest,
    ...extra,
  };
}

describe('installed external browsers', () => {
  it('recognizes validated unpacked manifests without an obsolete state field or live worker', () => {
    expect(mac({
      [join(chromeRoot, 'Local State')]: { profile: { info_cache: { Default: {} } } },
      [join(chromeRoot, 'Default', 'Secure Preferences')]: prefs(enabled()),
      [join(edgeRoot, 'Local State')]: { profile: { info_cache: { 'Profile 2': {} } } },
      [join(edgeRoot, 'Profile 2', 'Secure Preferences')]: prefs(enabled({ state: 1 })),
      [join(extensionPath, 'manifest.json')]: manifest,
    })).toEqual(['chrome', 'edge']);
  });

  it.each([{}, [], 'removed', { state: 1 }, { path: extensionPath }, enabled({ path: '' }),
    enabled({ path: 42 }), enabled({ path: '/missing/extension' }), enabled({ path: 'relative/unpacked' }),
    enabled({ location: '4' }), enabled({ location: 0 }), enabled({ state: '1' }),
    enabled({ state: 2 }), enabled({ disable_reasons: '0' }), enabled({ disable_reasons: null }),
  ])('rejects empty, malformed or missing installation metadata: %j', record => {
    expect(mac(chromeRecord(record))).toEqual([]);
  });

  it('falls back from an empty Secure Preferences residue to a complete ordinary record', () => {
    expect(mac(chromeRecord({}, {
      [join(chromeRoot, 'Default', 'Preferences')]: prefs(enabled()),
    }))).toEqual(['chrome']);
  });

  it.each([{ state: 0 }, { disable_reasons: [1024] }, { disable_reasons: 4 },
    { disable_reasons: ['permissions_increase'] },
  ])('never overrides an explicit secure disable with ordinary enabled preferences: %j', disabled => {
    expect(mac(chromeRecord(disabled, {
      [join(chromeRoot, 'Default', 'Preferences')]: prefs(enabled()),
    }))).toEqual([]);
  });

  it('uses ordinary Preferences when no secure record exists', () => {
    expect(mac({
      [join(chromeRoot, 'Default', 'Preferences')]: prefs(enabled({ disable_reasons: 0 })),
      [join(extensionPath, 'manifest.json')]: manifest,
    })).toEqual(['chrome']);
  });

  it('requires the actual unpacked manifest and its expected extension identity', () => {
    expect(mac({ [join(chromeRoot, 'Default', 'Preferences')]: prefs(enabled()) })).toEqual([]);
    for (const invalidManifest of [{}, { ...manifest, key: undefined }, { ...manifest, key: 'YWJj' },
      { ...manifest, manifest_version: '3' }, { ...manifest, version: 'broken' }]) {
      expect(mac(chromeRecord(enabled(), { [join(extensionPath, 'manifest.json')]: invalidManifest }))).toEqual([]);
    }
  });

  it('resolves relative packed paths under the selected profile Extensions directory', () => {
    const relative = `${MEMMY_BROWSER_EXTENSION_ID}/1.0.0_0`;
    const packedManifest = { ...manifest }; delete packedManifest.key;
    expect(mac(chromeRecord({ location: 1, path: relative, disable_reasons: [] }, {
      [join(chromeRoot, 'Default', 'Extensions', relative, 'manifest.json')]: packedManifest,
    }))).toEqual(['chrome']);
    for (const path of ['../outside', `${MEMMY_BROWSER_EXTENSION_ID}/../outside`, 'other-id/1.0.0_0']) {
      expect(mac(chromeRecord({ location: 1, path }))).toEqual([]);
    }
  });

  it('rejects a mismatched manifest key even under the expected packed folder', () => {
    const relative = `${MEMMY_BROWSER_EXTENSION_ID}/1.0.0_0`;
    expect(mac(chromeRecord({ location: 1, path: relative }, {
      [join(chromeRoot, 'Default', 'Extensions', relative, 'manifest.json')]: { ...manifest, key: 'YWJj' },
    }))).toEqual([]);
  });

  it('reads Windows profiles, validates the payload and ignores unsafe profile names', () => {
    const local = 'C:\\Users\\fixture\\AppData\\Local';
    const root = win32.join(local, 'Google', 'Chrome', 'User Data');
    const path = 'C:\\Program Files\\Memmy\\resources\\browser-extension';
    expect(installedExternalBrowsers({ platform: 'win32', env: { LOCALAPPDATA: local }, ...io({
      [win32.join(root, 'Local State')]: { profile: { info_cache: { Default: {}, 'Profile 3': {}, '../Outside': {} } } },
      [win32.join(root, 'Default', 'Secure Preferences')]: prefs({}),
      [win32.join(root, 'Profile 3', 'Preferences')]: prefs(enabled({ path })),
      [win32.join(path, 'manifest.json')]: manifest,
    }) })).toEqual(['chrome']);
  });

  it('resolves Windows packed path separators without reading a relative working-directory path', () => {
    const local = 'C:\\Users\\fixture\\AppData\\Local';
    const root = win32.join(local, 'Microsoft', 'Edge', 'User Data');
    const relative = `${MEMMY_BROWSER_EXTENSION_ID}\\1.0.0_0`;
    expect(installedExternalBrowsers({ platform: 'win32', env: { LOCALAPPDATA: local }, ...io({
      [win32.join(root, 'Default', 'Preferences')]: prefs({ location: 1, path: relative }),
      [win32.join(root, 'Default', 'Extensions', relative, 'manifest.json')]: manifest,
    }) })).toEqual(['edge']);
  });

  it('does not call a browser installed when manifest reading fails', () => {
    const files = io(chromeRecord(enabled()));
    expect(installedExternalBrowsers({ platform: 'darwin', home: '/fixture', ...files,
      readFile: path => { if (path.endsWith('manifest.json')) throw new Error('unavailable'); return files.readFile(path); },
    })).toEqual([]);
  });
});
