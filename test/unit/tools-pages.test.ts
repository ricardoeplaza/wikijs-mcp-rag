import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SERVER_INFO } from '../../src/server/mcp-server.js';
import type { SyncService } from '../../src/rag/sync.js';
import { registerPageTools } from '../../src/tools/pages.js';
import type { WikiClient } from '../../src/wiki/client.js';

const publishedPage = {
  id: 1,
  path: '/uno',
  title: 'Uno',
  description: 'desc-uno',
  isPublished: true,
  updatedAt: '2024-01-02T00:00:00.000Z',
};

const draftPage = {
  id: 2,
  path: '/dos',
  title: 'Dos',
  description: 'desc-dos',
  isPublished: false,
  updatedAt: '2024-01-03T00:00:00.000Z',
};

const EXPECTED_TOOL_NAMES = [
  'get_page',
  'get_page_content',
  'list_pages',
  'search_pages',
  'create_page',
  'update_page',
  'delete_page',
  'publish_page',
  'force_delete_page',
  'get_page_status',
  'list_all_pages',
  'search_unpublished_pages',
];

type CallToolOutcome = Awaited<ReturnType<Client['callTool']>>;

function textOf(result: CallToolOutcome): string {
  const content = (result as { content?: ReadonlyArray<{ type: string; text?: string }> }).content;
  const first = content?.[0];
  if (!first || first.type !== 'text' || typeof first.text !== 'string') {
    throw new Error(`unexpected tool result shape: ${JSON.stringify(result)}`);
  }
  return first.text;
}

function isErrorOf(result: CallToolOutcome): boolean {
  return (result as { isError?: boolean }).isError === true;
}

/**
 * Builds a WikiClient mock backed by vi.fn so each test can assert the exact
 * method/arguments invoked, and override implementations per case.
 */
function makeWiki() {
  const fns = {
    getPage: vi.fn(async (id: number) => ({ ...publishedPage, id })),
    getPageContent: vi.fn(async (id: number) => ({ title: `Title ${id}`, content: `# body ${id}` })),
    listPages: vi.fn(async () => [publishedPage, draftPage]),
    listAllPages: vi.fn(async () => [publishedPage, draftPage]),
    searchPages: vi.fn(
      async (term: string) => [
        { ...publishedPage, id: 11, title: `${term} A` },
        { ...publishedPage, id: 12, title: `${term} B` },
      ],
    ),
    createPage: vi.fn(async (input: { path?: string }) => ({ ...publishedPage, id: 10, path: input.path ?? '/nuevo' })),
    updatePage: vi.fn(async (id: number) => ({ ...publishedPage, id })),
    deletePage: vi.fn(async () => undefined),
    forceDeletePage: vi.fn(async () => undefined),
    publishPage: vi.fn(async (id: number) => ({ ...publishedPage, id, isPublished: true })),
    getPageStatus: vi.fn(async (id: number) => ({ ...publishedPage, id })),
  };
  return { wiki: fns as unknown as WikiClient, fns };
}

interface Harness {
  client: Client;
  fns: ReturnType<typeof makeWiki>['fns'];
  close: () => Promise<void>;
}

interface SetupOptions {
  sync?: SyncService;
}

/** Real McpServer + real SDK client over an in-memory transport (no network). */
async function setup(options: SetupOptions = {}): Promise<Harness> {
  const server = new McpServer(SERVER_INFO);
  const { wiki, fns } = makeWiki();
  registerPageTools(server, wiki, options.sync);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'pages-test-client', version: '0.0.1' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return {
    client,
    fns,
    close: async () => {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    },
  };
}

