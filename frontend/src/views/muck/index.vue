<template>
  <section class="page muck-board" data-module="muck">
    <header class="page-head">
      <div>
        <h2>渣土外运看板</h2>
        <p class="page-desc">
          按消纳场所分栏，栏内列出运输单号、渣土方量与运输车辆；滞留车次标红置顶。顶部按外运时段汇总。
        </p>
      </div>
      <div class="page-actions">
        <div class="role-switch" role="group" aria-label="切换当前值班身份">
          <label>
            身份
            <select :value="store.fleet" @change="onFleetChange(($event.target as HTMLSelectElement).value)">
              <option v-for="fleet in fleets" :key="fleet" :value="fleet">{{ fleet }}</option>
            </select>
          </label>
          <label>
            岗位
            <select :value="store.role" @change="onRoleChange(($event.target as HTMLSelectElement).value)">
              <option value="调度">调度</option>
              <option value="值班员">值班员</option>
            </select>
          </label>
        </div>
        <button class="btn" type="button" @click="exportRows">导出台账</button>
      </div>
    </header>

    <p class="identity-tip">
      当前操作身份：<strong>{{ store.operator }}（{{ store.fleet }} · {{ store.role }}）</strong>
      <span v-if="store.role !== '调度'">——非调度岗位只能查看，改车辆/押运与状态流转都会被拒绝。</span>
      <span v-else>——只有归属「{{ store.fleet }}」的运输单可改车辆、押运与确认；别的车队的单子只能查看。</span>
    </p>

    <div class="tab-row">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        class="tab-btn"
        :class="{ active: view === tab.key }"
        type="button"
        @click="view = tab.key"
      >
        {{ tab.label }}
      </button>
    </div>

    <!-- 顶部：按外运时段汇总的概览，两处入口同一份取数 -->
    <div class="stat-row">
      <article v-for="card in overallCards" :key="card.label" class="stat-card" :class="card.kind">
        <span class="stat-label">{{ card.label }}</span>
        <strong class="stat-value">{{ card.value }}</strong>
      </article>
    </div>
    <div class="period-strip">
      <article v-for="item in periods" :key="item.period" class="period-card">
        <header>{{ item.period }}</header>
        <p>
          <span>{{ item.trips }} 车</span>
          <span>{{ item.volume }} m³</span>
          <span class="dim">已消纳 {{ item.disposedTrips }} 车 / {{ item.disposedVolume }} m³</span>
        </p>
        <p v-if="item.detainedTrips" class="danger-text">滞留 {{ item.detainedTrips }} 车</p>
      </article>
    </div>

    <!-- 看板视图：按消纳场所分栏，滞留标红置顶 -->
    <div v-if="view === 'board'" class="board-columns">
      <section v-for="column in columns" :key="column.site" class="site-column">
        <header class="site-head">
          <div>
            <strong>{{ column.site }}</strong>
            <span v-if="column.fallback" class="tag warn">程序补填·待核</span>
          </div>
          <span class="site-count">{{ column.trips }} 车 / {{ column.volume }} m³</span>
        </header>
        <p v-if="column.detainedTrips" class="danger-text detained-count">滞留 {{ column.detainedTrips }} 车</p>
        <ul class="order-list">
          <li
            v-for="order in column.orders"
            :key="String(order.id)"
            class="order-card"
            :class="{ detained: isDetained(order), disabled: !canOperate(order) }"
          >
            <div class="order-line">
              <span class="order-no">{{ order['运输单号'] }}</span>
              <span class="order-status" :class="statusClass(order)">{{ order.status }}</span>
            </div>
            <div class="order-line muted">
              <span>{{ order['渣土方量'] }} m³</span>
              <span>{{ order['对应环号'] }}</span>
            </div>
            <div class="order-line">
              <span>🚚 {{ order['运输车辆'] || '车辆待派' }}</span>
            </div>
            <div class="order-line muted">
              <span>押运：{{ order['押运人员'] || '未派' }}</span>
              <span>{{ order['所属车队'] }}</span>
            </div>
            <div v-if="isDetained(order)" class="order-line danger-text">
              滞留签认：{{ order['滞留签认'] || '缺签认' }}
            </div>
            <div v-if="isDisposed(order)" class="order-line dim">
              消纳签认：{{ order['消纳签认号'] }} · {{ order['消纳时间'] }}
            </div>
            <div v-if="order['场所补填']" class="order-line warn-text">{{ order['场所补填'] }}</div>

            <div v-if="canOperate(order)" class="card-actions">
              <button
                v-if="String(order.status) === '待装车'"
                class="link"
                type="button"
                :disabled="busyId === order.id"
                @click="apply('arrangeLoading', order)"
              >
                安排装车
              </button>
              <button
                v-if="String(order.status) === '运输中'"
                class="link"
                type="button"
                :disabled="busyId === order.id"
                @click="apply('confirmDisposal', order)"
              >
                确认消纳
              </button>
              <button
                v-if="String(order.status) === '运输中' || String(order.status) === '待装车'"
                class="link danger-link"
                type="button"
                :disabled="busyId === order.id"
                @click="apply('registerDetained', order)"
              >
                登记滞留
              </button>
              <button
                v-if="String(order.status) === '已滞留'"
                class="link"
                type="button"
                :disabled="busyId === order.id"
                @click="apply('releaseDetained', order)"
              >
                解除滞留
              </button>
              <button class="link" type="button" @click="toggleEdit(order)">改车辆/押运</button>
            </div>
            <div v-else-if="!isDisposed(order)" class="card-actions blocked">
              仅{{ order['所属车队'] }}调度可操作（只读）
            </div>

            <form v-if="editingId === order.id" class="assign-form" @submit.prevent="saveAssign(order)">
              <input v-model="editForm['运输车辆']" placeholder="运输车辆（如 沪D·8101）" />
              <input v-model="editForm['押运人员']" placeholder="押运人员" />
              <div class="assign-actions">
                <button class="btn primary mini" type="submit" :disabled="busyId === order.id">保存</button>
                <button class="btn ghost mini" type="button" @click="editingId = null">取消</button>
              </div>
            </form>
          </li>
          <li v-if="!column.orders.length" class="empty-column">本栏暂无车次</li>
        </ul>
      </section>
    </div>

    <!-- 清单视图：原有台账表格，与看板同一份取数 -->
    <template v-else>
      <form class="filter-bar" @submit.prevent="reload">
        <label v-for="field in filterFields" :key="field" class="filter-item">
          <span>{{ field }}</span>
          <input v-model="filters[field]" :placeholder="`按${field}检索`" />
        </label>
        <button class="btn" type="submit">查询</button>
        <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
      </form>
      <table class="data-table">
        <thead>
          <tr>
            <th v-for="column in tableColumns" :key="column">{{ column }}</th>
            <th>当前状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in filteredRows" :key="String(row.id)" :class="{ 'row-danger': isDetained(row) }">
            <td v-for="column in tableColumns" :key="column">{{ row[column] === '' ? '—' : (row[column] ?? '—') }}</td>
            <td>{{ row.status }}</td>
            <td class="row-actions">
              <template v-if="canOperate(row)">
                <button v-if="String(row.status) === '待装车'" class="link" type="button" @click="apply('arrangeLoading', row)">安排装车</button>
                <button v-if="String(row.status) === '运输中'" class="link" type="button" @click="apply('confirmDisposal', row)">确认消纳</button>
                <button
                  v-if="String(row.status) === '运输中' || String(row.status) === '待装车'"
                  class="link danger-link"
                  type="button"
                  @click="apply('registerDetained', row)"
                >
                  登记滞留
                </button>
                <button v-if="String(row.status) === '已滞留'" class="link" type="button" @click="apply('releaseDetained', row)">解除滞留</button>
              </template>
              <span v-else class="dim">只读</span>
            </td>
          </tr>
          <tr v-if="!filteredRows.length">
            <td :colspan="tableColumns.length + 2" class="empty-state">暂无匹配的渣土运输单</td>
          </tr>
        </tbody>
      </table>
    </template>

    <section v-if="migrationReport" class="migration-note">
      <header>存量运输单迁移回填（按外运日期）</header>
      <ul>
        <li v-if="migrationReport.ran">
          本次迁移：{{ migrationReport.replacedSeed ? '检出占位样例并整体替换为迁移基准数据；' : '' }}
          标准化 {{ migrationReport.orders }} 张运输单，按外运日期补消纳场所 {{ migrationReport.siteBackfilled }} 处，
          同步滞留隐患 {{ migrationReport.hazardSynced }} 条，初始化环次核对 {{ migrationReport.ringsChecked }} 项。
        </li>
        <li v-else>存量运输单已迁移过（版本 {{ migratedVersion }}），本次未重复回填；重复提交只计一次。</li>
        <li v-for="(rule, index) in migrationReport.rules" :key="index">{{ rule }}</li>
      </ul>
    </section>

    <footer class="page-foot">
      <span>共 {{ orders.length }} 张运输单 · 数据与掘进环次核对清单、安全巡检隐患台账同源，落库失败整套撤回</span>
      <span v-if="message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  arrangeLoading,
  confirmDisposal,
  FLEETS,
  isDetained,
  isDisposed,
  lastMigrationReport,
  migrationVersion,
  periodSummaries,
  registerDetained,
  releaseDetained,
  runMigration,
  siteColumns,
  updateAssignment,
  type Actor,
  type MigrationReport,
} from '@/api/muck-service'
import { downloadEntries, filterRows, listEntries } from '@/api/local-service'
import type { EntryRow } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const store = useSessionStore()
const fleets = FLEETS

