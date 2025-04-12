import * as child_process from 'node:child_process';
import * as readline from 'node:readline';
import * as schema from '../schema.js'; // Import all schema types under the 'schema' namespace

// Type for pending requests map
type PendingRequest = {
  resolve: (value: any) => void; // Resolves with the 'result' part of the response
  reject: (reason?: any) => void;
  method: string; // For debugging/logging
};

// Type for active streams map
type ActiveStream = {
  controller: ReadableStreamDefaultController<any>; // Controller for the stream we return
  method: string; // For debugging/logging
};

/**
 * Manages communication with an A2A agent running as a separate process
 * over standard input/output.
 */
export class StdioTransport {
  private serverCommand: string[];
  private cwd?: string; // Add cwd option
  private serverProcess: child_process.ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private pendingRequests: Map<string | number, PendingRequest> = new Map();
  private activeStreams: Map<string | number, ActiveStream> = new Map(); // For tasks/sendSubscribe
  private nextRequestId = 1; // Simple counter for request IDs if needed

  constructor(serverCommand: string[], options?: { cwd?: string }) { // Add options
    if (!serverCommand || serverCommand.length === 0) {
      throw new Error("serverCommand must be a non-empty array.");
    }
    // Ensure command and args are split correctly
    this.serverCommand = [...serverCommand];
    this.cwd = options?.cwd;
    console.error(`[StdioTransport] Initialized with command: ${this.serverCommand.join(' ')} ${this.cwd ? `(cwd: ${this.cwd})` : ''}`);
  }

  /**
   * Starts the A2A agent server process.
   * @returns A promise that resolves when the server process is spawned and stdout is ready, or rejects on error.
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.serverProcess) {
        console.warn("[StdioTransport] Server process already started.");
        resolve();
        return;
      }

      console.error(`[StdioTransport] Starting server process: ${this.serverCommand.join(' ')}`);
      const command = this.serverCommand[0];
      const args = this.serverCommand.slice(1);

      // Spawn the process
      this.serverProcess = child_process.spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'], // stdin, stdout, stderr
        cwd: this.cwd, // Use the specified cwd
      });

      // --- Error Handling ---
      this.serverProcess.on('error', (err) => {
        console.error('[StdioTransport] Failed to start server process:', err);
        this.serverProcess = null;
        reject(new Error(`Failed to spawn server process: ${err.message}`));
      });

      this.serverProcess.on('exit', (code, signal) => {
        console.error(`[StdioTransport] Server process exited with code ${code}, signal ${signal}`);
        this.cleanup(); // Clean up resources on exit
        // Optionally reject pending requests/streams?
        this.rejectAllPending(`Server process exited unexpectedly (code: ${code}, signal: ${signal})`);
      });

      // --- Stderr Handling ---
      this.serverProcess.stderr?.on('data', (data) => {
        console.error(`[StdioTransport Server STDERR] ${data.toString().trim()}`);
        // Check stderr for early indication of readiness or failure if needed
        // e.g., if server prints "Ready" or specific error messages
      });

      // --- Stdout Handling ---
      if (!this.serverProcess.stdout) {
          this.cleanup();
          reject(new Error("Server process stdout stream is not available."));
          return;
      }
      this.rl = readline.createInterface({
        input: this.serverProcess.stdout,
        crlfDelay: Infinity, // Handle different line endings
      });

      this.rl.on('line', (line) => {
        this._handleStdoutLine(line);
      });

      this.rl.on('close', () => {
          console.error("[StdioTransport] Server stdout stream closed.");
          // This might happen normally on exit, or indicate an issue
      });

      // Assume started once the process is spawned and streams are attached
      // More robust check could wait for a specific message on stderr/stdout
      console.error("[StdioTransport] Server process spawned.");
      resolve();
    });
  }

  /**
   * Stops the A2A agent server process.
   */
  stop(): void {
    console.error("[StdioTransport] Stopping server process...");
    if (this.serverProcess) {
      this.serverProcess.kill(); // Send SIGTERM
    }
    this.cleanup();
    this.rejectAllPending("Client stopped the transport.");
  }

  /**
   * Cleans up resources like listeners and process handles.
   */
  private cleanup(): void {
    console.error("[StdioTransport] Cleaning up resources.");
    this.rl?.close();
    this.rl = null;
    this.serverProcess?.removeAllListeners();
    this.serverProcess = null;
    // Clear pending requests/streams without rejecting again if stop() called rejectAllPending
    // this.pendingRequests.clear();
    // this.activeStreams.clear();
  }

