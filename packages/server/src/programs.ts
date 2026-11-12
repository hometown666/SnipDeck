/**
 * 程序发现（P7.3a/b）：扫 .lnk，交给 core 的纯函数分类。
 *
 * 为什么用 PowerShell + WScript.Shell 而不是解析 .lnk 二进制：Windows 不保证
 * .lnk 的格式稳定，COM 的 CreateShortcut 是唯一官方入口。一次扫描 ~0.7s（本机
 * 310 条），结果缓存 60s，不跟着页面轮询跑。
 *
 * **只扫本机**：和桥同机才成立（`PROG_DIR` 是桥侧的目录）。所以这个接口不收 target——
 * 收了就等于对一个远程目标撒谎。
 */
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, dirname, resolve } from 'node:path'
import {
  decodeText,
  EMPTY_PROGRAMS_CONFIG,
  loadYamlDoc,
  normalizeProgramsConfig,
  normalizeWinPath,
  selectPrograms,
  type ProgramsConfig,
  type ProgramsSelection,
  type ProgramSource,
  type RawProgram,
} from '@snipdeck/core'

/** 交给 PowerShell 的形态：`folder` 是 GetFolderPath 的枚举名（桌面可能被重定向） */
type RootSpec = {
  source: ProgramSource
  path?: string
  folder?: string
  recurse: boolean
  /** 同时扫便携 .exe（只有 extraRoots 开） */
  exe?: boolean
  /** 点名的一个具体文件（only 模式），不再枚举 */
  file?: boolean
}

/**
 * PowerShell 侧只做「枚举 + 解 .lnk」两件事，**不判该不该显示**。
 *
 * 两个坑（都实测过）：
 *  1. `ConvertTo-Json -InputObject @($list)` 在**单元素数组**上直接抛「参数类型不匹配」
 *     （PS 5.1），所以逐条转 JSON 再手工拼数组。
 *  2. 中文路径默认按控制台代码页输出会变乱码，先切 `[Console]::OutputEncoding` 到
 *     UTF-8；即使这一步没生效，Node 侧还有 `decodeText()` 兜底。
 */
const SCAN_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$spec = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:SNIPDECK_SCAN_ROOTS))
# 逐行 JSON（NDJSON）：PS 5.1 里把整个数组喂给 ConvertFrom-Json 时，
# 单元素数组会退化成一个整体对象，$root.folder 直接变成「所有值拼起来的字符串」
$lines = @($spec.Split([char]10) | Where-Object { $_.Trim() -ne '' })

$shell = New-Object -ComObject WScript.Shell
$items = New-Object System.Collections.Generic.List[object]
$scanned = New-Object System.Collections.Generic.List[object]

