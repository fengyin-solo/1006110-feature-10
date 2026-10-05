<template>
  <section class="page" data-module="ring">
    <header class="page-head">
      <div>
        <h2>掘进环次管理</h2>
        <p class="page-desc">维护掘进环，围绕环号、起始里程、掘进速度、总推力做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记掘进环</button>
        <button class="btn" type="button" @click="exportRows">导出掘进环次清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

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
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无掘进环次数据，可先登记掘进环</td>
        </tr>
      </tbody>
    </table>

    <section class="checklist">
      <header class="checklist-head">
        <h3>出土方量核对清单（确认消纳后自动回写）</h3>
        <p class="page-desc">已消纳方量由「已消纳」运输单实时汇总，环次不另存一份，环次读到的数与渣土外运看板同源。</p>
      </header>
      <table class="data-table">
        <thead>
          <tr>
            <th>环号</th>
            <th>环次出土方量(m³)</th>
            <th>已消纳方量(m³)</th>
            <th>差值(m³)</th>
            <th>核对结果</th>
            <th>核对状态</th>
            <th>最近消纳</th>
            <th>最近签认号</th>
            <th>已消纳运输单</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in checklist" :key="String(item.ring['环号'])" :class="{ 'row-danger': item.result === '已消纳超出土' }">
            <td>{{ item.ring['环号'] }}</td>
            <td>{{ item.plannedVolume }}</td>
            <td>{{ item.disposedVolume }}</td>
            <td :class="item.diff === 0 ? 'ok-text' : item.diff > 0 ? 'warn-text' : ''">{{ item.diff }}</td>
            <td>{{ item.result }}</td>
            <td>{{ item.status }}</td>
            <td>{{ item.lastConfirmTime || '—' }}</td>
            <td>{{ item.ring['最近消纳签认号'] || '—' }}</td>
            <td>
              <span v-for="order in item.orders.filter((row) => row.status === '已消纳')" :key="String(order.id)" class="chip">
                {{ order['运输单号'] }}（{{ order['渣土方量'] }}m³/{{ order['消纳签认号'] }}）
              </span>
              <span v-if="!item.orders.some((row) => row.status === '已消纳')" class="dim">暂无</span>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条掘进环次记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { ringChecklist } from '@/api/muck-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('ring')
const columns = ["环号", "起始里程", "掘进速度", "总推力", "刀盘扭矩", "出土方量", "掘进班组", "环次状态"]
const actions = ["开始掘进", "确认完成", "申请纠偏"]
const statuses = ["待掘进", "掘进中", "已贯通", "已纠偏"]
const stats = [{"label": "本月掘进环数", "value": 0}, {"label": "平均掘进速度", "value": 0}, {"label": "纠偏环数", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
// 本地存储不是响应式的，用版本计数驱动：消纳确认后回到本页 reload 会让清单重算。
const dataVersion = ref(0)
const checklist = computed(() => {
  void dataVersion.value
  return ringChecklist()
})
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '掘进环登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    dataVersion.value += 1
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '掘进环次列表读取失败'
  }
}

onMounted(reload)
</script>
