import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 元数据中心作废传播的常量：条目与版本变更先形成新结论，再沿版本记录、血缘引用、编目引用传播。
const META_KEY = 'meta'
const VOID_ACTION = '作废条目'
const PUBLISH_ACTION = '生效发布'
const VOIDED_STATUS = '已作废'
const EFFECTIVE_STATUS = '已生效'
const CONCLUSION_SPLIT = '｜'
const NAME_LIST_SPLIT = /[、,，;；|]/

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

// ---------- 状态机：状态只能按顺序单向推进 ----------

// 校验「当前状态 → 目标状态」是否合法：不允许回退；默认要求源状态是目标状态的前一位，
// 个别动作（如批处理的终止）在模块登记里用 actionSources 显式声明源状态。
function checkTransition(meta: ModuleMeta, action: string, current: string, target: string): string {
  const currentIndex = meta.statuses.indexOf(current)
  const targetIndex = meta.statuses.indexOf(target)
  if (targetIndex < 0) {
    return `${meta.entity}没有登记「${target}」这个状态`
  }
  if (currentIndex < 0) {
    return `${meta.entity}当前状态「${current}」未登记，不能执行「${action}」`
  }
  if (targetIndex < currentIndex) {
    return `${meta.entity}不能从「${current}」回退到「${target}」：状态只能按顺序单向推进`
  }
  const source = meta.actionSources?.[action] ?? meta.statuses[targetIndex - 1]
  if (source && current !== source) {
    return `${meta.entity}当前状态是「${current}」，不能执行「${action}」：状态只能按顺序单向推进，「${action}」要求当前状态为「${source}」`
  }
  return ''
}

// ---------- 元数据中心：条目与版本变更的结论 ----------

// 版本变更字段形如「v1.2｜已生效」：竖线前是版本号，竖线后是当前结论。
function versionLabel(value: unknown): string {
  return String(value ?? '').split(CONCLUSION_SPLIT)[0].trim()
}

function withConclusion(value: unknown, conclusion: string): string {
  const label = versionLabel(value)
  return label ? `${label}${CONCLUSION_SPLIT}${conclusion}` : conclusion
}

function entryCodeOf(row: EntryRow): string {
  return String(row['条目编号'] ?? row.id)
}

// 对象还剩已生效版本时，返回最新一个（编号最大）的版本号；没有则返回空串。
function latestEffectiveVersionLabel(objectName: string): string {
  const effective = listRows(META_KEY).filter(
    (row) => String(row['对象名称'] ?? '').trim() === objectName && row.status === EFFECTIVE_STATUS,
  )
  if (effective.length === 0) {
    return ''
  }
  const latest = effective.reduce((a, b) => (Number(a.id) >= Number(b.id) ? a : b))
  return versionLabel(latest['版本变更'])
}

function parseNameList(value: unknown): string[] {
  return String(value ?? '')
    .split(NAME_LIST_SPLIT)
    .map((item) => item.trim())
    .filter(Boolean)
}

function formatNameList(names: string[]): string {
  return names.join('、')
}

