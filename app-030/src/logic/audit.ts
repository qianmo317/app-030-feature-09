/**
 * 本机操作留痕：规则版本的删除与删除拦截都会写入 IndexedDB，数据不出本地。
 */
import { idbGetAll, idbPut, STORE_AUDIT } from './idb'

export type AuditAction = 'rule_deleted' | 'rule_delete_blocked'

export type AuditEntry = {
  id: string
  at: number
  action: AuditAction
  /** 涉及的规则版本号 */
  version: string
  /** 规则版本说明（删除时的快照，便于事后核对） */
  label: string
  /** 人话描述：被哪些项目引用拦下 / 删除前的确认信息 */
  detail: string
  operator: string
}

export async function appendAudit(entry: Omit<AuditEntry, 'id' | 'at'>): Promise<AuditEntry> {
  const full: AuditEntry = {
    ...entry,
    id: `audit_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    at: Date.now()
  }
  await idbPut(STORE_AUDIT, full)
  return full
}

/** 全部留痕记录，按时间倒序（最新在前） */
export async function listAudit(): Promise<AuditEntry[]> {
  const entries = await idbGetAll<AuditEntry>(STORE_AUDIT)
  return entries.sort((a, b) => b.at - a.at)
}