const tabs = [
  { key: 'board', label: '消纳看板' },
  { key: 'list', label: '运输台账（同一份数据）' },
] as const
type ViewKey = (typeof tabs)[number]['key']
const view = ref<ViewKey>('board')

const tableColumns = ['运输单号', '对应环号', '渣土方量', '运输车辆', '外运时段', '消纳场所', '押运人员', '所属车队']
const filterFields = ['运输单号', '对应环号', '消纳场所']

const orders = ref<EntryRow[]>([])
const filters = ref<Record<string, string>>({})
const message = ref('')
const messageOk = ref(false)
const busyId = ref<number | null>(null)
const editingId = ref<number | null>(null)
const editForm = reactive<{ 运输车辆: string; 押运人员: string }>({ 运输车辆: '', 押运人员: '' })
const migrationReport = ref<MigrationReport | null>(null)
const migratedVersion = ref(0)

const periods = computed(() => periodSummaries(orders.value))
const columns = computed(() => siteColumns(orders.value))

const overallCards = computed(() => {
  const list = orders.value
  const today = new Date()
  const todayText = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const todayDisposed = list.filter((row) => isDisposed(row) && String(row['外运日期'] ?? '').startsWith(todayText))
  return [
    { label: '运输单总数', value: list.length, kind: '' },
    { label: '今日已消纳方量', value: `${todayDisposed.reduce((sum, row) => sum + Number(row['渣土方量'] || 0), 0)} m³`, kind: '' },
    { label: '运输中车次', value: list.filter((row) => String(row.status) === '运输中').length, kind: '' },
    { label: '滞留在场车次', value: list.filter((row) => isDetained(row)).length, kind: 'danger' },
  ]
})

