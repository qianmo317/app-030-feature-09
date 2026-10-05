/**
 * 本机离线存储（IndexedDB）。量体现场无网也能录入，数据不出本地。
 */

const DB_NAME = 'app030-uniform-tally'
const DB_VERSION = 2

export const STORE_PROJECTS = 'projects'
export const STORE_RULES = 'rules'
export const STORE_META = 'meta'
export const STORE_AUDIT = 'ruleAudit'

export type MetaEntry = { key: string; value: string }

function idbAvailable(): boolean {
  return typeof indexedDB !== 'undefined' && indexedDB !== null
}

let dbPromise: Promise<IDBDatabase> | null = null

export function openDb(): Promise<IDBDatabase> {
  if (!idbAvailable()) {
    return Promise.reject(new Error('当前浏览器不支持 IndexedDB，无法在本机离线保存数据'))
  }
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(STORE_PROJECTS)) db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' })
        if (!db.objectStoreNames.contains(STORE_RULES)) db.createObjectStore(STORE_RULES, { keyPath: 'version' })
        if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META, { keyPath: 'key' })
        // v2：规则删除 / 拦下动作的本机留痕
        if (!db.objectStoreNames.contains(STORE_AUDIT))
          db.createObjectStore(STORE_AUDIT, { keyPath: 'id', autoIncrement: true })
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('IndexedDB 打开失败'))
      request.onblocked = () => reject(new Error('IndexedDB 被其它标签页占用'))
    })
  }
  return dbPromise
}

async function runRequest<T>(
  storeName: string,
  mode: IDBTransactionMode,
  build: (store: IDBObjectStore) => IDBRequest
): Promise<T> {
  const db = await openDb()
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(storeName, mode)
    const request = build(transaction.objectStore(storeName))
    transaction.oncomplete = () => resolve(request.result as T)
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB 事务失败'))
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB 事务被中止'))
  })
}

export function idbGetAll<T>(storeName: string): Promise<T[]> {
  return runRequest<T[]>(storeName, 'readonly', (store) => store.getAll())
}

export function idbGet<T>(storeName: string, key: string): Promise<T | undefined> {
  return runRequest<T | undefined>(storeName, 'readonly', (store) => store.get(key))
}

export function idbPut<T>(storeName: string, value: T): Promise<void> {
  return runRequest<void>(storeName, 'readwrite', (store) => store.put(value))
}

/** 追加一条记录，返回自增主键（用于审计留痕这种 keyPath autoIncrement 的仓库） */
export function idbAdd<T>(storeName: string, value: T): Promise<number> {
  return runRequest<number>(storeName, 'readwrite', (store) => store.add(value))
}

export function idbPutMany<T>(storeName: string, values: T[]): Promise<void> {
  return runRequest<void>(storeName, 'readwrite', (store) => {
    for (const value of values) store.put(value)
    return store.count()
  })
}

export function idbDelete(storeName: string, key: string): Promise<void> {
  return runRequest<void>(storeName, 'readwrite', (store) => store.delete(key))
}