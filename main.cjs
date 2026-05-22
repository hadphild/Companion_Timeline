const { app, shell, BrowserWindow, ipcMain, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const Database = require('better-sqlite3')
const WebSocket = require('ws')

// ── Settings store ────────────────────────────────────────────────────────────

let _settingsCache = null
function getSettingsPath() { return path.join(app.getPath('userData'), 'settings.json') }
function readSettings() {
  if (_settingsCache) return _settingsCache
  try { _settingsCache = JSON.parse(fs.readFileSync(getSettingsPath(), 'utf-8')) } catch { _settingsCache = {} }
  return _settingsCache
}
function writeSettings(patch) {
  const s = { ...readSettings(), ...patch }
  fs.writeFileSync(getSettingsPath(), JSON.stringify(s, null, 2))
  _settingsCache = s
  // Reset tRPC connection so next call reconnects to the new host
  if (patch.companionHost !== undefined) { trpcWs = null }
}
function getCompanionHost() { return readSettings().companionHost || '127.0.0.1' }
function isLocalHost(host) { return !host || host === '127.0.0.1' || host === 'localhost' }

// ── Companion tRPC live-sync ──────────────────────────────────────────────────
// Companion v5 exposes a tRPC WebSocket at ws://HOST:8000/trpc.
// We use it to push changes into Companion's in-memory model immediately after
// writing to SQLite, so changes appear without restarting Companion.

let trpcWs = null
let trpcMsgId = 1

function getCompanionTRPC() {
  return new Promise((resolve) => {
    if (trpcWs && trpcWs.readyState === WebSocket.OPEN) return resolve(trpcWs)

    const host = getCompanionHost()
    const ws = new WebSocket(`ws://${host}:8000/trpc`, {
      headers: { Origin: `http://${host}:8000` },
      handshakeTimeout: 3000
    })
    const done = (result) => {
      ws.off('open', onOpen)
      ws.off('error', onFail)
      resolve(result)
    }
    const onOpen = () => { trpcWs = ws; done(ws) }
    const onFail = () => done(null)
    ws.once('open', onOpen)
    ws.once('error', onFail)
    ws.on('error', () => { trpcWs = null }) // reset on later errors
    ws.on('close', () => { if (trpcWs === ws) trpcWs = null })
    setTimeout(() => done(null), 3000)
  })
}

function trpcCall(ws, method, path, input) {
  return new Promise((resolve) => {
    const id = trpcMsgId++
    const timeout = setTimeout(() => { ws.off('message', handler); resolve(null) }, 4000)
    const handler = (data) => {
      try {
        const msg = JSON.parse(data)
        if (msg.id !== id) return
        clearTimeout(timeout)
        ws.off('message', handler)
        resolve(msg.result?.data ?? null)
      } catch (_) {}
    }
    ws.on('message', handler)
    ws.send(JSON.stringify({ id, method, params: { path, input } }))
  })
}

// Wrap an option value in Companion v5 format
function wrapOptionValue(v) {
  return { value: String(v ?? ''), isExpression: false }
}

// Hold trigger setIds are numbers in the tRPC schema — convert numeric strings
function normaliseSetId(setId) {
  const n = Number(setId)
  return Number.isFinite(n) && String(n) === setId ? n : setId
}

async function pushSyncToCompanion(syncEntries) {
  // syncEntries: [{ controlId, stepId, setId, oldEntityIds, newEntities }]
  let ws
  try { ws = await getCompanionTRPC() } catch (_) { ws = null }
  if (!ws) {
    console.log('[CT] tRPC unavailable — Companion will reflect changes after restart')
    return
  }

  let sets = 0, added = 0, failed = 0

  for (const { controlId, stepId, setId, oldEntityIds, newEntities } of syncEntries) {
    const entityLocation = { stepId, setId: normaliseSetId(setId) }

    // Remove all old entities from Companion's memory
    for (const entityId of oldEntityIds) {
      await trpcCall(ws, 'mutation', 'controls.entities.remove', { controlId, entityLocation, entityId })
    }

    // Add new entities in order, then set their options
    for (const entity of newEntities) {
      const newId = await trpcCall(ws, 'mutation', 'controls.entities.add', {
        controlId, entityLocation, ownerId: null,
        connectionId: entity.connectionId,
        entityType: 'action',
        entityDefinition: entity.definitionId
      })
      if (!newId) { failed++; continue }
      added++

      for (const [key, val] of Object.entries(entity.options || {})) {
        const raw = (val !== null && typeof val === 'object' && 'value' in val) ? val : wrapOptionValue(val)
        await trpcCall(ws, 'mutation', 'controls.entities.setOption', {
          controlId, entityLocation, entityId: newId, key, value: raw
        })
      }
    }
    sets++
  }

  if (failed > 0) {
    console.warn(`[CT] tRPC sync: ${sets} set(s), ${added} added, ${failed} failed — some changes may need a Companion restart`)
  } else {
    console.log(`[CT] tRPC sync complete — ${sets} action set(s), ${added} entity/ies pushed live`)
  }
}

function sqliteQuery(dbPath, sql) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try { return db.prepare(sql).all() }
  finally { db.close() }
}

