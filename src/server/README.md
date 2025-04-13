# A2A Server (JS)

This directory contains TypeScript server implementations for the Agent-to-Agent (A2A) communication protocol. It includes:

1.  An HTTP-based server using Express.js (`server.ts`, conceptual example below).
2.  A stdio-based server (`stdio_server.ts`) for running agents as local processes.

## HTTP Server (`server.ts` - Conceptual Example)

This server handles A2A communication over HTTP.

```typescript
import {
  A2AServer,
  InMemoryTaskStore,
  TaskContext,
  TaskYieldUpdate,
} from "./index"; // Assuming imports from the server package

// 1. Define your agent's logic as a TaskHandler
async function* myAgentLogic(
  context: TaskContext
): AsyncGenerator<TaskYieldUpdate> {
  console.log(`Handling task: ${context.task.id}`);
  yield {
    state: "working",
    message: { role: "agent", parts: [{ text: "Processing..." }] },
  };

  // Simulate work...
  await new Promise((resolve) => setTimeout(resolve, 1000));

  if (context.isCancelled()) {
    console.log("Task cancelled!");
    yield { state: "canceled" };
    return;
  }

  // Yield an artifact
  yield {
    name: "result.txt",
    mimeType: "text/plain",
    parts: [{ text: `Task ${context.task.id} completed.` }],
  };

  // Yield final status
  yield {
    state: "completed",
    message: { role: "agent", parts: [{ text: "Done!" }] },
  };
}

// 2. Create and start the server
const store = new InMemoryTaskStore(); // Or new FileStore()
const server = new A2AServer(myAgentLogic, { taskStore: store });

server.start(); // Starts listening on default port 41241

console.log("A2A Server started.");
```

This HTTP server implementation provides a foundation for building A2A-compliant agents accessible over the network.

---

## Stdio Server (`stdio_server.ts`)

This server handles A2A communication over standard input/output (stdin/stdout), allowing an agent to run as a child process managed by a client like `A2AStdioClient`.

### Purpose

-   Enables local execution of A2A agents without needing HTTP ports.
-   Communication happens via newline-delimited JSON-RPC messages on stdin/stdout.
-   Designed to be invoked by a controlling process (e.g., `stdio-cli.ts`).

### Basic Usage (within an Agent script)

The `A2AStdioServer` is typically instantiated and started within the main script of the agent itself.

```typescript
// Example: src/agents/my-agent/index.ts
import { A2AStdioServer, TaskContext, TaskYieldUpdate, InMemoryTaskStore } from "../../server"; // Adjust path as needed

// 1. Define your agent's logic (same TaskHandler as HTTP server)
async function* myAgentLogic(
  context: TaskContext
): AsyncGenerator<TaskYieldUpdate> {
  // ... (Agent logic using yield for status/artifacts)
  yield { state: "working" };
  await new Promise(resolve => setTimeout(resolve, 500));
  yield { state: "completed", message: { role: "agent", parts: [{ text: "Done via stdio!" }] } };
}

// 2. Check if running in stdio mode (e.g., via command-line arg)
const transport = process.argv.includes('--transport=stdio') ? 'stdio' : 'http'; // Example check

if (transport === 'stdio') {
  // 3. Create and start the Stdio server
  const store = new InMemoryTaskStore();
  const server = new A2AStdioServer(myAgentLogic, { taskStore: store });
  server.start(); // Listens on stdin, writes to stdout/stderr
  // No Express app or port listening needed
} else {
  // Optional: Start an HTTP server if not in stdio mode
  // const httpServer = new A2AServer(myAgentLogic, ...);
  // httpServer.start();
}
```

### Task Handler

The `A2AStdioServer` uses the same `TaskHandler` interface as the HTTP server. This allows you to potentially reuse the core agent logic regardless of the transport mechanism.

### Logging

The `A2AStdioServer` uses the shared logger (`src/logger.ts`). All log output (INFO, WARN, ERROR, etc.) is directed to `stderr` to keep `stdout` exclusively for the JSON-RPC messages required by the A2A protocol over stdio.
