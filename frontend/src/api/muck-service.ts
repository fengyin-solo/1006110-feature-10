import { commitEntries, getMeta, listRows, setMeta } from '@/data/local-store'
import { SEED_ROWS } from '@/data/seed'
import type { ActionResult, EntryRow } from '@/data/types'

// 渣土外运看板的跨模块编排都收在这一份里：
// muck（运输单，事实源）/ safety（隐患台账，滞留同步）/ ring（环次核对清单，已消纳方量只读派生）。
// 页面只渲染、不做业务判断；两个入口（看板、清单）都从这里取同一份数据。

export const MUCK_KEY = 'muck'
export const RING_KEY = 'ring'
export const SAFETY_KEY = 'safety'

export type MuckStatus = '待装车' | '运输中' | '已消纳' | '已滞留'
const DETAINED: MuckStatus = '已滞留'
const DISPOSED: MuckStatus = '已消纳'
const LAST_STATUS: MuckStatus = '已滞留'

// 定点消纳场轮排表 + 兜底场；存量单据缺消纳场所时按外运日期补齐。
export const PLANNED_SITES = ['南山渣土消纳场', '北港渣土消纳场', '西岭渣土消纳场'] as const
export const FALLBACK_SITE = '东桥综合消纳场'

export const FLEETS = ['盾构一队', '盾构二队'] as const

export type Actor = {
  name: string
  fleet: string
  role: '调度' | '值班员'
}

export type PeriodSummary = {
  period: string
  date: string
  shift: string
  trips: number
  volume: number
  disposedTrips: number
  disposedVolume: number
  detainedTrips: number
}

export type SiteColumn = {
  site: string
  fallback: boolean
  orders: EntryRow[]
  trips: number
  volume: number
  detainedTrips: number
}

export type RingChecklistRow = {
  ring: EntryRow
  plannedVolume: number
  disposedVolume: number
  diff: number
  status: string
  result: string
  lastConfirmTime: string
  orders: EntryRow[]
}

export type ReconcileReport = {
  synced: number
  closed: number
  ringUpdates: number
  message: string
}

