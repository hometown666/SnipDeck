import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { parseDocument, stringify } from 'yaml'

type YamlDoc = ReturnType<typeof parseDocument>

export function loadYamlDoc(file: string): YamlDoc {
  return parseDocument(readFileSync(file, 'utf8'))
}

export function loadYaml<T = unknown>(file: string): T {
  const data = loadYamlDoc(file).toJS()
  if (data === null || data === undefined) throw new Error(`empty yaml: ${file}`)
  return data as T
}

export function saveYamlDoc(file: string, doc: YamlDoc): void {
  if (existsSync(file)) copyFileSync(file, `${file}.bak`)
  writeFileSync(file, doc.toString({ lineWidth: 0 }), 'utf8')
}

export function writeYaml(file: string, data: unknown): void {
  if (existsSync(file)) copyFileSync(file, `${file}.bak`)
  writeFileSync(file, stringify(data, { lineWidth: 0 }), 'utf8')
}
