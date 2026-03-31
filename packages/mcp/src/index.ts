#!/usr/bin/env node

import { runSherpaMcpServer, resolveSherpaMcpOptions } from "./server.js";

export * from "./server.js";

if (import.meta.url === `file://${process.argv[1]}`) {
  runSherpaMcpServer(resolveSherpaMcpOptions()).catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(message);
    process.exit(1);
  });
}
