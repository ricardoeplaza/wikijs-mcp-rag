import { GraphQLClient, type Variables } from 'graphql-request';
import { Agent, fetch as undiciFetch } from 'undici';
import type { Config } from '../config.js';
import { queries } from './queries.js';
import {
  createPageInputSchema,
  createUserInputSchema,
  groupSchema,
  pageStatusSchema,
  responseResultSchema,
  updatePageInputSchema,
  updateUserInputSchema,
  userSchema,
  wikiPageSchema,
  type CreatePageInput,
  type CreateUserInput,
  type Group,
  type PageStatus,
  type ResponseResult,
  type UpdatePageInput,
  type UpdateUserInput,
  type User,
  type WikiPage,
} from './types.js';

/** Minimal HTTP configuration for the Wiki.js client. */
export interface WikiClientConfig {
  baseUrl: string;
  token: string;
  /** Accept self-signed TLS certificates (Wiki.js behind a proxy). Default false. */
  insecureTls?: boolean;
}

/**
 * Injectable HTTP layer for tests / custom transports.
 * Receives a GraphQL document + variables and resolves to the parsed `data`
 * field of the GraphQL response (the same shape `GraphQLClient.request` returns).
 */
export type RequestImpl = (query: string, variables?: unknown) => Promise<unknown>;

export interface WikiClientOptions {
  /** When provided, all HTTP goes through this function instead of `graphql-request`. */
  requestImpl?: RequestImpl;
}

/** High `limit` used by {@link WikiClient.listAllPages} (single request, no offset). */
const LIST_ALL_PAGES_LIMIT = 500;

/**
 * Builds a `fetch` that accepts self-signed TLS certificates by routing requests
 * through an undici `Agent` with `rejectUnauthorized: false`.
 *
 * Returned as the global `typeof fetch` so it can be passed to `graphql-request`
 * (`RequestConfig.fetch`). The real certificate validation happens at integration
 * time; unit tests bypass HTTP entirely via `requestImpl`.
 */
function createInsecureFetch(): typeof fetch {
  const agent = new Agent({ connect: { rejectUnauthorized: false } });
  const wrapped = (input: string | URL, init?: RequestInit): Promise<Response> => {
    const merged = { ...(init ?? {}), dispatcher: agent };
    return undiciFetch(input, merged as unknown as Parameters<typeof undiciFetch>[1]);
  };
  return wrapped as unknown as typeof fetch;
}

/**
 * Builds the HTTP headers for a GraphQL request. The `Authorization` header is
 * only included when a non-empty token is configured, so the client works against
 * a Wiki.js instance with no API key (WIKIJS_TOKEN empty).
 */
export function buildRequestHeaders(token: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token !== '') headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** Normalizes either the minimal config or the full app `Config` into a client config. */
function normalizeConfig(config: WikiClientConfig | Config): WikiClientConfig {
  if ('baseUrl' in config) {
    return { baseUrl: config.baseUrl, token: config.token, insecureTls: config.insecureTls };
  }
  return {
    baseUrl: config.wikijsBaseUrl,
    token: config.wikijsToken,
    insecureTls: config.wikijsInsecureTls,
  };
}

/** Throws a clear error when a `pages.single` lookup returns nothing. */
function requireSingle(raw: unknown, id: number): Record<string, unknown> {
  if (raw == null) throw new Error(`Wiki page ${id} not found`);
  return raw as Record<string, unknown>;
}

/**
 * Maps the partial page object returned by the `create`/`update` mutations into a
 * full {@link WikiPage}. The stage-3a mutations only select a subset of fields
 * (`id, path, title[, updatedAt]`), so the required-but-absent fields are filled
 * with documented defaults:
 *   - `isPublished`: the caller-controlled value (always set in the input), defaulting to `true`.
 *   - `updatedAt`: echoed by `update` but not by `create` → defaults to "now".
 */
function partialToWikiPage(
  partial: { id?: number | string; path?: string; title?: string; description?: string; updatedAt?: string },
  isPublished: boolean,
): WikiPage {
  return wikiPageSchema.parse({
    id: Number(partial.id ?? 0),
    path: partial.path ?? '',
    title: partial.title ?? '',
    description: partial.description,
    isPublished,
    updatedAt: partial.updatedAt ?? new Date().toISOString(),
  });
}

