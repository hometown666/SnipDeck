import { watch, type FSWatcher } from 'node:fs'
import MiniSearch from 'minisearch'
import { groupOf, loadSnippets, type SnippetError } from './snippets'
import type { Snippet } from './types'

export class SnippetStore {
  private snippets = new Map<string, Snippet>()
  private errorList: SnippetError[] = []
  private ms: MiniSearch
  private watcher: FSWatcher | null = null
  private debounce: ReturnType<typeof setTimeout> | null = null

  constructor(private dir: string) {
    this.ms = new MiniSearch({ idField: 'id', fields: ['title', 'id', 'group', 'tags', 'body'] })
    this.rebuild()
  }

  private rebuild(): void {
    const { snippets, errors } = loadSnippets(this.dir)
    this.snippets = new Map(snippets.map((s) => [s.id, s]))
    this.errorList = errors
    this.ms = new MiniSearch({ idField: 'id', fields: ['title', 'id', 'group', 'tags', 'body'] })
    this.ms.addAll(
      snippets.map((s) => ({
        id: s.id,
        title: s.title ?? s.id,
        group: groupOf(s, this.dir),
        tags: (s.tags ?? []).join(' '),
        body: s.steps.map((st) => (st.do === 'run' ? st.cmd : '')).join('\n'),
      })),
    )
  }

  reindex(): void {
    this.rebuild()
  }

  watchDir(): void {
    if (this.watcher) return
    try {
      this.watcher = watch(
        this.dir,
        { recursive: true },
        () => {
          if (this.debounce) clearTimeout(this.debounce)
          this.debounce = setTimeout(() => this.rebuild(), 200)
        },
      )
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

  search(q: string): Snippet[] {
    if (!q.trim()) return this.list()
    return this.ms
      .search(q)
      .map((r) => this.snippets.get(String(r.id)))
      .filter((s): s is Snippet => !!s)
  }
}
