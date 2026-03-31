# @sherpa/sdk

Sherpa's Node and Bun SDK.

## Install

```bash
npm install @sherpa/sdk
```

## Basic Use

```ts
import { SherpaClient } from "@sherpa/sdk";

const sherpa = SherpaClient.forAgent({ agentId: "main" });

const next = await sherpa.workflowNext("case-123");
```

The SDK exposes the same procedural retrieval surface as the CLI and MCP server, without requiring direct engine management in application code.
