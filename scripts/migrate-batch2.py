# -*- coding: utf-8 -*-
"""
REWRITE-PLAN 2.3 第 2 批 · SnippetList / SnippetEditor 换成 ui-* 组件

按路线 C：原子件（按钮 / 输入 / 标签 / 空状态 / 提示 / 复选框）换类名，
业务块（片段卡 .card、editor-row / editor-step / raw-wrap 等）保留类名，
只把它们的样式对齐 token（第 1 批已通过别名完成）。

同时删掉 styles.css 里会覆盖 @layer components 的旧原子件规则——否则
加了 ui-* 类名也只是语义变化，视觉仍由项目未分层规则决定。

不可重复执行。重跑前请从 backup/第2批前-20261108/ 恢复 packages/web/src。
用法：python scripts/migrate-batch2.py
"""
import io
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'packages', 'web', 'src')
BACKUP = os.path.join(ROOT, 'backup', '第2批前-20261108', 'packages', 'web', 'src')

if not os.path.isdir(BACKUP):
    sys.exit('找不到第 2 批前备份，拒绝执行')


def load(rel):
    # 始终从「第 2 批前」快照读取，脚本因此可重复执行
    with io.open(os.path.join(BACKUP, rel), encoding='utf-8') as f:
        return f.read()


def save(rel, text):
    with io.open(os.path.join(SRC, rel), 'w', encoding='utf-8') as f:
        f.write(text)


def must(old, new, count, label, text):
    n = text.count(old)
    if n != count:
        raise SystemExit('替换失败 [%s]：期望 %d 处，实际 %d 处\n片段：%r' % (label, count, n, old[:110]))
    return text.replace(old, new)


# ===========================================================================
# 1. SnippetList.tsx
# ===========================================================================
s = load('components/SnippetList.tsx')

s = must(
    """        <input
          data-search""",
    """        <input
          className="ui-input"
          data-search""",
    1, 'list 搜索框', s)

s = must(
    """        <div className="banner">
          这台设备还没有 token，先填一次才能执行片段。
          <button className="link" onClick={onFillToken}>
            去填写
          </button>
        </div>""",
    """        <div className="ui-alert ui-alert--warning" style={{ marginTop: 10 }}>
          <div className="ui-alert__body">
            <span className="ui-alert__title">这台设备还没有 token，先填一次才能执行片段。</span>
          </div>
          <button className="ui-btn ui-btn--link ui-btn--sm" onClick={onFillToken}>
            去填写
          </button>
        </div>""",
    1, 'list 缺 token 横幅', s)

s = must(
    """{groups.length === 0 && <p className="empty">没有匹配的片段</p>}""",
    """{groups.length === 0 && (
          <div className="ui-empty"><p className="ui-empty__desc">没有匹配的片段</p></div>
        )}""",
    1, 'list 空状态', s)

save('components/SnippetList.tsx', s)
print('SnippetList.tsx 已更新')

# ===========================================================================
# 2. SnippetEditor.tsx
# ===========================================================================
e = load('components/SnippetEditor.tsx')

# --- 按钮 ---
e = must("""className={`btn${confirmDelete ? ' danger' : ' ghost'}`}""",
         """className={`ui-btn ${confirmDelete ? 'ui-btn--danger' : 'ui-btn--ghost'}`}""",
         1, 'editor 删除按钮', e)
e = must('className="btn ghost"', 'className="ui-btn ui-btn--ghost"', 2, 'editor ghost 按钮', e)
e = must('className="btn primary"', 'className="ui-btn ui-btn--primary"', 1, 'editor 保存按钮', e)
e = must('className="btn tiny"', 'className="ui-btn ui-btn--xs"', 3, 'editor tiny 按钮', e)
e = must('className="icon-btn small"', 'className="ui-btn ui-btn--ghost ui-btn--icon ui-btn--xs"',
         5, 'editor 小图标按钮', e)

# --- 表单 / 原文 模式切换 ---
e = must("""className={`editor-tab${mode === 'form' ? ' on' : ''}`}""",
         """className={`ui-btn ui-btn--sm ${mode === 'form' ? 'ui-btn--primary' : 'ui-btn--ghost'}`}""",
         1, 'editor 表单 tab', e)
e = must("""className={`editor-tab${mode === 'raw' ? ' on' : ''}`}""",
         """className={`ui-btn ui-btn--sm ${mode === 'raw' ? 'ui-btn--primary' : 'ui-btn--ghost'}`}""",
         1, 'editor 原文 tab', e)

# --- 空状态 / 错误提示 ---
e = must('<p className="empty">加载中…</p>',
         '<div className="ui-empty"><p className="ui-empty__desc">加载中…</p></div>',
         1, 'editor 加载中', e)
e = must('<p className="empty">读取原文…</p>',
         '<div className="ui-empty"><p className="ui-empty__desc">读取原文…</p></div>',
         1, 'editor 读取原文', e)
e = must('<p className="form-error">{loadError}</p>',
         """<div className="ui-alert ui-alert--danger"><div className="ui-alert__body"><span className="ui-alert__title">{loadError}</span></div></div>""",
         1, 'editor 加载错误', e)
e = must('<p className="form-error">{error}</p>',
         """<div className="ui-alert ui-alert--danger"><div className="ui-alert__body"><span className="ui-alert__title">{error}</span></div></div>""",
         1, 'editor 表单错误', e)

# --- mono 输入先标记，避免后面被通用规则重复加类 ---
e, n_ta = re.subn(r'(<textarea\s+)className="mono"', r'\1className="ui-textarea mono"', e, count=1)
if n_ta != 1:
    raise SystemExit('editor mono textarea 未命中，实际 %d 处' % n_ta)
e = must('className="mono"', 'className="ui-input mono"', 4, 'editor mono input', e)

