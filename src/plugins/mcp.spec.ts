import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createRequireAuth: vi.fn(),
  createRequireTrade: vi.fn(),
  createMcpAuthMiddleware: vi.fn(),
  serve: vi.fn(),
  passthroughMiddleware: vi.fn(
    async (_c: unknown, next: () => Promise<void>) => {
      await next();
    }
  ),
}));

vi.mock("../core/auth.js", () => ({
  createRequireAuth: mocks.createRequireAuth,
  createRequireTrade: mocks.createRequireTrade,
}));

vi.mock("../core/mcp-auth-policy.js", () => ({
  createMcpAuthMiddleware: mocks.createMcpAuthMiddleware,
}));

vi.mock("@hono/node-server", () => ({
  serve: mocks.serve,
}));

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: class {
    registerTool() {}
    async connect() {}
  },
}));

vi.mock(
  "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js",
  () => ({
    WebStandardStreamableHTTPServerTransport: class {
      async handleRequest() {
        return new Response(null, { status: 200 });
      }
    },
  })
);

import { McpPlugin } from "./mcp.js";

describe("McpPlugin", () => {
  beforeEach(() => {
    mocks.createRequireAuth.mockReset();
    mocks.createRequireTrade.mockReset();
    mocks.createMcpAuthMiddleware.mockReset();
    mocks.serve.mockReset();
    mocks.passthroughMiddleware.mockClear();

    mocks.createRequireAuth.mockReturnValue(mocks.passthroughMiddleware);
    mocks.createRequireTrade.mockReturnValue(mocks.passthroughMiddleware);
    mocks.createMcpAuthMiddleware.mockReturnValue(mocks.passthroughMiddleware);
    mocks.serve.mockImplementation((_opts, onListen) => {
      onListen?.({ port: 0 });
      return { close: vi.fn() };
    });
  });

  it("wires auth middleware using config.auth.enforceAuth", async () => {
    const plugin = new McpPlugin({}, 0);
    await plugin.start({
      config: { auth: { enforceAuth: true } },
    } as never);

    expect(mocks.createRequireAuth).toHaveBeenCalledWith(true);
    expect(mocks.createRequireTrade).toHaveBeenCalledWith(true);

    await plugin.stop();
  });
});
