<template>
  <section class="page" data-module="muck">
    <header class="page-head">
      <div>
        <h2>渣土外运看板</h2>
        <p class="page-desc">按消纳场所分栏，滞留车次标红置顶；确认消纳自动回写掘进环次，滞留自动挂安全巡检隐患台账。</p>
      </div>
      <div class="page-actions">
        <span class="identity">当前身份：{{ store.fleet }} · {{ store.operator }}（{{ store.role }}）</span>
        <button class="btn" type="button" @click="toggleFleet">
          切换为{{ store.fleet === '渣土一队' ? '渣土二队' : '渣土一队' }}查看
        </button>
        <button class="btn" type="button" @click="exportRows">导出渣土外运清单</button>
      </div>
    </header>

    <div v-if="board.migration.length" class="notice-bar">
      <strong>存量迁移 / 同步</strong>
      <ul>
        <li v-for="line in board.migration" :key="line">{{ line }}</li>
      </ul>
    </div>

    <div class="shift-strip">
      <article v-for="shift in board.overview" :key="shift.外运时段" class="shift-card">
        <span class="stat-label">{{ shift.外运时段 }}</span>
        <strong class="stat-value">{{ shift.车次 }} 车</strong>
        <span class="shift-volume">{{ shift.方量合计 }} m³</span>
      </article>
      <article v-if="!board.overview.length" class="shift-card">
        <span class="stat-label">外运时段</span>
        <strong class="stat-value">暂无</strong>
      </article>
    </div>

    <p class="reconcile-bar" :class="{ warn: !board.reconcile.一致 }">
      滞留对账：{{ board.reconcile.说明 }}
    </p>

    <div class="board-columns">
      <section v-for="column in board.columns" :key="column.消纳场所" class="board-column">
        <header class="column-head">
          <strong>{{ column.消纳场所 }}</strong>
          <span>{{ column.车次 }} 车 · {{ column.方量合计 }} m³</span>
          <span v-if="column.滞留车次" class="retained-badge">滞留 {{ column.滞留车次 }}</span>
        </header>
        <article
          v-for="card in column.cards"
          :key="card.id"
          class="muck-card"
          :class="{ retained: card.滞留, disposed: card.状态 === '已消纳' }"
        >
          <header class="card-head">
            <strong>{{ card.运输单号 }}</strong>
            <span class="card-status">{{ card.状态 }}</span>
          </header>
          <p class="card-line">方量 {{ card.渣土方量 }} m³ · {{ card.运输车辆 }}</p>
          <p class="card-line">押运 {{ card.押运人员 }} · {{ card.车队 }}</p>
          <div v-if="editingId === card.id" class="card-edit">
            <input v-model="editVehicle" placeholder="运输车辆" />
            <input v-model="editEscort" placeholder="押运人员" />
            <button class="btn primary" type="button" :disabled="processing" @click="saveAssignment(card.id)">保存</button>
            <button class="btn ghost" type="button" @click="editingId = 0">取消</button>
          </div>
          <div v-else class="card-actions">
            <button class="link" type="button" :disabled="processing" @click="doAction('确认消纳', card.id)">确认消纳</button>
            <button class="link" type="button" :disabled="processing" @click="doAction('登记滞留', card.id)">登记滞留</button>
            <button class="link" type="button" :disabled="processing" @click="openEdit(card)">改车辆/押运</button>
          </div>
        </article>
      </section>
      <p v-if="!board.columns.length" class="empty-state">暂无渣土外运数据</p>
    </div>

    <h3 class="ledger-title">运输单台账</h3>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

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
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              :disabled="processing"
              @click="doAction(action, Number(row.id))"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无渣土外运数据，可先登记渣土运输单</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条渣土外运记录</span>
      <span v-if="noticeMessage" class="notice-text">{{ noticeMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  loadMuckBoard,
  moduleMeta,
  runAction as applyAction,
  updateMuckAssignment,
} from '@/api/local-service'
import type { EntryRow, MuckBoardCard, MuckBoardResult } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const meta = moduleMeta('muck')
const store = useSessionStore()
const columns = ["运输单号", "对应环号", "渣土方量", "运输车辆", "外运时段", "消纳场所", "押运人员", "车队", "运输状态"]
const actions = ["安排装车", "确认消纳", "登记滞留"]
const statuses = ["待装车", "运输中", "已消纳", "已滞留"]

const emptyBoard: MuckBoardResult = {
  overview: [],
  columns: [],
  reconcile: { 滞留车次: 0, 台账待整改: 0, 现场签认额外记录: 0, 一致: true, 说明: '' },
  migration: [],
}
const board = reactive<MuckBoardResult>({ ...emptyBoard })
const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const editingId = ref(0)
const editVehicle = ref('')
const editEscort = ref('')
/** 连点两回也只落一条：处理中禁用所有操作按钮，服务层本身也幂等。 */
const processing = ref(false)

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function toggleFleet() {
  store.switchFleet(store.fleet === '渣土一队' ? '渣土二队' : '渣土一队')
  noticeMessage.value = `已切换为 ${store.fleet} 身份，非本车队运输单只能查看`
}

function openEdit(card: MuckBoardCard) {
  editingId.value = card.id
  editVehicle.value = card.运输车辆
  editEscort.value = card.押运人员
}

function saveAssignment(id: number) {
  errorMessage.value = ''
  noticeMessage.value = ''
  processing.value = true
  try {
    const result = updateMuckAssignment(
      id,
      { 运输车辆: editVehicle.value, 押运人员: editEscort.value },
      store.operatorInfo,
    )
    if (!result.ok) {
      errorMessage.value = result.message
      return
    }
    noticeMessage.value = result.message
    editingId.value = 0
    reload()
  } finally {
    processing.value = false
  }
}

function doAction(action: string, id: number) {
  errorMessage.value = ''
  noticeMessage.value = ''
  processing.value = true
  try {
    const result = applyAction(meta.key, id, action)
    if (!result.ok) {
      errorMessage.value = result.message
      return
    }
    noticeMessage.value = result.message
    reload()
  } finally {
    processing.value = false
  }
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = loadMuckBoard()
    board.overview = payload.overview
    board.columns = payload.columns
    board.reconcile = payload.reconcile
    board.migration = payload.migration
    const list = listEntries(meta.key, filters.value)
    rows.value = list.items
    total.value = list.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '渣土外运列表读取失败'
  }
}

onMounted(reload)
</script>