foreach ($line in $lines) {
  $root = $line | ConvertFrom-Json
  $p = [string]$root.path
  if ($root.folder) { $p = [string][Environment]::GetFolderPath([string]$root.folder) }
  if (-not $p) { continue }
  if (-not (Test-Path -LiteralPath $p)) { continue }

  $files = @()
  if ($root.file) {
    # only 模式：点名的一个具体文件
    $files = @(Get-Item -LiteralPath $p -ErrorAction SilentlyContinue)
  } else {
    $files = @(Get-ChildItem -LiteralPath $p -Filter *.lnk -File -Recurse:([bool]$root.recurse) -ErrorAction SilentlyContinue)
    if ($root.exe) {
      # 便携 exe：**只扫两层**（目录 + 直接子目录）。tools 目录里常混着 node_modules
      # 这类深不见底的子树，放开递归会把几千个 exe 拉进来
      $files += @(Get-ChildItem -LiteralPath $p -Filter *.exe -File -ErrorAction SilentlyContinue)
      if ($root.recurse) {
        foreach ($sub in @(Get-ChildItem -LiteralPath $p -Directory -ErrorAction SilentlyContinue)) {
          $files += @(Get-ChildItem -LiteralPath $sub.FullName -Filter *.exe -File -ErrorAction SilentlyContinue)
        }
      }
    }
  }

  $scanned.Add([pscustomobject]@{ source = [string]$root.source; path = $p; count = $files.Count })
  foreach ($f in $files) {
    $ext = [string]$f.Extension
    if ($ext -ieq '.exe') {
      # 便携程序：没有 .lnk 可解，target 留空，由 Node 侧生成 .lnk 包装
      $items.Add([pscustomobject]@{
        path   = [string]$f.FullName
        name   = [string][IO.Path]::GetFileNameWithoutExtension($f.Name)
        dir    = [string]$f.DirectoryName
        source = [string]$root.source
        target = ''
        args   = ''
        kind   = 'exe'
      })
      continue
    }
    if ($ext -inotmatch '^\.lnk$') { continue }
    $target = ''
    $argText = ''
    try {
      $sc = $shell.CreateShortcut($f.FullName)
      $target = [string]$sc.TargetPath
      $argText = [string]$sc.Arguments
    } catch { }
    $items.Add([pscustomobject]@{
      path   = [string]$f.FullName
      name   = [string][IO.Path]::GetFileNameWithoutExtension($f.Name)
      dir    = [string]$f.DirectoryName
      source = [string]$root.source
      target = $target
      args   = $argText
      kind   = 'lnk'
    })
  }
}
[void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell)

