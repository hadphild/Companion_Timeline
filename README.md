# Companion Timeline

An NLE-style timeline editor for [Bitfocus Companion](https://bitfocus.io/companion) button action sequences. Visualise, drag and fine-tune your action delays on a scrollable, zoomable timeline — and sync changes back to Companion live without restarting.

> **⚠️ BETA SOFTWARE — Companion v5 only**
> Always back up your Companion database before use. See [Backups](#backups) below.

![Companion Timeline Screenshot](docs/screenshot.png)

---

## Requirements

- macOS (Apple Silicon or Intel)
- **Bitfocus Companion v5.x** running on the same machine
- Companion v4 and below are **not supported**

---

## ⚠️ Important — Back Up First

Companion Timeline reads and writes directly to Companion's live SQLite database. While every save automatically creates a backup, **you should manually back up your database before using this app for the first time**.

### Where Companion stores its database

```
~/Library/Application Support/companion/v5.0/db.sqlite
```

### Where Companion Timeline stores backups

Every time you save, a backup is automatically written alongside the live database:

```
~/Library/Application Support/companion/v5.0/db.sqlite.bak
```

This is overwritten on each save, so it always reflects the state **just before your last save**.

### Recommended: make your own backup before first use

Open Terminal and run:

```bash
cp ~/Library/Application\ Support/companion/v5.0/db.sqlite \
   ~/Desktop/companion-backup-$(date +%Y%m%d-%H%M%S).sqlite
```

This saves a timestamped copy to your Desktop. Keep it somewhere safe.

### Restoring a backup

If something goes wrong, quit Companion, then:

```bash
# Restore from the automatic backup
cp ~/Library/Application\ Support/companion/v5.0/db.sqlite.bak \
   ~/Library/Application\ Support/companion/v5.0/db.sqlite
```

Or restore your own manual backup:

```bash
cp ~/Desktop/companion-backup-YYYYMMDD-HHMMSS.sqlite \
   ~/Library/Application\ Support/companion/v5.0/db.sqlite
```

Then restart Companion.

---

## Installation

1. Download the correct DMG from [Releases](https://github.com/hadphild/Companion_Timeline/releases)

| File | Mac |
|---|---|
| `Companion Timeline-x.x.x-arm64.dmg` | Apple Silicon (M1 / M2 / M3 / M4) |
| `Companion Timeline-x.x.x.dmg` | Intel |

2. Open the DMG and drag **Companion Timeline** to Applications
3. **First launch:** macOS will block the app because it is unsigned. Right-click the app → **Open** → **Open** to bypass Gatekeeper (only needed once)
4. Start Companion first, then open Companion Timeline — it will auto-connect

---

## Features

- 🎬 **Visual timeline** — all actions across Press, Release and Hold triggers shown on scrollable, zoomable tracks
- ⏱️ **Drag to re-time** — drag action blocks to change delays; use the Wait After inspector to set gaps
- 🔴 **Live connection** — auto-detects Companion via the Satellite API; shows a **LIVE** badge when connected
- ⚡ **Instant sync** — changes push to Companion's in-memory model via tRPC so they appear in the web UI immediately, no restart required
- ➕ **Add actions** — full modal pulls all your connections and action definitions from Companion
- 🔁 **Undo** — Cmd+Z undoes any change (up to 20 steps)
- 🖱️ **Right-click** — context menu to delete actions
- 🔬 **Test button** — hold to fire the selected button live in Companion
- 📋 **Action inspector** — edit instance, action ID, delay and options in a side panel

---

## Usage

### Connecting to Companion

Start Companion before opening Companion Timeline. The app auto-detects Companion via the Satellite API on port 16622. When connected, a **LIVE** badge appears in the title bar and your buttons load automatically.

### Navigating the timeline

| Action | Result |
|---|---|
| Scroll | Pan left / right |
| ⌘ + Scroll | Zoom in / out |
| Click a block | Select action (opens inspector) |
| Drag a block | Change action delay |
| Double-click a track | Add new action |
| Right-click a block | Delete action |
| ⌘Z | Undo |

### Adding a wait between actions

Select an action, then use the **Wait After** section in the right-hand inspector. If the action is the last one in the set, click **Add** to open the action picker with the delay pre-set.

### Saving

Changes auto-save to Companion every 300 ms while connected (LIVE mode). A backup is written to `db.sqlite.bak` on every save. If not connected, use **Save As…** to export a `.companionconfig` file.

---

## Disclaimer

This project is **not affiliated with or endorsed by Bitfocus**. It is independent, open-source software provided as-is.

**The developers accept no responsibility for any damage, data loss, or corruption to your Bitfocus Companion installation, configuration, or database.** Use entirely at your own risk. Always maintain your own backups.

---

## Development

```bash
git clone https://github.com/hadphild/Companion_Timeline.git
cd Companion_Timeline
npm install        # also rebuilds native modules for Electron
npm run dev        # start dev server + Electron
```

### Building a release

```bash
npm run package          # builds arm64 + Intel DMGs → release/
npm run release:patch    # bumps patch version + builds
npm run release:minor    # bumps minor version + builds
npm run release:major    # bumps major version + builds
```

### Stack

- [Electron](https://www.electronjs.org/) 31
- [Vite](https://vitejs.dev/) + [React](https://react.dev/) + TypeScript
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) — direct Companion database access
- Bitfocus Companion Satellite API (port 16622/16623)
- Bitfocus Companion tRPC API (ws://127.0.0.1:8000/trpc) — live sync

---

## License

MIT
