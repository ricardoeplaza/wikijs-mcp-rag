[English](./README.md) | [Espanol](./README.es.md)

# wikijs-mcp-rag

**MCP + RAG** server for a private **Wiki.js** instance. Exposes the wiki's pages,
users and groups as MCP *tools* (CRUD) and adds a semantic search (RAG) layer over
the content: chunking + embeddings + vector index in SQLite (`sqlite-vec`) with
hybrid search (vector + lexical).

- **MCP transports:** `POST /mcp` (Streamable HTTP, stateless) and `GET /sse` + `POST /message` (SSE legacy).
- **Auth:** bearer token (`MCP_TOKEN`) on all MCP endpoints.
- **External endpoints:** the Wiki.js instance and the embeddings server (llama.cpp)
  live outside the compose; they are configured via environment variables.

---

## Architecture

```
                           ┌───────────────────────────────────────────────┐
   MCP client              │              wikijs-mcp-rag (Fastify)          │
   (OpenCode, llama.cpp    │                                               │
    UI, ...)               │  ┌─────────────────────────────────────────┐  │
         │                 │  │            McpServer (22 tools)         │  │
         │  HTTP           │  │  ┌───────────────┐      ┌────────────┐  │  │
         ├────────────────►│  │  │ Tools CRUD    │      │ Tools RAG  │  │  │
         │  /mcp (bearer)  │  │  │ pages(12)     │      │ rag_search │  │  │
         │  /sse (bearer)  │  │  │ users(4)      │      │ rag_get_   │  │  │
         │                 │  │  │ groups(1)     │      │ context    │  │  │
         │                 │  │  │ + ping        │      │ rag_index_ │  │  │
         │                 │  │  └───────┬───────┘      │ status     │  │  │
         │                 │  │           │              │ rag_reindex│ │  │
         │                 │  │           │              └─────┬──────┘  │  │
         │                 │  └───────────┼────────────────────┼──────────┘  │
         │                 │              │                    │             │
         │                 │  ┌───────────▼──────────┐  ┌──────▼──────────┐ │
         │                 │  │    WikiClient        │  │     RagDb       │ │
         │                 │  │  (GraphQL, bearer)   │  │ SQLite+sqlite-vec│ │
         │                 │  └───────────┬──────────┘  └──────┬──────────┘ │
         │                 │              │                    ▲             │
         ▼                 │              │                    │             │
  ┌──────────────┐         │   ┌──────────▼──────────┐  ┌──────┴──────────┐ │
  │  Wiki.js     │◄────────┘   │   Indexer/Querier   │─►│ EmbeddingsClient│ │
  │ (external)   │             │ chunk+embed+store   │  │  (llama.cpp)    │ │
  └──────────────┘             └─────────────────────┘  └──────┬──────────┘ │
                                                               ▼            │
                                                    ┌──────────────────┐    │
                                                    │ Embeddings (ext)│    │
                                                    └──────────────────┘    │
                                                                            │
   Background sync:  CRUD hooks (SyncService) + Poller (5 min) + nightly Scheduler
```

---

## Available tools (22)

### Infrastructure (1)
| Tool | Description |
|---|---|
| `ping` | Health check. Returns `{ pong: true, timestamp }`. |

### Pages — CRUD (12)
| Tool | Description |
|---|---|
| `get_page` | Metadata of a page by `id` (no content). |
| `get_page_content` | Markdown content of a page by `id` (`{ title, content }`). |
| `list_pages` | Lists pages (`limit`, `orderBy`, `includeUnpublished`). |
| `search_pages` | Full-text search over published pages. |
| `create_page` | Creates and publishes a page in Markdown. |
| `update_page` | Updates fields of an existing page. |
| `delete_page` | Soft delete of a page. |
| `publish_page` | Publishes a page (`isPublished=true`). |
| `force_delete_page` | Permanent deletion (purge). Irreversible. |
| `get_page_status` | Status/metadata of a page. |
| `list_all_pages` | The whole corpus in a single request. |
| `search_unpublished_pages` | Filters unpublished pages (optional `query`). |

### Users (4)
| Tool | Description |
|---|---|
| `list_users` | Lists all users. |
| `search_users` | Searches users by name or email. |
| `create_user` | Creates a local user. |
| `update_user` | Updates fields of a user. |

### Groups (1)
| Tool | Description |
|---|---|
| `list_groups` | Lists all groups. |