describe('registerPageTools (Etapa 4a)', () => {
  it('registers exactly the 12 page tools', async () => {
    const { client, close } = await setup();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());
    } finally {
      await close();
    }
  });

  it('get_page returns the page as JSON and calls wiki.getPage(id)', async () => {
    const { client, fns, close } = await setup();
    try {
      const result = await client.callTool({ name: 'get_page', arguments: { id: 5 } });
      expect(fns.getPage).toHaveBeenCalledWith(5);
      expect(JSON.parse(textOf(result))).toEqual({ ...publishedPage, id: 5 });
    } finally {
      await close();
    }
  });

  it('get_page_content returns { title, content }', async () => {
    const { client, fns, close } = await setup();
    try {
      const result = await client.callTool({ name: 'get_page_content', arguments: { id: 3 } });
      expect(fns.getPageContent).toHaveBeenCalledWith(3);
      expect(JSON.parse(textOf(result))).toEqual({ title: 'Title 3', content: '# body 3' });
    } finally {
      await close();
    }
  });

  it('list_pages applies defaults (limit=50, orderBy=TITLE) and includes unpublished by default', async () => {
    const { client, fns, close } = await setup();
    try {
      const result = await client.callTool({ name: 'list_pages', arguments: {} });
      expect(fns.listPages).toHaveBeenCalledWith(50, 'TITLE');
      expect(JSON.parse(textOf(result))).toEqual([publishedPage, draftPage]);
    } finally {
      await close();
    }
  });

  it('list_pages filters to published when includeUnpublished=false', async () => {
    const { client, close } = await setup();
    try {
      const result = await client.callTool({ name: 'list_pages', arguments: { includeUnpublished: false } });
      expect(JSON.parse(textOf(result))).toEqual([publishedPage]);
    } finally {
      await close();
    }
  });

  it('search_pages calls wiki.searchPages(query) and slices to limit', async () => {
    const { client, fns, close } = await setup();
    try {
      const result = await client.callTool({ name: 'search_pages', arguments: { query: 'sol', limit: 1 } });
      expect(fns.searchPages).toHaveBeenCalledWith('sol');
      expect(JSON.parse(textOf(result))).toEqual([{ ...publishedPage, id: 11, title: 'sol A' }]);
    } finally {
      await close();
    }
  });

  it('create_page forwards the input to wiki.createPage', async () => {
    const { client, fns, close } = await setup();
    try {
      const args = { path: '/nueva', title: 'Nueva', content: '# Hola', locale: 'es', description: 'd', isPrivate: false, tags: ['a'] };
      const result = await client.callTool({ name: 'create_page', arguments: args });
      expect(fns.createPage).toHaveBeenCalledWith(args);
      expect(JSON.parse(textOf(result))).toEqual({ ...publishedPage, id: 10, path: '/nueva' });
    } finally {
      await close();
    }
  });

  it('update_page calls wiki.updatePage(id, input) without the id in the input', async () => {
    const { client, fns, close } = await setup();
    try {
      const result = await client.callTool({ name: 'update_page', arguments: { id: 7, content: 'nuevo contenido', isPublished: false } });
      expect(fns.updatePage).toHaveBeenCalledWith(7, { content: 'nuevo contenido', isPublished: false });
      expect(JSON.parse(textOf(result))).toEqual({ ...publishedPage, id: 7 });
    } finally {
      await close();
    }
  });

  it('delete_page calls wiki.deletePage(id) and returns { deleted: true, id }', async () => {
    const { client, fns, close } = await setup();
    try {
      const result = await client.callTool({ name: 'delete_page', arguments: { id: 4 } });
      expect(fns.deletePage).toHaveBeenCalledWith(4);
      expect(JSON.parse(textOf(result))).toEqual({ deleted: true, id: 4 });
    } finally {
      await close();
    }
  });

  it('force_delete_page calls wiki.forceDeletePage(id) and returns forced:true', async () => {
    const { client, fns, close } = await setup();
    try {
      const result = await client.callTool({ name: 'force_delete_page', arguments: { id: 4 } });
      expect(fns.forceDeletePage).toHaveBeenCalledWith(4);
      expect(JSON.parse(textOf(result))).toEqual({ deleted: true, id: 4, forced: true });
    } finally {
      await close();
    }
  });

  it('publish_page calls wiki.publishPage(id)', async () => {
    const { client, fns, close } = await setup();
    try {
      const result = await client.callTool({ name: 'publish_page', arguments: { id: 2 } });
      expect(fns.publishPage).toHaveBeenCalledWith(2);
      expect(JSON.parse(textOf(result))).toEqual({ ...publishedPage, id: 2, isPublished: true });
    } finally {
      await close();
    }
  });

  it('get_page_status calls wiki.getPageStatus(id)', async () => {
    const { client, fns, close } = await setup();
    try {
      const result = await client.callTool({ name: 'get_page_status', arguments: { id: 6 } });
      expect(fns.getPageStatus).toHaveBeenCalledWith(6);
      expect(JSON.parse(textOf(result))).toEqual({ ...publishedPage, id: 6 });
    } finally {
      await close();
    }
  });

  it('list_all_pages returns the whole corpus by default and only published on demand', async () => {
    const { client, fns, close } = await setup();
    try {
      const all = await client.callTool({ name: 'list_all_pages', arguments: {} });
      expect(fns.listAllPages).toHaveBeenCalledTimes(1);
      expect(JSON.parse(textOf(all))).toEqual([publishedPage, draftPage]);

      const publishedOnly = await client.callTool({ name: 'list_all_pages', arguments: { includeUnpublished: false } });
      expect(JSON.parse(textOf(publishedOnly))).toEqual([publishedPage]);
    } finally {
      await close();
    }
  });

  it('search_unpublished_pages filters unpublished, matches query case-insensitively, and slices to limit', async () => {
    const { client, fns, close } = await setup();
    try {
      const allUnpublished = await client.callTool({ name: 'search_unpublished_pages', arguments: {} });
      expect(fns.listAllPages).toHaveBeenCalled();
      expect(JSON.parse(textOf(allUnpublished))).toEqual([draftPage]);

      const matched = await client.callTool({ name: 'search_unpublished_pages', arguments: { query: 'DOS' } });
      expect(JSON.parse(textOf(matched))).toEqual([draftPage]);

      const noMatch = await client.callTool({ name: 'search_unpublished_pages', arguments: { query: 'zzz' } });
      expect(JSON.parse(textOf(noMatch))).toEqual([]);
    } finally {
      await close();
    }
  });

  it('returns isError:true with the message when the wiki client throws', async () => {
    const { client, fns, close } = await setup();
    try {
      fns.getPage.mockImplementation(async () => {
        throw new Error('boom get_page');
      });
      const result = await client.callTool({ name: 'get_page', arguments: { id: 99 } });
      expect(isErrorOf(result)).toBe(true);
      expect(textOf(result)).toBe('boom get_page');
    } finally {
      await close();
    }
  });
});

