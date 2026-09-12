import { describe, expect, it } from 'vitest';
import { WikiClient, buildRequestHeaders, type RequestImpl } from '../../src/wiki/client.js';
import { queries, type QueryName } from '../../src/wiki/queries.js';

type Call = { query: string; variables?: unknown };

const BASE = { baseUrl: 'http://wikijs.test', token: 'test-token', insecureTls: false };

/**
 * Builds a WikiClient whose HTTP layer is fully mocked (no network).
 * The mock matches the exact GraphQL document sent by the client against the
 * stage-3a `queries` map and returns the configured `data` payload per operation.
 */
function buildClient(dataFor: Partial<Record<QueryName, unknown>>) {
  const calls: Call[] = [];
  const requestImpl: RequestImpl = (query, variables) => {
    calls.push({ query, variables });
    const name = (Object.keys(queries) as QueryName[]).find((n) => queries[n] === query);
    if (!name || !(name in dataFor)) throw new Error(`Mock has no response for operation ${name}`);
    return Promise.resolve(dataFor[name]);
  };
  const client = new WikiClient(BASE, { requestImpl });
  return { client, calls };
}

const pageData = (id: number) => ({
  id,
  path: `/p${id}`,
  title: `Title ${id}`,
  description: 'desc',
  isPublished: true,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-02T00:00:00.000Z',
});

