#!/usr/bin/env node

import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp";

import { createSherpaMcpServer, resolveSherpaMcpOptions, type SherpaMcpOptions } from "./server.js";

export interface SherpaMcpHttpOptions extends SherpaMcpOptions {
  host?: string;
  port?: number;
  endpoint?: string;
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request: IncomingMessage) {
  const chunks: Uint8Array[] = [];

  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  if (chunks.length === 0) {
    return undefined;
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function handleMcpPost(
  request: IncomingMessage,
  response: ServerResponse,
  options: SherpaMcpHttpOptions
) {
  let body: unknown;

  try {
    body = await readJsonBody(request);
  } catch {
    writeJson(response, 400, {
      jsonrpc: "2.0",
      error: {
        code: -32700,
        message: "Invalid JSON request body"
      },
      id: null
    });
    return;
  }

  const { server } = createSherpaMcpServer(options);
  const transport = new StreamableHTTPServerTransport();

  response.on("close", () => {
    void transport.close().finally(() => server.close());
  });

  try {
    await server.connect(transport as Parameters<typeof server.connect>[0]);
    await transport.handleRequest(request, response, body);
  } catch (error) {
    console.error("Error handling MCP HTTP request:", error);

    if (!response.headersSent) {
      writeJson(response, 500, {
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error"
        },
        id: null
      });
    }
  }
}

function handleMcpMethodNotAllowed(response: ServerResponse) {
  writeJson(response, 405, {
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method not allowed."
    },
    id: null
  });
}

export function resolveSherpaMcpHttpOptions(argv = process.argv.slice(2)): SherpaMcpHttpOptions {
  const base = resolveSherpaMcpOptions(argv);
  const hostIndex = argv.indexOf("--host");
  const portIndex = argv.indexOf("--port");
  const endpointIndex = argv.indexOf("--endpoint");

  const host = hostIndex === -1 ? undefined : argv[hostIndex + 1];
  const endpoint = endpointIndex === -1 ? undefined : argv[endpointIndex + 1];
  const portValue = portIndex === -1 ? undefined : argv[portIndex + 1];
  const parsedPort = portValue ? Number(portValue) : undefined;
  const port = parsedPort !== undefined && Number.isFinite(parsedPort) ? parsedPort : undefined;

  const options: SherpaMcpHttpOptions = {
    ...base,
    ...(host !== undefined ? { host } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(endpoint !== undefined ? { endpoint } : {})
  };

  return options;
}

export function createSherpaMcpHttpHandler(options: SherpaMcpHttpOptions = {}) {
  const endpoint = options.endpoint ?? "/mcp";

  return async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

    if (url.pathname === "/health") {
      writeJson(response, 200, {
        ok: true,
        transport: "streamable-http",
        endpoint
      });
      return;
    }

    if (url.pathname !== endpoint) {
      writeJson(response, 404, {
        error: "Not found"
      });
      return;
    }

    if (request.method === "POST") {
      await handleMcpPost(request, response, options);
      return;
    }

    handleMcpMethodNotAllowed(response);
  };
}

export async function runSherpaMcpHttpServer(options: SherpaMcpHttpOptions = {}) {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8787;
  const handler = createSherpaMcpHttpHandler(options);
  const server = createServer((request, response) => {
    void handler(request, response);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  console.log(`Sherpa MCP HTTP server listening on http://${host}:${port}${options.endpoint ?? "/mcp"}`);
  return server;
}

export async function closeSherpaMcpHttpServer(server: HttpServer) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSherpaMcpHttpServer(resolveSherpaMcpHttpOptions()).catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(message);
    process.exit(1);
  });
}
