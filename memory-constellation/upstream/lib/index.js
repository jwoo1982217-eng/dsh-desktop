/**
 * Host half of dsh-meow-constellation.
 *
 * Reads meow-memory's local SQLite store (read-only) and serves:
 *   GET /meow-constellation/app                  -> the star-map page
 *   GET /meow-constellation/api/workspaces      -> discovered memory stores
 *   GET /meow-constellation/api/memories        -> every memory entry, layered
 *
 * No writes, no tools, no LLM calls. The browser half (lib/client.js) only
 * mounts a launcher; all rendering lives in lib/constellation.html so the very
 * same page can be opened directly (it falls back to demo data off-host).
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

export const name = 'meow-constellation'

const APP_ROUTE = '/meow-constellation/app'
const API_WORKSPACES = '/meow-constellation/api/workspaces'
const API_MEMORIES = '/meow-constellation/api/memories'
const MEMORY_DIR = '.dsh-meow'
const DB_FILE = 'memory.db'
const PAGE_URL = new URL('./constellation.html', import.meta.url)

/** Seven layers of meow-memory, ordered from the innermost ring outwards. */
export const LAYERS = [
  { level: 'soul', label: 'AI 自身', color: '#ffd166' },
  { level: 'user', label: '用户', color: '#7ee8fa' },
  { level: 'rules', label: '准则', color: '#ffa66b' },
  { level: 'project', label: '项目', color: '#c9a7ff' },
  { level: 'topic', label: '话题', color: '#8ab4ff' },
  { level: 'fact', label: '事实', color: '#9dffc9' },
  { level: 'lesson', label: '经验', color: '#ff8fb8' },
]

