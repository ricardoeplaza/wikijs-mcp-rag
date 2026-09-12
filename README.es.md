[English](./README.md) | [Español](./README.es.md)

# wikijs-mcp-rag

Servidor **MCP + RAG** para una instancia privada de **Wiki.js**. Expone las páginas,
usuarios y grupos del wiki como *tools* MCP (CRUD) y añade una capa de búsqueda
semántica (RAG) sobre el contenido: chunking + embeddings + índice vectorial en
SQLite (`sqlite-vec`) con búsqueda híbrida (vectorial + léxica).

- **Transportes MCP:** `POST /mcp` (Streamable HTTP, stateless) y `GET /sse` + `POST /message` (SSE legacy).
- **Auth:** bearer token (`MCP_TOKEN`) en todos los endpoints MCP.
- **Endpoints externos:** la instancia de Wiki.js y el servidor de embeddings (llama.cpp)
  viven fuera del compose; se configuran por variables de entorno.

---

## Arquitectura

```
                           ┌───────────────────────────────────────────────┐
   Cliente MCP             │              wikijs-mcp-rag (Fastify)          │
   (OpenCode, llama.cpp    │                                               │
    UI, ...)               │  ┌─────────────────────────────────────────┐  │
         │                 │  │            McpServer (22 tools)         │  │
         │  HTTP           │  │  ┌───────────────┐      ┌────────────┐  │  │
         ├────────────────►│  │  │ Tools CRUD    │      │ Tools RAG  │  │  │
         │  /mcp (bearer)  │  │  │ páginas(12)   │      │ rag_search │  │  │
         │  /sse (bearer)  │  │  │ usuarios(4)   │      │ rag_get_   │  │  │
         │                 │  │  │ grupos(1)     │      │ context    │  │  │
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
  │ (externo)    │             │ chunk+embed+store   │  │  (llama.cpp)    │ │
  └──────────────┘             └─────────────────────┘  └──────┬──────────┘ │
                                                               ▼            │
                                                    ┌──────────────────┐    │
                                                    │ Embeddings (ext)│    │
                                                    └──────────────────┘    │
                                                                            │
   Sync en background:  hooks CRUD (SyncService) + Poller (5 min) + Scheduler nocturno
```

---

## Tools disponibles (22)

### Infraestructura (1)
| Tool | Descripción |
|---|---|
| `ping` | Health check. Devuelve `{ pong: true, timestamp }`. |

### Páginas — CRUD (12)
| Tool | Descripción |
|---|---|
| `get_page` | Metadatos de una página por `id` (sin contenido). |
| `get_page_content` | Contenido Markdown de una página por `id` (`{ title, content }`). |
| `list_pages` | Lista páginas (`limit`, `orderBy`, `includeUnpublished`). |
| `search_pages` | Búsqueda full-text de páginas publicadas. |
| `create_page` | Crea y publica una página en Markdown. |
| `update_page` | Actualiza campos de una página existente. |
| `delete_page` | Soft delete de una página. |
| `publish_page` | Publica una página (`isPublished=true`). |
| `force_delete_page` | Borrado permanente (purge). Irreversible. |
| `get_page_status` | Estado/metadatos de una página. |
| `list_all_pages` | Todo el corpus en una sola petición. |
| `search_unpublished_pages` | Filtra páginas no publicadas (opcional `query`). |

### Usuarios (4)
| Tool | Descripción |
|---|---|
| `list_users` | Lista todos los usuarios. |
| `search_users` | Busca usuarios por nombre o email. |
| `create_user` | Crea un usuario local. |
| `update_user` | Actualiza campos de un usuario. |

### Grupos (1)
| Tool | Descripción |
|---|---|
| `list_groups` | Lista todos los grupos. |

### RAG (4)
| Tool | Descripción |
|---|---|
| `rag_search` | Búsqueda semántica híbrida (vectorial + léxica) sobre el índice RAG. |
| `rag_get_context` | Bloque de contexto ensamblado + `sources`, listo para dar a un LLM. |
| `rag_index_status` | Estado del índice: páginas, chunks, dims y último indexado. |
| `rag_reindex_page` | Re-indexa una página concreta (rechunk + re-embed + store). |

---

## Configuración

Todas las variables se validan en [`src/config.ts`](src/config.ts) con Zod.
Copia [`.env.example`](.env.example) a `.env` y rellena los valores **requeridos**.

