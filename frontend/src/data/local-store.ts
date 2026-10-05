import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'shield-tunnel-construction:entries'
// 与业务条目分开存放的杂项（迁移版本等），避免和模块 key 混在一起。
const META_KEY = 'shield-tunnel-construction:meta'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

function readMeta(): Record<string, string | number | boolean> {
  if (typeof window === 'undefined' || !window.localStorage) {
    return {}
  }
  const raw = window.localStorage.getItem(META_KEY)
  if (!raw) {
    return {}
  }
  try {
    return JSON.parse(raw) as Record<string, string | number | boolean>
  } catch {
    return {}
  }
}

export function getMeta(key: string): string | number | boolean | undefined {
  return readMeta()[key]
}

export function setMeta(key: string, value: string | number | boolean): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  window.localStorage.setItem(META_KEY, JSON.stringify({ ...readMeta(), [key]: value }))
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  commitEntries({ [key]: rows })
}

// 多模块事务：一次动作要同时落 muck / safety / ring 三处，先整体写 localStorage，
// 写失败（配额、序列化异常等）恢复快照，缓存也不更新——落库不成就整套撤回。
export function commitEntries(patch: Record<string, EntryRow[]>): { ok: boolean; error?: string } {
  const base = allRows()
  const snapshot = clone(base)
  const next = { ...base, ...patch }
  if (typeof window === 'undefined' || !window.localStorage) {
    cache = next
    return { ok: true }
  }
  try {
    const raw = JSON.stringify(next)
    // 先落盘后改缓存：落盘抛错时缓存仍指向旧数据，调用方读到的一定是一致状态。
    window.localStorage.setItem(STORAGE_KEY, raw)
    cache = next
    return { ok: true }
  } catch (error) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
    } catch {
      // 回滚也落不下去时只能让缓存保持旧值，交给下次刷新从磁盘恢复。
    }
    cache = snapshot
    return { ok: false, error: error instanceof Error ? error.message : '本地存储写入失败' }
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