   /**
   * Rejects all pending requests and closes active streams.
   */
  private rejectAllPending(reasonMessage: string): void {
    const error = new Error(reasonMessage);
    console.error(`[StdioTransport] Rejecting all pending requests/streams: ${reasonMessage}`);
    this.pendingRequests.forEach((req) => {
      req.reject(error);
    });
    this.pendingRequests.clear();

    this.activeStreams.forEach((stream) => {
        try {
            stream.controller.error(error); // Signal error to the stream consumer
        } catch (e) {
            console.error("[StdioTransport] Error closing stream controller:", e);
        }
    });
    this.activeStreams.clear();
  }


  /**
   * Handles a single line received from the server's stdout.
   * Parses JSON and routes to appropriate handler (request response or stream event).
   */
  private _handleStdoutLine(line: string): void {
    console.error(`[StdioTransport Server STDOUT] ${line}`);
    try {
      const message = JSON.parse(line);

      // Check if it's a JSON-RPC response (has 'id' and 'result' or 'error')
      if (message && message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
        const response = message as schema.JSONRPCResponse; // Qualify with schema namespace
        const pending = this.pendingRequests.get(response.id);
        if (pending) {
          this.pendingRequests.delete(response.id); // Remove before resolving/rejecting
          if (response.error) {
            console.error(`[StdioTransport] Received error response for ID ${response.id}:`, response.error);
            pending.reject(new Error(`RPC Error ${response.error.code}: ${response.error.message}`)); // Create a proper error object
          } else {
            console.error(`[StdioTransport] Received success response for ID ${response.id}`);
            pending.resolve(response.result);
          }
        } else {
          // Might be a response for a stream request's initial setup, or unsolicited
          console.warn(`[StdioTransport] Received response for unknown or non-pending request ID: ${response.id}`);
        }
      }
      // Check if it's a streaming event (has 'id' which is the TASK_ID, and 'status' or 'artifact')
      else if (message && message.id !== undefined && typeof message.id === 'string' && (message.status !== undefined || message.artifact !== undefined)) {
         const streamEvent = message as (schema.TaskStatusUpdateEvent | schema.TaskArtifactUpdateEvent);
         const taskId = streamEvent.id; // Event ID is the Task ID

         // Check if we have an active stream associated with this TASK_ID
         let stream = this.activeStreams.get(taskId);

         if (!stream) {
             // If not found by Task ID, check if it's the *first* event for a stream
             // still keyed by the original REQUEST_ID.
             for (const [reqId, activeStream] of this.activeStreams.entries()) {
                 // Heuristic: If the stream method was sendSubscribe/resubscribe,
                 // assume this first event belongs to it and update the map key.
                 if (activeStream.method === 'tasks/sendSubscribe' || activeStream.method === 'tasks/resubscribe') {
                     console.error(`[StdioTransport] Associating Task ID ${taskId} with original Request ID ${reqId}`);
                     // Re-key the map entry from Request ID to Task ID
                     this.activeStreams.set(taskId, activeStream);
                     this.activeStreams.delete(reqId);
                     stream = activeStream; // Found it!
                     break;
                 }
             }
         }

         if (stream) {
            console.error(`[StdioTransport] Received stream event for Task ID ${taskId}`);
            stream.controller.enqueue(streamEvent); // Pass the event to the stream consumer
            // Check if the event signals the end of the stream
            if (streamEvent.final) {
                console.error(`[StdioTransport] Stream for Task ID ${taskId} marked as final.`);
                stream.controller.close();
                this.activeStreams.delete(taskId); // Delete by Task ID
            }
         } else {
             // Still couldn't find a matching stream
             console.warn(`[StdioTransport] Received stream event for unknown or inactive Task ID: ${taskId}`);
         }
      }
      else {
        console.warn(`[StdioTransport] Received non-JSONRPC/non-event message: ${line}`);
      }
    } catch (e) {
      console.error(`[StdioTransport] Failed to parse or handle stdout line: ${line}`, e);
    }
  }

  // --- Public Methods for Sending Requests/Starting Streams ---
  // (To be implemented in the next step)

