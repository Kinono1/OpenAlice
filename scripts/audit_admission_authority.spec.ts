import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  auditAdmissionAuthority,
  scanJavaScriptAuthorityWrites,
  scanTextAuthorityWrites,
} from './audit_admission_authority.js'

describe('audit_admission_authority', () => {
  it('detects object and direct assignments while ignoring comparisons and comments', () => {
    const violations = scanJavaScriptAuthorityWrites('src/runtime/rogue.ts', `
      // paperTradingAllowed: true
      const projected = { paperTradingAllowed: true }
      state.liveTradingAllowed = true
      const observed = input.liveExecutionArmed === true
    `)
    expect(violations.map((item) => [item.field, item.kind])).toEqual([
      ['paperTradingAllowed', 'property_assignment'],
      ['liveTradingAllowed', 'direct_assignment'],
    ])
  })

  it('detects equivalent Python or JSON writes', () => {
    expect(scanTextAuthorityWrites('ops/rogue.py', `{'liveExecutionArmed': True}`))
      .toMatchObject([{ field: 'liveExecutionArmed', kind: 'text_assignment' }])
  })

  it('allows only the reducer and test fixtures to construct positive authority states', async () => {
    const root = await mkdtemp(join(tmpdir(), 'admission-authority-audit-'))
    await mkdir(join(root, 'src/runtime'), { recursive: true })
    await mkdir(join(root, 'scripts/fixtures'), { recursive: true })
    await mkdir(join(root, 'ops'), { recursive: true })
    await writeFile(
      join(root, 'src/runtime/admission.ts'),
      'const decision = { paperTradingAllowed: true }\n',
    )
    await writeFile(
      join(root, 'src/runtime/admission.spec.ts'),
      'const fixture = { liveTradingAllowed: true }\n',
    )
    await writeFile(
      join(root, 'scripts/fixtures/decision.json'),
      '{"liveExecutionArmed":true}\n',
    )
    await writeFile(
      join(root, 'ops/rogue.py'),
      "state['liveTradingAllowed'] = True\n",
    )

    const audit = await auditAdmissionAuthority(root)
    expect(audit.status).toBe('fail')
    expect(audit.violations).toHaveLength(1)
    expect(audit.violations[0]).toMatchObject({
      path: 'ops/rogue.py',
      field: 'liveTradingAllowed',
    })
  })
})
