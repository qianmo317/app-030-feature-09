/**
 * 全局响应式状态（Vue 自带 reactive / computed，不引入 Pinia）+ IndexedDB 持久化。
 * 数据只写在本机浏览器，没有任何服务端请求。
 */
import { computed, reactive, toRaw } from 'vue'
import type { Project, ProjectKind, SizeRule } from './types'
import { BUILTIN_RULES, DEFAULT_RULE_VERSION, ruleByVersion } from './sizeRules'
import { runMerge } from './merge'
import { appendAudit } from './audit'
import {
  STORE_META,
  STORE_PROJECTS,
  STORE_RULES,
  STORE_RULES_ARCHIVE,
  idbDelete,
  idbGetAll,
  idbPut,
  type MetaEntry
} from './idb'

export type AppStore = {
  ready: boolean
  error: string
  projects: Project[]
  rules: SizeRule[]
  operator: string
}

export const store = reactive<AppStore>({
  ready: false,
  error: '',
  projects: [],
  rules: [...BUILTIN_RULES],
  operator: '现场录入员'
})

export const ruleVersions = computed(() => store.rules.map((rule) => rule.version))

/**
 * 已删除自定义版本的归档（按 version 索引）。
 * 版本从列表删除后不再出现在规则列表与新建项目下拉里，但锁定过该版本的项目页
 * 仍能按项目自己锁定的版本把规则读回来，不会空白、也不会串到别的版本。
 */
const archivedRules = new Map<string, SizeRule>()

const persistTimers = new Map<string, number>()

