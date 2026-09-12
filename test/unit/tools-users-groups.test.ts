import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../src/server/mcp-server.js';
import type { WikiClient } from '../../src/wiki/client.js';

const user = { id: 1, name: 'Ana', email: 'ana@example.com', isActive: true };
const group = { id: 2, name: 'users', isSystem: true };
const responseResult = { succeeded: true, message: 'ok' };

/** ping + 12 pages (4a) + 4 users + 1 group (4b) = 18 tools. */
const EXPECTED_TOOL_NAMES = [
  'ping',
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
  'list_users',
  'search_users',
  'create_user',
  'update_user',
  'list_groups',
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
 * method/arguments invoked, and override implementations per case. Only the
 * user/group methods are exercised here; page tools are registered but never called.
 */
function makeWiki() {
  const fns = {
    listUsers: vi.fn(async () => [user]),
    searchUsers: vi.fn(async (query: string) => [{ ...user, id: 10, name: `${query} Ana` }]),
    listGroups: vi.fn(async () => [group]),
    createUser: vi.fn(async (input: { email?: string }) => ({
      ...responseResult,
      message: `created ${input.email}`,
    })),
    updateUser: vi.fn(async (id: number) => ({ ...responseResult, message: `updated ${id}` })),
  };
  return { wiki: fns as unknown as WikiClient, fns };
}

interface Harness {
  client: Client;
  fns: ReturnType<typeof makeWiki>['fns'];
  close: () => Promise<void>;
}

/** Real McpServer (full createMcpServer wiring) + real SDK client over an in-memory transport. */
async function setup(): Promise<Harness> {
  const { wiki, fns } = makeWiki();
  const server = createMcpServer({ wiki });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'users-groups-test-client', version: '0.0.1' });
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

describe('registerUserTools + registerGroupTools', () => {
  it('registers the 17 CRUD tools + ping', async () => {
    const { client, close } = await setup();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());
    } finally {
      await close();
    }
  });

  it('list_users returns the users as JSON and calls wiki.listUsers()', async () => {
    const { client, fns, close } = await setup();
    try {
      const result = await client.callTool({ name: 'list_users', arguments: {} });
      expect(fns.listUsers).toHaveBeenCalledTimes(1);
      expect(JSON.parse(textOf(result))).toEqual([user]);
    } finally {
      await close();
    }
  });

  it('search_users calls wiki.searchUsers(query)', async () => {
    const { client, fns, close } = await setup();
    try {
      const result = await client.callTool({ name: 'search_users', arguments: { query: 'ana' } });
      expect(fns.searchUsers).toHaveBeenCalledWith('ana');
      expect(JSON.parse(textOf(result))).toEqual([{ ...user, id: 10, name: 'ana Ana' }]);
    } finally {
      await close();
    }
  });

  it('create_user forwards the input to wiki.createUser', async () => {
    const { client, fns, close } = await setup();
    try {
      const args = { name: 'Luis', email: 'luis@example.com', password: 'secret', role: 'editor', groups: [2, 3] };
      const result = await client.callTool({ name: 'create_user', arguments: args });
      expect(fns.createUser).toHaveBeenCalledWith(args);
      expect(JSON.parse(textOf(result))).toEqual({ ...responseResult, message: 'created luis@example.com' });
    } finally {
      await close();
    }
  });

  it('update_user calls wiki.updateUser(id, input) without the id in the input', async () => {
    const { client, fns, close } = await setup();
    try {
      const result = await client.callTool({
        name: 'update_user',
        arguments: { id: 7, email: 'new@example.com', password: 'newpass' },
      });
      expect(fns.updateUser).toHaveBeenCalledWith(7, { email: 'new@example.com', password: 'newpass' });
      expect(JSON.parse(textOf(result))).toEqual({ ...responseResult, message: 'updated 7' });
    } finally {
      await close();
    }
  });

  it('list_groups returns the groups as JSON and calls wiki.listGroups()', async () => {
    const { client, fns, close } = await setup();
    try {
      const result = await client.callTool({ name: 'list_groups', arguments: {} });
      expect(fns.listGroups).toHaveBeenCalledTimes(1);
      expect(JSON.parse(textOf(result))).toEqual([group]);
    } finally {
      await close();
    }
  });

  it('returns isError:true with the message when the wiki client throws', async () => {
    const { client, fns, close } = await setup();
    try {
      fns.listUsers.mockImplementation(async () => {
        throw new Error('boom list_users');
      });
      const result = await client.callTool({ name: 'list_users', arguments: {} });
      expect(isErrorOf(result)).toBe(true);
      expect(textOf(result)).toBe('boom list_users');
    } finally {
      await close();
    }
  });

  it('list_groups returns isError:true with the message when the wiki client throws', async () => {
    const { client, fns, close } = await setup();
    try {
      fns.listGroups.mockImplementation(async () => {
        throw new Error('boom list_groups');
      });
      const result = await client.callTool({ name: 'list_groups', arguments: {} });
      expect(isErrorOf(result)).toBe(true);
      expect(textOf(result)).toBe('boom list_groups');
    } finally {
      await close();
    }
  });
});