function sqliteWrite(dbPath, fn) {
  const db = new Database(dbPath)
  db.pragma('busy_timeout = 5000')
  try { fn(db) }
  finally { db.close() }
}

const COMPANION_BASE = process.platform === 'win32'
  ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'companion')
  : process.platform === 'linux'
    ? path.join(os.homedir(), '.local/share/companion')
    : path.join(os.homedir(), 'Library/Application Support/companion')
const COMPANION_V5_DB = path.join(COMPANION_BASE, 'v5.0/db.sqlite')
const COMPANION_V5_DB_BAK = path.join(COMPANION_BASE, 'v5.0/db.sqlite.bak')
const COMPANION_JSON_DB = path.join(COMPANION_BASE, 'v3.0/db')
const COMPANION_JSON_DB_BAK = path.join(COMPANION_BASE, 'v3.0/db.bak')

const isDev = process.env.NODE_ENV === 'development'

// ── Companion v5 SQLite adapter ──────────────────────────────────────────────

function readV5Database() {
  const rawControls  = sqliteQuery(COMPANION_V5_DB, 'SELECT id, value FROM controls')
  const rawPages     = sqliteQuery(COMPANION_V5_DB, 'SELECT id, value FROM pages')
  const rawInstances = sqliteQuery(COMPANION_V5_DB, 'SELECT id, value FROM instances')

  {

    // Build controls map
    const controlsMap = {}
    for (const row of rawControls) {
      controlsMap[row.id] = JSON.parse(row.value)
    }

    // Build page structure and produce bank:PAGE-ROW-COL keys compatible with our renderer
    const controls = {}
    const pageInfo = {}

    for (const row of rawPages) {
      const pg = JSON.parse(row.value)
      const pageNum = parseInt(row.id) // pages table id is 1, 2, 3 ...
      pageInfo[pageNum] = { name: pg.name || `Page ${pageNum}` }

      const grid = pg.controls || {}
      for (const [rowStr, cols] of Object.entries(grid)) {
        const r = parseInt(rowStr)
        for (const [colStr, bankId] of Object.entries(cols)) {
          const c = parseInt(colStr)
          const slot = r * 8 + c + 1  // convert row/col to 1-based slot
          const syntheticKey = `bank:${pageNum}-${slot}`
          const ctrl = controlsMap[bankId]
          if (!ctrl) continue

          if (ctrl.type === 'pageup' || ctrl.type === 'pagenum' || ctrl.type === 'pagedown') {
            controls[syntheticKey] = { type: ctrl.type }
            continue
          }

          if (ctrl.type === 'button-layered' || ctrl.type === 'button') {
            // Extract label text from layers
            const layers = ctrl.style?.layers || []
            const textLayer  = layers.find(l => l.type === 'text')
            const bgLayer    = layers.find(l => l.type === 'box')
            const imageLayer = layers.find(l => l.type === 'image' && l.base64Image?.value)
            const text   = textLayer?.text?.value   || ''
            const bgcolor = bgLayer?.color?.value   ?? 0
            const color   = textLayer?.color?.value ?? 0xffffff
            const image   = imageLayer?.base64Image?.value || null

            // Normalise steps: v5 actions use connectionId/definitionId, map to instance/action
            const steps = {}
            for (const [stepKey, step] of Object.entries(ctrl.steps || {})) {
              const actionSets = {}
              for (const [trigger, rawActions] of Object.entries(step.action_sets || {})) {
                const mapped = (rawActions || []).map(a => ({
                  id: a.id,
                  action: a.definitionId || a.action || '',
                  instance: a.connectionId || a.instance || '',
                  options: flattenOptions(a.options || {}),
                  delay: a.delay ?? 0,
                  children: a.children,
                  disabled: a.disabled,
                }))
                actionSets[trigger] = processActionsFromCompanion(mapped)
              }
              steps[stepKey] = {
                action_sets: actionSets,
                options: step.options || {}
              }
            }

            controls[syntheticKey] = {
              type: 'button',
              style: { text, color, bgcolor, image, size: 'auto' },
              options: { relativeDelay: false, stepAutoProgress: true },
              feedbacks: ctrl.feedbacks || [],
              steps,
              _v5id: bankId  // stash original ID for write-back
            }
          }
        }
      }
    }

    // Build instances map (only connection-type instances)
    const instances = {}
    for (const row of rawInstances) {
      const inst = JSON.parse(row.value)
      if (inst.moduleInstanceType === 'connection') {
        instances[row.id] = {
          instance_type: inst.moduleId || inst.moduleInstanceType,
          label: inst.label || row.id,
          enabled: inst.enabled !== false
        }
      }
    }

    return {
      version: 5,
      type: 'page',
      controls,
      page: pageInfo,
      instances,
      _source: 'v5sqlite'
    }
  }
}

