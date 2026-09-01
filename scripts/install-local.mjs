#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DSH_PACKAGE = '@monotykamary/dsh@0.1.0-rc.11'
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_PATHS = ['', 'protocol', 'store', 'store-sqlite', 'domain', 'tools', 'scheduler', 'client-ui']
const EXPECTED_ROWS = ['dsh-factory-store-sqlite', 'dsh-factory-domain', 'dsh-factory-tools', 'dsh-factory-scheduler', 'dsh-factory-client-ui']
const REQUIRED_ARTIFACTS = [
  'packages/protocol/lib/index.js',
  'packages/store/lib/index.js',
  'packages/store-sqlite/lib/index.js',
  'packages/domain/lib/index.js',
  'packages/domain/lib/typert.remote-client.js',
  'packages/tools/lib/index.js',
  'packages/scheduler/lib/index.js',
  'packages/client-ui/lib/client.cjs',
]

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}

async function main() {
  const options = parse(process.argv.slice(2))
  if (options.help) { help(); return }
  if (options.skipBuild) await verifyArtifacts()
  else {
    await run(['install', '--frozen-lockfile'])
    await run(['run', 'build'])
  }
  const packages = await Promise.all(PACKAGE_PATHS.map(async (part) => {
    const directory = part === '' ? ROOT : resolve(ROOT, 'packages', part)
    const manifest = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'))
    if (typeof manifest.name !== 'string' || manifest.name === '') throw new Error(`${directory}/package.json has no package name`)
    return `file:${directory}`
  }))
  await run(['x', DSH_PACKAGE, 'plugin', '--profile', options.profile, 'add', ...packages])
  const config = await run(['x', DSH_PACKAGE, '--profile', options.profile, '--dump-config'], true)
  for (const name of EXPECTED_ROWS) {
    if (!config.includes(`name: '${name}'`) && !config.includes(`name: ${name}`) && !config.includes(`name: "${name}"`)) {
      throw new Error(`profile ${JSON.stringify(options.profile)} is missing Factory row ${name}`)
    }
  }
  console.log(`Installed this dsh-factory checkout into profile ${JSON.stringify(options.profile)}.`)
  console.log('No server was started or restarted; load the profile again to activate Factory.')
}

function parse(args) {
  let profile = 'web'
  let skipBuild = false
  let helpValue = false
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--') continue
    if (argument === '--profile') {
      const value = args[index + 1]
      if (value === undefined) throw new Error('--profile requires a value')
      profile = value
      index += 1
    } else if (argument.startsWith('--profile=')) profile = argument.slice('--profile='.length)
    else if (argument === '--skip-build') skipBuild = true
    else if (argument === '--help' || argument === '-h') helpValue = true
    else throw new Error(`unknown argument ${JSON.stringify(argument)}`)
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(profile)) throw new Error(`invalid profile name ${JSON.stringify(profile)}`)
  return { profile, skipBuild, help: helpValue }
}

async function verifyArtifacts() {
  for (const path of REQUIRED_ARTIFACTS) {
    try { await access(resolve(ROOT, path)) }
    catch { throw new Error(`--skip-build requires ${path}; run without --skip-build first`) }
  }
}

function run(args, capture = false) {
  const invocation = { command: 'bun', args }
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(invocation.command, invocation.args, { cwd: ROOT, env: process.env, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' })
    let stdout = ''
    if (capture) child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.once('error', rejectPromise)
    child.once('close', (code, signal) => {
      if (code === 0) resolvePromise(stdout)
      else rejectPromise(new Error(`bun ${args.join(' ')} failed${signal === null ? ` with exit code ${code}` : ` from signal ${signal}`}`))
    })
  })
}


function help() {
  console.log(`Usage: bun run install:local -- [--profile web] [--skip-build]\n\nBuild and link this checkout into one DSH profile without starting it.`)
}
