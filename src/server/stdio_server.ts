import readline from 'node:readline';
import logger from '../logger.js'; // Import the shared logger
import * as schema from '../schema.js';
import {
  JSONRPCRequest,
  JSONRPCResponse,
  JSONRPCError,
  ErrorCodeParseError,
  ErrorCodeInvalidRequest,
  ErrorCodeInternalError,
  ErrorCodeMethodNotFound,
  ErrorCodeInvalidParams,
  TaskState,
  TaskStatus,
  Artifact,
  Message,
  Task,
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
  SendTaskRequest,
  SendTaskStreamingRequest,
  GetTaskRequest,
  CancelTaskRequest,
} from '../schema.js';
import { TaskStore, InMemoryTaskStore, TaskAndHistory } from './store.js';
import { TaskHandler, TaskContext, TaskYieldUpdate } from './handler.js';
import { A2AError } from './error.js';
import {
  getCurrentTimestamp,
  isTaskStatusUpdate,
  isArtifactUpdate,
} from './utils.js';

// Create a child logger specific to this component
const serverLogger = logger.child({ component: 'A2AStdioServer' });

/**
 * Options for configuring the A2AStdioServer.
 */
export interface A2AStdioServerOptions {
  /** Task storage implementation. Defaults to InMemoryTaskStore. */
  taskStore?: TaskStore;
}

/**
 * Implements an A2A specification compliant server communicating over stdio.
 */
export class A2AStdioServer {
  private taskHandler: TaskHandler;
  private taskStore: TaskStore;
  private activeCancellations: Set<string> = new Set();
  private rl?: readline.Interface; // Readline interface

  constructor(handler: TaskHandler, options: A2AStdioServerOptions = {}) { // Added options type
    this.taskHandler = handler;
    this.taskStore = options.taskStore ?? new InMemoryTaskStore();
    serverLogger.info("Initialized.");
  }

