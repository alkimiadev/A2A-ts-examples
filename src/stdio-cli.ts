#!/usr/bin/env node

import readline from 'node:readline';
import crypto from 'node:crypto';
import { A2AStdioClient } from './client/stdio_client.js'; // Import the Stdio client
import * as schema from './schema.js'; // Import schema types

// --- ANSI Colors (same as original cli.ts) ---
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

// --- Helper Functions (same as original cli.ts) ---
function colorize(color: keyof typeof colors, text: string): string {
  return `${colors[color]}${text}${colors.reset}`;
}

function generateTaskId(): string {
  return crypto.randomUUID();
}

// --- Argument Parsing ---
// Find the '--' separator to get the actual server command arguments
const separatorIndex = process.argv.indexOf('--');
const serverCommand = separatorIndex !== -1 ? process.argv.slice(separatorIndex + 1) : process.argv.slice(2); // Fallback if -- not found
if (serverCommand.length === 0) {
    console.error(colorize('red', 'Error: No server command provided.'));
    console.error(colorize('red', 'Usage: npm run a2a:stdio-cli -- <server_command...>'));
    console.error(colorize('red', 'Example: npm run a2a:stdio-cli -- npm run agents:movie-agent --prefix samples/js -- --transport=stdio'));
    process.exit(1);
}

// --- State ---
let currentTaskId: string = generateTaskId();
// Instantiate client, passing the server command and setting cwd to '.'
// because the npm script runs this CLI *within* the samples/js directory.
const client = new A2AStdioClient(serverCommand, { cwd: '.' });
let agentName = "Agent (stdio)"; // Default name for stdio agent

// --- Readline Setup ---
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: colorize("cyan", "You: "),
});

// --- Response Handling (Adapted for raw events) ---
function printAgentEvent(
  event: schema.TaskStatusUpdateEvent | schema.TaskArtifactUpdateEvent
) {
  const timestamp = new Date().toLocaleTimeString();
  const prefix = colorize("magenta", `\n${agentName} [${timestamp}]:`);

  // Check if it's a TaskStatusUpdateEvent
  if ("status" in event) {
    const update = event as schema.TaskStatusUpdateEvent;
    const state = update.status.state;
    let stateEmoji = "❓";
    let stateColor: keyof typeof colors = "yellow";

    switch (state) {
      case "working": stateEmoji = "⏳"; stateColor = "blue"; break;
      case "input-required": stateEmoji = "🤔"; stateColor = "yellow"; break;
      case "completed": stateEmoji = "✅"; stateColor = "green"; break;
      case "canceled": stateEmoji = "⏹️"; stateColor = "gray"; break;
      case "failed": stateEmoji = "❌"; stateColor = "red"; break;
    }
    console.log(`${prefix} ${stateEmoji} Status: ${colorize(stateColor, state)}`);
    if (update.status.message) {
      printMessageContent(update.status.message);
    }
  }
  // Check if it's a TaskArtifactUpdateEvent
  else if ("artifact" in event) {
    const update = event as schema.TaskArtifactUpdateEvent;
    console.log(
      `${prefix} 📄 Artifact Received: ${update.artifact.name || "(unnamed)"} (Index: ${update.artifact.index ?? 0})`
    );
    printMessageContent({ role: "agent", parts: update.artifact.parts });
  } else {
    console.log(prefix, colorize("yellow", "Received unknown event type:"), event);
  }
}

function printMessageContent(message: schema.Message) {
  message.parts.forEach((part, index) => {
    const partPrefix = colorize("gray", `  Part ${index + 1}:`);
    if ("text" in part) {
      console.log(`${partPrefix} ${colorize("green", "📝 Text:")}`, part.text);
    } else if ("file" in part) {
      const filePart = part as schema.FilePart;
      console.log(
        `${partPrefix} ${colorize("blue", "📄 File:")} Name: ${filePart.file.name || "N/A"}, Type: ${filePart.file.mimeType || "N/A"}, Source: ${filePart.file.bytes ? "Inline (bytes)" : filePart.file.uri}`
      );
    } else if ("data" in part) {
      const dataPart = part as schema.DataPart;
      console.log(`${partPrefix} ${colorize("yellow", "📊 Data:")}`, JSON.stringify(dataPart.data, null, 2));
    }
  });
}

// --- Main Loop ---
async function main() {
  console.log(colorize("bright", `A2A Stdio Terminal Client`));
  console.log(colorize("dim", `Server Command: ${serverCommand.join(' ')}`));

  // Agent card fetching is not applicable for stdio client
  // We could potentially implement a custom 'getAgentCard' method over stdio if needed

  console.log(colorize("dim", `Starting Task ID: ${currentTaskId}`));
  console.log(colorize("gray", `Enter messages, or use '/new' to start a new task.`));

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    if (input.toLowerCase() === "/new") {
      currentTaskId = generateTaskId();
      console.log(colorize("bright", `✨ Starting new Task ID: ${currentTaskId}`));
      rl.prompt();
      return;
    }

    const params: schema.TaskSendParams = {
      id: currentTaskId,
      message: {
        role: "user",
        parts: [{ type: "text", text: input }],
      },
    };

    try {
      console.log(colorize("gray", "Sending..."));
      // Use sendTaskSubscribe for streaming interaction
      const stream = client.sendTaskSubscribe(params);
      for await (const event of stream) {
        printAgentEvent(event); // Handle raw events
      }
      console.log(colorize("dim", `--- End of response stream for this input ---`));
    } catch (error: any) {
      console.error(
        colorize("red", `\n❌ Error communicating with agent (${agentName}):`),
        error.message || error
      );
      // Stdio client might throw different error types than HTTP client
      if (error.code) console.error(colorize("gray", `   Code: ${error.code}`));
      if (error.data) console.error(colorize("gray", `   Data: ${JSON.stringify(error.data)}`));
      if (error.stack) console.error(colorize("gray", `   Stack: ${error.stack}`));
    } finally {
      rl.prompt();
    }
  }).on("close", () => {
    console.log(colorize("yellow", "\nExiting terminal client. Stopping agent..."));
    client.close(); // Ensure agent process is stopped
    process.exit(0);
  });

  // Handle Ctrl+C gracefully
  process.on('SIGINT', () => {
    rl.close();
  });
}

// --- Start ---
main().catch(err => {
    // Catch errors during client/transport startup
    console.error(colorize("red", "Failed to start client:"), err);
    process.exit(1);
});