function flattenOptions(opts) {
  const out = {}
  for (const [k, v] of Object.entries(opts)) {
    out[k] = (v !== null && typeof v === 'object' && 'value' in v) ? v.value : v
  }
  return out
}

// Convert internal:wait actions into delay offsets on the following action.
// Preserves internal:action_group blocks with their children (processed recursively).
function processActionsFromCompanion(mappedActions) {
  let accMs = 0
  const result = []
  for (const a of mappedActions) {
    if (a.instance === 'internal' && a.action === 'wait') {
      accMs += Number(a.options?.time ?? 0) || 0
    } else if (a.instance === 'internal' && a.action === 'action_group') {
      // Preserve action_group with its children processed recursively
      const processedChildren = {}
      for (const [setKey, childActions] of Object.entries(a.children || {})) {
        processedChildren[setKey] = processActionsFromCompanion(
          (childActions || []).map(c => ({
            id: c.id,
            action: c.definitionId || c.action || '',
            instance: c.connectionId || c.instance || '',
            options: flattenOptions(c.options || {}),
            delay: c.delay ?? 0,
            children: c.children,
            disabled: c.disabled,
          }))
        )
      }
      result.push({
        ...a,
        delay: (a.delay || 0) + accMs,
        children: processedChildren,
      })
      accMs = 0
    } else {
      result.push({ ...a, delay: (a.delay || 0) + accMs })
      accMs = 0
    }
  }
  return result
}

// Convert delay-based actions back to Companion format, inserting internal:wait
// actions for gaps between consecutive action delays.
// action_group blocks are written back with their children intact.
function processActionsToCompanion(uiActions) {
  const sorted = [...uiActions]
    .filter(a => a.instance && a.action)  // skip blank/incomplete actions
    .sort((a, b) => (a.delay || 0) - (b.delay || 0))
  const result = []
  let prevMs = 0
  for (const a of sorted) {
    const gap = (a.delay || 0) - prevMs
    if (gap > 0) {
      result.push({
        type: 'action',
        id: Math.random().toString(36).slice(2, 12),
        connectionId: 'internal',
        definitionId: 'wait',
        options: { time: { value: String(gap), isExpression: false } },
        upgradeIndex: 3,
        children: {}
      })
    }

    if (a.instance === 'internal' && a.action === 'action_group') {
      // Write action_group with recursively converted children
      const writtenChildren = {}
      for (const [setKey, childActions] of Object.entries(a.children || {})) {
        writtenChildren[setKey] = processActionsToCompanion(childActions || [])
      }
      result.push({
        type: 'action',
        id: a.id,
        connectionId: 'internal',
        definitionId: 'action_group',
        options: wrapOptions(a.options || {}),
        upgradeIndex: 3,
        children: writtenChildren,
        ...(a.disabled != null && { disabled: a.disabled }),
      })
    } else {
      result.push({
        type: 'action',
        id: a.id,
        connectionId: a.instance,
        definitionId: a.action,
        options: wrapOptions(a.options || {}),
        upgradeIndex: 3,
        ...(a.disabled != null && { disabled: a.disabled }),
      })
    }
    prevMs = a.delay || 0
  }
  return result
}

