import { defineStore } from 'pinia'

import type { OperatorInfo } from '@/data/types'

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '张调度',
    role: '调度',
    fleet: '渣土一队',
    shiftLabel: '白班 08:00-20:00',
    scope: '盾构隧道掘进施工管理平台',
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
    /** 传给渣土外运联动服务的当前操作身份。 */
    operatorInfo(): OperatorInfo {
      return { name: this.operator, role: this.role, fleet: this.fleet }
    },
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    /** 切换值班车队，用来演示「只有本车队调度能改，别的车队只能查看」。 */
    switchFleet(fleet: string) {
      this.fleet = fleet
    },
  },
})
