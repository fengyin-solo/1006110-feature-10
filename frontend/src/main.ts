import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import { runMigration } from './api/muck-service'
import './styles/global.css'

// 挂载前先同步跑存量运输单迁移（幂等）：环次核对清单、安全隐患台账两处随之一致，任何页面首屏都是已迁移数据。
runMigration()

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
