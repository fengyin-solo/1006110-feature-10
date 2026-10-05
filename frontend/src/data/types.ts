/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 当前操作身份：车队 + 角色，用于渣土外运看板的越权校验。 */
export type OperatorInfo = {
  name: string
  role: string
  fleet: string
}

/** 渣土外运看板：栏内一张卡片就是一条运输单。 */
export type MuckBoardCard = {
  id: number
  运输单号: string
  渣土方量: number
  运输车辆: string
  押运人员: string
  车队: string
  状态: string
  滞留: boolean
}

export type MuckBoardColumn = {
  消纳场所: string
  车次: number
  滞留车次: number
  方量合计: number
  cards: MuckBoardCard[]
}

/** 看板顶部概览：按外运时段汇总。 */
export type MuckBoardShift = {
  外运时段: string
  车次: number
  方量合计: number
}

/** 滞留车次与安全巡检隐患台账的对账结果。 */
export type RetentionReconcile = {
  滞留车次: number
  台账待整改: number
  现场签认额外记录: number
  一致: boolean
  说明: string
}

export type MuckBoardResult = {
  overview: MuckBoardShift[]
  columns: MuckBoardColumn[]
  reconcile: RetentionReconcile
  /** 本次加载触发的存量迁移 / 隐患同步说明，空数组表示没有改动。 */
  migration: string[]
}
