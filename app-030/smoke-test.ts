/**
 * 端到端冒烟（node + 内存 IndexedDB）：
 * 规则版本删除入口的全部关键路径 ——
 * 内置版不许删、被项目引用不许删且说清项目、无引用自定义可删、
 * 新建项目下拉随之变短、项目锁定版本靠快照读回、删除与拦下均留痕。
 */

/* ------------------------- 最小内存 IndexedDB 实现 ------------------------- */

type RecordStore = Map<IDBValidKey, any>

class FakeObjectStore {
  map: RecordStore
  keyPath: string
  autoIncrement: boolean
  nextKey = 1
  constructor(name: string, public db: FakeDB, opts: any) {
    this.map = db.tables.get(name)!
    this.keyPath = opts?.keyPath
    this.autoIncrement = !!opts?.autoIncrement
  }
  private withResult(value: any): FakeRequest {
    const req = new FakeRequest()
    queueMicrotask(() => {
      req.result = value
      req.onsuccess?.(new Event('success'))
      req.transaction!.done()
    })
    return req
  }
  getAll(): FakeRequest {
    return this.withResult([...this.map.values()])
  }
  get(key: IDBValidKey): FakeRequest {
    return this.withResult(this.map.get(key))
  }
  count(): FakeRequest {
    return this.withResult(this.map.size)
  }
  put(value: any): FakeRequest {
    const key = this.keyPath ? value[this.keyPath] : this.nextKey
    this.map.set(key, value)
    return this.withResult(key)
  }
  add(value: any): FakeRequest {
    if (this.autoIncrement) {
      let key = this.keyPath ? value[this.keyPath] : undefined
      if (key === undefined) {
        while (this.map.has(this.nextKey)) this.nextKey++
        key = this.nextKey++
        if (this.keyPath) value[this.keyPath] = key
      }
      if (this.map.has(key)) {
        const req = new FakeRequest()
        queueMicrotask(() => {
          req.error = new Error('ConstraintError: key already exists')
          req.onerror?.(new Event('error'))
          req.transaction!.fail(req.error)
        })
        return req
      }
      this.map.set(key, value)
      return this.withResult(key)
    }
    const key = this.keyPath ? value[this.keyPath] : this.nextKey
    if (this.map.has(key)) {
      const req = new FakeRequest()
      queueMicrotask(() => {
        req.error = new Error('ConstraintError: key already exists')
        req.onerror?.(new Event('error'))
        req.transaction!.fail(req.error)
      })
      return req
    }
    this.map.set(key, value)
    return this.withResult(key)
  }
  delete(key: IDBValidKey): FakeRequest {
    this.map.delete(key)
    return this.withResult(undefined)
  }
}

class FakeRequest {
  result: any = undefined
  error: Error | null = null
  onsuccess: ((e: Event) => void) | null = null
  onerror: ((e: Event) => void) | null = null
  transaction!: FakeTransaction
}

class FakeTransaction {
  stores = new Map<string, FakeObjectStore>()
  private pending = 0
  private settled = false
  oncomplete: ((e: Event) => void) | null = null
  onerror: ((e: Event) => void) | null = null
  onabort: ((e: Event) => void) | null = null
  error: Error | null = null
  constructor(db: FakeDB, names: string[], mode: string) {
    for (const name of names) this.stores.set(name, new FakeObjectStore(name, db, db.storeOpts.get(name)))
    // 至少一个请求才结算；runRequest 总会 build 一个请求
  }
  track(): void {
    this.pending++
  }
  objectStore(name: string): FakeObjectStore {
    const store = this.stores.get(name)
    if (!store) throw new Error(`objectStore ${name} not in transaction`)
    return store
  }
  done(): void {
    this.pending--
    if (this.pending === 0 && !this.settled) {
      this.settled = true
      this.oncomplete?.(new Event('complete'))
    }
  }
  fail(error: Error): void {
    if (this.settled) return
    this.settled = true
    this.error = error
    this.onerror?.(new Event('error'))
  }
}

class FakeDB {
  tables = new Map<string, RecordStore>()
  storeOpts = new Map<string, any>()
  createObjectStore(name: string, opts: any): FakeObjectStore {
    this.tables.set(name, new Map())
    this.storeOpts.set(name, opts)
    return null as unknown as FakeObjectStore
  }
  objectStoreNames = { contains: (name: string) => this.tables.has(name) }
  transaction(names: string | string[], mode: string): FakeTransaction {
    const list = Array.isArray(names) ? names : [names]
    const tx = new FakeTransaction(this, list, mode)
    // 把请求与事务关联：包装 objectStore 方法产生的 request
    for (const store of tx.stores.values()) {
      for (const method of ['getAll', 'get', 'put', 'add', 'delete', 'count'] as const) {
        const original = (store as any)[method].bind(store)
        ;(store as any)[method] = (...args: any[]) => {
          tx.track()
          const req: FakeRequest = original(...args)
          req.transaction = tx
          return req
        }
      }
    }
    return tx
  }
}

const openRequests: any[] = []
const indexedDBShim = {
  open(name: string, version?: number) {
    const req: any = {
      result: null as FakeDB | null,
      error: null,
      onupgradeneeded: null as ((e: Event) => void) | null,
      onsuccess: null as ((e: Event) => void) | null,
      onerror: null as ((e: Event) => void) | null,
      onblocked: null as ((e: Event) => void) | null
    }
    openRequests.push({ req, name, version })
    return req
  }
}

function flushOpen(upgrade: boolean, db?: FakeDB): void {
  for (const pending of openRequests.splice(0)) {
    const d = db ?? new FakeDB()
    pending.req.result = d
    if (upgrade) pending.req.onupgradeneeded?.(new Event('upgradeneeded'))
    pending.req.onsuccess?.(new Event('success'))
  }
}