| Variable | Requerida | Default | Descripción |
|---|---|---|---|
| `WIKIJS_BASE_URL` | no | `http://wikijs:3000` | URL base de Wiki.js (endpoint real `<base>/graphql`). |
| `WIKIJS_TOKEN` | no | `''` | Token admin de Wiki.js. Opcional: vacío ⇒ el cliente omite el header `Authorization` (instancia sin API key). |
| `WIKIJS_INSECURE_TLS` | no | `true` | Aceptar certificado TLS autofirmado del proxy. |
| `EMBEDDINGS_BASE_URL` | **sí** | — | URL base del servidor de embeddings externo (`<base>/embeddings`). |
| `EMBEDDINGS_API_KEY` | no | `no-key` | API key (llama.cpp la ignora). |
| `EMBEDDINGS_MODEL` | no | `Qwen3-Embedding-0.6B` | Nombre del modelo (metadato). |
| `EMBEDDINGS_DIM` | no | `1024` | Dimensionalidad del embedding. Cambiar = reindexar todo. |
| `MCP_TOKEN` | **sí*** | — | Bearer token para `/mcp`, `/sse`, `/message`. *No requerida si `MCP_ALLOW_NOAUTH=true` (solo dev). |
| `MCP_ALLOW_NOAUTH` | no | `false` | `true` + token vacío → arranca sin auth con warning. |
| `MCP_HOST` | no | `0.0.0.0` | Host de escucha. |
| `MCP_PORT` | no | `8000` | Puerto de escucha (publicado por Docker). |
| `RAG_DB_PATH` | no | `/data/rag.db` | Ruta del fichero SQLite (debe estar en volumen). |
| `SYNC_POLL_INTERVAL_MS` | no | `300000` | Intervalo del poller (ms). `0` = desactivado. |
| `NIGHTLY_RESYNC_HOUR` | no | `3` | Hora local del reindex nocturno. |
| `NIGHTLY_RESYNC_ENABLED` | no | `true` | Activa/desactiva el resync nocturno. |
| `LOG_LEVEL` | no | `info` | `debug` / `info` / `warn` / `error`. |
| `CHUNK_TARGET_TOKENS` | no | `800` | Tamaño objetivo de chunk. |
| `CHUNK_OVERLAP_TOKENS` | no | `150` | Solapamiento entre chunks. |
| `RAG_DEFAULT_TOP_K` | no | `5` | Top-K por defecto de la búsqueda RAG. |

> **Integridad del índice:** si el fichero SQLite existe con unas `embedding_dims` distintas
> de `EMBEDDINGS_DIM`, el proceso **no arranca** y lo loguea (nunca se mezclan espacios vectoriales).
> Cambiar modelo/dims ⇒ borrar la BD o reindexar.

---

## Cómo ejecutar

### Opción A — Docker Compose (recomendado)

```bash
# 1. Configura el entorno
cp .env.example .env
#    -> rellena MCP_TOKEN (bearer seguro); WIKIJS_TOKEN solo si la instancia usa API key

# 2. Sube el servicio (build + start)
docker compose up -d --build

# 3. Comprueba salud
curl http://localhost:8000/health        # => { "status":"ok" }
```

- El SQLite persiste en `./data` (volumen montado en `/data`, `RAG_DB_PATH=/data/wikijs-rag.db`).
- Wiki.js y embeddings son **externos**: asegúrate de que `WIKIJS_BASE_URL` y
  `EMBEDDINGS_BASE_URL` apuntan a servicios accesibles desde el contenedor.

### Opción B — Desarrollo local (sin Docker)

```bash
npm install
cp .env.example .env      # rellena los valores requeridos
npm run dev               # tsx src/main.ts -> http://localhost:8000
```

Otros scripts: `npm run build` (emit `dist/`), `npm start` (`node dist/main.js`),
`npm test`, `npm run lint`, `npm run typecheck`.

---

## Conectar un cliente MCP

### Streamable HTTP — `POST /mcp` (bearer)

Ejemplo de configuración de un cliente MCP (formato `mcpServers`):

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

### SSE — `GET /sse` (opción legacy)

Para clientes que solo soportan SSE, usa el endpoint `/sse`. Como `EventSource`
no puede mandar headers, el token se acepta como query param:

```
http://localhost:8000/sse?token=<MCP_TOKEN>
```

(El cliente POSTea los mensajes a `POST /message?sessionId=...` con el mismo bearer.)

