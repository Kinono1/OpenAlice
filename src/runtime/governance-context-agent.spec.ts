import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runGovernanceContextAgent } from './governance-context-agent.js'
import { generateZodJsonObject } from './llm_json_generation.js'

vi.mock('../ai-providers/vercel-ai-sdk/model-factory.js', () => ({
  createModelFromConfig: vi.fn(async () => ({ model: {} as any, providerName: 'test-provider' })),
}))

vi.mock('./llm_json_generation.js', () => ({
  generateZodJsonObject: vi.fn(),
}))

describe('governance context agent', () => {
  beforeEach(() => {
    vi.mocked(generateZodJsonObject).mockReset()
  })

  it('translates validated reduce exposure output into bounded factor conditioning', async () => {
    vi.mocked(generateZodJsonObject).mockResolvedValue({
      macroRegime: 'vol-stress',
      action: 'reduce_exposure',
      parameters: {
        momentumWeightMultiplier: 0.4,
        meanReversionWeightMultiplier: 0.8,
        fundingWeightMultiplier: 0.2,
      },
      reasoning: 'Elevated VPIN and drawdown require caution.',
      confidenceScore: 0.8,
    })

    const result = await runGovernanceContextAgent({
      currentRegime: 'stress',
      factorICByName: { momentum: [0.1, -0.2] },
      dataQualityState: 'good',
      recentDrawdown: 0.04,
      vpin: 0.8,
    })

    expect(result?.conditioning.multiplierBySignal).toMatchObject({
      'momentum-composite': 0.4,
      'mean-reversion': 0.8,
      'funding-rate': 0.2,
      'carry-spread': 0.2,
    })
    expect(result?.conditioning.reasons).toEqual(expect.arrayContaining([
      'governance_action:reduce_exposure',
      'macro_regime:vol-stress',
    ]))
  })

  it('fails closed to null when model output cannot be generated or parsed', async () => {
    vi.mocked(generateZodJsonObject).mockRejectedValue(new Error('model unavailable'))

    await expect(runGovernanceContextAgent({
      currentRegime: 'normal',
      factorICByName: {},
      dataQualityState: 'unknown',
      recentDrawdown: 0,
    })).resolves.toBeNull()
  })
})