;(globalThis as any).indexedDB = indexedDBShim

/* --------------------------------- 测试 --------------------------------- */

import { initStore, store, createProject, requestDeleteRule } from './src/logic/store'
import { BUILTIN_RULES } from './src/logic/sizeRules'
import { listRuleAudit } from './src/logic/audit'
import type { SizeRule } from './src/logic/types'

let failures = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    failures++
    console.error(`  ✗ ${name} ${detail}`)
  }
}

async function main(): Promise<void> {
  // 首次打开：触发建库（v2 升级路径：v2 直接创建全部仓库）
  const ready = initStore()
  flushOpen(true)
  await ready

  const builtinVersions = BUILTIN_RULES.map((r) => r.version)
  check(`内置两版在列表中（${builtinVersions.join('、')}）`, BUILTIN_RULES.length === 2)
  check('初始化后规则列表只有内置版', store.rules.length === 2, `实际 ${store.rules.length}`)

  // 1) 新建两个自定义版本：一个给项目用，一个没人用
  const usedCustom: SizeRule = { ...structuredClone(toPlain(BUILTIN_RULES[0])), version: 'v9.1.0', builtin: false, label: '试验版（有项目）' }
  const orphanCustom: SizeRule = { ...structuredClone(toPlain(BUILTIN_RULES[0])), version: 'v9.2.0', builtin: false, label: '试错版（没人用）' }
  const { saveRule } = await import('./src/logic/store')
  await saveRule(usedCustom)
  await saveRule(orphanCustom)
  check('两个自定义版本已进入列表', store.rules.length === 4, `实际 ${store.rules.length}`)

  // 2) 建项目锁定 v9.1.0
  const project = await createProject({ name: '某中学 2026 校服', kind: 'school', batches: ['春装'], ruleVersion: 'v9.1.0' })
  check('项目锁定版本为 v9.1.0', project.ruleVersion === 'v9.1.0')
  check('建项目时写入了锁定规则快照', project.lockedRule?.version === 'v9.1.0')

  // 3) 删内置版 → 拦下 + 留痕
  const r1 = await requestDeleteRule(builtinVersions[0])
  check('删内置版被拦', r1.deleted === false && r1.reason === 'builtin')
  check('内置版仍在列表', store.rules.some((r) => r.version === builtinVersions[0]))

  // 4) 删被引用的自定义版 → 拦下 + 说清是哪几个项目 + 留痕
  const r2 = await requestDeleteRule('v9.1.0')
  check('删被引用版被拦', r2.deleted === false && r2.reason === 'in_use')
  if (!r2.deleted) {
    check('拦截结果列出引用项目名', r2.usedBy.some((p) => p.name === '某中学 2026 校服'))
    check('留痕里写明了项目', r2.audit?.usedByProjects[0]?.name === '某中学 2026 校服')
  }
  check('被引用版仍在列表', store.rules.some((r) => r.version === 'v9.1.0'))

  // 5) 删没人用的自定义版 → 成功，列表与「下拉数据源」一起少一条
  const beforeCount = store.rules.length
  const r3 = await requestDeleteRule('v9.2.0')
  check('无引用自定义版删除成功', r3.deleted === true)
  check('列表少了一版', store.rules.length === beforeCount - 1)
  check('被删版本不在列表（下拉同源）', !store.rules.some((r) => r.version === 'v9.2.0'))

  // 6) 项目锁定版本仍可读（这里 v9.1.0 没被删，走 live；下面再模拟快照兜底）
  const { getProjectRule, projectRuleOrNull } = await import('./src/logic/store')
  const rule = getProjectRule(project)
  check('项目按锁定版本读到规则', rule.version === 'v9.1.0')

  // 7) 快照兜底：模拟 live 列表里版本消失（异常场景，例如手工清库），项目仍按自己锁定的版读回，不串版
  const liveIndex = store.rules.findIndex((r) => r.version === 'v9.1.0')
  const [removedLive] = store.rules.splice(liveIndex, 1)
  check('已模拟 live 列表缺失', !!removedLive && !store.rules.some((r) => r.version === 'v9.1.0'))
  const fallback = projectRuleOrNull(project)
  check('live 缺失时用项目快照读回', fallback?.version === 'v9.1.0')
  check('快照内容就是锁定版（不是别的版本）', fallback?.label === '试验版（有项目）')
  // 放回，保持数据一致
  store.rules.splice(liveIndex, 0, removedLive)

  // 8) 留痕：3 条（拦内置、拦引用、删成功），最新在前
  const entries = await listRuleAudit(20)
  check('留痕共 3 条', entries.length === 3, `实际 ${entries.length}`)
  check('最新一条是删除成功', entries[0].action === 'rule_delete' && entries[0].version === 'v9.2.0')
  check('第二条记录被项目引用拦下', entries[1].action === 'rule_delete_blocked' && entries[1].version === 'v9.1.0')
  check('第三条记录内置版拦下', entries[2].action === 'rule_delete_blocked' && entries[2].version === builtinVersions[0])
  check('留痕带操作人', entries.every((e) => e.operator.length > 0))
  check('引用拦截留痕含项目清单', JSON.stringify(entries[1].usedByProjects).includes('某中学 2026 校服'))

  // 9) 幂等：再删一次已删版本不产生新留痕
  const r4 = await requestDeleteRule('v9.2.0')
  const entriesAfter = await listRuleAudit(20)
  check('重复删已不存在的版本返回 missing', r4.deleted === false && r4.reason === 'missing')
  check('幂等删除不新增留痕', entriesAfter.length === entries.length)

  console.log(failures === 0 ? '\n全部通过 ✅' : `\n有 ${failures} 项失败 ❌`)
  process.exitCode = failures === 0 ? 0 : 1
}

function toPlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
