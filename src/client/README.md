# A2A Client (JS)

This directory contains TypeScript client implementations for the Agent-to-Agent (A2A) communication protocol, supporting both HTTP and stdio transports.

## HTTP Client (`client.ts`)

This file defines the `A2AClient` class, which provides methods for interacting with an A2A server over HTTP using JSON-RPC.

### Key Features:

- **JSON-RPC Communication:** Handles sending requests and receiving responses (both standard and streaming via Server-Sent Events) according to the JSON-RPC 2.0 specification.
- **A2A Methods:** Implements standard A2A methods like `sendTask`, `sendTaskSubscribe`, `getTask`, `cancelTask`, `setTaskPushNotification`, `getTaskPushNotification`, and `resubscribeTask`.
- **Error Handling:** Provides basic error handling for network issues and JSON-RPC errors.
- **Streaming Support:** Manages Server-Sent Events (SSE) for real-time task updates (`sendTaskSubscribe`, `resubscribeTask`).
- **Extensibility:** Allows providing a custom `fetch` implementation for different environments (e.g., Node.js).

### Basic Usage

```typescript
import { A2AClient, Task, TaskQueryParams, TaskSendParams } from "./client"; // Import necessary types
import { v4 as uuidv4 } from "uuid"; // Example for generating task IDs

const client = new A2AClient("http://localhost:41241"); // Replace with your server URL

async function run() {
  try {
    // Send a simple task (pass only params)
    const taskId = uuidv4();
    const sendParams: TaskSendParams = {
      id: taskId,
      message: { role: "user", parts: [{ text: "Hello, agent!" }] },
    };
    // Method now returns Task | null directly
    const taskResult: Task | null = await client.sendTask(sendParams);
    console.log("Send Task Result:", taskResult);

    // Get task status (pass only params)
    const getParams: TaskQueryParams = { id: taskId };
    // Method now returns Task | null directly
    const getTaskResult: Task | null = await client.getTask(getParams);
    console.log("Get Task Result:", getTaskResult);
  } catch (error) {
    console.error("A2A Client Error:", error);
  }
}

run();
```

### Streaming Usage

```typescript
import {
  A2AClient,
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
  TaskSendParams, // Use params type directly
} from "./client"; // Adjust path if necessary
import { v4 as uuidv4 } from "uuid";

const client = new A2AClient("http://localhost:41241");

async function streamTask() {
  const streamingTaskId = uuidv4();
  try {
    console.log(`\n--- Starting streaming task ${streamingTaskId} ---`);
    // Construct just the params
    const streamParams: TaskSendParams = {
      id: streamingTaskId,
      message: { role: "user", parts: [{ text: "Stream me some updates!" }] },
    };
    // Pass only params to the client method
    const stream = client.sendTaskSubscribe(streamParams);

    // Stream now yields the event payloads directly
    for await (const event of stream) {
      // Type guard to differentiate events based on structure
      if ("status" in event) {
        // It's a TaskStatusUpdateEvent
        const statusEvent = event as TaskStatusUpdateEvent; // Cast for clarity
        console.log(
          `[${streamingTaskId}] Status Update: ${statusEvent.status.state} - ${
            statusEvent.status.message?.parts[0]?.text ?? "No message"
          }`
        );
        if (statusEvent.final) {
          console.log(`[${streamingTaskId}] Stream marked as final.`);
          break; // Exit loop when server signals completion
        }
      } else if ("artifact" in event) {
        // It's a TaskArtifactUpdateEvent
        const artifactEvent = event as TaskArtifactUpdateEvent; // Cast for clarity
        console.log(
          `[${streamingTaskId}] Artifact Update: ${
            artifactEvent.artifact.name ??
            `Index ${artifactEvent.artifact.index}`
          } - Part Count: ${artifactEvent.artifact.parts.length}`
        );
        // Process artifact content (e.g., artifactEvent.artifact.parts[0].text)
      } else {
        console.warn("Received unknown event structure:", event);
      }
    }
    console.log(`--- Streaming task ${streamingTaskId} finished ---`);
  } catch (error) {
    console.error(`Error during streaming task ${streamingTaskId}:`, error);
  }
}

streamTask();
```