describe('registerPageTools sync hooks (Etapa 8a)', () => {
  /** SyncService mock: the hooks are fired fire-and-forget, so plain vi.fn suffice. */
  function makeSync() {
    const fns = {
      onAfterChange: vi.fn(async () => undefined),
      onAfterDelete: vi.fn(async () => undefined),
    };
    return { sync: fns as unknown as SyncService, fns };
  }

  it('create_page fires onAfterChange with the NEW page id after success', async () => {
    const { sync, fns } = makeSync();
    const { client, close } = await setup({ sync });
    try {
      const result = await client.callTool({
        name: 'create_page',
        arguments: { path: '/nueva', title: 'Nueva', content: '# Hola' },
      });
      expect(isErrorOf(result)).toBe(false);
      expect(fns.onAfterChange).toHaveBeenCalledTimes(1);
      // the wiki mock's createPage returns a page with id 10
      expect(fns.onAfterChange).toHaveBeenCalledWith(10);
    } finally {
      await close();
    }
  });

  it('update_page fires onAfterChange with the page id', async () => {
    const { sync, fns } = makeSync();
    const { client, close } = await setup({ sync });
    try {
      const result = await client.callTool({ name: 'update_page', arguments: { id: 7, content: 'nuevo' } });
      expect(isErrorOf(result)).toBe(false);
      expect(fns.onAfterChange).toHaveBeenCalledTimes(1);
      expect(fns.onAfterChange).toHaveBeenCalledWith(7);
    } finally {
      await close();
    }
  });

  it('publish_page fires onAfterChange with the page id', async () => {
    const { sync, fns } = makeSync();
    const { client, close } = await setup({ sync });
    try {
      const result = await client.callTool({ name: 'publish_page', arguments: { id: 2 } });
      expect(isErrorOf(result)).toBe(false);
      expect(fns.onAfterChange).toHaveBeenCalledTimes(1);
      expect(fns.onAfterChange).toHaveBeenCalledWith(2);
    } finally {
      await close();
    }
  });

  it('delete_page fires onAfterDelete with the page id', async () => {
    const { sync, fns } = makeSync();
    const { client, close } = await setup({ sync });
    try {
      const result = await client.callTool({ name: 'delete_page', arguments: { id: 4 } });
      expect(isErrorOf(result)).toBe(false);
      expect(fns.onAfterDelete).toHaveBeenCalledTimes(1);
      expect(fns.onAfterDelete).toHaveBeenCalledWith(4);
    } finally {
      await close();
    }
  });

  it('force_delete_page fires onAfterDelete with the page id', async () => {
    const { sync, fns } = makeSync();
    const { client, close } = await setup({ sync });
    try {
      const result = await client.callTool({ name: 'force_delete_page', arguments: { id: 4 } });
      expect(isErrorOf(result)).toBe(false);
      expect(fns.onAfterDelete).toHaveBeenCalledTimes(1);
      expect(fns.onAfterDelete).toHaveBeenCalledWith(4);
    } finally {
      await close();
    }
  });

  it('fires no hook when the wiki operation fails', async () => {
    const { sync, fns } = makeSync();
    const { client, fns: wikiFns, close } = await setup({ sync });
    try {
      wikiFns.createPage.mockImplementation(async () => {
        throw new Error('boom create');
      });
      const result = await client.callTool({
        name: 'create_page',
        arguments: { path: '/x', title: 'X', content: '# x' },
      });
      expect(isErrorOf(result)).toBe(true);
      expect(fns.onAfterChange).not.toHaveBeenCalled();
      expect(fns.onAfterDelete).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });
});