  /**
   * Sends a standard JSON-RPC request and waits for a single response.
   */
  async request<TResult = any>(method: string, params: any): Promise<TResult> {
    if (!this.serverProcess || !this.serverProcess.stdin || this.serverProcess.stdin.destroyed) {
      throw new Error("Server process is not running or stdin is not available/writable.");
    }

    const requestId = this.nextRequestId++;
    const request: schema.JSONRPCRequest = {
      jsonrpc: "2.0",
      id: requestId,
      method: method,
      params: params,
    };

    const promise = new Promise<TResult>((resolve, reject) => {
      this.pendingRequests.set(requestId, { resolve: resolve as (value: any) => void, reject, method });
      // Optional: Set a timeout for the request
      // const timeoutId = setTimeout(() => {
      //   if (this.pendingRequests.has(requestId)) {
      //     this.pendingRequests.delete(requestId);
      //     reject(new Error(`Request timed out for method ${method} (ID: ${requestId})`));
      //   }
      // }, 30000); // 30 second timeout
      // // Store timeoutId with pending request to clear it on response/error
      // this.pendingRequests.get(requestId)!.timeoutId = timeoutId;
    });

    try {
      const requestString = JSON.stringify(request);
      console.error(`[StdioTransport] Sending request (ID: ${requestId}): ${requestString}`);
      this.serverProcess.stdin.write(requestString + '\n', (err) => {
          if (err) {
              console.error(`[StdioTransport] Error writing to stdin for request ${requestId}:`, err);
              if (this.pendingRequests.has(requestId)) {
                  this.pendingRequests.get(requestId)!.reject(new Error(`Failed to write request to server stdin: ${err.message}`));
                  this.pendingRequests.delete(requestId);
              }
          }
      });
    } catch (e) {
        console.error(`[StdioTransport] Error stringifying request ${requestId}:`, e);
        this.pendingRequests.get(requestId)!.reject(new Error(`Failed to stringify request: ${e instanceof Error ? e.message : String(e)}`));
        this.pendingRequests.delete(requestId); // Clean up if stringify/write fails
        // Re-throw the error to signal immediate failure
        throw new Error(`Failed to send request: ${e instanceof Error ? e.message : String(e)}`);
    }

    return promise;
  }

  /**
   * Sends a request that initiates a stream of events.
   * Returns an AsyncIterable that yields the event payloads.
   */
  stream<TEvent = schema.TaskStatusUpdateEvent | schema.TaskArtifactUpdateEvent>(
    method: string,
    params: any
  ): AsyncIterable<TEvent> {
     if (!this.serverProcess || !this.serverProcess.stdin || this.serverProcess.stdin.destroyed) {
      // Cannot create a stream if the process isn't running
      // Return an empty async iterable that immediately throws an error
      return (async function*() {
          throw new Error("Server process is not running or stdin is not available/writable.");
      })();
    }

    const requestId = this.nextRequestId++;
    const request: schema.JSONRPCRequest = {
      jsonrpc: "2.0",
      id: requestId,
      method: method,
      params: params,
    };

    // Use ReadableStream to create the AsyncIterable
    const stream = new ReadableStream<TEvent>({
        start: (controller) => {
            // Store the controller before attempting to write
            this.activeStreams.set(requestId, { controller: controller as ReadableStreamDefaultController<any>, method });
            try {
                const requestString = JSON.stringify(request);
                console.error(`[StdioTransport] Sending stream request (ID: ${requestId}): ${requestString}`);
                this.serverProcess!.stdin!.write(requestString + '\n', (err) => {
                    if (err) {
                        console.error(`[StdioTransport] Error writing to stdin for stream request ${requestId}:`, err);
                        if (this.activeStreams.has(requestId)) {
                            this.activeStreams.get(requestId)!.controller.error(new Error(`Failed to write stream request to server stdin: ${err.message}`));
                            this.activeStreams.delete(requestId);
                        }
                    }
                });
            } catch (e) {
                console.error(`[StdioTransport] Error stringifying stream request ${requestId}:`, e);
                // Error occurred before write, reject immediately
                controller.error(new Error(`Failed to stringify stream request: ${e instanceof Error ? e.message : String(e)}`));
                this.activeStreams.delete(requestId); // Clean up
            }
        },
        cancel: (reason) => {
            console.error(`[StdioTransport] Stream ${requestId} cancelled by consumer. Reason:`, reason);
            // Optional: Send a tasks/cancel request to the server if the stream was cancelled?
            // This might require knowing the task ID associated with the stream request ID.
            // Example: this.request('tasks/cancel', { id: params.id }).catch(e => console.error("Failed to send cancel", e));
            this.activeStreams.delete(requestId);
        }
    });

    // Ensure ReadableStream is recognized as AsyncIterable<TEvent>
    return stream as AsyncIterable<TEvent>;
  }
}