function writeV5Database(config) {
  if (fs.existsSync(COMPANION_V5_DB)) {
    fs.copyFileSync(COMPANION_V5_DB, COMPANION_V5_DB_BAK)
  }

  try {
    const rows = sqliteQuery(COMPANION_V5_DB, 'SELECT id, value FROM controls')
    const currentRaw = {}
    for (const row of rows) currentRaw[row.id] = JSON.parse(row.value)

    // Collect sync info: old entity IDs (to remove) + new entities (to add)
    const syncEntries = []

    sqliteWrite(COMPANION_V5_DB, (db) => {
      const update = db.prepare('UPDATE controls SET value = ? WHERE id = ?')
      const run = db.transaction(() => {
        for (const [, ctrl] of Object.entries(config.controls)) {
          if (ctrl.type !== 'button' || !ctrl._v5id) continue
          const raw = currentRaw[ctrl._v5id]
          if (!raw) continue

          const newSteps = {}
          for (const [stepKey, step] of Object.entries(ctrl.steps || {})) {
            const actionSets = {}
            for (const [trigger, actions] of Object.entries(step.action_sets || {})) {
              const newEntities = processActionsToCompanion(actions || [])
              actionSets[trigger] = newEntities

              const oldEntities = raw.steps?.[stepKey]?.action_sets?.[trigger] ?? []
              syncEntries.push({
                controlId: ctrl._v5id,
                stepId: stepKey,
                setId: trigger,
                oldEntityIds: oldEntities.map(e => e.id),
                newEntities
              })
            }
            newSteps[stepKey] = {
              action_sets: actionSets,
              options: step.options || raw.steps?.[stepKey]?.options || {}
            }
          }

          update.run(JSON.stringify({ ...raw, steps: newSteps }), ctrl._v5id)
        }
      })
      run()
    })

    return { ok: true, syncEntries }
  } catch (e) {
    return { error: e.message }
  }
}

function wrapOptions(flatOpts, originalActions) {
  // Try to find matching original action to preserve isExpression flags
  const out = {}
  for (const [k, v] of Object.entries(flatOpts)) {
    out[k] = { value: v, isExpression: false }
  }
  return out
}

// ── Electron setup ────────────────────────────────────────────────────────────

// ── Live polling ─────────────────────────────────────────────────────────────

let pollInterval = null
let lastMtime = 0
let isSaving = false  // suppress false-positive after our own write

function startPolling(win) {
  if (pollInterval) return
  lastMtime = fs.existsSync(COMPANION_V5_DB) ? fs.statSync(COMPANION_V5_DB).mtimeMs : 0
  pollInterval = setInterval(() => {
    if (isSaving || !fs.existsSync(COMPANION_V5_DB)) return
    try {
      const mtime = fs.statSync(COMPANION_V5_DB).mtimeMs
      if (mtime === lastMtime) return
      lastMtime = mtime
      const config = readV5Database()
      if (win && !win.isDestroyed()) {
        win.webContents.send('companion:changed', {
          filePath: COMPANION_V5_DB,
          content: JSON.stringify(config)
        })
      }
    } catch (_) {
      // DB may be locked by Companion — skip this tick
    }
  }, 2000)
}

function stopPolling() {
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null }
}

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1a1a1a',
    titleBarStyle: 'hiddenInset',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: false,
      contextIsolation: true,
      webSecurity: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
    startPolling(mainWindow)
  })
  mainWindow.on('closed', stopPolling)

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (isDev) {
    mainWindow.webContents.on('console-message', (_e, level, msg, line, src) => {
      if (level >= 2) console.error(`[renderer] ${msg} (${src}:${line})`)
    })
    mainWindow.loadURL('http://localhost:5173')
  } else {
    mainWindow.loadFile(path.join(__dirname, 'dist/index.html'))
  }
}