const filteredRows = computed(() => filterRows(orders.value, filters.value))

function canOperate(row: EntryRow): boolean {
  if (store.role !== '调度') {
    return false
  }
  const fleet = String(row['所属车队'] ?? '')
  return !fleet || fleet === store.fleet
}

function statusClass(row: EntryRow): string {
  if (isDetained(row)) {
    return 'danger'
  }
  if (isDisposed(row)) {
    return 'ok'
  }
  return ''
}

function onFleetChange(fleet: string) {
  store.setIdentity(fleet, store.role)
}

function onRoleChange(role: string) {
  store.setIdentity(store.fleet, role as '调度' | '值班员')
}

function toggleEdit(order: EntryRow) {
  if (editingId.value === order.id) {
    editingId.value = null
    return
  }
  editingId.value = Number(order.id)
  editForm['运输车辆'] = String(order['运输车辆'] ?? '')
  editForm['押运人员'] = String(order['押运人员'] ?? '')
}

function saveAssign(order: EntryRow) {
  const result = updateAssignment(
    Number(order.id),
    { 运输车辆: editForm['运输车辆'], 押运人员: editForm['押运人员'] },
    store.actor as Actor,
  )
  notify(result)
  editingId.value = null
  if (result.ok) {
    reload()
  }
}

type MuckAction = 'arrangeLoading' | 'confirmDisposal' | 'registerDetained' | 'releaseDetained'

function apply(action: MuckAction, row: EntryRow) {
  // 同一运输单重复提交只计一次：操作期间锁住按钮，服务端也按状态幂等兜底。
  if (busyId.value === row.id) {
    return
  }
  busyId.value = Number(row.id)
  let result
  if (action === 'confirmDisposal') {
    result = confirmDisposal(Number(row.id), store.actor as Actor)
  } else if (action === 'registerDetained') {
    result = registerDetained(Number(row.id), store.actor as Actor)
  } else if (action === 'releaseDetained') {
    result = releaseDetained(Number(row.id), store.actor as Actor)
  } else {
    result = arrangeLoading(Number(row.id), store.actor as Actor)
  }
  busyId.value = null
  notify(result)
  if (result.ok) {
    reload()
  }
}

function notify(result: { ok: boolean; message: string }) {
  message.value = result.message || (result.ok ? '操作已落库' : '操作被拒绝')
  messageOk.value = result.ok
}

function resetFilters() {
  filters.value = {}
}

function exportRows() {
  downloadEntries('muck')
}

function reload() {
  orders.value = listEntries('muck').items
}

onMounted(() => {
  // 迁移已在 App 启动时执行，这里读同一份报告；万一本页先挂载也再兜一次（幂等）。
  migrationReport.value = lastMigrationReport() ?? runMigration()
  migratedVersion.value = migrationVersion()
  reload()
})
</script>
