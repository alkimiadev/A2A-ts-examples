### Overview

 This code was originally copied and adapted from the [Google A2A repository](https://github.com/google/A2A/tree/main), specifically from the `samples/js` directory.

 Modifications were made using [Roo Code](https://github.com/RooVetGit/Roo-Code) and [Gemini 2.5 Pro](https://ai.google.dev) via vibe coding.
 ![roo vibecode](roo-vibecode.png)

 These examples are not intended for production use and have not been thoroughly vetted. They demonstrate the A2A protocol using both a standard HTTP client/server model (implied, see `src/client` and `src/server`) and a local process communication mechanism via `StdioTransport` (see `src/client/stdio_client.ts` and `src/server/stdio_server.ts`). This allows running agents as child processes, similar to how the MCP (Model Context Protocol) architecture can operate locally.

---
# JavaScript Samples
The provided samples are built using [Genkit](https://genkit.dev/) and the Gemini API. See the [Server README](src/server/README.md) and [Client README](src/client/README.md) for details on the A2A implementations.

## Agents

- [Movie Agent](src/agents/movie-agent/README.md): Uses TMDB API to search for movie information and answer questions.
- [Coder Agent](src/agents/coder/README.md): Generates full code files as artifacts.

## Testing the Agents

```bash
export GEMINI_API_KEY=<your_api_key>
npx tsx src/stdio-cli.ts -- npx tsx src/agents/movie-agent/index.ts --transport=stdio
