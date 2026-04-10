import { useState } from 'react'
import { api, type AppConfig } from '../api'
import { SaveIndicator } from '../components/SaveIndicator'
import { ConfigSection, Field, inputClass } from '../components/form'
import { Toggle } from '../components/Toggle'
import { useConfigPage } from '../hooks/useConfigPage'
import { PageHeader } from '../components/PageHeader'

type MarketDataConfig = Record<string, unknown>

// ==================== Constants ====================

const PROVIDER_OPTIONS: Record<string, string[]> = {
  equity: ['yfinance', 'fmp', 'intrinio', 'tiingo', 'alpha_vantage'],
  crypto: ['yfinance', 'fmp', 'tiingo'],
  currency: ['yfinance', 'fmp', 'tiingo'],
}

const ASSET_LABELS: Record<string, string> = {
  equity: 'Equity',
  crypto: 'Crypto',
  currency: 'Currency',
}

/** Maps provider name → providerKeys key. null means free, no key required. */
const PROVIDER_KEY_MAP: Record<string, string | null> = {
  yfinance: null,
  fmp: 'fmp',
  intrinio: 'intrinio',
  tiingo: 'tiingo',
  alpha_vantage: 'alpha_vantage',
  benzinga: 'benzinga',
  biztoc: 'biztoc',
}

const UTILITY_PROVIDERS = [
  { key: 'fred', name: 'FRED', desc: 'Federal Reserve Economic Data — CPI, GDP, interest rates, macro indicators.', hint: 'Free — fredaccount.stlouisfed.org/apikeys' },
  { key: 'bls', name: 'BLS', desc: 'Bureau of Labor Statistics — employment, payrolls, wages, CPI.', hint: 'Free — registrationapps.bls.gov/bls_registration' },
  { key: 'eia', name: 'EIA', desc: 'Energy Information Administration — petroleum status, energy reports.', hint: 'Free — eia.gov/opendata' },
  { key: 'econdb', name: 'EconDB', desc: 'Global macro indicators, country profiles, shipping data.', hint: 'Optional — works without key (limited). econdb.com' },
  { key: 'nasdaq', name: 'Nasdaq', desc: 'Nasdaq Data Link — dividend/earnings calendars, short interest.', hint: 'Freemium — data.nasdaq.com' },
  { key: 'tradingeconomics', name: 'Trading Economics', desc: '20M+ indicators across 196 countries, economic calendar.', hint: 'Paid — tradingeconomics.com' },
] as const

// ==================== Test Button ====================

function TestButton({
  status,
  disabled,
  onClick,
}: {
  status: 'idle' | 'testing' | 'ok' | 'error'
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`shrink-0 border rounded-md px-3 py-2 text-[13px] font-medium cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-default ${
        status === 'ok'
          ? 'border-green text-green'
          : status === 'error'
            ? 'border-red text-red'
            : 'border-border text-text-muted hover:bg-bg-tertiary hover:text-text'
      }`}
    >
      {status === 'testing' ? '…' : status === 'ok' ? 'OK' : status === 'error' ? 'Fail' : 'Test'}
    </button>
  )
}

// ==================== Page ====================

