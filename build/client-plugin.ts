import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import type { UserConfig } from 'tsdown'
import { transform } from 'lightningcss'

const CSS_PREFIX = '\0dsh-factory-css:'
const CSS_SUFFIX = '.mjs'
const PLATFORM_MODULES = new Set([
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@monotykamary/cordis', '@monotykamary/dsh-client-ui-slots',
  '@monotykamary/dsh-client-ui-attachment/client', '@monotykamary/dsh-client-ui-deliverables/client',
  '@monotykamary/dsh-client-ui-primitives', '@monotykamary/dsh-client-runtime/client',
])

/** Build the Node marker and dynamic browser closure for one Factory UI package. */
export function clientPlugin(id: string): UserConfig[] {
  return [
    {
      name: id,
      entry: ['src/index.ts', 'src/invariant.ts'],
      outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024',
      fixedExtension: false, dts: false, clean: false,
    },
    {
      name: `${id}/client`,
      entry: { client: 'src/client/index.ts' },
      outDir: 'lib', format: 'cjs', platform: 'browser', target: 'es2024',
      dts: false, sourcemap: true, clean: false,
      deps: {
        neverBundle: [...PLATFORM_MODULES],
        alwaysBundle: (source: string) => PLATFORM_MODULES.has(source) ? undefined : true,
      },
      define: { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production') },
      plugins: [
        {
          name: 'dsh-factory-client-imports',
          resolveId(source: string) {
            if (!source.startsWith('@monotykamary/')) return null
            if (PLATFORM_MODULES.has(source)) return null
            if (source === '@monotykamary/dsh-typert-protocol') return null
            throw new Error(`Factory browser bundle cannot import Host module ${JSON.stringify(source)}`)
          },
        },
        {
          name: 'dsh-factory-css-modules',
          resolveId(source: string, importer: string | undefined) {
            if (!source.endsWith('.module.css')) return null
            const direct = importer === undefined ? source : sourceAssetPath(source, importer)
            return CSS_PREFIX + direct + CSS_SUFFIX
          },
          async load(idValue: string) {
            if (!idValue.startsWith(CSS_PREFIX)) return null
            const file = idValue.slice(CSS_PREFIX.length, -CSS_SUFFIX.length)
            this.addWatchFile(file)
            const result = transform({ filename: file, code: await readFile(file), cssModules: { pattern: '[hash]_[local]' }, minify: true })
            const classes: Record<string, string> = {}
            for (const [local, value] of Object.entries(result.exports ?? {})) classes[local] = value.name
            const tag = `${id}/${basename(file)}`
            return [
              `const value=${JSON.stringify(result.code.toString())};`,
              `if(typeof document!==\"undefined\"){let tag=document.querySelector(${JSON.stringify(`style[data-plugin-css="${tag}"]`)});if(tag===null){tag=document.createElement(\"style\");tag.dataset.plugin=${JSON.stringify(id)};tag.dataset.pluginCss=${JSON.stringify(tag)};document.head.appendChild(tag)}tag.textContent=value}`,
              `export default ${JSON.stringify(classes)};`,
            ].join('\n')
          },
        },
      ],
      outputOptions: {
        entryFileNames: 'client.cjs',
        banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
        footer: 'return module.exports; } });',
        intro: 'var module = { exports: {} }; var exports = module.exports;',
      },
    },
  ]
}

function sourceAssetPath(source: string, importer: string): string {
  const direct = resolve(dirname(importer), source)
  if (existsSync(direct)) return direct
  const marker = '/lib/types/'
  const normalized = direct.replaceAll('\\\\', '/')
  const boundary = normalized.indexOf(marker)
  return boundary < 0 ? direct : resolve(normalized.slice(0, boundary), 'src', normalized.slice(boundary + marker.length))
}