This HTTP client is designed to work with servers implementing the A2A protocol specification over HTTP.

---

## Stdio Transport (`stdio_transport.ts`)

This file defines the `StdioTransport` class.

### Purpose

-   Manages the lifecycle (starting, stopping) of an A2A agent running as a separate child process.
-   Handles the low-level exchange of newline-delimited JSON-RPC messages over the child process's standard input (stdin) and standard output (stdout).
-   Listens to the child process's standard error (stderr) for logging output from the agent.
-   It is primarily intended for internal use by the `A2AStdioClient`.

---

## Stdio Client (`stdio_client.ts`)

This file defines the `A2AStdioClient` class.

### Purpose

-   Provides a high-level client interface for interacting with A2A agents that run as local child processes, communicating via stdio.
-   Uses `StdioTransport` internally to manage the process and communication.

### Key Features

-   **Process Management:** Takes a command array (`serverCommand`) during instantiation to specify how to launch the agent process. Can also take a working directory (`cwd`) option.
-   **A2A Methods:** Implements the *same* standard A2A method interface as the HTTP `A2AClient` (`sendTask`, `sendTaskSubscribe`, `getTask`, `cancelTask`, etc.). This allows client-side code to potentially interact with both HTTP and stdio agents using a similar pattern.
-   **Direct Communication:** Interacts directly with the agent process via stdin/stdout, bypassing HTTP.

### Differences from HTTP Client

-   **No HTTP:** Does not use HTTP requests or listen on ports.
-   **No Discovery:** Does not support agent discovery via URLs or `.well-known/agent.json`. The client must know the exact command to run the agent.
-   **Instantiation:** Requires a `serverCommand` array instead of a server URL.

### Basic Usage

```typescript
import { A2AStdioClient, Task, TaskQueryParams, TaskSendParams } from "./stdio_client"; // Import from stdio_client
import * as schema from '../schema'; // Import schema for types
import { v4 as uuidv4 } from "uuid";

// 1. Define the command to run the agent server
const serverCommand = [
  'npx',
  'tsx',
  'src/agents/movie-agent/index.ts', // Path to the agent's entry point
  '--transport=stdio' // Argument telling the agent to use stdio mode
];

// 2. Instantiate the client
// The cwd might be needed depending on how the CLI/agent is structured
const client = new A2AStdioClient(serverCommand, { cwd: '.' });

async function runStdio() {
  const taskId = uuidv4();
  try {
    console.log(`--- Starting stdio task ${taskId} ---`);
    // 3. Send a task (using the same method signature as HTTP client)
    const sendParams: schema.TaskSendParams = {
      id: taskId,
      message: { role: "user", parts: [{ text: "Tell me about the movie Inception" }] },
    };

    // Use sendTaskSubscribe for streaming interaction
    const stream = client.sendTaskSubscribe(sendParams);

    for await (const event of stream) {
      if ("status" in event) {
        const statusEvent = event as schema.TaskStatusUpdateEvent;
        console.log(
          `[${taskId}] Status: ${statusEvent.status.state} - ${
            statusEvent.status.message?.parts[0]?.text ?? "(no message)"
          }`
        );
        if (statusEvent.final) break;
      } else if ("artifact" in event) {
        const artifactEvent = event as schema.TaskArtifactUpdateEvent;
        console.log(`[${taskId}] Artifact: ${artifactEvent.artifact.name ?? "unnamed"}`);
        // Process artifact parts
      }
    }
    console.log(`--- Stdio task ${taskId} finished ---`);

  } catch (error) {
    console.error(`A2A Stdio Client Error (Task ${taskId}):`, error);
  } finally {
    // 4. Close the client (stops the transport and kills the agent process)
    client.close();
  }
}

runStdio();
```

This client enables interaction with locally running A2A agents without requiring network setup, suitable for CLI tools or local orchestration.