- Sin token o con token incorrecto → `401 { "error": "unauthorized" }`.
- Si `MCP_ALLOW_NOAUTH=true` y `MCP_TOKEN` vacío → se acepta sin auth (solo desarrollo).

---

## RAG y sincronización

### Indexación
Cada página se indexa así: contenido Markdown → **chunking** (`chunkMarkdown`:
secciones por H1/H2, empaquetado greedy, solapamiento) → **una llamada batch** a
`embeddings.embed()` → almacenamiento en SQLite (`pages` + `chunks` + vectores en
`chunks_vec` vía `sqlite-vec`). El hash `sha256(content)` se guarda para saltar
páginas sin cambios.

### Búsqueda híbrida
`rag_search` / `rag_get_context` embedean la query, recuperan candidatos por KNN
vectorial (`sqlite-vec`) y hacen **rerank híbrido** por candidato:
`score = alpha·vecSim + (1−alpha)·léxico`, con `alpha=0.7` por defecto. Devuelve
el top-K por score descendente.

### Mecanismos de sync (3)
1. **Hooks en CRUD** (`SyncService`, fire-and-forget): tras `create_page` /
   `update_page` / `publish_page` → `reindexPage(id)`; tras `delete_page` /
   `force_delete_page` → `purgePage(id)`. Nunca bloquean ni rompen la respuesta del tool.
2. **Poller incremental** (cada `SYNC_POLL_INTERVAL_MS`, 5 min por defecto):
   reconcilia índice vs wiki — reindexa páginas cuyo hash cambió y purga las que ya no existen.
3. **Scheduler nocturno** (a `NIGHTLY_RESYNC_HOUR`, 03:00 por defecto):
   `reindexAll()` completo como red de seguridad de consistencia final.

### Reindex en primer arranque
Al arrancar, `main()` llama a `createApp(config, { startLifecycle: true })`, lo que
dispara `poller.start()`. Este hace un **`runOnce()` inmediato** (fire-and-forget) antes
de programar el intervalo. Con la base SQLite vacía, todas las páginas del wiki tienen
hash ausente → **todas se indexan en ese primer barrido**. Es decir, el **reindex inicial
es automático**: no hace falta invocar `reindex_all` a mano; el primer `runOnce()` del
poller indexa todo el corpus (y lo loguea). Si más adelante cambias de modelo/dims,
borra la BD (`./data`) o reindexa con `rag_reindex_page` / un reindex completo.

---

## Tests

```bash
npm test                 # vitest run (unit + integración)
npm run test:watch       # modo watch
npx vitest run --coverage  # con cobertura
```

Los tests no levantan timers ni tráfico real: la app se construye con
`startLifecycle:false` y las dependencias (WikiClient, embeddings, RagDb `:memory:`) se mockean.

---

## Estructura del proyecto

```
src/
├── main.ts                 # bootstrap Fastify + lifecycle (poller/scheduler) + shutdown
├── config.ts               # variables de env (Zod) + loadConfig()
├── logger.ts               # pino
├── server/
│   ├── mcp-server.ts       # factory McpServer + ping + wiring de tools
│   ├── http-transport.ts   # POST /mcp (Streamable HTTP stateless)
│   ├── sse-transport.ts    # GET /sse + POST /message
│   └── auth.ts             # middleware bearer
├── tools/
│   ├── index.ts            # registerAllTools (17 CRUD)
│   ├── pages.ts            # 12 tools de páginas
│   ├── users.ts            # 4 tools de usuarios
│   ├── groups.ts           # 1 tool de grupos
│   └── rag.ts              # 4 tools RAG
├── wiki/
│   ├── client.ts           # WikiClient (GraphQL)
│   ├── queries.ts          # operaciones GraphQL
│   └── types.ts            # schemas Zod
└── rag/
    ├── db.ts               # RagDb (SQLite + sqlite-vec)
    ├── embeddings.ts       # EmbeddingsClient (llama.cpp, OpenAI-compatible)
    ├── chunker.ts          # chunkMarkdown
    ├── indexer.ts          # Indexer (indexPage / reindexAll / purgePage)
    ├── querier.ts          # Querier (búsqueda híbrida + indexStatus)
    ├── sync.ts             # SyncService (hooks CRUD fire-and-forget)
    ├── poller.ts           # Poller (resync incremental)
    └── scheduler.ts        # Scheduler (reindex nocturno)
```
