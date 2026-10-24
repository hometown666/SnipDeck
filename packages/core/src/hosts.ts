import type { HostTarget } from './types'
import { loadYaml } from './yaml'

export type Hosts = Record<string, HostTarget>

export function loadHosts(file: string): Hosts {
  return loadYaml<Hosts>(file)
}

export function resolveTarget(
  hosts: Hosts,
  name: string | undefined,
): { name: string; target: HostTarget } {
  const key =
    name ??
    Object.keys(hosts).find((k) => !hosts[k]!.reserved) ??
    Object.keys(hosts)[0]
  if (!key) throw new Error('no host target configured')
  const target = hosts[key]
  if (!target) throw new Error(`unknown target: ${key}`)
  return { name: key, target }
}
