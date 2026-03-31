import { createServer } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { createSherpaMcpHttpHandler, resolveSherpaMcpHttpOptions } from "./http.js";

describe("resolveSherpaMcpHttpOptions", () => {
  it("parses HTTP transport flags", () => {
    expect(
      resolveSherpaMcpHttpOptions([
        "--agent-id",
        "alpha",
        "--host",
        "0.0.0.0",
        "--port",
        "8788",
        "--endpoint",
        "/rpc"
      ])
    ).toEqual({
      agentId: "alpha",
      host: "0.0.0.0",
      port: 8788,
      endpoint: "/rpc"
    });
  });
});

describe("createSherpaMcpHttpHandler", () => {
  const servers = new Set<ReturnType<typeof createServer>>();

  afterEach(async () => {
    await Promise.all(
      Array.from(servers, (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }

            resolve();
          });
        })
      )
    );

    servers.clear();
  });

  it("serves a health response", async () => {
    const server = createServer((request, response) => {
      void createSherpaMcpHttpHandler({ endpoint: "/rpc" })(request, response);
    });
    servers.add(server);

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected an ephemeral TCP address");
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/health`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      transport: "streamable-http",
      endpoint: "/rpc"
    });
  });

  it("rejects invalid JSON POST bodies", async () => {
    const server = createServer((request, response) => {
      void createSherpaMcpHttpHandler()(request, response);
    });
    servers.add(server);

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected an ephemeral TCP address");
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: "{invalid"
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      jsonrpc: "2.0",
      error: {
        code: -32700,
        message: "Invalid JSON request body"
      },
      id: null
    });
  });
});
