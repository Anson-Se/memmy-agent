# Changelog

## 1.2.401 - 2026-10-23

### Fixed

- Accept valid macOS update packages during CPU architecture checks.
- Hide empty User Memories pagination and count seven-day activated-skill recalls and invocations correctly.
- Include `ignore` in packaged Memory and declare `fzstd` in standalone Agent dependencies.
- Verify SQLite 13 N-API prebuilds in Memory runtime packages.
- Retry temporary Linux Gateway bootstrap HTTP 503 responses.
- Retry Draft Release commit-to-PR metadata requests and preserve complete change snapshots.

### Changed

- Require Node.js 22.23.4+ (22.x), 24.22.1+ (24.x), or 26.12.1+ (26.x) for the Linux CLI installer.

- Upgrade Electron to `43.8.1` and `better-sqlite3` to `^13.0.3`; align native runtime packaging with the bundled N-API binaries.
- Package the standalone Memory executable with Node 24 and retain both glibc and musl SQLite variants for Linux targets.
- Synchronize Memmy Desktop and Agent to `1.2.401`; Memory remains independently versioned at `2.1.7`.
