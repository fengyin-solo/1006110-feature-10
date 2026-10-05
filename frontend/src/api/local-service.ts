import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveAll, saveRows } from '@/data/local-store'
import type {
  ActionResult,
  EntryRow,
  ModuleMeta,
  MuckBoardCard,
  MuckBoardColumn,
  MuckBoardResult,
  OperatorInfo,
  OverviewResult,
  PageResult,
  RetentionReconcile,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  // 渣土外运的「确认消纳 / 登记滞留」要联动掘进环次与安全巡检，统一收进联动服务，
  // 不管从看板卡片还是列表按钮进来，走的都是同一份数据、同一套口径。
  if (key === 'muck') {
    if (action === '确认消纳') {
      return confirmMuckDisposal(id)
    }
    if (action === '登记滞留') {
      return registerMuckRetention(id)
    }
  }
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

/* ------------------------------------------------------------------------ */
/* 渣土外运看板：分栏、确认消纳回写环次、滞留同步隐患台账、存量迁移。          */
/* 联动写一律「先在内存算完整套，再一次 saveAll 原子落库」，落库失败整套撤回。 */
/* ------------------------------------------------------------------------ */

/** 存量单缺车队时统一归入本车队，调度权限按这个字段卡。 */
const DEFAULT_FLEET = '渣土一队'
/** 同日期、全局都参考不到消纳场所时的兜底场所。 */
const FALLBACK_SITE = '待定消纳场'
/** 滞留隐患给现场留的整改天数。 */
const HAZARD_RECTIFY_DAYS = 7

function toVolume(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** 外运时段形如「2026-09-29 早班」，取前 10 位作为外运日期，迁移分组按它来。 */
function shiftDate(row: EntryRow): string {
  return String(row['外运时段'] ?? '').slice(0, 10)
}

function siteOf(row: EntryRow): string {
  return String(row['消纳场所'] ?? '').trim()
}

/** 空串、占位符（旧数据里的「渣土外运样例N」）都视为缺消纳场所，需要迁移回填。 */
function isSiteMissing(site: string): boolean {
  return site === '' || site === '—' || site.includes('样例')
}

function plusDays(days: number): string {
  const date = new Date()
  date.setDate(date.getDate() + days)
  return date.toISOString().slice(0, 10)
}

/**
 * 存量运输单迁移：按外运日期分组回填。
 * 缺消纳场所的补齐规则——先抄同外运日期其他单出现次数最多的场所；
 * 当天没有可参考的，再抄全局最常去的场所；都没有才落到「待定消纳场」。
 * 缺车队的一律补默认车队；方量不是数字的记 0 并在报告里点名。
 */
function migrateMuckRows(rows: EntryRow[]): { rows: EntryRow[]; report: string[] } {
  const report: string[] = []
  const siteCount = (list: EntryRow[]): Map<string, number> => {
    const counts = new Map<string, number>()
    for (const row of list) {
      const site = siteOf(row)
      if (!isSiteMissing(site)) {
        counts.set(site, (counts.get(site) ?? 0) + 1)
      }
    }
    return counts
  }
  const topSite = (counts: Map<string, number>): string | null => {
    let best: string | null = null
    let bestCount = 0
    for (const [site, count] of counts) {
      if (count > bestCount || (count === bestCount && best !== null && site < best)) {
        best = site
        bestCount = count
      }
    }
    return best
  }
  const globalTop = topSite(siteCount(rows))
  const migrated = rows.map((row) => {
    const next = { ...row }
    const 单号 = String(row['运输单号'] ?? `#${row.id}`)
    if (!String(next['车队'] ?? '').trim()) {
      next['车队'] = DEFAULT_FLEET
      report.push(`存量迁移：${单号} 缺车队，归入默认车队「${DEFAULT_FLEET}」`)
    }
    const site = siteOf(next)
    if (isSiteMissing(site)) {
      const sameDay = rows.filter(
        (item) => item !== row && shiftDate(item) === shiftDate(row) && !isSiteMissing(siteOf(item)),
      )
      const filled = topSite(siteCount(sameDay)) ?? globalTop ?? FALLBACK_SITE
      next['消纳场所'] = filled
      next['场所回填'] = '是'
      const basis = sameDay.length > 0 ? `同外运日期（${shiftDate(row)}）多数单去向` : '全局最常用场所/兜底'
      report.push(`存量迁移：${单号} 缺消纳场所，按${basis}回填为「${filled}」`)
    }
    if (!Number.isFinite(Number(next['渣土方量']))) {
      next['渣土方量'] = 0
      report.push(`存量迁移：${单号} 渣土方量不是数字，按 0 入账，请人工复核`)
    } else {
      next['渣土方量'] = toVolume(next['渣土方量'])
    }
    return next
  })
  return { rows: migrated, report }
}

/**
 * 环次出土方量核对清单的唯一口径：某环「已消纳方量」= 该环所有已消纳运输单的方量之和。
 * 每次全量重算、整体覆盖，不做增量累加——环次页面读到的永远只有一个数，
 * 同一运输单重复确认消纳也不会重复入账。
 */
function recalcRingDisposed(ringRows: EntryRow[], muckRows: EntryRow[]): EntryRow[] {
  const disposedByRing = new Map<string, number>()
  for (const row of muckRows) {
    if (String(row.status) !== '已消纳') {
      continue
    }
    const ring = String(row['对应环号'] ?? '').trim()
    if (!ring) {
      continue
    }
    disposedByRing.set(ring, (disposedByRing.get(ring) ?? 0) + toVolume(row['渣土方量']))
  }
  return ringRows.map((row) => ({
    ...row,
    已消纳方量: disposedByRing.get(String(row['环号'] ?? '').trim()) ?? 0,
  }))
}

function buildHazardRow(muckRow: EntryRow, id: number): EntryRow {
  const 单号 = String(muckRow['运输单号'])
  const 场所 = siteOf(muckRow)
  return {
    id,
    status: '待整改',
    pending: true,
    abnormal: false,
    巡检编号: `SAFE-${单号}`,
    巡检区域: `渣土外运·${场所}`,
    巡检项目: '渣土车滞留',
    发现问题: `运输单${单号}（${String(muckRow['运输车辆'])}）滞留于${场所}`,
    隐患等级: '一般隐患',
    整改期限: plusDays(HAZARD_RECTIFY_DAYS),
    巡检人员: '现场签认',
    巡检状态: '待整改',
    关联运输单: 单号,
    现场签认: '已签认',
    来源: '渣土外运滞留同步',
  }
}

/**
 * 滞留车次 → 安全巡检隐患台账：每辆滞留车挂一条待整改隐患，按运输单号去重，
 * 重复登记只更新不新增。台账里已有的记录（尤其现场签认过的）原样保留，
 * 只补不删——两处条数对不上时以现场签认的记录为准。
 */
function syncRetentionHazards(
  safetyRows: EntryRow[],
  muckRows: EntryRow[],
): { rows: EntryRow[]; added: string[] } {
  const added: string[] = []
  const linked = new Set(
    safetyRows.map((row) => String(row['关联运输单'] ?? '')).filter((no) => no !== ''),
  )
  let nextId = safetyRows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const next = [...safetyRows]
  for (const row of muckRows) {
    if (String(row.status) !== '已滞留') {
      continue
    }
    const 单号 = String(row['运输单号'])
    if (linked.has(单号)) {
      continue
    }
    next.push(buildHazardRow(row, nextId))
    nextId += 1
    linked.add(单号)
    added.push(单号)
  }
  return { rows: next, added }
}

/** 滞留解除（确认消纳）时，把该单挂着的隐患一并闭环。 */
function closeHazardsFor(safetyRows: EntryRow[], 单号: string): EntryRow[] {
  return safetyRows.map((row) =>
    String(row['关联运输单'] ?? '') === 单号 && String(row.status) !== '已闭环'
      ? { ...row, status: '已闭环', pending: false, 巡检状态: '已闭环' }
      : row,
  )
}

function buildReconcile(safetyRows: EntryRow[], muckRows: EntryRow[]): RetentionReconcile {
  const retained = new Set(
    muckRows.filter((row) => String(row.status) === '已滞留').map((row) => String(row['运输单号'])),
  )
  const openHazards = safetyRows.filter((row) => String(row.status) === '待整改')
  const linkedOpen = openHazards.filter((row) => String(row['关联运输单'] ?? '') !== '')
  const fieldSignedExtra = openHazards.filter((row) => {
    const 单号 = String(row['关联运输单'] ?? '')
    return String(row['现场签认'] ?? '') === '已签认' && (单号 === '' || !retained.has(单号))
  })
  const 一致 = linkedOpen.length === retained.size && fieldSignedExtra.length === 0
  const 说明 = 一致
    ? `滞留 ${retained.size} 车次与隐患台账 ${linkedOpen.length} 条一一对应`
    : `滞留 ${retained.size} 车次、台账待整改 ${linkedOpen.length} 条` +
      (fieldSignedExtra.length > 0 ? `，另有现场签认 ${fieldSignedExtra.length} 条` : '') +
      '，条数对不上，以现场签认的记录为准'
  return {
    滞留车次: retained.size,
    台账待整改: linkedOpen.length,
    现场签认额外记录: fieldSignedExtra.length,
    一致,
    说明,
  }
}

/** 确认消纳：运输单 → 已消纳，回写环次已消纳方量，闭环对应滞留隐患；幂等，重复确认只算一次。 */
export function confirmMuckDisposal(id: number): ActionResult {
  const muckRows = listRows('muck')
  const index = muckRows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的渣土运输单` }
  }
  const row = muckRows[index]
  const 单号 = String(row['运输单号'] ?? `#${id}`)
  const status = String(row.status)
  if (status === '已消纳') {
    return { ok: true, message: `${单号} 已确认过消纳，本次不重复入账` }
  }
  if (status === '待装车') {
    return { ok: false, message: `${单号} 尚未安排装车发运，不能确认消纳` }
  }
  const nextMuck = [...muckRows]
  nextMuck[index] = { ...row, status: '已消纳', pending: false, abnormal: false, 运输状态: '已消纳' }
  const nextRing = recalcRingDisposed(listRows('ring'), nextMuck)
  const nextSafety = closeHazardsFor(listRows('safety'), 单号)
  try {
    saveAll({ muck: nextMuck, ring: nextRing, safety: nextSafety })
  } catch (error) {
    return {
      ok: false,
      message: `落库失败，本次确认已整套撤回：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  const 环号 = String(row['对应环号'] ?? '').trim()
  const ringRow = nextRing.find((item) => String(item['环号'] ?? '').trim() === 环号)
  const 回写 = ringRow ? `，环号 ${环号} 已消纳方量回写为 ${String(ringRow['已消纳方量'])} m³` : ''
  return { ok: true, message: `${单号} 已确认消纳${回写}` }
}

/** 登记滞留：运输单 → 已滞留，同步一条安全隐患到巡检台账；幂等，重复登记只挂一条。 */
export function registerMuckRetention(id: number): ActionResult {
  const muckRows = listRows('muck')
  const index = muckRows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的渣土运输单` }
  }
  const row = muckRows[index]
  const 单号 = String(row['运输单号'] ?? `#${id}`)
  const status = String(row.status)
  if (status === '已滞留') {
    return { ok: true, message: `${单号} 已是滞留状态，隐患台账不重复挂号` }
  }
  if (status === '已消纳') {
    return { ok: false, message: `${单号} 已确认消纳，不能再登记滞留` }
  }
  if (status === '待装车') {
    return { ok: false, message: `${单号} 尚未装车发运，车辆不在消纳现场，不能登记滞留` }
  }
  const nextMuck = [...muckRows]
  nextMuck[index] = { ...row, status: '已滞留', pending: true, abnormal: true, 运输状态: '已滞留' }
  const synced = syncRetentionHazards(listRows('safety'), [nextMuck[index]])
  try {
    saveAll({ muck: nextMuck, safety: synced.rows })
  } catch (error) {
    return {
      ok: false,
      message: `落库失败，本次滞留登记已整套撤回：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  return { ok: true, message: `${单号} 已登记滞留，安全隐患已同步到巡检台账` }
}

/** 改运输车辆 / 押运人员：只有本车队调度能改，别的车队只能查看，越权当场拒绝。 */
export function updateMuckAssignment(
  id: number,
  patch: { 运输车辆?: string; 押运人员?: string },
  operator: OperatorInfo,
): ActionResult {
  const rows = listRows('muck')
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的渣土运输单` }
  }
  const row = rows[index]
  const 单号 = String(row['运输单号'] ?? `#${id}`)
  if (operator.role !== '调度') {
    return { ok: false, message: `越权拒绝：${operator.name} 不是调度，不能改运输车辆与押运人员` }
  }
  const owner = String(row['车队'] ?? '').trim() || DEFAULT_FLEET
  if (owner !== operator.fleet) {
    return { ok: false, message: `越权拒绝：${单号} 属于${owner}，只有本车队调度能改，${operator.fleet} 只能查看` }
  }
  const 车辆 = (patch.运输车辆 ?? '').trim()
  const 押运 = (patch.押运人员 ?? '').trim()
  if (!车辆 && !押运) {
    return { ok: false, message: '没有填写要修改的运输车辆或押运人员' }
  }
  const next = [...rows]
  next[index] = {
    ...row,
    ...(车辆 ? { 运输车辆: 车辆 } : {}),
    ...(押运 ? { 押运人员: 押运 } : {}),
  }
  saveRows('muck', next)
  return { ok: true, message: `${单号} 已更新${车辆 ? `运输车辆为 ${车辆}` : ''}${车辆 && 押运 ? '，' : ''}${押运 ? `押运人员为 ${押运}` : ''}` }
}

/**
 * 渣土外运看板：先迁移存量单、再同步滞留隐患、重算环次已消纳方量，
 * 有改动就一次原子落库，然后输出分栏与概览。看板、掘进环次、安全巡检
 * 三处读的都是同一份本地数据。
 */
export function loadMuckBoard(): MuckBoardResult {
  const migration: string[] = []
  const migrated = migrateMuckRows(listRows('muck'))
  migration.push(...migrated.report)
  const synced = syncRetentionHazards(listRows('safety'), migrated.rows)
  for (const 单号 of synced.added) {
    migration.push(`隐患同步：为滞留单 ${单号} 补挂安全隐患 SAFE-${单号}`)
  }
  const nextRing = recalcRingDisposed(listRows('ring'), migrated.rows)
  const ringChanged = JSON.stringify(nextRing) !== JSON.stringify(listRows('ring'))
  const changed =
    JSON.stringify(migrated.rows) !== JSON.stringify(listRows('muck')) ||
    JSON.stringify(synced.rows) !== JSON.stringify(listRows('safety')) ||
    ringChanged
  if (changed) {
    try {
      saveAll({ muck: migrated.rows, safety: synced.rows, ring: nextRing })
      if (ringChanged) {
        migration.push('环次核对：已按运输单重算各环已消纳方量')
      }
    } catch {
      migration.push('迁移落库失败，本次迁移已整套撤回，看板按原数据展示')
    }
  }
  const muckRows = listRows('muck')
  const safetyRows = listRows('safety')

  const shiftMap = new Map<string, { 车次: number; 方量合计: number }>()
  for (const row of muckRows) {
    const shift = String(row['外运时段'] ?? '').trim() || '未排时段'
    const bucket = shiftMap.get(shift) ?? { 车次: 0, 方量合计: 0 }
    bucket.车次 += 1
    bucket.方量合计 += toVolume(row['渣土方量'])
    shiftMap.set(shift, bucket)
  }
  const overview = [...shiftMap.entries()]
    .map(([外运时段, bucket]) => ({ 外运时段, ...bucket }))
    .sort((a, b) => a.外运时段.localeCompare(b.外运时段))

  const columnMap = new Map<string, MuckBoardCard[]>()
  for (const row of muckRows) {
    const site = siteOf(row) || FALLBACK_SITE
    const card: MuckBoardCard = {
      id: Number(row.id),
      运输单号: String(row['运输单号'] ?? ''),
      渣土方量: toVolume(row['渣土方量']),
      运输车辆: String(row['运输车辆'] ?? ''),
      押运人员: String(row['押运人员'] ?? ''),
      车队: String(row['车队'] ?? ''),
      状态: String(row.status),
      滞留: String(row.status) === '已滞留',
    }
    const list = columnMap.get(site) ?? []
    list.push(card)
    columnMap.set(site, list)
  }
  const columns: MuckBoardColumn[] = [...columnMap.entries()]
    .map(([消纳场所, cards]) => {
      // 滞留车次标红并提到栏内最前，其余按运输单号排。
      const ordered = [...cards].sort((a, b) =>
        a.滞留 === b.滞留 ? a.运输单号.localeCompare(b.运输单号) : a.滞留 ? -1 : 1,
      )
      return {
        消纳场所,
        车次: ordered.length,
        滞留车次: ordered.filter((card) => card.滞留).length,
        方量合计: ordered.reduce((sum, card) => sum + card.渣土方量, 0),
        cards: ordered,
      }
    })
    .sort((a, b) => b.滞留车次 - a.滞留车次 || b.车次 - a.车次 || a.消纳场所.localeCompare(b.消纳场所))

  return { overview, columns, reconcile: buildReconcile(safetyRows, muckRows), migration }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