  /**
   * Starts the server listening on stdin.
   */
  start(): void {
    if (this.rl) {
      serverLogger.warn("Start called but server is already running.");
      return; // Added return statement
    }
    serverLogger.info("Starting...");

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout, // We write directly, this is just needed by readline
      terminal: false, // Treat as a pipe
    });

    this.rl.on('line', (line) => {
        // Use a non-blocking wrapper to allow processing multiple lines if they arrive quickly
        this._processLine(line).catch((err: any) => { // Added type annotation for err
            // Catch unexpected errors during line processing itself
            serverLogger.error({ error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined }, "Uncaught error processing line");
            // Attempt to send a generic internal error response if possible
            try {
                const errorResponse = this._normalizeError(err, null); // No request ID available here
                this._writeResponse(errorResponse);
            } catch (writeErr) {
                serverLogger.fatal({ error: writeErr instanceof Error ? writeErr.message : String(writeErr) }, "Failed to write error response after line processing error");
            }
        });
    });

    this.rl.on('close', () => {
      serverLogger.info("Stdin stream closed. Exiting.");
      process.exit(0);
    });

    // Keep the process running until stdin is closed
    process.stdin.resume();

    serverLogger.info("Ready and listening on stdin.");
  }

  /**
   * Processes a single line received from stdin.
   */
  private async _processLine(line: string): Promise<void> {
    serverLogger.debug({ data: line }, `Received line`);
    let request: JSONRPCRequest | null = null;
    try {
      request = JSON.parse(line) as JSONRPCRequest;

      // Basic validation
      if (request?.jsonrpc !== '2.0' || !request.method) {
        throw A2AError.invalidRequest("Invalid JSON-RPC request structure.");
      }

      serverLogger.debug({ reqId: request.id, method: request.method }, `Parsed request`);

      await this._routeRequest(request);

    } catch (error: any) {
      // Error logging is handled within _normalizeError
      // Use the normalizeError helper function
      const errorResponse = this._normalizeError(error, request?.id ?? null, request?.params?.['id']);
      this._writeResponse(errorResponse);
    }
  }

  /**
   * Routes the request to the appropriate handler method.
   */
  private async _routeRequest(request: JSONRPCRequest): Promise<void> {
     switch (request.method) {
      case "tasks/send":
        await this._handleTaskSend(request as SendTaskRequest);
        break;
      case "tasks/sendSubscribe":
        await this._handleTaskSendSubscribe(request as SendTaskStreamingRequest);
        break;
      case "tasks/get":
        await this._handleTaskGet(request as GetTaskRequest);
        break;
      case "tasks/cancel":
        await this._handleTaskCancel(request as CancelTaskRequest);
        break;
      default:
        throw A2AError.methodNotFound(request.method);
    }
  }

  // === Internal Request Handlers (Adapted from previous implementation / A2AServer) ===

  private async _handleTaskSend(req: SendTaskRequest): Promise<void> {
    this._validateTaskSendParams(req.params);
    const { id: taskId, message, sessionId, metadata } = req.params;

    let currentData = await this._loadOrCreateTaskAndHistory(
      taskId,
      message,
      sessionId,
      metadata
    );
    const context = this._createTaskContext(
      currentData.task,
      message,
      currentData.history
    );
    const generator = this.taskHandler(context);

    try {
      for await (const yieldValue of generator) {
        currentData = this._applyUpdateToTaskAndHistory(currentData, yieldValue);
        await this.taskStore.save(currentData);
        context.task = currentData.task; // Update context snapshot
      }
    } catch (handlerError) {
      const failureStatusUpdate: Omit<TaskStatus, "timestamp"> = {
        state: "failed",
        message: {
          role: "agent",
          parts: [ { text: `Handler failed: ${ handlerError instanceof Error ? handlerError.message : String(handlerError) }` } ],
        },
      };
      currentData = this._applyUpdateToTaskAndHistory( currentData, failureStatusUpdate );
      try {
        await this.taskStore.save(currentData);
      } catch (saveError) {
        serverLogger.error({ taskId, error: saveError instanceof Error ? saveError.message : String(saveError), stack: saveError instanceof Error ? saveError.stack : undefined }, `Failed to save task after handler error`);
      }
      // Rethrow normalized error, which will be caught by _processLine
      throw this._normalizeError(handlerError, req.id, taskId).error; // Throw the inner error object
    }

    // Send the final task state
    this._writeResponse(this._createSuccessResponse(req.id, currentData.task));
  }

  private async _handleTaskSendSubscribe(req: SendTaskStreamingRequest): Promise<void> {
    this._validateTaskSendParams(req.params);
    const { id: taskId, message, sessionId, metadata } = req.params;

    let currentData = await this._loadOrCreateTaskAndHistory(
      taskId,
      message,
      sessionId,
      metadata
    );
    const context = this._createTaskContext(
      currentData.task,
      message,
      currentData.history
    );
    const generator = this.taskHandler(context);

    let lastEventWasFinal = false;

    try {
      for await (const yieldValue of generator) {
        currentData = this._applyUpdateToTaskAndHistory(currentData, yieldValue);
        await this.taskStore.save(currentData);
        context.task = currentData.task;

        let event: TaskStatusUpdateEvent | TaskArtifactUpdateEvent;
        let isFinal = false;

        if (isTaskStatusUpdate(yieldValue)) {
          const terminalStates: TaskState[] = [ "completed", "failed", "canceled", "input-required" ];
          isFinal = terminalStates.includes(currentData.task.status.state);
          event = this._createTaskStatusEvent( taskId, currentData.task.status, isFinal );
          if (isFinal) serverLogger.debug({ taskId, state: currentData.task.status.state }, `Yielded terminal state, marking event as final.`);
        } else if (isArtifactUpdate(yieldValue)) {
          const updatedArtifact = currentData.task.artifacts?.find(
              (a) => (a.index !== undefined && a.index === yieldValue.index) || (a.name && a.name === yieldValue.name)
            ) ?? yieldValue;
          event = this._createTaskArtifactEvent(taskId, updatedArtifact, false);
        } else {
          serverLogger.warn({ taskId, yieldValue }, "Handler yielded unknown value type");
          continue;
        }

        // Send the raw event object for streaming
        this._writeResponse(event);
        lastEventWasFinal = isFinal;

        if (isFinal) break;
      }

      if (!lastEventWasFinal && !context.isCancelled()) { // Also check for cancellation
        serverLogger.debug({ taskId, state: currentData.task.status.state }, `Handler finished without yielding terminal state. Sending final state.`);
        const finalStates: TaskState[] = ["completed", "failed", "canceled", "input-required"];
        if (!finalStates.includes(currentData.task.status.state)) {
          serverLogger.warn({ taskId, state: currentData.task.status.state }, `Task ended non-terminally. Forcing 'completed'.`);
          currentData = this._applyUpdateToTaskAndHistory(currentData, { state: "completed" });
          await this.taskStore.save(currentData);
        }
        const finalEvent = this._createTaskStatusEvent( taskId, currentData.task.status, true );
        this._writeResponse(finalEvent); // Send final event
      }
    } catch (handlerError) {
      serverLogger.error({ taskId, error: handlerError instanceof Error ? handlerError.message : String(handlerError), stack: handlerError instanceof Error ? handlerError.stack : undefined }, `Handler error during streaming`);
      const failureUpdate: Omit<TaskStatus, "timestamp"> = {
        state: "failed",
        message: { role: "agent", parts: [{ text: `Handler failed: ${handlerError instanceof Error ? handlerError.message : String(handlerError)}` }] },
      };
      currentData = this._applyUpdateToTaskAndHistory(currentData, failureUpdate);
      try {
        await this.taskStore.save(currentData);
      } catch (saveError) {
        serverLogger.error({ taskId, error: saveError instanceof Error ? saveError.message : String(saveError), stack: saveError instanceof Error ? saveError.stack : undefined }, `Failed to save task after handler error during streaming`);
      }
      const errorEvent = this._createTaskStatusEvent( taskId, currentData.task.status, true );
      this._writeResponse(errorEvent); // Send final error event
      // Don't rethrow, error is communicated via the stream
    }
    // No final JSON-RPC response needed for streaming
  }


  private async _handleTaskGet(req: GetTaskRequest): Promise<void> {
    const { id: taskId } = req.params;
    if (!taskId) throw A2AError.invalidParams("Missing task ID.");

    const data = await this.taskStore.load(taskId);
    if (!data) {
      throw A2AError.taskNotFound(taskId);
    }
    this._writeResponse(this._createSuccessResponse(req.id, data.task));
  }

  private async _handleTaskCancel(req: CancelTaskRequest): Promise<void> {
    const { id: taskId } = req.params;
    if (!taskId) throw A2AError.invalidParams("Missing task ID.");

    let data = await this.taskStore.load(taskId);
    if (!data) {
      throw A2AError.taskNotFound(taskId);
    }

    const finalStates: TaskState[] = ["completed", "failed", "canceled"];
    if (finalStates.includes(data.task.status.state)) {
      serverLogger.warn({ taskId, state: data.task.status.state }, `Attempted to cancel task already in final state.`);
      this._writeResponse(this._createSuccessResponse(req.id, data.task));
      return;
    }

    this.activeCancellations.add(taskId);

    const cancelUpdate: Omit<TaskStatus, "timestamp"> = {
      state: "canceled",
      message: { role: "agent", parts: [{ text: "Task cancelled by request." }] },
    };
    data = this._applyUpdateToTaskAndHistory(data, cancelUpdate);

    await this.taskStore.save(data);
    this.activeCancellations.delete(taskId); // Remove *after* saving

    this._writeResponse(this._createSuccessResponse(req.id, data.task));
  }


  // === Helper Functions (Adapted from A2AServer) ===

  private _applyUpdateToTaskAndHistory(
    current: TaskAndHistory,
    update: Omit<TaskStatus, "timestamp"> | Artifact
  ): TaskAndHistory {
      let newTask = { ...current.task };
      let newHistory = [...current.history];

      if (isTaskStatusUpdate(update)) {
        newTask.status = { ...newTask.status, ...update, timestamp: getCurrentTimestamp() };
        if (update.message?.role === "agent") newHistory.push(update.message);
      } else if (isArtifactUpdate(update)) {
        newTask.artifacts = newTask.artifacts ? [...newTask.artifacts] : [];
        const existingIndex = update.index ?? -1;
        let replaced = false;
        if (existingIndex >= 0 && existingIndex < newTask.artifacts.length) {
          const existingArtifact = newTask.artifacts[existingIndex];
          if (update.append) {
            const appendedArtifact = JSON.parse(JSON.stringify(existingArtifact));
            appendedArtifact.parts.push(...update.parts);
            if (update.metadata) appendedArtifact.metadata = { ...(appendedArtifact.metadata || {}), ...update.metadata };
            if (update.lastChunk !== undefined) appendedArtifact.lastChunk = update.lastChunk;
            if (update.description) appendedArtifact.description = update.description;
            newTask.artifacts[existingIndex] = appendedArtifact;
            replaced = true;
          } else {
            newTask.artifacts[existingIndex] = { ...update };
            replaced = true;
          }
        } else if (update.name) {
          const namedIndex = newTask.artifacts.findIndex((a) => a.name === update.name);
          if (namedIndex >= 0) {
            newTask.artifacts[namedIndex] = { ...update };
            replaced = true;
          }
        }
        if (!replaced) {
          newTask.artifacts.push({ ...update });
          if (newTask.artifacts.some((a) => a.index !== undefined)) {
            newTask.artifacts.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
          }
        }
      }
      return { task: newTask, history: newHistory };
  }


  private async _loadOrCreateTaskAndHistory(
    taskId: string,
    initialMessage: Message,
    sessionId?: string | null,
    metadata?: Record<string, unknown> | null
  ): Promise<TaskAndHistory> {
    let data = await this.taskStore.load(taskId);
    let needsSave = false;

    if (!data) {
      const initialTask: Task = {
        id: taskId, sessionId: sessionId ?? undefined,
        status: { state: "submitted", timestamp: getCurrentTimestamp(), message: null },
        artifacts: [], metadata: metadata ?? undefined,
      };
      data = { task: initialTask, history: [initialMessage] };
      needsSave = true;
      serverLogger.debug({ taskId }, `Created new task and history.`);
    } else {
      serverLogger.debug({ taskId }, `Loaded existing task and history.`);
      data = { task: data.task, history: [...data.history, initialMessage] };
      needsSave = true;
      const finalStates: TaskState[] = ["completed", "failed", "canceled"];
      if (finalStates.includes(data.task.status.state)) {
        serverLogger.warn({ taskId, state: data.task.status.state }, `Received message for task in final state. Resetting to 'submitted'.`);
        data = this._applyUpdateToTaskAndHistory(data, { state: "submitted", message: null });
      } else if (data.task.status.state === "input-required") {
        serverLogger.debug({ taskId }, `Received message while 'input-required', changing state to 'working'.`);
        data = this._applyUpdateToTaskAndHistory(data, { state: "working" });
      } else if (data.task.status.state === "working") {
        serverLogger.warn({ taskId }, `Received message while already 'working'. Proceeding.`);
      }
    }
    if (needsSave) await this.taskStore.save(data);
    return { task: { ...data.task }, history: [...data.history] }; // Return copies
  }

  private _createTaskContext( task: Task, userMessage: Message, history: Message[] ): TaskContext {
    return {
      task: { ...task }, userMessage: userMessage, history: [...history],
      isCancelled: () => this.activeCancellations.has(task.id),
    };
  }

  private _validateTaskSendParams(params: any): asserts params is schema.TaskSendParams {
    if (!params || typeof params !== "object") throw A2AError.invalidParams("Missing or invalid params object.");
    if (typeof params.id !== "string" || params.id === "") throw A2AError.invalidParams("Invalid or missing task ID (params.id).");
    if (!params.message || typeof params.message !== "object" || !Array.isArray(params.message.parts)) {
      throw A2AError.invalidParams("Invalid or missing message object (params.message).");
    }
  }

  private _createSuccessResponse<T>(id: number | string | null, result: T): JSONRPCResponse<T> {
    if (id === null) throw A2AError.internalError("Cannot create success response for null ID.");
    return { jsonrpc: "2.0", id: id, result: result };
  }

  private _createErrorResponse(id: number | string | null, error: JSONRPCError<unknown>): JSONRPCResponse<null, unknown> {
    return { jsonrpc: "2.0", id: id, error: error };
  }

  private _normalizeError(error: any, reqId: number | string | null, taskId?: string): JSONRPCResponse<null, unknown> {
    let a2aError: A2AError;
    if (error instanceof A2AError) a2aError = error;
    else if (error instanceof Error) a2aError = A2AError.internalError(error.message, { stack: error.stack });
    else a2aError = A2AError.internalError("An unknown error occurred.", error);
    if (taskId && !a2aError.taskId) a2aError.taskId = taskId;
    serverLogger.error({ taskId: a2aError.taskId, reqId, errorCode: a2aError.code, errorMessage: a2aError.message, errorData: a2aError.data, stack: a2aError.stack }, `Error processing request`);
    return this._createErrorResponse(reqId, a2aError.toJSONRPCError());
  }

  private _createTaskStatusEvent(taskId: string, status: TaskStatus, final: boolean): TaskStatusUpdateEvent {
    return { id: taskId, status: status, final: final };
  }

  private _createTaskArtifactEvent(taskId: string, artifact: Artifact, final: boolean): TaskArtifactUpdateEvent {
    return { id: taskId, artifact: artifact, final: final };
  }

  /** Writes response object (JSON-RPC or raw event) to stdout */
  private _writeResponse(response: JSONRPCResponse | TaskStatusUpdateEvent | TaskArtifactUpdateEvent) {
    try {
      const responseString = JSON.stringify(response);
      process.stdout.write(responseString + '\n');
      serverLogger.debug({ response: response }, `Sent response/event`); // Log the object directly for structured logging
    } catch (stringifyError: any) {
        serverLogger.fatal({ error: stringifyError.message, stack: stringifyError.stack }, "Failed to stringify response");
    }
  }
}

// Example Usage (if run directly, requires a handler to be passed or imported)
// This part would typically be in the agent's index.ts file now.
/*
import { movieAgentHandler } from '../agents/movie-agent/index.js'; // Assuming export
const server = new A2AStdioServer(movieAgentHandler);
server.start();
*/