### RAG (4)
| Tool | Description |
|---|---|
| `rag_search` | Hybrid semantic search (vector + lexical) over the RAG index. |
| `rag_get_context` | Assembled context block + `sources`, ready to hand to an LLM. |
| `rag_index_status` | Index status: pages, chunks, dims and last indexed. |
| `rag_reindex_page` | Re-indexes a specific page (rechunk + re-embed + store). |

---

## Configuration

All variables are validated in [`src/config.ts`](src/config.ts) with Zod.
Copy [`.env.example`](.env.example) to `.env` and fill in the **required** values.

| Variable | Required | Default | Description |
|---|---|---|---|
| `WIKIJS_BASE_URL` | no | `http://wikijs:3000` | Base URL of Wiki.js (actual endpoint `<base>/graphql`). |
| `WIKIJS_TOKEN` | no | `''` | Wiki.js admin token. Optional: empty ⇒ the client omits the `Authorization` header (instance without an API key). |
| `WIKIJS_INSECURE_TLS` | no | `true` | Accepts the proxy's self-signed TLS certificate. |
| `EMBEDDINGS_BASE_URL` | **yes** | — | Base URL of the external embeddings server (`<base>/embeddings`). |
| `EMBEDDINGS_API_KEY` | no | `no-key` | API key (llama.cpp ignores it). |
| `EMBEDDINGS_MODEL` | no | `Qwen3-Embedding-0.6B` | Model name (metadata). |
| `EMBEDDINGS_DIM` | no | `1024` | Embedding dimensionality. Changing it = reindex everything. |
| `MCP_TOKEN` | **yes*** | — | Bearer token for `/mcp`, `/sse`, `/message`. *Not required if `MCP_ALLOW_NOAUTH=true` (dev only). |
| `MCP_ALLOW_NOAUTH` | no | `false` | `true` + empty token → starts without auth with a warning. |
| `MCP_HOST` | no | `0.0.0.0` | Listen host. |
| `MCP_PORT` | no | `8000` | Listen port (published by Docker). |
| `RAG_DB_PATH` | no | `/data/rag.db` | Path of the SQLite file (must be on a volume). |
| `SYNC_POLL_INTERVAL_MS` | no | `300000` | Poller interval (ms). `0` = disabled. |
| `NIGHTLY_RESYNC_HOUR` | no | `3` | Local hour of the nightly reindex. |
| `NIGHTLY_RESYNC_ENABLED` | no | `true` | Enables/disables the nightly resync. |
| `LOG_LEVEL` | no | `info` | `debug` / `info` / `warn` / `error`. |
| `CHUNK_TARGET_TOKENS` | no | `800` | Target chunk size. |
| `CHUNK_OVERLAP_TOKENS` | no | `150` | Overlap between chunks. |
| `RAG_DEFAULT_TOP_K` | no | `5` | Default top-K of the RAG search. |

> **Index integrity:** if the SQLite file exists with an `embedding_dims` different
> from `EMBEDDINGS_DIM`, the process **does not start** and logs it (vector spaces are never mixed).
> Changing model/dims ⇒ delete the DB or reindex.

---

## How to run

### Option A — Docker Compose (recommended)

```bash
# 1. Configure the environment
cp .env.example .env
#    -> fill in MCP_TOKEN (secure bearer); WIKIJS_TOKEN only if the instance uses an API key

# 2. Start the service (build + start)
docker compose up -d --build

# 3. Check health
curl http://localhost:8000/health        # => { "status":"ok" }
```

- The SQLite database persists in `./data` (volume mounted at `/data`, `RAG_DB_PATH=/data/wikijs-rag.db`).
- Wiki.js and embeddings are **external**: make sure `WIKIJS_BASE_URL` and
  `EMBEDDINGS_BASE_URL` point to services reachable from the container.

### Option B — Local development (no Docker)

```bash
npm install
cp .env.example .env      # fill in the required values
npm run dev               # tsx src/main.ts -> http://localhost:8000
```

Other scripts: `npm run build` (emits `dist/`), `npm start` (`node dist/main.js`),
`npm test`, `npm run lint`, `npm run typecheck`.

---

## Connecting an MCP client

### Streamable HTTP — `POST /mcp` (bearer)

Example MCP client configuration (`mcpServers` format):

```jsonc
{
  "mcpServers": {
    "wikijs": {
      "url": "http://localhost:8000/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_TOKEN>"
      }
    }
  }
}
```

