import { watch, type FSWatcher } from 'node:fs'
import { groupOf, loadSnippets, type SnippetError } from './snippets'
import type { Snippet } from './types'

/**
 * 搜索用的「一条片段的全部可搜文本」。
 *
 * 为什么不用全文索引库（MiniSearch / 倒排）：它们的默认 tokenizer 只按空白与标点切，
 * CJK 不会进一步分词，`查看实例表` 会变成一个完整 token，查 `实例` 就是 0 命中
 * （ISSUE-002）。当前规模是十几条、上限几百条，`includes()` 的 O(n) 是几十微秒，
 * 用子串匹配换来的是「网页搜到什么，CLI 就搜到什么」这同一套语义。
 * 等真涨到几千条再上 `Intl.Segmenter` 分词或 n-gram，那时再谈建索引。
 */
export function snippetHaystack(s: Snippet, dir: string): string {
  return [
    s.id,
    s.title ?? '',
    groupOf(s, dir),
    (s.tags ?? []).join(' '),
    s.steps.map((st) => (st.do === 'run' ? st.cmd : '')).join('\n'),
  ]
    .join('\n')
    .toLowerCase()
}

/**
 * 命中权重：标题 > id > 标签 > 命令正文。只影响排序，不影响是否命中——
 * 「搜得到」永远不依赖打分。
 */
export function scoreSnippet(s: Snippet, terms: string[]): number {
  const title = (s.title ?? '').toLowerCase()
  const id = s.id.toLowerCase()
  const tags = (s.tags ?? []).join(' ').toLowerCase()
  const body = s.steps
    .map((st) => (st.do === 'run' ? st.cmd : ''))
    .join('\n')
    .toLowerCase()
  let score = 0
  for (const t of terms) {
    if (title.includes(t)) score += 3
    if (id.includes(t)) score += 2
    if (tags.includes(t)) score += 1
    if (body.includes(t)) score += 0.5
  }
  return score
}

export class SnippetStore {
  private snippets = new Map<string, Snippet>()
  private errorList: SnippetError[] = []
  private watcher: FSWatcher | null = null
  private debounce: ReturnType<typeof setTimeout> | null = null

  constructor(private dir: string) {
    this.rebuild()
  }

  private rebuild(): void {
    const { snippets, errors } = loadSnippets(this.dir)
    this.snippets = new Map(snippets.map((s) => [s.id, s]))
    this.errorList = errors
  }

  reindex(): void {
    this.rebuild()
  }

  watchDir(): void {
    if (this.watcher) return
    try {
      this.watcher = watch(this.dir, { recursive: true }, () => {
        if (this.debounce) clearTimeout(this.debounce)
        this.debounce = setTimeout(() => this.rebuild(), 200)
      })
    } catch {
      // 平台不支持 recursive watch 时静默降级，可靠 reindex
    }
  }

  list(): Snippet[] {
    return [...this.snippets.values()]
  }

  get(id: string): Snippet | undefined {
    return this.snippets.get(id)
  }

  errors(): SnippetError[] {
    return this.errorList
  }

  /**
   * 子串匹配，多词按 **AND** 组合（`实例 表` 只出 `查看实例表`）。
   * 大小写与前后空白都不敏感；空查询返回全部。
   */
  search(q: string): Snippet[] {
    const needle = q.trim().toLowerCase()
    if (!needle) return this.list()
    const terms = needle.split(/\s+/)
    const hits: { s: Snippet; score: number }[] = []
    for (const s of this.snippets.values()) {
      const hay = snippetHaystack(s, this.dir)
      if (!terms.every((t) => hay.includes(t))) continue
      hits.push({ s, score: scoreSnippet(s, terms) })
    }
    return hits
      .sort((a, b) => b.score - a.score || a.s.id.localeCompare(b.s.id))
      .map((h) => h.s)
  }
}