app.whenReady().then(() => {
  // Extract action IDs from a minified Companion module bundle via pattern matching
  function extractModuleActionIds(moduleDir) {
    try {
      const mainJs = path.join(moduleDir, 'main.js')
      if (!fs.existsSync(mainJs)) return []
      const src = fs.readFileSync(mainJs, 'utf-8')
      const ids = new Set()

      // Pattern 1 (older modules): setActionDefinitions({ actionId: { name: ... } })
      // Finds the largest chunk after .setActionDefinitions( and scans it
      const needle = '.setActionDefinitions('
      let best = null, bestSize = 0, pos = 0
      while ((pos = src.indexOf(needle, pos)) !== -1) {
        const after = src.slice(pos + needle.length, pos + needle.length + 10)
        if (/^(e|t|i|s|r|n)\)/.test(after)) { pos++; continue }
        const chunk = src.slice(pos + needle.length, pos + needle.length + 200000)
        if (chunk.length > bestSize) { best = chunk; bestSize = chunk.length }
        pos++
      }
      if (best) {
        for (const m of best.matchAll(/[{,]([a-z][a-z0-9_]{1,60}):\s*\{[^}]{0,400}(?:name|label)\s*:/g)) {
          ids.add(m[1])
        }
      }

      // Pattern 2 (newer v5 modules like ATEM): actionId: 'some_action_id'
      for (const m of src.matchAll(/actionId:\s*['"]([a-z_][a-z0-9_]{1,60})['"]/g)) {
        ids.add(m[1])
      }

      // Pattern 3 (object shorthand): { id: 'action_name', name: '...', options: }
      for (const m of src.matchAll(/\bid:\s*['"]([a-z_][a-z0-9_]{1,60})['"]\s*,\s*(?:name|label):/g)) {
        ids.add(m[1])
      }

      const SKIP = new Set(['options', 'description', 'type', 'value', 'default', 'choices',
        'style', 'size', 'text', 'min', 'max', 'step', 'regex', 'tooltip', 'width', 'height'])
      return [...ids].filter(k => !SKIP.has(k))
    } catch (_) { return [] }
  }

  // ── Settings IPC ───────────────────────────────────────────────────────────
  ipcMain.handle('settings:get', () => readSettings())
  ipcMain.handle('settings:set', (_event, patch) => { writeSettings(patch); return true })

  ipcMain.handle('companion:getActionLibrary', async () => {
    const host = getCompanionHost()
    try {
      // Build connection map: local SQLite or remote HTTP API
      const connections = {}  // connectionId → { label, moduleId }
      const usedActions = {}  // "connectionId:definitionId" → { options }

      if (isLocalHost(host)) {
        const instRows = sqliteQuery(COMPANION_V5_DB, 'SELECT id, value FROM instances')
        for (const row of instRows) {
          const inst = JSON.parse(row.value)
          if (inst.moduleInstanceType !== 'connection') continue
          connections[row.id] = { label: inst.label || row.id, moduleId: inst.moduleId || '' }
        }

        // Scan existing controls for used action options (as templates)
        const ctrlRows = sqliteQuery(COMPANION_V5_DB, 'SELECT value FROM controls')
        for (const row of ctrlRows) {
          const ctrl = JSON.parse(row.value)
          for (const step of Object.values(ctrl.steps || {})) {
            for (const actions of Object.values(step.action_sets || {})) {
              for (const a of (actions || [])) {
                if (!a.connectionId || !a.definitionId) continue
                const key = `${a.connectionId}:${a.definitionId}`
                if (!usedActions[key]) {
                  const opts = {}
                  for (const [k, v] of Object.entries(a.options || {})) {
                    opts[k] = (v !== null && typeof v === 'object' && 'value' in v) ? v.value : v
                  }
                  usedActions[key] = { connectionId: a.connectionId, definitionId: a.definitionId, options: opts }
                }
              }
            }
          }
        }
      } else {
        // Remote: fetch connections from Companion HTTP API
        try {
          const resp = await fetch(`http://${host}:8000/api/connections`, { signal: AbortSignal.timeout(5000) })
          if (resp.ok) {
            const data = await resp.json()
            const list = Array.isArray(data) ? data : (data.connections || data.instances || [])
            for (const conn of list) {
              const id = conn.id || conn.uid
              if (!id) continue
              connections[id] = { label: conn.label || id, moduleId: conn.instance_type || conn.moduleId || '' }
            }
          }
        } catch (e) {
          console.warn('[library] remote connections fetch failed:', e.message)
        }
      }

      // Scan installed modules to extract action IDs (always local — modules are installed locally)
      const MODULES_DIR = path.join(COMPANION_BASE, 'modules')
      const moduleActionIds = {}
      if (fs.existsSync(MODULES_DIR)) {
        for (const entry of fs.readdirSync(MODULES_DIR)) {
          const moduleDir = path.join(MODULES_DIR, entry)
          if (!fs.statSync(moduleDir).isDirectory()) continue
          const manifestPath = path.join(moduleDir, 'companion', 'manifest.json')
          let moduleId = null
          if (fs.existsSync(manifestPath)) {
            try { moduleId = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')).id } catch (_) {}
          }
          if (!moduleId) moduleId = entry.replace(/-\d+\.\d+.*$/, '')
          if (!moduleActionIds[moduleId]) moduleActionIds[moduleId] = extractModuleActionIds(moduleDir)
        }
      }

      // Internal Companion actions
      const INTERNAL_ACTIONS = [
        'action_group', 'log', 'set_page_by_id', 'set_page_by_name',
        'button_pressrelease', 'button_press', 'button_release',
        'button_rotate_left', 'button_rotate_right',
        'variable_set_number', 'variable_set_string',
        'instance_control', 'kill_all_delays',
      ]
      const internalUsed = Object.values(usedActions).filter(a => a.connectionId === 'internal')
      const internalIds = [...new Set([...INTERNAL_ACTIONS, ...internalUsed.map(a => a.definitionId)])]

      const result = []
      for (const defId of internalIds) {
        const usedTemplate = usedActions[`internal:${defId}`]
        result.push({ connectionId: 'internal', connectionLabel: 'Internal', moduleId: 'internal',
          definitionId: defId, options: usedTemplate?.options ?? {}, usedBefore: !!usedTemplate })
      }

      for (const [connId, conn] of Object.entries(connections)) {
        const fromModule = moduleActionIds[conn.moduleId] || []
        const fromUsed = Object.values(usedActions).filter(a => a.connectionId === connId).map(a => a.definitionId)
        const allIds = [...new Set([...fromUsed, ...fromModule])]

        if (allIds.length === 0) {
          result.push({ connectionId: connId, connectionLabel: conn.label, moduleId: conn.moduleId,
            definitionId: '', options: {}, usedBefore: false, noActions: true })
        } else {
          for (const defId of allIds) {
            const usedTemplate = usedActions[`${connId}:${defId}`]
            result.push({ connectionId: connId, connectionLabel: conn.label, moduleId: conn.moduleId,
              definitionId: defId, options: usedTemplate?.options ?? {}, usedBefore: !!usedTemplate, noActions: false })
          }
        }
      }

      return { actions: result, connections }
    } catch (e) {
      return { error: e.message }
    }
  })

  ipcMain.handle('companion:loadLive', async () => {
    const host = getCompanionHost()

    if (!isLocalHost(host)) {
      // Remote: return an empty config shell — satellite will show live states
      // and tRPC will push edits to the remote host
      return {
        filePath: `remote://${host}`,
        content: JSON.stringify({ _source: 'remote', host, pages: {}, controls: {} }),
        isLiveDb: true,
        version: 5,
        isRemote: true,
        remoteHost: host,
      }
    }

    // Local: prefer v5 SQLite, fall back to v3 JSON
    if (fs.existsSync(COMPANION_V5_DB)) {
      try {
        const config = readV5Database()
        return { filePath: COMPANION_V5_DB, content: JSON.stringify(config), isLiveDb: true, version: 5 }
      } catch (e) {
        return { error: `v5 read failed: ${e.message}` }
      }
    } else if (fs.existsSync(COMPANION_JSON_DB)) {
      try {
        const content = fs.readFileSync(COMPANION_JSON_DB, 'utf-8')
        return { filePath: COMPANION_JSON_DB, content, isLiveDb: true, version: 3 }
      } catch (e) {
        return { error: `v3 read failed: ${e.message}` }
      }
    }
    return { error: 'Companion database not found. Is Companion installed?' }
  })

  ipcMain.handle('companion:saveLive', async (_event, content) => {
    // Show native confirm dialog in main process (avoids Electron renderer dialog issues)
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Save to Companion', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      title: 'Save to Companion',
      message: 'Overwrite the live Companion database?',
      detail: 'A backup will be saved first (db.sqlite.bak).\n\nCompanion will automatically reload changes.'
    })
    if (response !== 0) return { cancelled: true }

    const config = JSON.parse(content)
    if (config._source === 'v5sqlite') {
      isSaving = true
      const result = writeV5Database(config)
      if (fs.existsSync(COMPANION_V5_DB)) lastMtime = fs.statSync(COMPANION_V5_DB).mtimeMs
      setTimeout(() => { isSaving = false }, 3000)
      if (result.error) console.error('[save] v5 write error:', result.error)
      else {
        console.log('[save] v5 write OK')
        pushSyncToCompanion(result.syncEntries).catch(e => console.error('[sync]', e.message))
      }
      return result
    }
    // v3 JSON write
    try {
      if (fs.existsSync(COMPANION_JSON_DB)) {
        fs.copyFileSync(COMPANION_JSON_DB, COMPANION_JSON_DB_BAK)
      }
      fs.writeFileSync(COMPANION_JSON_DB, content, 'utf-8')
      console.log('[save] v3 JSON write OK')
      return { ok: true }
    } catch (e) {
      console.error('[save] v3 write error:', e.message)
      return { error: e.message }
    }
  })

  // Silent auto-save: write changes directly to SQLite without a confirmation dialog.
  // Called by the renderer after every action delay/edit when live.
  ipcMain.handle('companion:saveSilent', async (_event, content) => {
    try {
      const config = JSON.parse(content)
      if (config._source !== 'v5sqlite') return { error: 'only v5sqlite supported' }
      isSaving = true
      const result = writeV5Database(config)
      if (fs.existsSync(COMPANION_V5_DB)) lastMtime = fs.statSync(COMPANION_V5_DB).mtimeMs
      setTimeout(() => { isSaving = false }, 3000)
      if (result.ok) pushSyncToCompanion(result.syncEntries).catch(e => console.error('[sync]', e.message))
      return result
    } catch (e) {
      isSaving = false
      return { error: e.message }
    }
  })

  // Renderer calls these when it has a live socket to Companion — no need to poll
  ipcMain.handle('companion:pausePolling', () => stopPolling())
  ipcMain.handle('companion:resumePolling', () => { if (mainWindow) startPolling(mainWindow) })

  ipcMain.handle('dialog:openFile', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Open Companion Config',
      filters: [
        { name: 'Companion Config', extensions: ['companionconfig'] },
        { name: 'JSON', extensions: ['json'] }
      ],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const filePath = result.filePaths[0]
    const content = fs.readFileSync(filePath, 'utf-8')
    return { filePath, content }
  })

  ipcMain.handle('dialog:saveFile', async (_event, filePath, content) => {
    if (!filePath) {
      const result = await dialog.showSaveDialog({
        title: 'Save Companion Config',
        filters: [{ name: 'Companion Config', extensions: ['companionconfig'] }]
      })
      if (result.canceled || !result.filePath) return null
      filePath = result.filePath
    }
    fs.writeFileSync(filePath, content, 'utf-8')
    return filePath
  })

  ipcMain.handle('dialog:saveFileAs', async (_event, content) => {
    const result = await dialog.showSaveDialog({
      title: 'Save Companion Config As',
      filters: [{ name: 'Companion Config', extensions: ['companionconfig'] }]
    })
    if (result.canceled || !result.filePath) return null
    fs.writeFileSync(result.filePath, content, 'utf-8')
    return result.filePath
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