/**
 * Wiki.js GraphQL client (stage 3b).
 *
 * - Talks to `${baseUrl}/graphql` with `Authorization: Bearer <token>`.
 * - Accepts self-signed TLS when `insecureTls` is set (`WIKIJS_INSECURE_TLS`).
 * - The HTTP layer is injectable via `options.requestImpl` for unit tests (no network).
 */
export class WikiClient {
  private readonly config: WikiClientConfig;
  private readonly requestImpl?: RequestImpl;
  private readonly client: GraphQLClient | null;

  constructor(config: WikiClientConfig | Config, options?: WikiClientOptions) {
    this.config = normalizeConfig(config);
    this.requestImpl = options?.requestImpl;
    // Only build the real HTTP client when no HTTP layer was injected (production path).
    this.client = this.requestImpl ? null : this.buildClient(this.config);
  }

  /** Builds the `graphql-request` client for the production path. */
  private buildClient(config: WikiClientConfig): GraphQLClient {
    const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/graphql`;
    const requestConfig: {
      method: 'POST';
      headers: Record<string, string>;
      fetch?: typeof fetch;
    } = {
      method: 'POST',
      headers: buildRequestHeaders(config.token),
    };
    if (config.insecureTls) {
      requestConfig.fetch = createInsecureFetch();
    }
    return new GraphQLClient(endpoint, requestConfig);
  }

  /** Runs a GraphQL operation, returning its `data` field. */
  private async execute<T>(query: string, variables?: unknown): Promise<T> {
    const impl = this.requestImpl;
    if (impl) return (await impl(query, variables)) as T;
    const client = this.client;
    if (!client) throw new Error('WikiClient has no HTTP layer configured');
    const data = await client.request<unknown, Variables>(query, (variables ?? {}) as Variables);
    return data as T;
  }

  // --- Pages: reads ---

  async getPage(id: number): Promise<WikiPage> {
    const data = await this.execute<{ pages: { single: unknown } }>(queries.GetPage, { id });
    return wikiPageSchema.parse(requireSingle(data.pages.single, id));
  }

  async getPageContent(id: number): Promise<{ title: string; content: string }> {
    const data = await this.execute<{ pages: { single: { title: string; content: string } | null } }>(
      queries.GetPageContent,
      { id },
    );
    if (data.pages.single == null) throw new Error(`Wiki page ${id} not found`);
    return data.pages.single;
  }

  async listPages(limit = 50, orderBy: string = 'TITLE'): Promise<WikiPage[]> {
    const data = await this.execute<{ pages: { list: unknown[] | null } }>(queries.ListPages, { limit, orderBy });
    return (data.pages.list ?? []).map((page) => wikiPageSchema.parse(page));
  }

  /**
   * Returns the whole corpus in a SINGLE request using a high `limit`.
   *
   * NOTE: no `offset` pagination is used. The corpus is small (~24 articles) and
   * `pages.list(offset)` behavior has not been verified against the live instance,
   * so we avoid depending on it (plan §8.3).
   */
  async listAllPages(): Promise<WikiPage[]> {
    return this.listPages(LIST_ALL_PAGES_LIMIT, 'TITLE');
  }

  async searchPages(term: string): Promise<WikiPage[]> {
    const data = await this.execute<{ pages: { search: { results: unknown[] | null } | null } }>(
      queries.SearchPages,
      { query: term },
    );
    const results = data.pages.search?.results ?? [];
    // The SearchPages op (stage 3a) only selects `id, title, description, path, locale` —
    // not publish state or timestamps. Those are defaulted so the result stays a uniform
    // WikiPage[] for retrieval. Verify the real shape against the live instance in integration.
    return results.map((raw, index) => {
      const r = raw as Record<string, unknown>;
      const id = Number(r.id);
      return wikiPageSchema.parse({
        id: Number.isFinite(id) ? id : index,
        path: typeof r.path === 'string' ? r.path : '',
        title: typeof r.title === 'string' ? r.title : `result-${index}`,
        description: typeof r.description === 'string' ? r.description : undefined,
        isPublished: true,
        updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : new Date().toISOString(),
      });
    });
  }

  // --- Pages: writes ---

  /**
   * Fetches the full editable state of a page (content + metadata + tags) in a
   * single request.
   *
   * Wiki.js's `update` mutation is NOT a partial patch: it always requires a
   * non-empty `content`, sets `isPublished` to false when omitted, and crashes
   * with "Cannot read properties of undefined (reading 'map')" if `tags` is not
   * provided (the model calls `tags.map()` without a null-check). So before any
   * update we must read the current state and merge the requested changes on top.
   */
  private async getFullState(id: number): Promise<{ content: string; description: string; title: string; isPublished: boolean; tags: string[] }> {
    const data = await this.execute<{
      pages: {
        single: {
          id: number;
          title: string;
          description: string | null;
          isPublished: boolean;
          content: string | null;
          tags: { tag: string }[] | null;
        } | null;
      };
    }>(queries.GetPageFull, { id });
    const p = data.pages.single;
    if (p == null) throw new Error(`Wiki page ${id} not found`);
    return {
      content: p.content ?? '',
      description: p.description ?? '',
      title: p.title,
      isPublished: p.isPublished,
      tags: (p.tags ?? []).map((t) => t.tag),
    };
  }

  async createPage(input: CreatePageInput): Promise<WikiPage> {
    const parsed = createPageInputSchema.parse(input);
    const pageInput = {
      path: parsed.path,
      title: parsed.title,
      content: parsed.content,
      editor: 'markdown',
      isPublished: true,
      isPrivate: parsed.isPrivate ?? false,
      // CORRECTION of the fork bug (which used 'ru'): default locale is 'es'.
      locale: parsed.locale ?? 'es',
      description: parsed.description ?? '',
      tags: parsed.tags ?? [],
    };
    const data = await this.execute<{ pages: { create: { responseResult: unknown; page: unknown } | null } }>(
      queries.CreatePage,
      pageInput,
    );
    if (data.pages.create == null) throw new Error(`Failed to create page "${parsed.path}": empty response`);
    const result = responseResultSchema.parse(data.pages.create.responseResult);
    if (!result.succeeded) {
      throw new Error(`Failed to create page "${parsed.path}": ${result.message ?? 'unknown error'}`);
    }
    return partialToWikiPage(data.pages.create.page as Record<string, unknown>, true);
  }

  async updatePage(id: number, input: UpdatePageInput): Promise<WikiPage> {
    const parsed = updatePageInputSchema.parse(input);
    // Merge the requested changes over the current full state (see getFullState).
    const current = await this.getFullState(id);
    const data = await this.execute<{ pages: { update: { responseResult: unknown; page: unknown } | null } }>(
      queries.UpdatePage,
      {
        id,
        content: parsed.content ?? current.content,
        description: parsed.description ?? current.description,
        isPublished: parsed.isPublished ?? current.isPublished,
        title: parsed.title ?? current.title,
        // Replace-all semantics (Wiki.js associateTags): the provided list becomes
        // the complete new tag set; when omitted, keep the current tags.
        tags: parsed.tags ?? current.tags,
      },
    );
    if (data.pages.update == null) throw new Error(`Failed to update page ${id}: empty response`);
    const result = responseResultSchema.parse(data.pages.update.responseResult);
    if (!result.succeeded) {
      throw new Error(`Failed to update page ${id}: ${result.message ?? 'unknown error'}`);
    }
    return partialToWikiPage(data.pages.update.page as Record<string, unknown>, parsed.isPublished ?? current.isPublished);
  }

  async deletePage(id: number): Promise<void> {
    await this.performDelete(id);
  }

  // NOTE: Wiki.js only exposes a single `delete(id)` mutation — there is no
  // `purge` argument. Both `delete_page` and `force_delete_page` perform the
  // same soft delete (the page becomes recoverable from trash, not hard-removed).
  async forceDeletePage(id: number): Promise<void> {
    await this.performDelete(id);
  }

  private async performDelete(id: number): Promise<void> {
    const data = await this.execute<{ pages: { delete: { responseResult: unknown } | null } }>(queries.DeletePage, { id });
    if (data.pages.delete == null) {
      throw new Error(`Failed to delete page ${id}: empty response`);
    }
    const result = responseResultSchema.parse(data.pages.delete.responseResult);
    if (!result.succeeded) {
      throw new Error(`Failed to delete page ${id}: ${result.message ?? 'unknown error'}`);
    }
  }

  /** Publishes a page by re-saving its full state with `isPublished: true`. */
  async publishPage(id: number): Promise<WikiPage> {
    const current = await this.getFullState(id);
    const data = await this.execute<{ pages: { update: { responseResult: unknown; page: unknown } | null } }>(
      queries.UpdatePage,
      {
        id,
        content: current.content,
        description: current.description,
        isPublished: true,
        title: current.title,
        tags: current.tags,
      },
    );
    if (data.pages.update == null) throw new Error(`Failed to publish page ${id}: empty response`);
    const result = responseResultSchema.parse(data.pages.update.responseResult);
    if (!result.succeeded) {
      throw new Error(`Failed to publish page ${id}: ${result.message ?? 'unknown error'}`);
    }
    return partialToWikiPage(data.pages.update.page as Record<string, unknown>, true);
  }

  async getPageStatus(id: number): Promise<PageStatus> {
    const data = await this.execute<{ pages: { single: unknown } }>(queries.GetPage, { id });
    return pageStatusSchema.parse(requireSingle(data.pages.single, id));
  }

  // --- Users / groups ---

  async listUsers(): Promise<User[]> {
    const data = await this.execute<{ users: { list: unknown[] | null } }>(queries.ListUsers);
    return (data.users.list ?? []).map((user) => userSchema.parse(user));
  }

  async searchUsers(query: string): Promise<User[]> {
    const data = await this.execute<{ users: { search: unknown[] | null } }>(queries.SearchUsers, { query });
    return (data.users.search ?? []).map((user) => userSchema.parse(user));
  }

  async listGroups(): Promise<Group[]> {
    const data = await this.execute<{ groups: { list: unknown[] | null } }>(queries.ListGroups);
    return (data.groups.list ?? []).map((group) => groupSchema.parse(group));
  }

  async createUser(input: CreateUserInput): Promise<ResponseResult> {
    const parsed = createUserInputSchema.parse(input);
    const userInput = {
      name: parsed.name,
      email: parsed.email,
      providerKey: 'local',
      // Wiki.js expects the raw password under `passwordRaw`, not `password`.
      passwordRaw: parsed.password,
      groups: parsed.groups ?? [2],
      mustChangePassword: false,
      sendWelcomeEmail: false,
    };
    const data = await this.execute<{ users: { create: { responseResult: unknown; user: unknown } | null } }>(
      queries.CreateUser,
      userInput,
    );
    if (data.users.create == null) {
      throw new Error(`Failed to create user "${parsed.email}": empty response`);
    }
    const result = responseResultSchema.parse(data.users.create.responseResult);
    if (!result.succeeded) {
      throw new Error(`Failed to create user "${parsed.email}": ${result.message ?? 'unknown error'}`);
    }
    return result;
  }

  async updateUser(id: number, input: UpdateUserInput): Promise<ResponseResult> {
    const parsed = updateUserInputSchema.parse(input);
    const { password, ...rest } = parsed;
    // The `update` mutation takes the new password under `newPassword` (not `passwordRaw`).
    const variables: Record<string, unknown> = { id, ...rest };
    if (password !== undefined) variables.newPassword = password;
    const data = await this.execute<{ users: { update: { responseResult: unknown } | null } }>(
      queries.UpdateUser,
      variables,
    );
    if (data.users.update == null) {
      throw new Error(`Failed to update user ${id}: empty response`);
    }
    const result = responseResultSchema.parse(data.users.update.responseResult);
    if (!result.succeeded) {
      throw new Error(`Failed to update user ${id}: ${result.message ?? 'unknown error'}`);
    }
    return result;
  }
}
