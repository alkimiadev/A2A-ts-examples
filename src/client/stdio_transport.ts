import * as child_process from 'node:child_process';
import * as readline from 'node:readline';
import logger from '../logger.js'; // Import the shared logger
import * as schema from '../schema.js'; // Import all schema types under the 'schema' namespace

// Create a child logger specific to this component
const transportLogger = logger.child({ component: 'StdioTransport' });

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
    transportLogger.info({ command: this.serverCommand, cwd: this.cwd }, `Initialized`);
  }

  /**
   * Starts the A2A agent server process.
   * @returns A promise that resolves when the server process is spawned and stdout is ready, or rejects on error.
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.serverProcess) {
        transportLogger.warn("Start called but server process already exists.");
        resolve();
        return;
      }

      transportLogger.info({ command: this.serverCommand, cwd: this.cwd }, `Starting server process`);
      const command = this.serverCommand[0];
      const args = this.serverCommand.slice(1);

      // Spawn the process
      this.serverProcess = child_process.spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'], // stdin, stdout, stderr
        cwd: this.cwd, // Use the specified cwd
      });

      // --- Error Handling ---
      this.serverProcess.on('error', (err) => {
        transportLogger.error({ error: err.message, stack: err.stack }, 'Failed to start server process');
        this.serverProcess = null;
        reject(new Error(`Failed to spawn server process: ${err.message}`));
      });

      this.serverProcess.on('exit', (code, signal) => {
        transportLogger.warn({ code, signal }, `Server process exited`);
        this.cleanup(); // Clean up resources on exit
        // Optionally reject pending requests/streams?
        this.rejectAllPending(`Server process exited unexpectedly (code: ${code}, signal: ${signal})`);
      });

      // --- Stderr Handling ---
      this.serverProcess.stderr?.on('data', (data) => {
        transportLogger.debug({ stream: 'stderr', data: data.toString().trim() }, `Server STDERR data`);
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
          transportLogger.info("Server stdout stream closed.");
          // This might happen normally on exit, or indicate an issue
      });

      // Assume started once the process is spawned and streams are attached
      // More robust check could wait for a specific message on stderr/stdout
      transportLogger.info("Server process spawned and streams attached.");
      resolve();
    });
  }

  /**
   * Stops the A2A agent server process.
   */
  stop(): void {
    transportLogger.info("Stopping server process...");
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
    transportLogger.info("Cleaning up resources.");
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
    transportLogger.warn({ reason: reasonMessage }, `Rejecting all pending requests/streams`);
    this.pendingRequests.forEach((req) => {
      req.reject(error);
    });
    this.pendingRequests.clear();

    this.activeStreams.forEach((stream) => {
        try {
            stream.controller.error(error); // Signal error to the stream consumer
        } catch (e) {
            transportLogger.error({ error: e instanceof Error ? e.message : String(e) }, "Error closing stream controller during rejection");
        }
    });
    this.activeStreams.clear();
  }


  /**
   * Handles a single line received from the server's stdout.
   * Parses JSON and routes to appropriate handler (request response or stream event).
   */
  private _handleStdoutLine(line: string): void {
    transportLogger.debug({ stream: 'stdout', data: line }, `Received line`);
    try {
      const message = JSON.parse(line);

      // Check if it's a JSON-RPC response (has 'id' and 'result' or 'error')
      if (message && message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
        const response = message as schema.JSONRPCResponse; // Qualify with schema namespace
        const pending = this.pendingRequests.get(response.id);
        if (pending) {
          this.pendingRequests.delete(response.id); // Remove before resolving/rejecting
          if (response.error) {
            transportLogger.error({ reqId: response.id, errorCode: response.error.code, errorMessage: response.error.message, errorData: response.error.data }, `Received error response`);
            pending.reject(new Error(`RPC Error ${response.error.code}: ${response.error.message}`)); // Create a proper error object
          } else {
            transportLogger.debug({ reqId: response.id }, `Received success response`);
            pending.resolve(response.result);
          }
        } else {
          // Might be a response for a stream request's initial setup, or unsolicited
          transportLogger.warn({ reqId: response.id }, `Received response for unknown or non-pending request ID`);
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
                     transportLogger.debug({ taskId, reqId }, `Associating Task ID with original Request ID for stream`);
                     // Re-key the map entry from Request ID to Task ID
                     this.activeStreams.set(taskId, activeStream);
                     this.activeStreams.delete(reqId);
                     stream = activeStream; // Found it!
                     break;
                 }
             }
         }

         if (stream) {
            const eventType = 'status' in streamEvent ? 'status' : 'artifact';
            transportLogger.debug({ taskId, eventType }, `Received stream event`);
            stream.controller.enqueue(streamEvent); // Pass the event to the stream consumer
            // Check if the event signals the end of the stream
            if (streamEvent.final) {
                transportLogger.debug({ taskId }, `Stream marked as final, closing controller`);
                stream.controller.close();
                this.activeStreams.delete(taskId); // Delete by Task ID
            }
         } else {
             // Still couldn't find a matching stream
             transportLogger.warn({ taskId }, `Received stream event for unknown or inactive Task ID`);
         }
      }
      else {
        transportLogger.warn({ data: line }, `Received non-JSONRPC/non-event message`);
      }
    } catch (e) {
      transportLogger.error({ data: line, error: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined }, `Failed to parse or handle stdout line`);
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
      transportLogger.debug({ reqId: requestId, method: method, params: params }, `Sending request`);
      this.serverProcess.stdin.write(requestString + '\n', (err) => {
          if (err) {
              transportLogger.error({ reqId: requestId, error: err.message, stack: err.stack }, `Error writing request to stdin`);
              if (this.pendingRequests.has(requestId)) {
                  this.pendingRequests.get(requestId)!.reject(new Error(`Failed to write request to server stdin: ${err.message}`));
                  this.pendingRequests.delete(requestId);
              }
          }
      });
    } catch (e) {
        transportLogger.error({ reqId: requestId, error: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined }, `Error stringifying request`);
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
                transportLogger.debug({ reqId: requestId, method: method, params: params }, `Sending stream request`);
                this.serverProcess!.stdin!.write(requestString + '\n', (err) => {
                    if (err) {
                        transportLogger.error({ reqId: requestId, error: err.message, stack: err.stack }, `Error writing stream request to stdin`);
                        if (this.activeStreams.has(requestId)) {
                            this.activeStreams.get(requestId)!.controller.error(new Error(`Failed to write stream request to server stdin: ${err.message}`));
                            this.activeStreams.delete(requestId);
                        }
                    }
                });
            } catch (e) {
                transportLogger.error({ reqId: requestId, error: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined }, `Error stringifying stream request`);
                // Error occurred before write, reject immediately
                controller.error(new Error(`Failed to stringify stream request: ${e instanceof Error ? e.message : String(e)}`));
                this.activeStreams.delete(requestId); // Clean up
            }
        },
        cancel: (reason) => {
            transportLogger.info({ reqId: requestId, reason }, `Stream cancelled by consumer`);
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