### SSE — `GET /sse` (legacy option)

For clients that only support SSE, use the `/sse` endpoint. Since `EventSource`
cannot send headers, the token is accepted as a query parameter:

```
http://localhost:8000/sse?token=<MCP_TOKEN>
```

(The client POSTs the messages to `POST /message?sessionId=...` with the same bearer.)

- No token or wrong token → `401 { "error": "unauthorized" }`.
- If `MCP_ALLOW_NOAUTH=true` and `MCP_TOKEN` is empty → accepted without auth (development only).

---

## RAG and synchronization

### Indexing
Each page is indexed as follows: Markdown content → **chunking** (`chunkMarkdown`:
sections by H1/H2, greedy packing, overlap) → **one batch call** to
`embeddings.embed()` → storage in SQLite (`pages` + `chunks` + vectors in
`chunks_vec` via `sqlite-vec`). The hash `sha256(content)` is stored to skip
unchanged pages.

### Hybrid search
`rag_search` / `rag_get_context` embed the query, retrieve candidates by KNN
vector search (`sqlite-vec`) and do a **hybrid rerank** per candidate:
`score = alpha·vecSim + (1−alpha)·lexical`, with `alpha=0.7` by default. Returns
the top-K by descending score.

### Sync mechanisms (3)
1. **CRUD hooks** (`SyncService`, fire-and-forget): after `create_page` /
   `update_page` / `publish_page` → `reindexPage(id)`; after `delete_page` /
   `force_delete_page` → `purgePage(id)`. They never block or break the tool response.
2. **Incremental poller** (every `SYNC_POLL_INTERVAL_MS`, 5 min by default):
   reconciles index vs wiki — reindexes pages whose hash changed and purges those that no longer exist.
3. **Nightly scheduler** (at `NIGHTLY_RESYNC_HOUR`, 03:00 by default):
   full `reindexAll()` as a final-consistency safety net.

### First-start reindex
On startup, `main()` calls `createApp(config, { startLifecycle: true })`, which
triggers `poller.start()`. This performs an **immediate `runOnce()`** (fire-and-forget) before
scheduling the interval. With an empty SQLite database, all wiki pages have a missing
hash → **all of them are indexed in that first sweep**. In other words, the **initial reindex
is automatic**: there is no need to invoke `reindex_all` manually; the poller's first `runOnce()`
indexes the whole corpus (and logs it). If you later change model/dims,
delete the DB (`./data`) or reindex with `rag_reindex_page` / a full reindex.

---

## Tests

```bash
npm test                 # vitest run (unit + integration)
npm run test:watch       # watch mode
npx vitest run --coverage  # with coverage
```

The tests do not start timers or real traffic: the app is built with
`startLifecycle:false` and the dependencies (WikiClient, embeddings, RagDb `:memory:`) are mocked.

---

## Project structure

```
src/
├── main.ts                 # bootstrap Fastify + lifecycle (poller/scheduler) + shutdown
├── config.ts               # env variables (Zod) + loadConfig()
├── logger.ts               # pino
├── server/
│   ├── mcp-server.ts       # McpServer factory + ping + tools wiring
│   ├── http-transport.ts   # POST /mcp (Streamable HTTP stateless)
│   ├── sse-transport.ts    # GET /sse + POST /message
│   └── auth.ts             # bearer middleware
├── tools/
│   ├── index.ts            # registerAllTools (17 CRUD)
│   ├── pages.ts            # 12 page tools
│   ├── users.ts            # 4 user tools
│   ├── groups.ts           # 1 group tool
│   └── rag.ts              # 4 RAG tools
├── wiki/
│   ├── client.ts           # WikiClient (GraphQL)
│   ├── queries.ts          # GraphQL operations
│   └── types.ts            # Zod schemas
└── rag/
    ├── db.ts               # RagDb (SQLite + sqlite-vec)
    ├── embeddings.ts       # EmbeddingsClient (llama.cpp, OpenAI-compatible)
    ├── chunker.ts          # chunkMarkdown
    ├── indexer.ts          # Indexer (indexPage / reindexAll / purgePage)
    ├── querier.ts          # Querier (hybrid search + indexStatus)
    ├── sync.ts             # SyncService (CRUD hooks fire-and-forget)
    ├── poller.ts           # Poller (incremental resync)
    └── scheduler.ts        # Scheduler (nightly reindex)
```