$parts = @(foreach ($it in $items) { $it | ConvertTo-Json -Compress -Depth 3 })
$rootParts = @(foreach ($s in $scanned) { $s | ConvertTo-Json -Compress -Depth 3 })
Write-Output ('{"items":[' + ($parts -join ',') + '],"roots":[' + ($rootParts -join ',') + ']}')
`

type ScanOutput = { items: RawProgram[]; roots: { source: string; path: string; count: number }[] }

export class ProgramsError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message)
    this.name = 'ProgramsError'
  }
}

function runPowerShell(script: string, env: Record<string, string>, timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, env: { ...process.env, ...env } },
    )

    const chunks: Buffer[] = []
    let size = 0
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new ProgramsError(504, `扫描超时（${Math.round(timeoutMs / 1000)}s）`))
    }, timeoutMs)

    child.stdout.on('data', (b: Buffer) => {
      size += b.length
      // 开始菜单再大也就几 MB；给个硬上限，别让一条失控的扫描把内存吃干净
      if (size > 16 * 1024 * 1024) {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          child.kill()
          reject(new ProgramsError(500, '扫描输出超过 16MB，已中止'))
        }
        return
      }
      chunks.push(b)
    })
    child.stderr.on('data', (b: Buffer) => {
      // PS 5.1 会往 stderr 写 CLIXML 进度记录，只在真失败时才用得上
      if (stderr.length < 8192) stderr += b.toString('utf8')
    })
    child.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new ProgramsError(500, `起不来 PowerShell：${e.message}`))
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const text = decodeText(Buffer.concat(chunks)).trim()
      if (!text) {
        const hint = stderr.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300)
        reject(new ProgramsError(500, `扫描没有输出（exit=${String(code)}）${hint ? `：${hint}` : ''}`))
        return
      }
      resolvePromise(text)
    })
  })
}

/** 冒烟 / 离线开发用：设了就直接读这份 JSON，不碰本机开始菜单 */
function fixturePath(): string {
  return (process.env.SNIPDECK_PROGRAMS_FIXTURE ?? '').trim()
}

export async function scanPrograms(roots: RootSpec[]): Promise<ScanOutput> {
  const fixture = fixturePath()
  if (fixture) {
    const raw = JSON.parse(readFileSync(fixture, 'utf8')) as Partial<ScanOutput>
    return { items: raw.items ?? [], roots: raw.roots ?? [] }
  }
  if (roots.length === 0) return { items: [], roots: [] }

  const spec = Buffer.from(
    roots.map((r) => JSON.stringify(r)).join('\n'),
    'utf8',
  ).toString('base64')
  const text = await runPowerShell(SCAN_SCRIPT, { SNIPDECK_SCAN_ROOTS: spec }, 30_000)
  let parsed: ScanOutput
  try {
    parsed = JSON.parse(text) as ScanOutput
  } catch {
    throw new ProgramsError(500, `扫描结果不是 JSON：${text.slice(0, 160)}`)
  }
  return { items: Array.isArray(parsed.items) ? parsed.items : [], roots: parsed.roots ?? [] }
}

/* ——— 扫描范围 ——— */

export function defaultRoots(progDir: string, extraRoots: string[]): RootSpec[] {
  const roots: RootSpec[] = []
  if (progDir) roots.push({ source: 'progDir', path: progDir, recurse: false })
  // extraRoots 是用户自己指的工具目录：除了 .lnk，也收两层以内的便携 .exe
  for (const dir of extraRoots) roots.push({ source: 'extra', path: dir, recurse: true, exe: true })
  // 这四条交给 PowerShell 的 GetFolderPath 展开：桌面可能被重定向（本机就是 D:\Users\Desktop）
  roots.push({ source: 'userMenu', folder: 'Programs', recurse: true })
  roots.push({ source: 'userDesktop', folder: 'Desktop', recurse: false })
  roots.push({ source: 'commonMenu', folder: 'CommonPrograms', recurse: true })
  roots.push({ source: 'commonDesktop', folder: 'CommonDesktopDirectory', recurse: false })
  return roots
}

/* ——— 便携 exe → .lnk 包装 ——— */

/**
 * 为什么要生成 .lnk：桥的 `RunPlain` 只在拿到 `.lnk` 时才解析 `WorkingDirectory`；
 * 直接 `run` 一个 exe，`workDir` 是空的，新进程继承 listener 的工作目录。
 * 便携程序大多要读自己旁边的 dll / 配置，这个差别会以「一启动就报错」暴露，
 * 而且报错离原因很远。包装成 .lnk 后工作目录就是 exe 所在目录。
 */
const WRAP_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$dir = [string]$env:SNIPDECK_WRAP_DIR
$spec = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:SNIPDECK_WRAP_SPEC))
$lines = @($spec.Split([char]10) | Where-Object { $_.Trim() -ne '' })

$shell = New-Object -ComObject WScript.Shell
$out = New-Object System.Collections.Generic.List[object]

foreach ($line in $lines) {
  $it = $line | ConvertFrom-Json
  $exe = [string]$it.exe
  $base = [string]$it.name
  if (-not $exe) { continue }
  if (-not (Test-Path -LiteralPath $exe)) { continue }
  if (-not $base) { $base = [IO.Path]::GetFileNameWithoutExtension($exe) }
  $base = [regex]::Replace($base, '[\\/:*?"<>|]', '_')

  $lnk = ''
  $n = 1
  while ($n -le 50) {
    if ($n -eq 1) { $cand = Join-Path $dir ($base + '.lnk') }
    else { $cand = Join-Path $dir ($base + ' (' + $n + ').lnk') }
    if (-not (Test-Path -LiteralPath $cand)) { $lnk = $cand; break }
    $t = ''
    try { $t = [string]$shell.CreateShortcut($cand).TargetPath } catch { }
    if ($t -and ([IO.Path]::GetFullPath($t) -ieq [IO.Path]::GetFullPath($exe))) { $lnk = $cand; break }
    $n = $n + 1
  }
  if (-not $lnk) { continue }

  if (-not (Test-Path -LiteralPath $lnk)) {
    $sc = $shell.CreateShortcut($lnk)
    $sc.TargetPath = $exe
    # 工作目录 = exe 所在目录。个别目录会让桥报「Parameter #2 invalid.」（实测
    # D:\SumatraPDF 就会；同一个 exe 换个目录就正常，用户自己装的同名 .lnk 也一样）——
    # 那是桥/环境的问题，不是这里产生的，我们只保持和原生快捷方式一致的行为
    $sc.WorkingDirectory = [IO.Path]::GetDirectoryName($exe)
    $sc.IconLocation = ($exe + ',0')
    $sc.Save()
  }
  $out.Add([pscustomobject]@{ exe = $exe; lnk = $lnk })
}
[void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell)

$parts = @(foreach ($o in $out) { $o | ConvertTo-Json -Compress -Depth 3 })
Write-Output ('[' + ($parts -join ',') + ']')
`

