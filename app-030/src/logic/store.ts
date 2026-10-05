/**
 * 全局响应式状态（Vue 自带 reactive / computed，不引入 Pinia）+ IndexedDB 持久化。
 * 数据只写在本机浏览器，没有任何服务端请求。
 */
import { computed, reactive, toRaw } from 'vue'
import type { Project, ProjectKind, RuleAuditEntry, SizeRule } from './types'
import { BUILTIN_RULES, DEFAULT_RULE_VERSION, ruleByVersion } from './sizeRules'
import { runMerge } from './merge'
import { appendRuleAudit, projectRefs } from './audit'
import {
  STORE_META,
  STORE_PROJECTS,
  STORE_RULES,
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

const persistTimers = new Map<string, number>()

function sortProjects(): void {
  store.projects.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function initStore(): Promise<void> {
  try {
    const [projects, rules, meta] = await Promise.all([
      idbGetAll<Project>(STORE_PROJECTS),
      idbGetAll<SizeRule>(STORE_RULES),
      idbGetAll<MetaEntry>(STORE_META)
    ])
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
    // 旧数据（创建时还没存快照的项目）按当前列表补齐锁定版本快照并落盘，
    // 保证以后即便对应版本从规则列表消失，项目仍能按自己锁定的这版读回。
    await backfillLockedRules(projects, store.rules)
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

export function getRule(version: string): SizeRule {
  return ruleByVersion(store.rules, version)
}

/**
 * 读取项目锁定的那一版规则：
 * 1) 规则列表里还有该版本 → 用列表里的（仍在的自定义版本允许覆盖保存，以最新内容为准）；
 * 2) 版本已从列表删除 → 用项目自己的 lockedRule 快照读回，不空白、不串到别的版本；
 * 3) 两者都没有（理论上不会发生，删除被项目引用的版本会被拦下）→ 明确报错而不是悄悄用别版。
 */
export function getProjectRule(project: Project): SizeRule {
  const live = store.rules.find((rule) => rule.version === project.ruleVersion)
  if (live) return live
  if (project.lockedRule && project.lockedRule.version === project.ruleVersion) return project.lockedRule
  throw new RuleVersionMissingError(project.ruleVersion)
}

export class RuleVersionMissingError extends Error {
  constructor(public readonly version: string) {
    super(`项目锁定的规则版本 ${version} 在本机已找不到对应规则`)
    this.name = 'RuleVersionMissingError'
  }
}

/** 不抛错版本：规则（列表或快照）缺失时返回 null，由页面明确提示而不是空白或串版 */
export function projectRuleOrNull(project: Project): SizeRule | null {
  try {
    return getProjectRule(project)
  } catch {
    return null
  }
}

function cloneRule(rule: SizeRule): SizeRule {
  return JSON.parse(JSON.stringify(rule)) as SizeRule
}

/** 补齐旧项目的 lockedRule 快照（仅在快照缺失 / 版本对不上时写盘） */
async function backfillLockedRules(projects: Project[], rules: SizeRule[]): Promise<void> {
  for (const project of projects) {
    const matched = rules.find((rule) => rule.version === project.ruleVersion)
    if (matched && project.lockedRule?.version !== project.ruleVersion) {
      project.lockedRule = cloneRule(matched)
      await idbPut(STORE_PROJECTS, toRaw(project))
    }
  }
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
  const version = input.ruleVersion || DEFAULT_RULE_VERSION
  const rule = store.rules.find((item) => item.version === version) ?? BUILTIN_RULES[0]
  const project: Project = {
    id: makeProjectId(),
    name: input.name.trim(),
    kind: input.kind,
    ruleVersion: rule.version,
    // 建项目时把锁定版本的规则整版拷进项目，之后规则列表删版也不影响本项目
    lockedRule: cloneRule(rule),
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
  const rule = projectRuleOrNull(project)
  if (!rule) return 0
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
  await idbPut(STORE_RULES, toRaw(rule))
}

export type DeleteRuleResult =
  | { deleted: true; version: string; audit: RuleAuditEntry }
  | { deleted: false; reason: 'builtin' | 'in_use' | 'missing'; usedBy: Project[]; audit: RuleAuditEntry | null }

/**
 * 删除规则版本的唯一入口：
 * - 内置版本不许删；
 * - 正被项目引用的版本不许删，调用方需把「哪几个项目在用」说清楚；
 * - 确定没人用的自定义版本才删（先写留痕、再删数据）；
 * - 删除成功与被拦下都在本机留痕。
 */
export async function requestDeleteRule(version: string): Promise<DeleteRuleResult> {
  const rule = store.rules.find((item) => item.version === version)
  const usedBy = projectsUsingRule(version)

  if (rule?.builtin) {
    const audit = await appendRuleAudit({
      action: 'rule_delete_blocked',
      version,
      label: rule.label,
      builtin: true,
      usedByProjects: projectRefs(usedBy),
      reason: '内置规则版本不允许删除'
    })
    return { deleted: false, reason: 'builtin', usedBy, audit }
  }

  if (usedBy.length > 0) {
    const names = usedBy.map((project) => project.name).join('、')
    const audit = await appendRuleAudit({
      action: 'rule_delete_blocked',
      version,
      label: rule?.label ?? '',
      builtin: false,
      usedByProjects: projectRefs(usedBy),
      reason: `版本 ${version} 正被 ${usedBy.length} 个项目使用：${names}`
    })
    return { deleted: false, reason: 'in_use', usedBy, audit }
  }

  // 列表里已经没有了（可能其它标签页刚删），按幂等处理，不写删除留痕
  if (!rule) return { deleted: false, reason: 'missing', usedBy: [], audit: null }

  const audit = await appendRuleAudit({
    action: 'rule_delete',
    version,
    label: rule.label,
    builtin: false,
    usedByProjects: [],
    reason: `自定义版本 ${version} 经确认无项目引用，已删除`
  })

  store.rules = store.rules.filter((item) => item.version !== version)
  await idbDelete(STORE_RULES, version)
  return { deleted: true, version, audit }
}

export async function setOperator(name: string): Promise<void> {
  store.operator = name
  await idbPut<MetaEntry>(STORE_META, { key: 'operator', value: name })
}