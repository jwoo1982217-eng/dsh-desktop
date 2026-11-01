import { defineConfig } from 'vitest/config'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
const scratch = mkdtempSync(join(process.cwd(), '.phone-test-'))
export default defineConfig({ test: { include: ['scripts/test-fixtures/phone-login.spec.ts'], environment: 'node', env: { DSH_HOME: scratch, DSH_CHANNEL_PACK_STATE_DIR: scratch, DSH_UNIT_TEST_NO_WREQ: '1', DSH_OPENAI_GATEWAY_ENABLED: '0' } } })
