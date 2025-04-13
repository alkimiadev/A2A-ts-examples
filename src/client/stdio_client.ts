import { StdioTransport } from './stdio_transport.js';
import logger from '../logger.js'; // Import the shared logger
import * as schema from '../schema.js';

// Create a child logger specific to this component
const clientLogger = logger.child({ component: 'A2AStdioClient' });

/**
 * A client implementation for the A2A protocol that communicates
 * with an A2A agent running as a separate process over stdio.
 */
export class A2AStdioClient {
  private transport: StdioTransport;
  private startPromise: Promise<void>; // To await transport start

  /**
   * Creates an instance of A2AStdioClient.
   * @param serverCommand An array containing the command and arguments to start the server process.
   * @param options Optional settings, including the working directory (`cwd`) for the server process.
   */
  constructor(serverCommand: string[], options?: { cwd?: string }) { // Add options
    this.transport = new StdioTransport(serverCommand, options); // Pass options to transport
    // Start the transport immediately but allow awaiting its completion
    this.startPromise = this.transport.start().catch(err => {
        clientLogger.error({ error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined }, "Transport failed to start");
        // Propagate the error so users awaiting start know it failed
        throw err;
    });
  }

  /**
   * Ensures the underlying transport is started before proceeding.
   */
  private async ensureStarted(): Promise<void> {
    await this.startPromise;
  }

  /**
   * Closes the connection to the agent process.
   */
  close(): void {
    this.transport.stop();
  }

  // --- A2A Methods ---

  /**
   * Sends a task request to the agent (non-streaming).
   * @param params The parameters for the tasks/send method.
   * @returns A promise resolving to the Task object or null.
   */
  async sendTask(params: schema.TaskSendParams): Promise<schema.Task | null> {
    await this.ensureStarted();
    // The transport's request method returns the 'result' part directly
    return this.transport.request<schema.Task | null>("tasks/send", params);
  }

  /**
   * Sends a task request and subscribes to streaming updates.
   * @param params The parameters for the tasks/sendSubscribe method.
   * @yields TaskStatusUpdateEvent or TaskArtifactUpdateEvent payloads.
   */
  sendTaskSubscribe(
    params: schema.TaskSendParams
  ): AsyncIterable<schema.TaskStatusUpdateEvent | schema.TaskArtifactUpdateEvent> {
    // Need to handle the case where ensureStarted fails *before* returning the iterable
    const startAndStream = async function* (this: A2AStdioClient): AsyncIterable<schema.TaskStatusUpdateEvent | schema.TaskArtifactUpdateEvent> {
        await this.ensureStarted();
        // The transport's stream method returns the AsyncIterable directly
        yield* this.transport.stream<schema.TaskStatusUpdateEvent | schema.TaskArtifactUpdateEvent>(
            "tasks/sendSubscribe",
            params
        );
    }.bind(this);

    return startAndStream();
  }

  /**
   * Retrieves the current state of a task.
   * @param params The parameters for the tasks/get method.
   * @returns A promise resolving to the Task object or null.
   */
  async getTask(params: schema.TaskQueryParams): Promise<schema.Task | null> {
    await this.ensureStarted();
    return this.transport.request<schema.Task | null>("tasks/get", params);
  }

  /**
   * Cancels a currently running task.
   * @param params The parameters for the tasks/cancel method.
   * @returns A promise resolving to the updated Task object (usually canceled state) or null.
   */
  async cancelTask(params: schema.TaskIdParams): Promise<schema.Task | null> {
    await this.ensureStarted();
    return this.transport.request<schema.Task | null>("tasks/cancel", params);
  }

  /**
   * Sets or updates the push notification config for a task.
   * @param params The parameters for the tasks/pushNotification/set method (which is TaskPushNotificationConfig).
   * @returns A promise resolving to the confirmed TaskPushNotificationConfig or null.
   */
  async setTaskPushNotification(
    params: schema.TaskPushNotificationConfig
  ): Promise<schema.TaskPushNotificationConfig | null> {
    await this.ensureStarted();
    return this.transport.request<schema.TaskPushNotificationConfig | null>(
      "tasks/pushNotification/set",
      params
    );
  }

  /**
   * Retrieves the currently configured push notification config for a task.
   * @param params The parameters for the tasks/pushNotification/get method.
   * @returns A promise resolving to the TaskPushNotificationConfig or null.
   */
  async getTaskPushNotification(
    params: schema.TaskIdParams
  ): Promise<schema.TaskPushNotificationConfig | null> {
    await this.ensureStarted();
    return this.transport.request<schema.TaskPushNotificationConfig | null>(
      "tasks/pushNotification/get",
      params
    );
  }

  /**
   * Resubscribes to updates for a task after a potential connection interruption.
   * @param params The parameters for the tasks/resubscribe method.
   * @yields TaskStatusUpdateEvent or TaskArtifactUpdateEvent payloads.
   */
  resubscribeTask(
    params: schema.TaskQueryParams
  ): AsyncIterable<schema.TaskStatusUpdateEvent | schema.TaskArtifactUpdateEvent> {
     const startAndStream = async function* (this: A2AStdioClient): AsyncIterable<schema.TaskStatusUpdateEvent | schema.TaskArtifactUpdateEvent> {
        await this.ensureStarted();
        yield* this.transport.stream<schema.TaskStatusUpdateEvent | schema.TaskArtifactUpdateEvent>(
            "tasks/resubscribe",
            params
        );
    }.bind(this);
    return startAndStream();
  }

  // Note: agentCard() and supports() methods are omitted as they don't make sense
  // for a stdio client where the server isn't discoverable via HTTP .well-known.
  // If needed, a mechanism to get the card via stdio could be defined, but it's
  // outside the current scope based on the HTTP server's implementation.
}