function send(res, status, payload, contentType = 'application/json; charset=utf-8') {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * Memory contents are private. Only serve them to the local DSH carrier:
 * loopback socket, or a request explicitly addressed to localhost.
 */
function allowed(req) {
  const addr = String(req?.socket?.remoteAddress ?? '')
  if (addr === '' || addr.startsWith('127.') || addr === '::1' || addr === '::ffff:127.0.0.1') return true
  const host = String(req?.headers?.host ?? '')
  return host.startsWith('127.0.0.1') || host.startsWith('localhost')
}

/** Find every workspace that actually owns a meow-memory database. */
export async function discoverWorkspaces(ctx) {
  const found = new Set()
  const add = (p) => {
    if (typeof p !== 'string' || p.length === 0 || !isAbsolute(p)) return
    if (existsSync(join(p, MEMORY_DIR, DB_FILE))) found.add(p)
  }
  try {
    const sp = ctx?.get?.('sessionPersistence')
    if (sp && typeof sp.list === 'function') {
      const list = await sp.list()
      for (const s of Array.isArray(list) ? list : []) {
        const header = s?.header ?? s
        add(header?.cwd ?? s?.cwd)
      }
    }
  } catch { /* service not ready */ }
  try {
    const reg = ctx?.get?.('workspaceRegistry')
    if (reg) {
      const list = typeof reg.list === 'function' ? await reg.list()
        : (Array.isArray(reg.workspaces) ? reg.workspaces : [])
      for (const w of Array.isArray(list) ? list : []) {
        add(typeof w === 'string' ? w : (w?.path ?? w?.cwd ?? w?.root))
      }
    }
  } catch { /* service not ready */ }
  // meow-memory's own window index is a good source when no session is open.
  const home = homedir()
  for (const file of [
    join(home, MEMORY_DIR, 'window-index.json'),
    join(home, '.dsh', 'storages', 'meow-memory', 'window-index.json'),
    join(home, '.dsh', 'dsh-home', 'storages', 'meow-memory', 'window-index.json'),
  ]) {
    try {
      const index = JSON.parse(readFileSync(file, 'utf8'))
      for (const value of Object.values(index)) add(value)
    } catch { /* absent or malformed */ }
  }
  add(process.cwd())

  const out = [...found].map((path) => {
    let mtime = 0
    let size = 0
    try {
      const st = statSync(join(path, MEMORY_DIR, DB_FILE))
      mtime = st.mtimeMs
      size = st.size
    } catch { /* just removed */ }
    const stats = countMemories(path)
    return { path, name: basename(path) || path, mtime, size, activeTotal: stats.active, total: stats.total }
  })
  // 主库优先：有效条数多的排前面，相同再按最近写入时间
  out.sort((a, b) => (b.activeTotal - a.activeTotal) || (b.mtime - a.mtime))
  return out
}

/** 轻量统计：某个库的有效条数与总条数，用于工作区下拉排序与展示。 */
function countMemories(workspace) {
  const result = { active: 0, total: 0 }
  const dbPath = join(workspace, MEMORY_DIR, DB_FILE)
  if (!existsSync(dbPath)) return result
  let db
  try { db = openReadOnly(dbPath) } catch { return result }
  try {
    for (const layer of LAYERS) {
      try {
        const rows = db.prepare(`SELECT status FROM "${layer.level}"`).all()
        result.total += rows.length
        for (const r of rows) {
          const status = typeof r.status === 'string' && r.status ? r.status : 'active'
          if (status === 'active') result.active += 1
        }
      } catch { /* table missing */ }
    }
  } finally {
    try { db.close() } catch { /* ignore */ }
  }
  return result
}

function openReadOnly(path) {
  try {
    return new DatabaseSync(path, { readOnly: true })
  } catch {
    return new DatabaseSync(path)
  }
}

/** Read all seven layer tables. Exported for the smoke test. */
export function readMemories(workspace, includeAll = false) {
  if (typeof workspace !== 'string' || !isAbsolute(workspace)) return null
  const dbPath = join(workspace, MEMORY_DIR, DB_FILE)
  if (!existsSync(dbPath)) return null

  let db
  try {
    db = openReadOnly(dbPath)
  } catch (error) {
    throw new Error(`无法打开记忆库: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    const items = []
    const layerCounts = {}
    for (const layer of LAYERS) {
      let rows = []
      try {
        rows = db.prepare(`SELECT * FROM "${layer.level}"`).all()
      } catch {
        layerCounts[layer.level] = 0
        continue
      }
      let count = 0
      for (const r of rows) {
        const status = typeof r.status === 'string' && r.status ? r.status : 'active'
        if (!includeAll && status !== 'active') continue
        count += 1
        let keywords = []
        if (Array.isArray(r.keywords)) {
          keywords = r.keywords.map(String)
        } else if (typeof r.keywords === 'string') {
          try {
            const parsed = JSON.parse(r.keywords)
            keywords = Array.isArray(parsed) ? parsed.map(String) : []
          } catch {
            keywords = r.keywords.split(/[、,|]/).map((s) => s.trim()).filter(Boolean)
          }
        }
        items.push({
          id: String(r.id ?? ''),
          level: layer.level,
          content: String(r.content ?? ''),
          title: r.title == null ? null : String(r.title),
          importance: Number(r.importance ?? 1) || 1,
          keywords,
          status,
          project: r.project == null ? null : String(r.project),
          subcategory: r.subcategory == null ? null : String(r.subcategory),
          goal: r.goal == null ? null : String(r.goal),
          corrected: Number(r.corrected ?? 0) === 1,
          hitCount: Number(r.hit_count ?? 0) || 0,
          createdAt: Number(r.created_at ?? 0) || null,
          updatedAt: Number(r.updated_at ?? 0) || null,
          sourceSession: r.source_session == null ? null : String(r.source_session),
        })
      }
      layerCounts[layer.level] = count
    }
    let mtime = 0
    try { mtime = statSync(dbPath).mtimeMs } catch { /* ignore */ }
    return {
      ok: true,
      workspace,
      workspaceName: basename(workspace) || workspace,
      mtime,
      generatedAt: Date.now(),
      includeAll: Boolean(includeAll),
      total: items.length,
      layerCounts,
      layers: LAYERS,
      items,
    }
  } finally {
    try { db.close() } catch { /* ignore */ }
  }
}

export function apply(ctx) {
  const log = (message) => {
    try { ctx?.logger?.info?.(message) } catch { /* ignore */ }
  }
  const routes = [
    [APP_ROUTE, (req, res) => {
      if (!allowed(req)) return send(res, 403, { ok: false, error: 'loopback only' })
      try {
        send(res, 200, readFileSync(PAGE_URL, 'utf8'), 'text/html; charset=utf-8')
      } catch (error) {
        send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    }],
    [API_WORKSPACES, (req, res) => {
      if (!allowed(req)) return send(res, 403, { ok: false, error: 'loopback only' })
      void (async () => {
        try {
          const workspaces = await discoverWorkspaces(ctx)
          send(res, 200, { ok: true, workspaces, current: workspaces[0]?.path ?? null })
        } catch (error) {
          send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      })()
    }],
    [API_MEMORIES, (req, res) => {
      if (!allowed(req)) return send(res, 403, { ok: false, error: 'loopback only' })
      void (async () => {
        try {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          const includeAll = url.searchParams.get('all') === '1'
          const dir = url.searchParams.get('dir')
          const scope = url.searchParams.get('scope')
          const since = Number(url.searchParams.get('since') || 0) || 0
          const workspaces = await discoverWorkspaces(ctx)
          if (workspaces.length === 0) {
            return send(res, 200, { ok: false, error: '未找到 meow-memory 记忆库', workspaces })
          }
          // 聚合视图：把所有工作区的记忆合并成一片星图
          if (scope === 'all') {
            const items = []
            const layerCounts = {}
            for (const layer of LAYERS) layerCounts[layer.level] = 0
            let mtime = 0
            for (const w of workspaces) {
              const part = readMemories(w.path, includeAll)
              if (!part) continue
              mtime = Math.max(mtime, part.mtime)
              for (const item of part.items) {
                items.push({
                  ...item,
                  uid: `${part.workspaceName}::${item.id}`,
                  workspace: w.path,
                  workspaceName: part.workspaceName,
                })
                layerCounts[item.level] = (layerCounts[item.level] || 0) + 1
              }
            }
            if (since && mtime && since === mtime) {
              return send(res, 200, { ok: true, unchanged: true, mtime, scope: 'all', workspaceName: '全部工作区', total: items.length })
            }
            return send(res, 200, {
              ok: true,
              scope: 'all',
              workspace: '__all__',
              workspaceName: '全部工作区',
              mtime,
              generatedAt: Date.now(),
              includeAll,
              total: items.length,
              layerCounts,
              layers: LAYERS,
              items,
            })
          }
          // Only paths we discovered may be read: never accept an arbitrary dir.
          const target = dir ? workspaces.find((w) => w.path === dir) : workspaces[0]
          if (!target) {
            return send(res, 200, { ok: false, error: '未找到 meow-memory 记忆库', workspaces })
          }
          const payload = readMemories(target.path, includeAll)
          if (!payload) return send(res, 404, { ok: false, error: '记忆库已不存在' })
          if (since && payload.mtime && since === payload.mtime) {
            return send(res, 200, { ok: true, unchanged: true, mtime: payload.mtime, workspaceName: payload.workspaceName, total: payload.total })
          }
          send(res, 200, payload)
        } catch (error) {
          send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      })()
    }],
  ]

  let timer = 0
  const register = (attempt) => {
    const webServer = ctx?.get?.('webServer')
    if (webServer && typeof webServer.register === 'function') {
      for (const [path, handler] of routes) {
        try {
          const mount = () => webServer.register({ kind: 'exact', path, handler })
          if (typeof ctx.effect === 'function') ctx.effect(mount, `meow-constellation: GET ${path}`)
          else mount()
        } catch (error) {
          log(`meow-constellation: route ${path} 注册失败: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      log('meow-constellation: 星图页面与记忆 API 已注册')
      return
    }
    if (attempt < 20) timer = setTimeout(() => register(attempt + 1), 1000)
    else log('meow-constellation: webServer 20s 内未就绪，星图入口未注册')
  }
  register(0)
  return () => clearTimeout(timer)
}
