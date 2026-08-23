import { defineConfig } from 'tsdown'
import { clientPlugin } from '../../build/client-plugin.ts'
export default defineConfig(clientPlugin('dsh-factory-client-ui'))