export function MarketDataPage() {
  const { config, status, loadError, updateConfig, updateConfigImmediate, retry } = useConfigPage<MarketDataConfig>({
    section: 'marketData',
    extract: (full: AppConfig) => (full as Record<string, unknown>).marketData as MarketDataConfig,
  })

  const enabled = !config || (config as Record<string, unknown>).enabled !== false

  if (!config) {
    return (
      <div className="flex flex-col flex-1 min-h-0">
        <PageHeader title="Market Data" description="Structured financial data — prices, fundamentals, macro indicators." />
        <div className="flex-1 flex items-center justify-center">
          <p className="text-[13px] text-text-muted">Loading…</p>
        </div>
      </div>
    )
  }

  const dataBackend = (config.backend as string) || 'typebb-sdk'
  const apiUrl = (config.apiUrl as string) || 'http://localhost:6900'
  const apiServer = (config.apiServer as { enabled: boolean; port: number } | undefined) ?? { enabled: false, port: 6901 }
  const providers = (config.providers ?? { equity: 'yfinance', crypto: 'yfinance', currency: 'yfinance' }) as Record<string, string>
  const providerKeys = (config.providerKeys ?? {}) as Record<string, string>

  const handleProviderChange = (asset: string, provider: string) => {
    updateConfigImmediate({ providers: { ...providers, [asset]: provider } })
  }

  const handleKeyChange = (keyName: string, value: string) => {
    const all = (config.providerKeys ?? {}) as Record<string, string>
    const updated = { ...all, [keyName]: value }
    const cleaned: Record<string, string> = {}
    for (const [k, v] of Object.entries(updated)) {
      if (v) cleaned[k] = v
    }
    updateConfig({ providerKeys: cleaned })
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <PageHeader
        title="Market Data"
        description="Structured financial data — prices, fundamentals, macro indicators."
        right={
          <div className="flex items-center gap-3">
            <SaveIndicator status={status} onRetry={retry} />
            <Toggle size="sm" checked={enabled} onChange={(v) => updateConfigImmediate({ enabled: v })} />
          </div>
        }
      />

      <div className="flex-1 overflow-y-auto px-4 md:px-8 py-5">
        <div className={`max-w-[880px] mx-auto ${!enabled ? 'opacity-40 pointer-events-none' : ''}`}>
          {/* Data Backend */}
          <DataBackendSection
            backend={dataBackend}
            apiUrl={apiUrl}
            onBackendChange={(backend) => { updateConfigImmediate({ backend }); }}
            onApiUrlChange={(url) => updateConfig({ apiUrl: url })}
          />

          {/* Asset Providers */}
          <AssetProvidersSection
            providers={providers}
            providerKeys={providerKeys}
            onProviderChange={handleProviderChange}
            onKeyChange={handleKeyChange}
          />

          {/* Embedded API Server */}
          <ConfigSection
            title="Embedded API Server"
            description="Expose an OpenBB-compatible HTTP API from Alice. Other services can connect to query market data."
          >
            <div className="flex items-center justify-between mb-3">
              <div>
                <p className="text-[13px] text-text">Enable HTTP server</p>
                <p className="text-[12px] text-text-muted/60 mt-0.5">
                  Serves at <span className="font-mono text-[11px]">http://localhost:{apiServer.port}</span>
                </p>
              </div>
              <Toggle
                size="sm"
                checked={apiServer.enabled}
                onChange={(v) => updateConfigImmediate({ apiServer: { ...apiServer, enabled: v } })}
              />
            </div>
            {apiServer.enabled && (
              <Field label="Port">
                <input
                  className={`${inputClass} w-28`}
                  type="number"
                  min={1024}
                  max={65535}
                  value={apiServer.port}
                  onChange={(e) => updateConfig({ apiServer: { ...apiServer, port: Number(e.target.value) || 6901 } })}
                />
              </Field>
            )}
          </ConfigSection>

          {/* Macro & Utility Providers */}
          <UtilityProvidersSection
            providerKeys={providerKeys}
            onKeyChange={handleKeyChange}
          />
        </div>
        {loadError && <p className="text-[13px] text-red mt-4 max-w-[880px] mx-auto">Failed to load configuration.</p>}
      </div>
    </div>
  )
}

// ==================== Data Backend Section ====================