type WrapPair = { exe: string; lnk: string }

async function createShortcuts(
  items: { exe: string; name: string }[],
  dir: string,
): Promise<WrapPair[]> {
  mkdirSync(dir, { recursive: true })
  const spec = Buffer.from(items.map((i) => JSON.stringify(i)).join('\n'), 'utf8').toString('base64')
  const text = await runPowerShell(
    WRAP_SCRIPT,
    { SNIPDECK_WRAP_DIR: dir, SNIPDECK_WRAP_SPEC: spec },
    20_000,
  )
  try {
    const parsed = JSON.parse(text) as WrapPair[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    throw new ProgramsError(500, `快捷方式生成结果不是 JSON：${text.slice(0, 160)}`)
  }
}

/** 只处理「还没包装过」的 exe：已经有 `launch` 的原样返回 */
async function wrapExes(
  programs: ProgramsSelection['programs'],
  dir: string,
): Promise<{ programs: ProgramsSelection['programs']; made: number; missing: number }> {
  const todo = programs.filter((p) => p.kind === 'exe' && !/\.lnk$/i.test(p.value))
  if (todo.length === 0) return { programs, made: 0, missing: 0 }

  const pairs = await createShortcuts(
    todo.map((p) => ({ exe: p.path, name: p.name })),
    dir,
  )
  const byExe = new Map(pairs.map((p) => [normalizeWinPath(p.exe), p.lnk]))
  const missing = todo.filter((p) => !byExe.has(normalizeWinPath(p.path))).length

  const next = programs
    .map((p) => {
      if (p.kind !== 'exe') return p
      const lnk = byExe.get(normalizeWinPath(p.path))
      return lnk ? { ...p, value: lnk } : null
    })
    .filter((p): p is ProgramsSelection['programs'][number] => p !== null)

  return { programs: next, made: pairs.length, missing }
}

/* ——— programs.yaml（机器级配置，gitignore） ——— */

export type ProgramsConfigView = {
  config: ProgramsConfig
  /** 文件路径（给界面显示，方便用户自己去看） */
  file: string
  exists: boolean
  problems: string[]
}

export function loadProgramsConfig(file: string): ProgramsConfigView {
  if (!existsSync(file)) {
    return { config: { ...EMPTY_PROGRAMS_CONFIG }, file, exists: false, problems: [] }
  }
  try {
    const data = loadYamlDoc(file).toJS()
    const { config, problems } = normalizeProgramsConfig(data)
    return { config, file, exists: true, problems }
  } catch (e) {
    return {
      config: { ...EMPTY_PROGRAMS_CONFIG },
      file,
      exists: true,
      problems: [`programs.yaml 解析失败：${e instanceof Error ? e.message : String(e)}`],
    }
  }
}

/**
 * 存的时候就把「写了但不生效」挡住：桥不会报错，只会找不到；
 * 界面上写着「只显示这几个」而实际空列表，比报错难查得多。
 */
export function validateProgramsConfig(config: ProgramsConfig): string[] {
  const problems: string[] = []
  const file = (p: string, label: string) => {
    if (!isAbsolute(p)) {
      problems.push(`${label} 必须是绝对路径：${p}`)
      return false
    }
    if (!existsSync(p)) {
      problems.push(`${label} 不存在：${p}`)
      return false
    }
    if (!/\.(lnk|exe)$/i.test(p)) {
      problems.push(`${label} 必须是 .lnk 快捷方式或 .exe 便携程序：${p}`)
      return false
    }
    return true
  }
  for (const p of config.only) file(p, 'only')
  for (const p of config.include) file(p, 'include')
  for (const p of config.extraRoots) {
    if (!isAbsolute(p)) {
      problems.push(`extraRoots 必须是绝对路径：${p}`)
      continue
    }
    if (!existsSync(p)) {
      problems.push(`extraRoots 不存在：${p}`)
      continue
    }
    try {
      if (!statSync(p).isDirectory()) problems.push(`extraRoots 不是目录：${p}`)
    } catch {
      problems.push(`extraRoots 读不到：${p}`)
    }
  }
  return problems
}

const CONFIG_HEADER = `# SnipDeck 程序发现配置（机器级，已 gitignore）
#
# only:       绝对 .lnk 或 .exe 路径。非空 = 跳过自动发现，只显示这些；不套黑名单
# extraRoots: 额外要扫的目录（递归找 .lnk，另外扫两层以内的便携 .exe）
# include:    被黑名单挡掉、但你强制要显示的绝对路径
#
# 便携 .exe 会被包成 .lnk（带工作目录）放进 data/program-links/，删除后可重建。
# 路径里带中文和空格都没问题；反斜杠按 YAML 普通标量写，不用转义。
`

function yamlList(key: string, items: string[]): string {
  if (items.length === 0) return `${key}: []`
  return `${key}:\n${items.map((v) => `  - ${quoteScalar(v)}`).join('\n')}`
}

function quoteScalar(v: string): string {
  // 冒号+空格、井号、引号开头的路径在 YAML 里会被误解析，统一用单引号包起来
  if (/^[\s'"#&*!|>%@`[{]|:\s|^\s|\s$/.test(v)) return `'${v.replace(/'/g, "''")}'`
  return v
}

export function writeProgramsConfig(file: string, config: ProgramsConfig): ProgramsConfigView {
  const problems = validateProgramsConfig(config)
  if (problems.length > 0) throw new ProgramsError(400, problems.join('；'))
  const body = [
    CONFIG_HEADER.trimEnd(),
    yamlList('only', config.only),
    yamlList('extraRoots', config.extraRoots),
    yamlList('include', config.include),
    '',
  ].join('\n')
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, body, 'utf8')
  renameSync(tmp, file)
  return { config, file, exists: true, problems: [] }
}

export function programsConfigPath(dataDir: string): string {
  return resolve(dataDir, 'programs.yaml')
}

/** 只做形状校验（不碰磁盘）：路由层收 body 时用 */
export function normalizeProgramsBody(input: unknown) {
  return normalizeProgramsConfig(input)
}

/* ——— 组合：扫描 + 分类（带 60s 缓存） ——— */

export type ProgramsView = ProgramsSelection & {
  /** 生效的 PROG_DIR（空 = 没设，跳过这一路） */
  progDir: string
  /** 便携 exe 的 .lnk 包装目录（data/program-links） */
  wrapDir: string
  /** 实际扫了哪些目录、各出多少条 */
  roots: { source: string; path: string; count: number }[]
  /** only 生效时没有扫描 */
  mode: 'only' | 'discover'
  scannedAt: number
  cacheAgeMs: number
  config: ProgramsConfig
  configFile: string
  error?: string
  notes: string[]
}

type CacheEntry = { key: string; at: number; value: ProgramsView }
let cache: CacheEntry | null = null
let inflight: { key: string; promise: Promise<ProgramsView> } | null = null

const CACHE_TTL_MS = 60_000

export function clearProgramsCache(): void {
  cache = null
}

export async function getPrograms(opts: {
  progDir: string
  configFile: string
  /** 便携 exe 的 .lnk 包装目录 */
  wrapDir: string
  force?: boolean
}): Promise<ProgramsView> {
  const loaded = loadProgramsConfig(opts.configFile)
  const config = loaded.config
  const key = JSON.stringify([
    opts.progDir,
    config.only,
    config.extraRoots,
    config.include,
    fixturePath(),
  ])

  if (!opts.force && cache && cache.key === key && Date.now() - cache.at < CACHE_TTL_MS) {
    return { ...cache.value, cacheAgeMs: Date.now() - cache.at }
  }
  if (inflight && inflight.key === key) return inflight.promise

  const promise = buildView(opts.progDir, config, loaded, opts.wrapDir).then((view) => {
    cache = { key, at: Date.now(), value: view }
    return view
  })
  inflight = { key, promise }
  try {
    return await promise
  } finally {
    if (inflight?.promise === promise) inflight = null
  }
}

async function buildView(
  progDir: string,
  config: ProgramsConfig,
  loaded: ProgramsConfigView,
  wrapDir: string,
): Promise<ProgramsView> {
  const notes: string[] = [...loaded.problems]
  const mode: 'only' | 'discover' = config.only.length > 0 ? 'only' : 'discover'
  const roots: RootSpec[] =
    mode === 'only'
      ? config.only.map((p) => ({
          source: 'only' as ProgramSource,
          path: p,
          recurse: false,
          file: true,
        }))
      : defaultRoots(progDir, config.extraRoots)
  const onlySet = new Set(config.only.map(normalizeWinPath))
  // only 模式下所有条目都来自用户的点名列表，来源就该标成「指定列表」，
  // 而不是沿用扫描器随手写的 progDir / commonMenu
  const remap = (it: RawProgram): RawProgram =>
    mode === 'only' ? { ...it, source: 'only' as ProgramSource } : it

  if (mode === 'discover' && !progDir) {
    notes.push('未设置 PROG_DIR：只扫开始菜单与桌面（下方 ⚙ 里可以填桥用的程序目录）')
  }

  let scan: ScanOutput = { items: [], roots: [] }
  let error: string | undefined
  try {
    scan = await scanPrograms(roots)
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  const selection = selectPrograms(
    // only 模式下再过滤一次：即使扫描器（或冒烟夹具）多给了条目，点名列表说了算
    mode === 'only'
      ? scan.items.filter((it) => onlySet.has(normalizeWinPath(it.path))).map(remap)
      : scan.items,
    { include: config.include },
  )
  if (selection.truncated > 0) notes.push(`条目超过上限，另有 ${selection.truncated} 个未显示`)

  // 便携 exe 统一走「生成的 .lnk 包装」：桥跑裸 exe 时工作目录是 listener 的目录，
  // 便携程序十有八九要读自己旁边的文件，会以「一启动就报错」的形式暴露
  let programs = selection.programs
  const exeCount = programs.filter((p) => p.kind === 'exe').length
  if (exeCount > 0) {
    try {
      const wrapped = await wrapExes(programs, wrapDir)
      programs = wrapped.programs
      if (wrapped.made > 0) notes.push(`为 ${wrapped.made} 个便携 exe 生成了快捷方式（${wrapDir}）`)
      if (wrapped.missing > 0) {
        notes.push(`${wrapped.missing} 个便携 exe 生成快捷方式失败，已从列表移除`)
      }
    } catch (e) {
      notes.push(`便携 exe 的快捷方式生成失败：${e instanceof Error ? e.message : String(e)}`)
      programs = programs.filter((p) => p.kind !== 'exe')
    }
  }

  return {
    ...selection,
    programs,
    progDir,
    wrapDir,
    roots: scan.roots,
    mode,
    scannedAt: Date.now(),
    cacheAgeMs: 0,
    config,
    configFile: loaded.file,
    notes,
    ...(error ? { error } : {}),
  }
}
