import { useConfigPage } from '../hooks/useConfigPage'
import { SaveIndicator } from '../components/SaveIndicator'
import { SDKSelector, CONNECTOR_OPTIONS } from '../components/SDKSelector'
import { ConfigSection, Field, inputClass } from '../components/form'
import { PageHeader } from '../components/PageHeader'
import type { AppConfig, ConnectorsConfig } from '../api'

export function ConnectorsPage() {
  const { config, status, loadError, updateConfig, updateConfigImmediate, retry } =
    useConfigPage<ConnectorsConfig>({
      section: 'connectors',
      extract: (full: AppConfig) => full.connectors,
    })

  // Derive selected connector IDs from enabled flags (web + mcp are always included)
  const selected = config
    ? [
        'web',
        'mcp',
        ...(config.mcpAsk.enabled ? ['mcpAsk'] : []),
        ...(config.telegram.enabled ? ['telegram'] : []),
      ]
    : ['web', 'mcp']

  const handleToggle = (id: string) => {
    if (!config) return
    if (id === 'mcpAsk') {
      updateConfigImmediate({ mcpAsk: { ...config.mcpAsk, enabled: !config.mcpAsk.enabled } })
    } else if (id === 'telegram') {
      updateConfigImmediate({ telegram: { ...config.telegram, enabled: !config.telegram.enabled } })
    }
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <PageHeader
        title="Connectors"
        description="Service ports and external integrations. Changes require a restart."
        right={<SaveIndicator status={status} onRetry={retry} />}
      />

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 md:px-8 py-5">
        {config && (
          <div className="max-w-[880px] mx-auto">
            {/* Connector selector cards */}
            <ConfigSection
              title="Active Connectors"
              description="Select which connectors to enable. Web UI and MCP Server are always active."
            >
              <SDKSelector
                options={CONNECTOR_OPTIONS}
                selected={selected}
                onToggle={handleToggle}
              />
            </ConfigSection>

            {/* Web UI config — always shown */}
            <ConfigSection
              title="Web UI"
              description="Browser-based chat and configuration interface."
            >
              <Field label="Port">
                <input
                  className={inputClass}
                  type="number"
                  value={config.web.port}
                  onChange={(e) => updateConfig({ web: { port: Number(e.target.value) } })}
                />
              </Field>
            </ConfigSection>

            {/* MCP Server config — always shown */}
            <ConfigSection
              title="MCP Server"
              description="Tool bridge for Claude Code provider and external AI agents."
            >
              <Field label="Port">
                <input
                  className={inputClass}
                  type="number"
                  value={config.mcp.port}
                  onChange={(e) => updateConfig({ mcp: { port: Number(e.target.value) } })}
                />
              </Field>
            </ConfigSection>

            {/* MCP Ask config */}
            {config.mcpAsk.enabled && (
              <ConfigSection
                title="MCP Ask"
                description="Multi-turn conversation endpoint for external agents."
              >
                <Field label="Port">
                  <input
                    className={inputClass}
                    type="number"
                    value={config.mcpAsk.port ?? ''}
                    onChange={(e) => {
                      const v = e.target.value
                      updateConfig({ mcpAsk: { ...config.mcpAsk, port: v ? Number(v) : undefined } })
                    }}
                    placeholder="e.g. 3003"
                  />
                </Field>
              </ConfigSection>
            )}

            {/* Telegram config */}
            {config.telegram.enabled && (
              <ConfigSection
                title="Telegram"
                description="Create a bot via @BotFather, paste the token below, and add your chat ID."
              >
                <Field label="Bot Token">
                  <input
                    className={inputClass}
                    type="password"
                    value={config.telegram.botToken ?? ''}
                    onChange={(e) =>
                      updateConfig({
                        telegram: { ...config.telegram, botToken: e.target.value || undefined },
                      })
                    }
                    placeholder="123456:ABC-DEF..."
                  />
                </Field>
                <Field label="Bot Username">
                  <input
                    className={inputClass}
                    value={config.telegram.botUsername ?? ''}
                    onChange={(e) =>
                      updateConfig({
                        telegram: { ...config.telegram, botUsername: e.target.value || undefined },
                      })
                    }
                    placeholder="my_bot"
                  />
                </Field>
                <Field label="Allowed Chat IDs">
                  <input
                    className={inputClass}
                    value={config.telegram.chatIds.join(', ')}
                    onChange={(e) =>
                      updateConfig({
                        telegram: {
                          ...config.telegram,
                          chatIds: e.target.value
                            ? e.target.value
                                .split(',')
                                .map((s) => Number(s.trim()))
                                .filter((n) => !isNaN(n))
                            : [],
                        },
                      })
                    }
                    placeholder="Comma-separated, e.g. 123456, 789012"
                  />
                </Field>
              </ConfigSection>
            )}
          </div>
        )}
        {loadError && <p className="text-[13px] text-red">Failed to load configuration.</p>}
      </div>
    </div>
  )
}