describe('WikiClient (unit, mocked HTTP)', () => {
  it('getPage returns a Zod-validated WikiPage and sends { id }', async () => {
    const id = 7;
    const { client, calls } = buildClient({ GetPage: { pages: { single: pageData(id) } } });
    expect(await client.getPage(id)).toEqual(pageData(id));
    expect(calls[0]!.variables).toEqual({ id });
  });

  it('getPage throws when the page does not exist', async () => {
    const { client } = buildClient({ GetPage: { pages: { single: null } } });
    await expect(client.getPage(999)).rejects.toThrow(/not found/);
  });

  it('getPageContent returns { title, content }', async () => {
    const { client } = buildClient({ GetPageContent: { pages: { single: { title: 'T', content: '# hi' } } } });
    expect(await client.getPageContent(1)).toEqual({ title: 'T', content: '# hi' });
  });

  it('listPages maps the flat pages.list array and applies defaults', async () => {
    const list = [pageData(1), pageData(2)];
    const { client, calls } = buildClient({ ListPages: { pages: { list } } });
    expect(await client.listPages()).toEqual(list);
    expect(calls[0]!.variables).toEqual({ limit: 50, orderBy: 'TITLE' });
  });

  it('listAllPages makes a single high-limit request (no offset)', async () => {
    const list = [pageData(1), pageData(2), pageData(3)];
    const { client, calls } = buildClient({ ListPages: { pages: { list } } });
    expect(await client.listAllPages()).toEqual(list);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.variables).toMatchObject({ limit: 500 });
  });

  it('searchPages maps results to WikiPage[] with numeric ids', async () => {
    const results = [
      { id: '10', title: 'A', description: 'da', path: '/a', locale: 'es' },
      { id: 11, title: 'B', path: '/b' },
    ];
    const { client, calls } = buildClient({
      SearchPages: { pages: { search: { results, totalHits: 2, suggestions: [] } } },
    });
    const pages = await client.searchPages('term');
    expect(calls[0]!.variables).toEqual({ query: 'term' });
    expect(pages).toHaveLength(2);
    expect(typeof pages[0]!.id).toBe('number');
    expect(pages[0]!).toMatchObject({ id: 10, path: '/a', title: 'A' });
    expect(pages[1]!).toMatchObject({ id: 11, title: 'B' });
  });

  it('createPage builds PageInput with locale "es" + defaults and returns the page', async () => {
    const created = { id: 99, path: '/new', title: 'New' };
    const { client, calls } = buildClient({
      CreatePage: { pages: { create: { responseResult: { succeeded: true, message: 'ok' }, page: created } } },
    });
    const page = await client.createPage({ path: '/new', title: 'New', content: '# c' });
    expect(page).toMatchObject({ id: 99, path: '/new', title: 'New' });
    // The create mutation takes flat arguments (no `input` wrapper object).
    expect(calls[0]!.variables).toEqual({
      path: '/new',
      title: 'New',
      content: '# c',
      editor: 'markdown',
      isPublished: true,
      isPrivate: false,
      locale: 'es',
      description: '',
      tags: [],
    });
  });

  it('createPage throws when responseResult.succeeded is false', async () => {
    const { client } = buildClient({
      CreatePage: { pages: { create: { responseResult: { succeeded: false, message: 'path exists' }, page: null } } },
    });
    await expect(client.createPage({ path: '/x', title: 'X', content: 'c' })).rejects.toThrow(/path exists/);
  });

  it('updatePage merges changes over the current state and saves the full page', async () => {
    const updated = { id: 6, path: '/p6', title: 'P6', updatedAt: '2024-02-01T00:00:00.000Z' };
    const { client, calls } = buildClient({
      GetPageFull: { pages: { single: { id: 6, title: 'Title 6', description: 'desc', isPublished: true, content: 'old', tags: [] } } },
      UpdatePage: { pages: { update: { responseResult: { succeeded: true }, page: updated } } },
    });
    const page = await client.updatePage(6, { content: 'new', isPublished: false });
    // Wiki.js requires the FULL state, so the update call carries current values merged with the change.
    const updateCall = calls.find((c) => c.query === queries.UpdatePage)!;
    expect(updateCall.variables).toEqual({
      id: 6,
      content: 'new', // from input
      description: 'desc', // from current state
      isPublished: false, // from input
      title: 'Title 6', // from current state
      tags: [], // from current state
    });
    expect(page).toMatchObject({ id: 6, isPublished: false });
  });

  it('updatePage replaces the current tags when input.tags is provided', async () => {
    const updated = { id: 6, path: '/p6', title: 'P6' };
    const { client, calls } = buildClient({
      GetPageFull: { pages: { single: { id: 6, title: 'Title 6', description: 'desc', isPublished: true, content: 'old', tags: ['a', 'b'] } } },
      UpdatePage: { pages: { update: { responseResult: { succeeded: true }, page: updated } } },
    });
    await client.updatePage(6, { tags: ['c'] });
    const updateCall = calls.find((c) => c.query === queries.UpdatePage)!;
    expect(updateCall.variables).toEqual({
      id: 6,
      content: 'old', // from current state
      description: 'desc', // from current state
      isPublished: true, // from current state
      title: 'Title 6', // from current state
      tags: ['c'], // from input (replace-all semantics)
    });
  });

  it('deletePage and forceDeletePage both call delete(id) (no purge arg in the schema)', async () => {
    const ok = { pages: { delete: { responseResult: { succeeded: true } } } };
    const a = buildClient({ DeletePage: ok });
    await a.client.deletePage(5);
    expect(a.calls[0]!.variables).toEqual({ id: 5 });

    const b = buildClient({ DeletePage: ok });
    await b.client.forceDeletePage(5);
    expect(b.calls[0]!.variables).toEqual({ id: 5 });
  });

  it('publishPage re-saves the full state with isPublished:true', async () => {
    const { client, calls } = buildClient({
      GetPageFull: { pages: { single: { id: 3, title: 'Title 3', description: 'desc', isPublished: false, content: 'body', tags: [] } } },
      UpdatePage: { pages: { update: { responseResult: { succeeded: true }, page: { id: 3, path: '/p3', title: 'P3' } } } },
    });
    await client.publishPage(3);
    const updateCall = calls.find((c) => c.query === queries.UpdatePage)!;
    expect(updateCall.variables).toEqual({
      id: 3,
      content: 'body',
      description: 'desc',
      isPublished: true,
      title: 'Title 3',
      tags: [],
    });
  });

  it('getPageStatus returns a PageStatus including isPublished', async () => {
    const { client } = buildClient({ GetPage: { pages: { single: pageData(4) } } });
    const status = await client.getPageStatus(4);
    expect(status.id).toBe(4);
    expect(status.isPublished).toBe(true);
  });

  it('listUsers maps users.list', async () => {
    const u = { id: 1, name: 'Ada', email: 'a@e.com', isActive: true };
    const { client } = buildClient({ ListUsers: { users: { list: [u] } } });
    expect(await client.listUsers()).toEqual([u]);
  });

  it('searchUsers maps users.search and sends { query }', async () => {
    const u = { id: 2, name: 'Bob', email: 'b@e.com', isActive: false };
    const { client, calls } = buildClient({ SearchUsers: { users: { search: [u] } } });
    expect(await client.searchUsers('bob')).toEqual([u]);
    expect(calls[0]!.variables).toEqual({ query: 'bob' });
  });

  it('listGroups maps groups.list', async () => {
    const g = { id: 2, name: 'editors', isSystem: false };
    const { client } = buildClient({ ListGroups: { groups: { list: [g] } } });
    expect(await client.listGroups()).toEqual([g]);
  });

  it('createUser builds flat args (passwordRaw + default groups) and returns the result', async () => {
    const res = { succeeded: true, message: 'ok' };
    const { client, calls } = buildClient({
      CreateUser: { users: { create: { responseResult: res, user: { id: 42 } } } },
    });
    expect(await client.createUser({ name: 'C', email: 'c@e.com', password: 'secret' })).toEqual(res);
    expect(calls[0]!.variables).toEqual({
      name: 'C',
      email: 'c@e.com',
      providerKey: 'local',
      passwordRaw: 'secret',
      groups: [2],
      mustChangePassword: false,
      sendWelcomeEmail: false,
    });
  });

  it('updateUser maps password to newPassword and sends flat { id, ...fields }', async () => {
    const res = { succeeded: true };
    const { client, calls } = buildClient({ UpdateUser: { users: { update: { responseResult: res } } } });
    await client.updateUser(8, { email: 'new@e.com', password: 'np' });
    expect(calls[0]!.variables).toEqual({ id: 8, email: 'new@e.com', newPassword: 'np' });
  });

  it('propagates HTTP/GraphQL errors from the request layer', async () => {
    const requestImpl: RequestImpl = () => Promise.reject(new Error('network down'));
    const client = new WikiClient(BASE, { requestImpl });
    await expect(client.getPage(1)).rejects.toThrow('network down');
  });

  it('accepts a full Config object with insecureTls and builds without error', () => {
    const config = {
      wikijsBaseUrl: 'https://wiki.example.com',
      wikijsToken: 'tok',
      wikijsInsecureTls: true,
      embeddingsBaseUrl: 'http://e:8071/v1',
      embeddingsApiKey: 'k',
      embeddingsModel: 'm',
      embeddingsDim: 1024,
      mcpToken: '',
      mcpAllowNoAuth: true,
      mcpHost: '0.0.0.0',
      mcpPort: 8000,
      ragDbPath: '/data/rag.db',
      syncPollIntervalMs: 300000,
      nightlyResyncHour: 3,
      nightlyResyncEnabled: true,
      logLevel: 'info' as const,
      chunkTargetTokens: 800,
      chunkOverlapTokens: 150,
      ragDefaultTopK: 5,
    };
    expect(() => new WikiClient(config)).not.toThrow();
  });

  it('createPage throws on an empty create response', async () => {
    const { client } = buildClient({ CreatePage: { pages: { create: null } } });
    await expect(client.createPage({ path: '/x', title: 'X', content: 'c' })).rejects.toThrow(/empty response/);
  });

  it('updatePage throws on an empty update response', async () => {
    const { client } = buildClient({
      GetPageFull: { pages: { single: { id: 6, title: 'Title 6', description: 'desc', isPublished: true, content: 'old', tags: [] } } },
      UpdatePage: { pages: { update: null } },
    });
    await expect(client.updatePage(6, { content: 'c' })).rejects.toThrow(/empty response/);
  });

  it('publishPage throws on an empty update response', async () => {
    const { client } = buildClient({
      GetPageFull: { pages: { single: { id: 3, title: 'Title 3', description: 'desc', isPublished: false, content: 'body', tags: [] } } },
      UpdatePage: { pages: { update: null } },
    });
    await expect(client.publishPage(3)).rejects.toThrow(/empty response/);
  });

  it('deletePage throws when the delete responseResult fails', async () => {
    const { client } = buildClient({
      DeletePage: { pages: { delete: { responseResult: { succeeded: false, message: 'locked' } } } },
    });
    await expect(client.deletePage(5)).rejects.toThrow(/locked/);
  });

  it('createUser throws when the create user responseResult fails', async () => {
    const { client } = buildClient({
      CreateUser: { users: { create: { responseResult: { succeeded: false, message: 'dup email' }, user: null } } },
    });
    await expect(client.createUser({ name: 'C', email: 'c@e.com', password: 's' })).rejects.toThrow(/dup email/);
  });

  it('updateUser throws when the update user responseResult fails', async () => {
    const { client } = buildClient({
      UpdateUser: { users: { update: { responseResult: { succeeded: false, message: 'nope' } } } },
    });
    await expect(client.updateUser(8, { email: 'x@e.com' })).rejects.toThrow(/nope/);
  });

  it('listPages returns [] when pages.list is null', async () => {
    const { client } = buildClient({ ListPages: { pages: { list: null } } });
    expect(await client.listPages()).toEqual([]);
  });

  it('searchPages falls back to the index for non-finite ids and missing fields', async () => {
    const results = [
      { id: 'not-a-number' }, // id -> index, path/title/description/updatedAt all defaulted
    ];
    const { client } = buildClient({ SearchPages: { pages: { search: { results } } } });
    const pages = await client.searchPages('t');
    expect(pages[0]!).toMatchObject({ id: 0, path: '', title: 'result-0' });
  });

  it('searchPages returns [] when search is null', async () => {
    const { client } = buildClient({ SearchPages: { pages: { search: null } } });
    expect(await client.searchPages('t')).toEqual([]);
  });
});

describe('buildRequestHeaders', () => {
  it('omits Authorization when the token is empty (no API key)', () => {
    expect(buildRequestHeaders('')).toEqual({ 'Content-Type': 'application/json' });
  });

  it('includes a Bearer Authorization header when a token is set', () => {
    expect(buildRequestHeaders('tok-123')).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer tok-123',
    });
  });
});
