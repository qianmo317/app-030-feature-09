/**
 * 规则删除相关操作的本机留痕（删除成功 / 被拦下）。
 * 只写本机 IndexedDB 的 ruleAudit 仓库，不联网、不上传。
 */
import { STORE_AUDIT, idbAdd, idbGetAll } from './idb'
import { store } from './store'
import type { Project, RuleAuditEntry } from './types'

/** 写入留痕时不要求调用方提供 id / 时间 / 操作人，统一在这里补齐；返回写入后的条目 */
export type RuleAuditInput = Omit<RuleAuditEntry, 'id' | 'at' | 'operator'>

export async function appendRuleAudit(input: RuleAuditInput): Promise<RuleAuditEntry> {
  const base: Omit<RuleAuditEntry, 'id'> = {
    ...input,
    at: Date.now(),
    operator: store.operator
  }
  try {
    const id = await idbAdd<Omit<RuleAuditEntry, 'id'>>(STORE_AUDIT, base)
    return { ...base, id }
  } catch (error) {
    // 留痕失败不能静默：交给调用方在界面上提示，避免「删了但没留痕」
    throw new Error(
      `操作已被拒绝：本机留痕写入失败（${error instanceof Error ? error.message : String(error)}）`
    )
  }
}

/** 读取留痕，最新在前 */
export async function listRuleAudit(limit = 20): Promise<RuleAuditEntry[]> {
  const entries = await idbGetAll<RuleAuditEntry>(STORE_AUDIT)
  return entries.sort((a, b) => (b.at === a.at ? b.id - a.id : b.at - a.at)).slice(0, limit)
}

export function projectRefs(projects: Project[]): { id: string; name: string }[] {
  return projects.map((project) => ({ id: project.id, name: project.name }))
}
