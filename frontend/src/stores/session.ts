import { defineStore } from 'pinia'

import { FLEETS } from '@/api/muck-service'

// 渣土外运按车队分权：只有本车队的调度能改运输车辆与押运人员，别的车队只能查看。
export type SessionRole = '调度' | '值班员'

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '王调度',
    shiftLabel: '白班 08:00-20:00',
    scope: '盾构隧道掘进施工管理平台',
    // 可在渣土外运页切换身份验证分权：默认一队调度（本车队可写），切成二队即只读。
    role: '调度' as SessionRole,
    fleet: FLEETS[0] as string,
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
    actor: (state) => ({ name: state.operator, fleet: state.fleet, role: state.role }),
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setIdentity(fleet: string, role: SessionRole) {
      this.fleet = fleet
      this.role = role
      this.operator = `${fleet === FLEETS[0] ? '王' : '陈'}${role}`
    },
  },
})