function DataBackendSection({
  backend,
  apiUrl,
  onBackendChange,
  onApiUrlChange,
}: {
  backend: string
  apiUrl: string
  onBackendChange: (backend: string) => void
  onApiUrlChange: (url: string) => void
}) {
  const [testing, setTesting] = useState(false)
  const [testStatus, setTestStatus] = useState<'idle' | 'ok' | 'error'>('idle')

  const testConnection = async () => {
    setTesting(true)
    setTestStatus('idle')
    try {
      const res = await fetch(`${apiUrl}/api/v1/equity/search?query=AAPL&provider=sec`, { signal: AbortSignal.timeout(5000) })
      setTestStatus(res.ok ? 'ok' : 'error')
    } catch {
      setTestStatus('error')
    } finally {
      setTesting(false)
    }
  }

  return (
    <ConfigSection
      title="Data Backend"
      description="Choose between the built-in TypeBB engine or an external OpenBB-compatible API."
    >
      <div className="flex border border-border rounded-lg overflow-hidden w-fit mb-3">
        {(['typebb-sdk', 'openbb-api'] as const).map((opt, i) => (
          <button
            key={opt}
            onClick={() => { onBackendChange(opt); setTestStatus('idle') }}
            className={`px-4 py-1.5 text-[13px] font-medium transition-colors cursor-pointer ${
              i > 0 ? 'border-l border-border' : ''
            } ${
              backend === opt
                ? 'bg-bg-tertiary text-text'
                : 'text-text-muted hover:text-text'
            }`}
          >
            {opt === 'typebb-sdk' ? 'Built-in Engine (TypeBB)' : 'External OpenBB API'}
          </button>
        ))}
      </div>
      <p className="text-[13px] text-text-muted/70">
        {backend === 'typebb-sdk'
          ? 'Uses the built-in TypeBB engine. No external process required.'
          : 'Connects to an external OpenBB-compatible HTTP endpoint.'}
      </p>

      {backend === 'openbb-api' && (
        <div className="mt-4">
          <Field label="API URL">
            <div className="flex items-center gap-2">
              <input
                className={inputClass}
                value={apiUrl}
                onChange={(e) => { onApiUrlChange(e.target.value); setTestStatus('idle') }}
                placeholder="http://localhost:6900"
              />
              <button
                onClick={testConnection}
                disabled={testing}
                className={`shrink-0 border rounded-lg px-4 py-2 text-[13px] font-medium cursor-pointer transition-colors disabled:opacity-50 ${
                  testStatus === 'ok'
                    ? 'border-green text-green'
                    : testStatus === 'error'
                      ? 'border-red text-red'
                      : 'border-border text-text-muted hover:bg-bg-tertiary hover:text-text'
                }`}
              >
                {testing ? 'Testing…' : testStatus === 'ok' ? 'Connected' : testStatus === 'error' ? 'Failed' : 'Test'}
              </button>
            </div>
          </Field>
        </div>
      )}
    </ConfigSection>
  )
}

// ==================== Asset Providers Section ====================

