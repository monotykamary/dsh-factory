/** Pack Factory and validate its ordinary npm consumer dependency graph. */

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const harnessRoot = resolve(root, '../deepseek-harness')
const INSTALL_TIMEOUT_MS = 8 * 60 * 1000
const cordisPackageDirectories = [
  'packages/store',
  'packages/store-sqlite',
  'packages/domain',
  'packages/tools',
  'packages/scheduler',
  'packages/client-ui',
]
const packageDirectories = ['packages/protocol', ...cordisPackageDirectories, '.']

function manifest(directory) {
  return JSON.parse(readFileSync(resolve(root, directory, 'package.json'), 'utf8'))
}

function verifyCordisPeers() {
  const cordisVersion = JSON.parse(readFileSync(resolve(harnessRoot, 'vendor/cordis/package.json'), 'utf8')).version
  const expected = `^${cordisVersion}`
  const failures = []
  for (const directory of cordisPackageDirectories) {
    const current = manifest(directory)
    const peer = current.peerDependencies?.['@monotykamary/cordis']
    const development = current.devDependencies?.['@monotykamary/cordis']
    if (peer !== expected) failures.push(`${current.name}: peer ${String(peer)}, expected ${expected}`)
    if (development !== expected) failures.push(`${current.name}: development ${String(development)}, expected ${expected}`)
  }
  if (failures.length > 0) throw new Error(`Factory Cordis declarations do not match the linked Harness package:\n${failures.join('\n')}`)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeout,
  })
  if (result.error !== undefined) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.error.message}\n${result.stdout}\n${result.stderr}`)
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status)}:\n${result.stdout}\n${result.stderr}`)
  }
  return `${result.stdout}${result.stderr}`
}

function main() {
  verifyCordisPeers()
  const versions = new Set(packageDirectories.map(directory => manifest(directory).version))
  if (versions.size !== 1) throw new Error(`Factory packages must share one version, found: ${[...versions].join(', ')}`)
  const temporary = mkdtempSync(join(tmpdir(), 'dsh-factory-packed-'))
  const packed = join(temporary, 'packed')
  const consumer = join(temporary, 'consumer')
  try {
    mkdirSync(packed, { recursive: true })
    mkdirSync(consumer, { recursive: true })
    for (const directory of packageDirectories) {
      run('pnpm', ['--dir', resolve(root, directory), 'pack', '--pack-destination', packed])
    }

    const dependencies = {}
    for (const filename of readdirSync(packed).filter(name => name.endsWith('.tgz')).sort()) {
      const tarball = resolve(packed, filename)
      const packedManifest = JSON.parse(execFileSync('tar', ['-xOzf', tarball, 'package/package.json'], { encoding: 'utf8' }))
      dependencies[packedManifest.name] = pathToFileURL(tarball).href
    }
    if (Object.keys(dependencies).length !== packageDirectories.length) {
      throw new Error(`packed ${String(Object.keys(dependencies).length)} Factory packages, expected ${String(packageDirectories.length)}`)
    }

    writeFileSync(resolve(consumer, 'package.json'), `${JSON.stringify({
      name: 'dsh-factory-packed-consumer',
      version: '0.0.0',
      private: true,
      dependencies,
      overrides: Object.fromEntries(Object.keys(dependencies).map(name => [name, `$${name}`])),
    }, null, 2)}\n`)
    const environment = { ...process.env }
    const installOutput = run('npm', [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      '--loglevel=warn',
    ], { cwd: consumer, env: environment, timeout: INSTALL_TIMEOUT_MS })
    if (installOutput.includes('ERESOLVE')) throw new Error(`standard npm install reported peer resolution overrides:\n${installOutput}`)
    run('npm', ['ls', '--all', '--omit=dev'], { cwd: consumer, env: environment })
    console.log(`verify-packed-install: standard npm installed ${String(packageDirectories.length)} Factory tarballs without peer overrides`)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

main()