function sortProjects(): void {
  store.projects.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function initStore(): Promise<void> {
  try {
    const [projects, rules, meta, archived] = await Promise.all([
      idbGetAll<Project>(STORE_PROJECTS),
      idbGetAll<SizeRule>(STORE_RULES),
      idbGetAll<MetaEntry>(STORE_META),
      idbGetAll<SizeRule>(STORE_RULES_ARCHIVE)
    ])
    archivedRules.clear()
    for (const rule of archived) archivedRules.set(rule.version, rule)
    const customRules = rules.filter((rule) => !rule.builtin)
    store.rules = [...BUILTIN_RULES, ...customRules].sort((a, b) =>
      a.effectiveFrom === b.effectiveFrom
        ? a.version.localeCompare(b.version)
        : a.effectiveFrom.localeCompare(b.effectiveFrom)
    )
    const missingBuiltin = BUILTIN_RULES.filter(
      (builtin) => !rules.some((rule) => rule.version === builtin.version)
    )
    if (missingBuiltin.length > 0) {
      for (const rule of missingBuiltin) await idbPut(STORE_RULES, rule)
    }
    store.projects = projects
    sortProjects()
    const operator = meta.find((entry) => entry.key === 'operator')
    if (operator) store.operator = operator.value
    store.ready = true
  } catch (error) {
    store.error = error instanceof Error ? error.message : String(error)
    store.ready = true
  }
}

export function getProject(id: string | string[]): Project | undefined {
  const key = Array.isArray(id) ? id[0] : id
  return store.projects.find((project) => project.id === key)
}

/**
 * 按版本号取规则：先查在用列表，再查已删除版本的归档（项目锁定版本不随列表增删而变），
 * 最后才兜底到首个可用版本，避免项目页因列表里少了一版而空白或串到别的版本。
 */
export function getRule(version: string): SizeRule {
  const active = store.rules.find((rule) => rule.version === version)
  if (active) return active
  const archived = archivedRules.get(version)
  if (archived) return archived
  return ruleByVersion(store.rules, version)
}

/** 该版本是否仍在在用列表中（false 表示已删除归档或从未存在） */
export function isRuleActive(version: string): boolean {
  return store.rules.some((rule) => rule.version === version)
}

export function projectsUsingRule(version: string): Project[] {
  return store.projects.filter((project) => project.ruleVersion === version)
}

export function isRuleInUse(version: string): boolean {
  return projectsUsingRule(version).length > 0
}

export function makeProjectId(): string {
  return `prj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

export async function createProject(input: {
  name: string
  kind: ProjectKind
  batches: string[]
  ruleVersion: string
}): Promise<Project> {
  const now = Date.now()
  // 只允许锁定在用列表里的版本，避免下拉残留已删除版本导致新项目锁定到失效版本
  const ruleVersion = isRuleActive(input.ruleVersion) ? input.ruleVersion : DEFAULT_RULE_VERSION
  const project: Project = {
    id: makeProjectId(),
    name: input.name.trim(),
    kind: input.kind,
    ruleVersion,
    batches: input.batches.length > 0 ? input.batches : [],
    persons: [],
    imports: [],
    createdAt: now,
    updatedAt: now
  }
  store.projects.unshift(project)
  await idbPut(STORE_PROJECTS, toRaw(project))
  return project
}

/**
 * 归并前的准备：按项目锁定版本执行归并（幂等），并记录本次耗时。
 * 结果始终来自项目锁定的规则版本，规则改版不会改变既有项目结果。
 */
export function ensureMerged(project: Project): number {
  const rule = getRule(project.ruleVersion)
  const result = runMerge(project, rule)
  project.perf = { ...(project.perf ?? {}), mergeMs: result.durationMs, mergeCount: project.persons.length }
  return result.durationMs
}

/** 保存项目：默认合并短时间内的连续写入，避免连续录入时频繁落盘 */
export function persistProject(project: Project, immediate = false): void {
  project.updatedAt = Date.now()
  if (!store.projects.some((item) => item.id === project.id)) store.projects.unshift(project)
  sortProjects()
  const pending = persistTimers.get(project.id)
  if (pending) window.clearTimeout(pending)
  if (immediate) {
    persistTimers.delete(project.id)
    void idbPut(STORE_PROJECTS, toRaw(project))
    return
  }
  const timer = window.setTimeout(() => {
    persistTimers.delete(project.id)
    void idbPut(STORE_PROJECTS, toRaw(project))
  }, 180)
  persistTimers.set(project.id, timer)
}

/** 立即落盘（导出、离开页面前调用），保证离线数据完整 */
export async function flushProject(project: Project): Promise<void> {
  const pending = persistTimers.get(project.id)
  if (pending) {
    window.clearTimeout(pending)
    persistTimers.delete(project.id)
  }
  project.updatedAt = Date.now()
  await idbPut(STORE_PROJECTS, toRaw(project))
  if (!store.projects.some((item) => item.id === project.id)) store.projects.unshift(project)
  sortProjects()
}

export async function deleteProject(id: string): Promise<void> {
  store.projects = store.projects.filter((project) => project.id !== id)
  await idbDelete(STORE_PROJECTS, id)
}

export async function saveRule(rule: SizeRule): Promise<void> {
  const index = store.rules.findIndex((item) => item.version === rule.version)
  if (index >= 0) store.rules[index] = rule
  else store.rules.push(rule)
  store.rules.sort((a, b) =>
    a.effectiveFrom === b.effectiveFrom
      ? a.version.localeCompare(b.version)
      : a.effectiveFrom.localeCompare(b.effectiveFrom)
  )
  // 同名版本重新启用时清掉归档里的旧快照，保证归档只保留「已删除」的版本
  archivedRules.delete(rule.version)
  await idbDelete(STORE_RULES_ARCHIVE, rule.version)
  await idbPut(STORE_RULES, toRaw(rule))
}

export type RuleDeleteResult =
  | { ok: true }
  | { ok: false; reason: 'builtin' | 'in_use' | 'missing'; usedBy: Project[] }

/**
 * 删除自定义规则版本。内置版本与被项目引用的版本一律拦下，并说明拦下原因；
 * 确认无人引用的版本移入归档（项目页仍可按锁定版本读回规则），从在用列表移除。
 * 删除与拦下都会写入本机留痕。
 */
export async function deleteRule(version: string): Promise<RuleDeleteResult> {
  const rule = store.rules.find((item) => item.version === version)
  if (!rule) return { ok: false, reason: 'missing', usedBy: [] }
  if (rule.builtin) {
    await appendAudit({
      action: 'rule_delete_blocked',
      version: rule.version,
      label: rule.label,
      detail: '内置版本为只读基线，任何情况下不可删除',
      operator: store.operator
    })
    return { ok: false, reason: 'builtin', usedBy: [] }
  }
  const usedBy = projectsUsingRule(version)
  if (usedBy.length > 0) {
    await appendAudit({
      action: 'rule_delete_blocked',
      version: rule.version,
      label: rule.label,
      detail: `正被 ${usedBy.length} 个项目引用：${usedBy.map((project) => `「${project.name}」`).join('、')}`,
      operator: store.operator
    })
    return { ok: false, reason: 'in_use', usedBy }
  }
  archivedRules.set(rule.version, toRaw(rule))
  await idbPut(STORE_RULES_ARCHIVE, toRaw(rule))
  store.rules = store.rules.filter((item) => item.version !== version)
  await idbDelete(STORE_RULES, version)
  await appendAudit({
    action: 'rule_deleted',
    version: rule.version,
    label: rule.label,
    detail: '未被任何项目引用，已从版本列表与新建项目下拉移除；已导出的下单表不受影响',
    operator: store.operator
  })
  return { ok: true }
}

export async function setOperator(name: string): Promise<void> {
  store.operator = name
  await idbPut<MetaEntry>(STORE_META, { key: 'operator', value: name })
}