function AssetProvidersSection({
  providers,
  providerKeys,
  onProviderChange,
  onKeyChange,
}: AssetProviderGridProps) {
  const [localKeys, setLocalKeys] = useState<Record<string, string>>(() => ({ ...providerKeys }))
  const [testStatus, setTestStatus] = useState<Record<string, 'idle' | 'testing' | 'ok' | 'error'>>({})

  const handleKeyChange = (keyName: string, value: string) => {
    setLocalKeys((prev) => ({ ...prev, [keyName]: value }))
    setTestStatus((prev) => ({ ...prev, [keyName]: 'idle' }))
    onKeyChange(keyName, value)
  }

  const testProvider = async (provider: string, keyName: string) => {
    const key = localKeys[keyName]
    if (!key) return
    setTestStatus((prev) => ({ ...prev, [keyName]: 'testing' }))
    try {
      const result = await api.marketData.testProvider(provider, key)
      setTestStatus((prev) => ({ ...prev, [keyName]: result.ok ? 'ok' : 'error' }))
    } catch {
      setTestStatus((prev) => ({ ...prev, [keyName]: 'error' }))
    }
  }

  return (
    <ConfigSection
      title="Asset Providers"
      description="Select a data provider for each asset class. Providers requiring an API key show a key input and test button."
    >
      <div className="space-y-3">
        {Object.entries(PROVIDER_OPTIONS).map(([asset, options]) => {
          const selectedProvider = providers[asset] || options[0]
          const keyName = PROVIDER_KEY_MAP[selectedProvider] ?? null
          const status = keyName ? (testStatus[keyName] || 'idle') : 'idle'

          return (
            <div key={asset} className="flex items-center gap-3">
              <span className="text-[13px] text-text w-20 shrink-0 font-medium">{ASSET_LABELS[asset]}</span>
              <select
                className={`${inputClass} max-w-[160px]`}
                value={selectedProvider}
                onChange={(e) => onProviderChange(asset, e.target.value)}
              >
                {options.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
              </select>
              {keyName ? (
                <>
                  <input
                    className={inputClass}
                    type="password"
                    value={localKeys[keyName] || ''}
                    onChange={(e) => handleKeyChange(keyName, e.target.value)}
                    placeholder="API key"
                  />
                  <TestButton
                    status={status}
                    disabled={!localKeys[keyName] || status === 'testing'}
                    onClick={() => testProvider(selectedProvider, keyName)}
                  />
                </>
              ) : (
                <span className="text-[13px] text-text-muted/50 px-1">Free</span>
              )}
            </div>
          )
        })}
      </div>
    </ConfigSection>
  )
}

interface AssetProviderGridProps {
  providers: Record<string, string>
  providerKeys: Record<string, string>
  onProviderChange: (asset: string, provider: string) => void
  onKeyChange: (keyName: string, value: string) => void
}

// ==================== Utility Providers Section ====================

function UtilityProvidersSection({
  providerKeys,
  onKeyChange,
}: {
  providerKeys: Record<string, string>
  onKeyChange: (keyName: string, value: string) => void
}) {
  const [localKeys, setLocalKeys] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {}
    for (const p of UTILITY_PROVIDERS) init[p.key] = providerKeys[p.key] || ''
    return init
  })
  const [testStatus, setTestStatus] = useState<Record<string, 'idle' | 'testing' | 'ok' | 'error'>>({})

  const handleKeyChange = (keyName: string, value: string) => {
    setLocalKeys((prev) => ({ ...prev, [keyName]: value }))
    setTestStatus((prev) => ({ ...prev, [keyName]: 'idle' }))
    onKeyChange(keyName, value)
  }

  const testProvider = async (keyName: string) => {
    const key = localKeys[keyName]
    if (!key) return
    setTestStatus((prev) => ({ ...prev, [keyName]: 'testing' }))
    try {
      const result = await api.marketData.testProvider(keyName, key)
      setTestStatus((prev) => ({ ...prev, [keyName]: result.ok ? 'ok' : 'error' }))
    } catch {
      setTestStatus((prev) => ({ ...prev, [keyName]: 'error' }))
    }
  }

  return (
    <ConfigSection
      title="Macro & Utility Providers"
      description="Used by dedicated macro endpoints — FRED for CPI/GDP, BLS for employment, EIA for energy. Not per-asset-class selectable."
    >
      <div className="space-y-4">
        {UTILITY_PROVIDERS.map(({ key, name, desc, hint }) => {
          const status = testStatus[key] || 'idle'
          return (
            <Field key={key} label={name} description={hint}>
              <p className="text-[12px] text-text-muted/70 mb-2">{desc}</p>
              <div className="flex items-center gap-2">
                <input
                  className={inputClass}
                  type="password"
                  value={localKeys[key]}
                  onChange={(e) => handleKeyChange(key, e.target.value)}
                  placeholder="Not configured"
                />
                <TestButton
                  status={status}
                  disabled={!localKeys[key] || status === 'testing'}
                  onClick={() => testProvider(key)}
                />
              </div>
            </Field>
          )
        })}
      </div>
    </ConfigSection>
  )
}