# --- 复选框：换成 ui-checkbox 的标准 DOM（input + __box + __label） ---
e = must(
    """            <label className="check">
              <input
                type="checkbox"
                checked={form.danger}
                onChange={(e) => patch({ danger: e.target.checked })}
              />
              <span>标记为 danger（执行前要二次确认）</span>
            </label>""",
    """            <label className="ui-checkbox">
              <input
                type="checkbox"
                checked={form.danger}
                onChange={(e) => patch({ danger: e.target.checked })}
              />
              <span className="ui-checkbox__box" aria-hidden="true" />
              <span className="ui-checkbox__label">标记为 danger（执行前要二次确认）</span>
            </label>""",
    1, 'editor danger 复选框', e)

e = must(
    """                  <label className="mini-check" title="secret 变量的值不会回显，也不落运行档案">
                    <input
                      type="checkbox"
                      checked={v.secret}
                      onChange={(e) => patchVar(i, { secret: e.target.checked })}
                    />
                    secret
                  </label>""",
    """                  <label className="ui-checkbox mini" title="secret 变量的值不会回显，也不落运行档案">
                    <input
                      type="checkbox"
                      checked={v.secret}
                      onChange={(e) => patchVar(i, { secret: e.target.checked })}
                    />
                    <span className="ui-checkbox__box" aria-hidden="true" />
                    <span className="ui-checkbox__label">secret</span>
                  </label>""",
    1, 'editor secret 复选框', e)

e = must(
    """                    <label className="mini-check" title="失败也继续往下走">
                      <input
                        type="checkbox"
                        checked={s.optional}
                        onChange={(e) => patchStep(i, { optional: e.target.checked })}
                      />
                      可失败
                    </label>""",
    """                    <label className="ui-checkbox mini" title="失败也继续往下走">
                      <input
                        type="checkbox"
                        checked={s.optional}
                        onChange={(e) => patchStep(i, { optional: e.target.checked })}
                      />
                      <span className="ui-checkbox__box" aria-hidden="true" />
                      <span className="ui-checkbox__label">可失败</span>
                    </label>""",
    1, 'editor optional 复选框', e)

# --- 其余 input / select / textarea 统一补组件类 ---
TAG_CLASS = {'input': 'ui-input', 'select': 'ui-input', 'textarea': 'ui-textarea'}


def add_component_class(m):
    tag = m.group(1)
    start = m.start()
    end = e.find('>', start)
    chunk = e[start:end]
    if 'className=' in chunk:
        return m.group(0)          # 已经处理过（mono / raw-text）
    if 'type="checkbox"' in chunk:
        return m.group(0)          # ui-checkbox 的原生 input 不能套 ui-input
    return '<%s className="%s"' % (tag, TAG_CLASS[tag])


e, n = re.subn(r'<(input|select|textarea)(?=\s)', add_component_class, e)
print('SnippetEditor.tsx 补类名标签数:', n)

save('components/SnippetEditor.tsx', e)
print('SnippetEditor.tsx 已更新')

# ===========================================================================
# 3. styles.css：收敛旧原子件规则
# ===========================================================================
c = load('styles.css')

# 多选择器规则拆开：只保留侧栏搜索框，主区搜索框交给 .ui-input
c = must('.searchbar input,\n.sidebar-search input {', '.sidebar-search input {', 1, '拆分搜索规则', c)
c = must('.searchbar input:focus,\n.sidebar-search input:focus {', '.sidebar-search input:focus {', 1,
         '拆分搜索 focus 规则', c)
c = must('.editor-section h4 .btn.tiny {', '.editor-section h4 .ui-btn--xs {', 1,
         'h4 按钮右对齐选择器', c)

DROP = [
    '.btn {', '.btn.primary {', '.btn.danger {', '.btn.ghost {', '.btn.tiny {',
    '.icon-btn.small {', '.icon-btn:disabled {',
    '.editor-tab {', '.editor-tab.on {', '.editor-tab:disabled {',
    '.empty {', '.banner {', '.link {', '.form-error {',
    '.check {', '.check input {', '.mini-check {',
    '.field input,', '.editor-row.tight input {', '.editor-row input {', '.editor-row input.mono {',
]


def drop_rule(css, prefix):
    m = re.search(r'(?m)^' + re.escape(prefix), css)
    if not m:
        raise SystemExit('未找到待删规则: ' + prefix)
    i = m.start()
    b = css.index('{', i)
    depth, j = 1, b + 1
    while depth:
        if css[j] == '{':
            depth += 1
        elif css[j] == '}':
            depth -= 1
        j += 1
    # 连带吃掉规则后面的空行
    while j < len(css) and css[j] == '\n':
        j += 1
    return css[:i] + css[j:]


for d in DROP:
    c = drop_rule(c, d)
print('已删除旧规则:', len(DROP), '条')

c += '''
/* ==========================================================================
   第 2 批 · 原子件改用组件库后的布局兜底
   （这些只是尺寸/字体，颜色边框全部由 @layer components 的 ui-* 提供）
   ========================================================================== */
.searchbar .ui-input { width: 100%; }
.editor-grid .field .ui-input { width: 100%; }
.editor-row .ui-input, .editor-row .ui-textarea { min-width: 0; }
.editor-row.tight .ui-input { max-width: 240px; }
.ui-input.mono, .ui-textarea.mono { font-family: var(--ui-font-mono); font-size: var(--ui-text-xs); }
.ui-checkbox.mini .ui-checkbox__label { font-size: var(--ui-text-xs); }
'''
save('styles.css', c)
print('styles.css 已更新，行数:', c.count('\n') + 1)
print('\n完成。接下来跑 npm run typecheck --workspace @snipdeck/web 与 npm run build:web。')