export type MigrationReport = {
  ran: boolean
  replacedSeed: boolean
  orders: number
  siteBackfilled: number
  hazardSynced: number
  ringsChecked: number
  rules: string[]
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function text(row: EntryRow, field: string): string {
  const value = row[field]
  return value === undefined || value === null ? '' : String(value)
}

export function volumeOf(row: EntryRow): number {
  const value = Number(row['渣土方量'])
  return Number.isFinite(value) && value > 0 ? value : 0
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function dayOfYear(date: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date)
  if (!match) {
    return 0
  }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  let ordinal = day
  for (let i = 0; i < month - 1; i += 1) {
    ordinal += daysInMonth[i]
  }
  return ordinal
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

export function todayLabel(): string {
  const now = new Date()
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
}

export function formatTime(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`
}

// 从“外运时段/外运日期”里拆出外运日期与班次，存量数据只有日期时默认按白班处理。
export function parsePeriod(row: EntryRow): { date: string; shift: string } {
  const explicitDate = text(row, '外运日期')
  const period = text(row, '外运时段')
  const match = /^(\d{4}-\d{2}-\d{2})(?:\s*(白班|夜班))?/.exec(period)
  const date = explicitDate || (match ? match[1] : '')
  let shift = text(row, '班次') || (match && match[2] ? match[2] : '')
  if (!shift) {
    shift = '白班'
  }
  return { date, shift }
}

// 消纳场所补齐规则：
// 1) 白班按外运日期在当年的序次，在三个定点场轮排；夜班序次顺延 1；
// 2) 序号落不到定点场（日期解析失败等）时，统一补到兜底场“东桥综合消纳场”；
// 3) 程序补齐的场所一律挂“待核”，由现场签认后才算确认。
export function plannedSiteFor(date: string, shift: string): { site: string; fallback: boolean } {
  const ordinal = dayOfYear(date)
  if (!ordinal) {
    return { site: FALLBACK_SITE, fallback: true }
  }
  const index = (ordinal + (shift === '夜班' ? 1 : 0) - 1) % PLANNED_SITES.length
  return { site: PLANNED_SITES[index], fallback: false }
}

export function isDetained(row: EntryRow): boolean {
  return text(row, 'status') === DETAINED
}

export function isDisposed(row: EntryRow): boolean {
  return text(row, 'status') === DISPOSED
}

// ---------------------------------------------------------------------------
// 取数（两个入口共用）
// ---------------------------------------------------------------------------

export function muckOrders(): EntryRow[] {
  return listRows(MUCK_KEY)
}

export function periodSummaries(orders: EntryRow[] = muckOrders()): PeriodSummary[] {
  const map = new Map<string, PeriodSummary>()
  for (const row of orders) {
    const { date, shift } = parsePeriod(row)
    const period = text(row, '外运时段') || `${date} ${shift}`.trim()
    let item = map.get(period)
    if (!item) {
      item = { period, date, shift, trips: 0, volume: 0, disposedTrips: 0, disposedVolume: 0, detainedTrips: 0 }
      map.set(period, item)
    }
    item.trips += 1
    item.volume += volumeOf(row)
    if (isDisposed(row)) {
      item.disposedTrips += 1
      item.disposedVolume += volumeOf(row)
    }
    if (isDetained(row)) {
      item.detainedTrips += 1
    }
  }
  return [...map.values()].sort((a, b) =>
    a.date === b.date
      ? a.shift === b.shift
        ? 0
        : a.shift === '白班'
          ? -1
          : 1
      : a.date < b.date
        ? -1
        : 1,
  )
}

// 按消纳场所分栏：定点场固定出场且顺序固定，程序补的兜底场单列；栏内滞留车次提到最前并标红，
// 其余按外运时段、运输单号排序。
export function siteColumns(orders: EntryRow[] = muckOrders()): SiteColumn[] {
  const map = new Map<string, SiteColumn>()
  for (const site of PLANNED_SITES) {
    map.set(site, { site, fallback: false, orders: [], trips: 0, volume: 0, detainedTrips: 0 })
  }
  for (const row of orders) {
    let site = text(row, '消纳场所')
    let fallback = false
    if (!site) {
      site = FALLBACK_SITE
      fallback = true
    }
    let column = map.get(site)
    if (!column) {
      column = { site, fallback, orders: [], trips: 0, volume: 0, detainedTrips: 0 }
      map.set(site, column)
    }
    column.orders.push(row)
  }
  const columns = [...map.values()]
  for (const column of columns) {
    column.orders.sort((a, b) => {
      const detainedDiff = Number(isDetained(b)) - Number(isDetained(a))
      if (detainedDiff !== 0) {
        return detainedDiff
      }
      const periodA = text(a, '外运时段')
      const periodB = text(b, '外运时段')
      if (periodA !== periodB) {
        return periodA < periodB ? -1 : 1
      }
      return text(a, '运输单号') < text(b, '运输单号') ? -1 : 1
    })
    column.trips = column.orders.length
    column.volume = column.orders.reduce((sum, row) => sum + volumeOf(row), 0)
    column.detainedTrips = column.orders.filter(isDetained).length
  }
  // 定点场在前，兜底/其他场在后；空的兜底场也保留，提示存在未补场所的单据。
  columns.sort((a, b) => {
    const indexA = PLANNED_SITES.indexOf(a.site as (typeof PLANNED_SITES)[number])
    const indexB = PLANNED_SITES.indexOf(b.site as (typeof PLANNED_SITES)[number])
    if (indexA !== -1 && indexB !== -1) {
      return indexA - indexB
    }
    if (indexA !== -1) {
      return -1
    }
    if (indexB !== -1) {
      return 1
    }
    return a.site < b.site ? -1 : 1
  })
  return columns
}

// 环次「已消纳方量」的唯一出口：环次页和核对清单都调它，库里不存第二份方量。
export function disposedVolumeByRing(orders: EntryRow[] = muckOrders()): Map<string, number> {
  const totals = new Map<string, number>()
  for (const row of orders) {
    if (!isDisposed(row)) {
      continue
    }
    const ringNo = text(row, '对应环号')
    if (!ringNo) {
      continue
    }
    totals.set(ringNo, (totals.get(ringNo) ?? 0) + volumeOf(row))
  }
  return totals
}

function ringCheckResult(planned: number, disposed: number, hasOpenOrders: boolean): { status: string; result: string } {
  if (disposed === 0) {
    return { status: '待外运', result: '待外运' }
  }
  if (disposed === planned) {
    return { status: hasOpenOrders ? '核对中' : '已核对', result: hasOpenOrders ? '方量已齐，待全部确认' : '核对一致' }
  }
  if (disposed < planned) {
    return { status: '核对中', result: hasOpenOrders ? '外运核对中' : '方量不足' }
  }
  return { status: '核对异常', result: '已消纳超出土' }
}

// 环次出土方量核对清单：方量全部由运输单实时派生，回写的只有核对状态/时间/最近签认号。
export function ringChecklist(): RingChecklistRow[] {
  const orders = muckOrders()
  const totals = disposedVolumeByRing(orders)
  return listRows(RING_KEY).map((ring) => {
    const ringNo = text(ring, '环号')
    const ringOrders = orders
      .filter((row) => text(row, '对应环号') === ringNo)
      .sort((a, b) => (text(a, '运输单号') < text(b, '运输单号') ? -1 : 1))
    const planned = Number(ring['出土方量']) || 0
    const disposed = totals.get(ringNo) ?? 0
    const hasOpenOrders = ringOrders.some((row) => !isDisposed(row))
    const derived = ringCheckResult(planned, disposed, hasOpenOrders)
    const confirmed = ringOrders
      .filter(isDisposed)
      .sort((a, b) => (text(a, '消纳时间') < text(b, '消纳时间') ? 1 : -1))
    return {
      ring,
      plannedVolume: planned,
      disposedVolume: disposed,
      diff: disposed - planned,
      // 核对状态随运输单实时计算，库里的“核对状态”只是回写痕迹，二者同源不会出现两个数。
      status: derived.status,
      result: derived.result,
      lastConfirmTime: confirmed[0] ? text(confirmed[0], '消纳时间') : '',
      orders: ringOrders,
    }
  })
}

// ---------------------------------------------------------------------------
// 安全隐患台账同步（以现场签认的运输单为准）
// ---------------------------------------------------------------------------

const SOURCE_FIELD = '来源模块'
const SOURCE_MUCK = '渣土外运'
const SOURCE_NO_FIELD = '来源运输单'

export function detainedHazardRow(order: EntryRow): EntryRow {
  const site = text(order, '消纳场所') || FALLBACK_SITE
  const signNo = text(order, '滞留签认')
  return {
    id: -1,
    status: '待整改',
    pending: true,
    abnormal: true,
    巡检编号: `SAFE-${text(order, '运输单号')}`,
    巡检区域: `${site}（渣土车滞留）`,
    巡检项目: '渣土车滞留在场',
    发现问题: `运输单 ${text(order, '运输单号')}（${text(order, '运输车辆') || '车辆未派'}，押运 ${text(order, '押运人员') || '未派'}）在 ${site} 滞留在场，需核实处置`,
    隐患等级: '一般',
    整改期限: text(order, '外运日期') || todayLabel(),
    巡检人员: text(order, '押运人员') || '现场值班',
    巡检状态: '待整改',
    [SOURCE_FIELD]: SOURCE_MUCK,
    [SOURCE_NO_FIELD]: text(order, '运输单号'),
    滞留签认号: signNo,
  }
}

function nextSafetyId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

// 滞留车次同步 + 核对：现场签认的运输单是权威记录。
// 滞留且签认的单据在安全台账里必须有一条待整改隐患（按来源运输单号去重，重复提交只计一次）；
// 单据已消纳或查无此单的同步隐患，以现场签认为准自动闭环；逐条核对，条数自然对上。
export function reconcileSafety(
  orders: EntryRow[] = muckOrders(),
  safetyRows: EntryRow[] = listRows(SAFETY_KEY),
): { safety: EntryRow[]; synced: number; closed: number } {
  const safety = clone(safetyRows)
  let synced = 0
  let closed = 0
  const orderByNo = new Map(orders.map((row) => [text(row, '运输单号'), row]))

  // 先处理已存在的同步条目：该关的关掉；来源车再次滞留时把已闭环条目重新挂起（一次滞留一条隐患）。
  for (const row of safety) {
    if (text(row, SOURCE_FIELD) !== SOURCE_MUCK) {
      continue
    }
    const sourceNo = text(row, SOURCE_NO_FIELD)
    const source = orderByNo.get(sourceNo)
    const shouldStayOpen = source ? isDetained(source) && !!text(source, '滞留签认') : false
    if (shouldStayOpen) {
      if (text(row, 'status') === '已闭环') {
        row.status = '待整改'
        row.pending = true
        row.abnormal = true
        row['巡检状态'] = '待整改'
        row['闭环依据'] = ''
        row['滞留签认号'] = source ? text(source, '滞留签认') : ''
        synced += 1
      }
      continue
    }
    if (text(row, 'status') !== '已闭环') {
      row.status = '已闭环'
      row.pending = false
      row.abnormal = false
      row['巡检状态'] = '已闭环'
      row['闭环依据'] = source
        ? isDisposed(source)
          ? `运输单 ${sourceNo} 已消纳，签认号 ${text(source, '消纳签认号') || '—'}`
          : `运输单 ${sourceNo} 现场已解除滞留`
        : `运输单 ${sourceNo} 查无现场签认记录，按现场签认为准闭环`
      closed += 1
    }
  }

  // 只把仍待整改的同步条目算作占用，已闭环的不阻止同一运输单再次滞留时挂新隐患。
  const openLinks = new Set(
    safety
      .filter((row) => text(row, SOURCE_FIELD) === SOURCE_MUCK && text(row, 'status') !== '已闭环')
      .map((row) => text(row, SOURCE_NO_FIELD)),
  )
  for (const order of orders) {
    const orderNo = text(order, '运输单号')
    if (!isDetained(order) || !text(order, '滞留签认') || openLinks.has(orderNo)) {
      continue
    }
    // 该运输单曾滞留但旧条目都已闭环（解除后重新滞留）：新签认另挂一条，保留旧闭环痕迹。
    const row = detainedHazardRow(order)
    row.id = nextSafetyId(safety)
    safety.push(row)
    openLinks.add(orderNo)
    synced += 1
  }
  return { safety, synced, closed }
}

// 运输单状态变化后，把环次核对清单的状态/时间/最近签认号回写到对应环次。
// 注意：这里不回写方量，已消纳方量始终实时派生，环次那边读不到两个数。
function refreshRingChecklist(
  orders: EntryRow[],
  ringRows: EntryRow[],
): { rings: EntryRow[]; updates: number } {
  const totals = disposedVolumeByRing(orders)
  const rings = clone(ringRows)
  let updates = 0
  for (const ring of rings) {
    const ringNo = text(ring, '环号')
    const ringOrders = orders.filter((row) => text(row, '对应环号') === ringNo)
    const planned = Number(ring['出土方量']) || 0
    const disposed = totals.get(ringNo) ?? 0
    const hasOpenOrders = ringOrders.some((row) => !isDisposed(row))
    const derived = ringCheckResult(planned, disposed, hasOpenOrders)
    const confirmed = ringOrders.filter(isDisposed)
    const times = confirmed.map((row) => text(row, '消纳时间')).sort()
    const signs = confirmed.map((row) => text(row, '消纳签认号')).sort()
    const lastTime = times.length ? times[times.length - 1] : ''
    const lastSign = signs.length ? signs[signs.length - 1] : ''
    const next: Record<string, string> = {
      核对状态: derived.status,
      核对结果: derived.result,
      最近消纳时间: lastTime,
      最近消纳签认号: lastSign,
    }
    for (const [field, value] of Object.entries(next)) {
      if (text(ring, field) !== value) {
        ring[field] = value
        updates += 1
      }
    }
  }
  return { rings, updates }
}

// 三处数据一起落库的内部事务：任一落库失败整套撤回，调用方拿到的还是旧数据。
function commitAll(orders: EntryRow[], safety: EntryRow[], rings: EntryRow[]): ActionResult {
  const result = commitEntries({ [MUCK_KEY]: orders, [SAFETY_KEY]: safety, [RING_KEY]: rings })
  if (!result.ok) {
    return { ok: false, message: `落库失败，已整套撤回：${result.error ?? '未知原因'}` }
  }
  return { ok: true, message: '' }
}

function findOrder(orders: EntryRow[], id: number): EntryRow | undefined {
  return orders.find((row) => Number(row.id) === id)
}

function assertDispatch(actor: Actor | null, order: EntryRow, action: string): ActionResult | null {
  if (!actor) {
    return { ok: false, message: '未取得当前值班身份，操作已拒绝' }
  }
  if (actor.role !== '调度') {
    return { ok: false, message: `只有本车队调度才能${action}：${actor.name} 是${actor.role}，当场拒绝` }
  }
  const fleet = text(order, '所属车队')
  if (fleet && actor.fleet !== fleet) {
    return { ok: false, message: `越权改动当场拒绝：运输单 ${text(order, '运输单号')} 属${fleet}，${actor.fleet}只能查看` }
  }
  return null
}

function patchStatus(order: EntryRow, status: MuckStatus): void {
  order.status = status
  // pending / abnormal 与既有存储约定保持一致：最后一个状态不再待处理，滞留挂异常。
  order.pending = status !== LAST_STATUS
  order.abnormal = status === DETAINED
  order['运输状态'] = status
}

// ---------------------------------------------------------------------------
// 运输单流转（幂等 + 事务 + 越权拦截）
// ---------------------------------------------------------------------------

// 确认消纳：①运输单标已消纳并落签认号 → ②同步隐患台账（滞留隐患自动闭环）→ ③回写环次核对清单。
// 顺序由本函数裁决：先改事实源，再同步两边；同一运输单重复确认只算一次。
export function confirmDisposal(id: number, actor: Actor | null): ActionResult {
  const orders = clone(muckOrders())
  const order = findOrder(orders, id)
  if (!order) {
    return { ok: false, message: `没有找到编号为 ${id} 的渣土运输单` }
  }
  const denied = assertDispatch(actor, order, '确认消纳')
  if (denied) {
    return denied
  }
  if (isDisposed(order)) {
    // 幂等：重复点两回只落一条，直接报已有签认，不再写库。
    return { ok: false, message: `运输单 ${text(order, '运输单号')} 已消纳（签认号 ${text(order, '消纳签认号') || '—'}），重复确认只算一次` }
  }

  patchStatus(order, DISPOSED)
  const time = formatTime()
  order['消纳时间'] = time
  order['消纳签认号'] = text(order, '消纳签认号') || `QR-${time.replace(/[-: ]/g, '').slice(0, 12)}-${id}`
  order['滞留签认'] = ''

  const { safety } = reconcileSafety(orders)
  const { rings } = refreshRingChecklist(orders, listRows(RING_KEY))
  return commitAll(orders, safety, rings)
}

// 登记滞留：现场滞留签认后，运输单标滞留并在安全巡检隐患台账挂一条待整改隐患。
export function registerDetained(id: number, actor: Actor | null): ActionResult {
  const orders = clone(muckOrders())
  const order = findOrder(orders, id)
  if (!order) {
    return { ok: false, message: `没有找到编号为 ${id} 的渣土运输单` }
  }
  const denied = assertDispatch(actor, order, '登记滞留')
  if (denied) {
    return denied
  }
  if (isDetained(order)) {
    return { ok: false, message: `运输单 ${text(order, '运输单号')} 已登记滞留（签认 ${text(order, '滞留签认') || '—'}），重复提交只计一次` }
  }
  if (isDisposed(order)) {
    return { ok: false, message: `运输单 ${text(order, '运输单号')} 已消纳，不能再登记滞留` }
  }

  patchStatus(order, DETAINED)
  order['滞留签认'] = text(order, '滞留签认') || `ZL-${todayLabel().replace(/-/g, '')}-${id}`

  const { safety } = reconcileSafety(orders)
  const { rings } = refreshRingChecklist(orders, listRows(RING_KEY))
  return commitAll(orders, safety, rings)
}

export function arrangeLoading(id: number, actor: Actor | null): ActionResult {
  const orders = clone(muckOrders())
  const order = findOrder(orders, id)
  if (!order) {
    return { ok: false, message: `没有找到编号为 ${id} 的渣土运输单` }
  }
  const denied = assertDispatch(actor, order, '安排装车')
  if (denied) {
    return denied
  }
  if (text(order, 'status') === '运输中') {
    return { ok: false, message: `运输单 ${text(order, '运输单号')} 已安排装车，不用重复操作` }
  }
  if (isDisposed(order) || isDetained(order)) {
    return { ok: false, message: `运输单 ${text(order, '运输单号')} 已是「${text(order, 'status')}」终态，不能再装车` }
  }
  // 车辆和押运换班都靠现场口头问最容易乱：没派齐不允许装车外运。
  if (!text(order, '运输车辆') || !text(order, '押运人员')) {
    return { ok: false, message: `运输单 ${text(order, '运输单号')} 尚未派齐运输车辆/押运人员，不能安排装车` }
  }
  if (!text(order, '消纳场所')) {
    return { ok: false, message: `运输单 ${text(order, '运输单号')} 缺消纳场所，请先按迁移规则补齐并经现场确认` }
  }
  patchStatus(order, '运输中')
  const result = commitEntries({ [MUCK_KEY]: orders })
  return result.ok ? { ok: true, message: `运输单 ${text(order, '运输单号')} 已安排装车` } : { ok: false, message: `落库失败，已整套撤回：${result.error ?? ''}` }
}

// 解除滞留：现场处置完毕、车辆重新外运，运输单回到运输中；同步挂着的隐患按现场签认自动闭环。
export function releaseDetained(id: number, actor: Actor | null): ActionResult {
  const orders = clone(muckOrders())
  const order = findOrder(orders, id)
  if (!order) {
    return { ok: false, message: `没有找到编号为 ${id} 的渣土运输单` }
  }
  const denied = assertDispatch(actor, order, '解除滞留')
  if (denied) {
    return denied
  }
  if (!isDetained(order)) {
    return { ok: false, message: `运输单 ${text(order, '运输单号')} 当前不是滞留状态，无需解除` }
  }
  patchStatus(order, '运输中')
  order['滞留签认'] = ''

  const { safety } = reconcileSafety(orders)
  const { rings } = refreshRingChecklist(orders, listRows(RING_KEY))
  return commitAll(orders, safety, rings)
}

// 改运输车辆与押运人员：只有本车队调度能动；别的车队只能查看，越权当场拒绝。
export function updateAssignment(id: number, patch: { 运输车辆?: string; 押运人员?: string }, actor: Actor | null): ActionResult {
  const orders = clone(muckOrders())
  const order = findOrder(orders, id)
  if (!order) {
    return { ok: false, message: `没有找到编号为 ${id} 的渣土运输单` }
  }
  const denied = assertDispatch(actor, order, '调整车辆或押运人员')
  if (denied) {
    return denied
  }
  const nextVehicle = patch['运输车辆'] === undefined ? text(order, '运输车辆') : patch['运输车辆'].trim()
  const nextEscort = patch['押运人员'] === undefined ? text(order, '押运人员') : patch['押运人员'].trim()
  if (text(order, '运输车辆') === nextVehicle && text(order, '押运人员') === nextEscort) {
    return { ok: false, message: '车辆与押运人员没有变化，未重复落库' }
  }
  order['运输车辆'] = nextVehicle
  order['押运人员'] = nextEscort
  const result = commitEntries({ [MUCK_KEY]: orders })
  return result.ok
    ? { ok: true, message: `运输单 ${text(order, '运输单号')} 的车辆/押运已更新` }
    : { ok: false, message: `落库失败，已整套撤回：${result.error ?? ''}` }
}

// 安全巡检页手工触发核对：按现场签认记录对齐两边条数，返回同步/闭环条数。
export function reconcileFromSafety(): ReconcileReport {
  const orders = muckOrders()
  const before = listRows(SAFETY_KEY)
  const { safety, synced, closed } = reconcileSafety(orders, before)
  const { rings, updates } = refreshRingChecklist(orders, listRows(RING_KEY))
  if (synced === 0 && closed === 0 && updates === 0) {
    return { synced, closed, ringUpdates: 0, message: '两边条数一致，无需调整（以现场签认记录为准）' }
  }
  const result = commitEntries({ [SAFETY_KEY]: safety, [RING_KEY]: rings })
  if (!result.ok) {
    return { synced: 0, closed: 0, ringUpdates: 0, message: `核对结果落库失败，已整套撤回：${result.error ?? ''}` }
  }
  return {
    synced,
    closed,
    ringUpdates: updates,
    message: `已按现场签认记录核对：新增隐患 ${synced} 条，闭环 ${closed} 条，回写环次核对 ${updates} 项`,
  }
}

// ---------------------------------------------------------------------------
// 存量运输单迁移回填（按外运日期）
// ---------------------------------------------------------------------------

const MIGRATION_VERSION = 2
const MIGRATION_KEY = 'muck-migration-version'

// 迁移在应用启动时跑、页面挂载时也会问一次；缓存最近一次报告，两处看到的是同一份结论。
let lastReport: MigrationReport | null = null
export function lastMigrationReport(): MigrationReport | null {
  return lastReport
}

// 仓库生成的占位样例（“渣土外运样例1”这类）不是真实单据，整体替换为迁移基准数据；
// 真实历史单据原样保留，只补缺失字段。
function looksLikeSeed(rows: EntryRow[]): boolean {
  return rows.some((row) => /渣土外运样例\d+/.test(text(row, '运输单号') + text(row, '对应环号')))
}

function normalizeOrder(row: EntryRow, index: number, backfilled: { count: number }): EntryRow {
  const next = clone(row)
  const { date, shift } = parsePeriod(next)
  if (date) {
    next['外运日期'] = date
  }
  if (shift) {
    next['班次'] = shift
  }
  if (text(next, '外运时段') === '' && date) {
    next['外运时段'] = `${date} ${shift}`.trim()
  }
  if (!text(next, '所属车队')) {
    next['所属车队'] = FLEETS[0]
  }
  if (!text(next, '消纳场所')) {
    // 缺消纳场所：按外运日期+班次走轮排/兜底规则补齐，挂“待核”等现场确认。
    const { site } = plannedSiteFor(date, shift)
    next['消纳场所'] = site
    next['场所补填'] = `按外运日期轮排补齐·待核（${date} ${shift}）`
    backfilled.count += 1
  }
  const numericVolume = Number(next['渣土方量'])
  if (!Number.isFinite(numericVolume) || numericVolume <= 0) {
    next['渣土方量'] = 32
  }
  for (const field of ['消纳签认号', '消纳时间', '滞留签认'] as const) {
    if (next[field] === undefined || next[field] === null) {
      next[field] = ''
    }
  }
  if (!text(next, '运输单号')) {
    next['运输单号'] = `YD-OLD-${String(index + 1).padStart(3, '0')}`
  }
  return next
}

// 启动迁移：幂等，已迁移过不重跑；迁移本身也是多模块事务，失败整套撤回、不加版本号。
export function runMigration(): MigrationReport {
  const rules = [
    '占位样例数据整体替换为迁移基准数据，不参与回填统计',
    '真实单据缺消纳场所：白班按外运日期年内序次在南山/北港/西岭三场轮排，夜班顺延一场',
    '日期缺失或轮排落空的，统一补兜底场“东桥综合消纳场”',
    '程序补齐的场所挂“待核”，以现场签认为准',
    '缺外运日期/班次的从“外运时段”拆出，拆不出日期默认白班；缺所属车队默认盾构一队',
    '滞留在场车次同步安全巡检隐患台账，环次核对清单同步初始化',
  ]

  const version = Number(getMeta(MIGRATION_KEY) ?? 0)
  if (version >= MIGRATION_VERSION) {
    const report: MigrationReport = { ran: false, replacedSeed: false, orders: 0, siteBackfilled: 0, hazardSynced: 0, ringsChecked: 0, rules }
    lastReport = report
    return report
  }

  // 引用种子前先触发缓存初始化。
  const current = listRows(MUCK_KEY)
  let orders: EntryRow[]
  let replacedSeed = false
  if (looksLikeSeed(current)) {
    // 仓库生成的占位样例不是真实单据，整体替换为迁移基准数据，再走一遍字段标准化。
    orders = clone(SEED_ROWS[MUCK_KEY] ?? [])
    replacedSeed = true
  } else {
    orders = clone(current)
  }

  const backfilled = { count: 0 }
  orders = orders.map((row, index) => normalizeOrder(row, index, backfilled))

  // 同步两边：滞留隐患 + 环次核对清单，一次事务。
  const safetyBase = replacedSeed ? clone(SEED_ROWS[SAFETY_KEY] ?? []) : listRows(SAFETY_KEY)
  const ringBase = replacedSeed ? clone(SEED_ROWS[RING_KEY] ?? []) : listRows(RING_KEY)
  const { safety, synced } = reconcileSafety(orders, safetyBase)
  const { rings, updates } = refreshRingChecklist(orders, ringBase)
  const result = commitEntries({ [MUCK_KEY]: orders, [SAFETY_KEY]: safety, [RING_KEY]: rings })
  if (!result.ok) {
    const failed: MigrationReport = { ran: false, replacedSeed, orders: 0, siteBackfilled: 0, hazardSynced: 0, ringsChecked: 0, rules }
    lastReport = failed
    return failed
  }
  setMeta(MIGRATION_KEY, MIGRATION_VERSION)
  const report: MigrationReport = {
    ran: true,
    replacedSeed,
    orders: orders.length,
    siteBackfilled: backfilled.count,
    hazardSynced: synced,
    ringsChecked: updates,
    rules,
  }
  lastReport = report
  return report
}

export function migrationVersion(): number {
  return Number(getMeta(MIGRATION_KEY) ?? 0)
}