function today(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

// ---------- 元数据中心：作废影响的传播与校验 ----------

type PropagationResult = ActionResult & { affected: number }

// 作废后的影响传播：版本快照转历史结论、血缘活跃节点摘除引用、已发布目录同步最新有效版本。
// 每一步改完立即落库，且每步都幂等（以数据现状为断点）：失败时已处理节点保留，
// 再次执行「作废条目」只补做剩下的部分，不会重复传播。
function propagateMetaVoid(entry: EntryRow, baseChanges: string[], baseAffected: number): PropagationResult {
  const objectName = String(entry['对象名称'] ?? '').trim()
  const entryCode = entryCodeOf(entry)
  const changes = [...baseChanges]
  const failures: string[] = []
  let affected = baseAffected

  if (objectName) {
    // 1) 版本记录：对象已没有已生效版本时，相关版本快照转为历史结论（已过期）。
    //    已过期等老记录保持原值，不再回写。
    if (latestEffectiveVersionLabel(objectName) === '') {
      const rows = listRows('snapshot')
      const done: string[] = []
      const next = rows.map((row) => {
        if (row.status === EFFECTIVE_STATUS && String(row['目标表名'] ?? '').trim() === objectName) {
          done.push(String(row['快照编号'] ?? row.id))
          return { ...row, status: '已过期', pending: false }
        }
        return row
      })
      if (done.length > 0) {
        saveRows('snapshot', next)
        affected += done.length
        changes.push(`版本快照${done.join('、')}转为历史结论（已过期）`)
      }
    }

    // 2) 血缘图谱：活跃节点（草稿/待校验/已启用）的上游、下游列表摘除该对象，
    //    新的节点关系不能再引用它；已停用节点是历史结论，保持原值。
    {
      const rows = listRows('lineage')
      const done: string[] = []
      const next = rows.map((row) => {
        if (row.status === '已停用') {
          return row
        }
        let updated = row
        const hitFields: string[] = []
        for (const field of ['上游节点列表', '下游节点列表']) {
          const names = parseNameList(updated[field])
          const kept = names.filter((name) => name !== objectName && name !== entryCode)
          if (kept.length !== names.length) {
            updated = { ...updated, [field]: formatNameList(kept) }
            hitFields.push(field)
          }
        }
        if (hitFields.length > 0) {
          done.push(`${String(updated['节点编号'] ?? updated.id)}（${hitFields.join('、')}）`)
          return updated
        }
        return row
      })
      if (done.length > 0) {
        saveRows('lineage', next)
        affected += done.length
        changes.push(`血缘节点${done.join('、')}已摘除对「${objectName}」的引用`)
      }
    }

    // 3) 数据编目：已发布目录同步取到最新有效版本；目录引用对不上时明确报错，
    //    指出编目编号和丢失的属性，原属性值保留不丢。
    {
      const rows = listRows('catalog')
      const done: string[] = []
      const next = rows.map((row) => {
        if (row.status !== '已发布' || String(row['数据集名称'] ?? '').trim() !== objectName) {
          return row
        }
        const latest = latestEffectiveVersionLabel(objectName)
        if (!latest) {
          failures.push(
            `数据目录${String(row['编目编号'] ?? row.id)}引用的对象「${objectName}」已没有有效版本，丢失属性：编目版本（原值${String(row['编目版本'] ?? '—')}）`,
          )
          return row
        }
        const pinned = String(row['编目版本'] ?? '').trim()
        if (pinned !== latest) {
          done.push(`${String(row['编目编号'] ?? row.id)}（编目版本${pinned || '—'}→${latest}）`)
          return { ...row, 编目版本: latest }
        }
        return row
      })
      if (done.length > 0) {
        saveRows('catalog', next)
        affected += done.length
        changes.push(`数据目录${done.join('、')}已同步到最新有效版本`)
      }
    }
  }

  // 4) 一致性校验：条目仍显示已生效、节点关系残留旧值、目录引用对不上，都要明确报错。
  failures.push(...verifyMetaVoid(objectName, entryCode))

  // 5) 跨业务链路的执行记录：与本次结果一致，落到操作审计（节点关系变更清单一并持久化）。
  //    只有本次执行真的改了数据才写记录：同一对象重复作废、或阻塞未解除的再次尝试，
  //    都不会重复产生传播影响。
  if (affected > 0) {
    appendVoidAudit(entryCode, objectName, changes, failures, affected)
  }

  if (failures.length > 0) {
    return {
      ok: false,
      affected,
      message: `影响传播未完成：${failures.join('；')}。已处理的节点已保留，处理完阻塞后再次执行「${VOID_ACTION}」将从断点继续`,
    }
  }
  return {
    ok: true,
    affected,
    message: changes.length > 0 ? `影响传播完成：${changes.join('；')}` : '影响传播完成：没有需要更新的关联引用',
  }
}

// 修复后的兜底校验：任何一处仍对不上，都报出节点编号/编目编号和丢失的属性。
function verifyMetaVoid(objectName: string, entryCode: string): string[] {
  const problems: string[] = []
  const entry = listRows(META_KEY).find((row) => entryCodeOf(row) === entryCode)
  if (entry && (entry.status !== VOIDED_STATUS || String(entry['版本变更'] ?? '').includes(EFFECTIVE_STATUS))) {
    problems.push(`元数据条目${entryCode}仍显示已生效，丢失属性：版本变更结论`)
  }
  if (!objectName) {
    return problems
  }
  for (const row of listRows('lineage')) {
    if (row.status === '已停用') {
      continue
    }
    for (const field of ['上游节点列表', '下游节点列表']) {
      const names = parseNameList(row[field])
      if (names.includes(objectName) || names.includes(entryCode)) {
        problems.push(`血缘节点${String(row['节点编号'] ?? row.id)}的${field}仍残留旧值「${objectName}」`)
      }
    }
  }
  const latest = latestEffectiveVersionLabel(objectName)
  if (latest) {
    for (const row of listRows('catalog')) {
      if (row.status !== '已发布' || String(row['数据集名称'] ?? '').trim() !== objectName) {
        continue
      }
      const pinned = String(row['编目版本'] ?? '').trim()
      if (pinned !== latest) {
        problems.push(
          `数据目录${String(row['编目编号'] ?? row.id)}的编目版本仍是旧值${pinned || '—'}，丢失属性：编目版本（应为${latest}）`,
        )
      }
    }
  }
  return problems
}

// 执行记录落到操作审计：成功即归档；传播中断则留待审核，详情里写清断点与丢失属性。
function appendVoidAudit(
  entryCode: string,
  objectName: string,
  changes: string[],
  failures: string[],
  affected: number,
): void {
  const rows = listRows('audit')
  const nextId = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const ok = failures.length === 0
  const detail = [
    `元数据条目${entryCode}${objectName ? `（对象${objectName}）` : ''}作废传播`,
    changes.length > 0 ? changes.join('；') : '关联引用无需更新',
    failures.length > 0 ? `中断：${failures.join('；')}` : '',
  ]
    .filter(Boolean)
    .join('。')
  saveRows('audit', [
    ...rows,
    {
      id: nextId,
      status: ok ? '已归档' : '待审核',
      pending: !ok,
      abnormal: !ok,
      日志编号: `AUDI-${String(nextId).padStart(4, '0')}`,
      操作类型: '作废传播',
      操作对象: entryCode,
      操作详情: detail,
      操作来源: '元数据中心',
      执行时间: today(),
      影响行数: affected,
      回滚能力: '不可回滚',
    },
  ])
}

// 作废条目：条目状态与版本变更先形成新结论并落库，再做影响传播。
function voidMetaEntry(rows: EntryRow[], index: number): ActionResult {
  const entry = rows[index]
  const entryCode = entryCodeOf(entry)
  const next = [...rows]
  next[index] = {
    ...entry,
    status: VOIDED_STATUS,
    pending: false,
    abnormal: true,
    版本变更: withConclusion(entry['版本变更'], VOIDED_STATUS),
  }
  saveRows(META_KEY, next)
  const result = propagateMetaVoid(next[index], [`元数据条目${entryCode}已作废、版本变更转为历史结论`], 1)
  if (!result.ok) {
    return { ok: false, message: `元数据条目已作废，但${result.message}` }
  }
  return { ok: true, message: `元数据条目已作废，当前状态「${VOIDED_STATUS}」；${result.message}` }
}

// 已作废的条目再次点「作废条目」：传播没走完就从断点继续，都走完了就提示不用重复操作。
function resumeMetaVoid(rows: EntryRow[], index: number): ActionResult {
  const entry = rows[index]
  const entryCode = entryCodeOf(entry)
  const baseChanges: string[] = []
  let baseAffected = 0
  let working = entry
  // 历史数据可能只改了状态、版本变更还停在旧结论，这里先把结论补齐（不覆盖版本号）。
  const fixed = withConclusion(entry['版本变更'], VOIDED_STATUS)
  if (fixed !== String(entry['版本变更'] ?? '')) {
    const next = [...rows]
    working = { ...entry, 版本变更: fixed }
    next[index] = working
    saveRows(META_KEY, next)
    baseAffected = 1
    baseChanges.push(`元数据条目${entryCode}的版本变更补齐历史结论`)
  }
  const result = propagateMetaVoid(working, baseChanges, baseAffected)
  if (!result.ok) {
    return { ok: false, message: result.message }
  }
  if (result.affected === 0) {
    return { ok: false, message: `元数据条目已经是「${VOIDED_STATUS}」，不用重复操作` }
  }
  return { ok: true, message: `作废影响已从断点继续并完成；${result.message}` }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  // 元数据条目已作废后再点「作废条目」：传播未完成则从断点继续，已完成则不用重复操作。
  if (key === META_KEY && action === VOID_ACTION && current === VOIDED_STATUS) {
    return resumeMetaVoid(rows, index)
  }
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  // 状态只能按顺序单向推进：作废只能从已生效发生，其余动作同样不许跳步、不许回退。
  const orderError = checkTransition(meta, action, current, target)
  if (orderError) {
    return { ok: false, message: orderError }
  }
  // 元数据条目作废：先形成新结论，再沿版本记录、血缘引用、编目引用传播。
  if (key === META_KEY && action === VOID_ACTION) {
    return voidMetaEntry(rows, index)
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  // 生效发布同样要让条目与版本变更一起形成新结论。
  if (key === META_KEY && action === PUBLISH_ACTION) {
    updated['版本变更'] = withConclusion(updated['版本变更'], EFFECTIVE_STATUS)
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
