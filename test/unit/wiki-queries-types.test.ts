import { describe, expect, it } from 'vitest';
import * as queriesModule from '../../src/wiki/queries.js';
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
} from '../../src/wiki/types.js';

type OpName = keyof typeof queriesModule.queries;

/** Operation name -> the GraphQL root field it must query/mutate. */
const QUERY_ROOTS: Record<OpName, string> = {
  GetPage: 'pages',
  GetPageContent: 'pages',
  GetPageFull: 'pages',
  ListPages: 'pages',
  SearchPages: 'pages',
  CreatePage: 'pages',
  UpdatePage: 'pages',
  DeletePage: 'pages',
  ListUsers: 'users',
  SearchUsers: 'users',
  ListGroups: 'groups',
  CreateUser: 'users',
  UpdateUser: 'users',
};

describe('wiki queries (sanity, no network)', () => {
  it.each(Object.keys(queriesModule.queries) as OpName[])(
    '%s is a non-empty document containing its name and root field',
    (name) => {
      const doc = queriesModule.queries[name];
      expect(typeof doc).toBe('string');
      expect(doc.length).toBeGreaterThan(0);
      expect(doc).toContain(name);
      expect(doc).toContain(QUERY_ROOTS[name]);
    },
  );

  it('exposes all operations through the `queries` map', () => {
    expect(Object.keys(queriesModule.queries).sort()).toEqual(
      Object.keys(QUERY_ROOTS).sort(),
    );
  });
});

function omit<T extends object, K extends keyof T>(obj: T, key: K): Omit<T, K> {
  const copy = { ...obj };
  delete copy[key];
  return copy as Omit<T, K>;
}

describe('wiki types (zod schemas)', () => {
  const validPage = {
    id: 1,
    path: '/guide',
    title: 'Guide',
    isPublished: true,
    updatedAt: '2024-01-01T00:00:00.000Z',
  };

  it('wikiPageSchema parses a valid page and rejects missing required field', () => {
    expect(wikiPageSchema.parse(validPage)).toEqual(validPage);
    expect(wikiPageSchema.safeParse(omit(validPage, 'updatedAt')).success).toBe(false);
  });

  it('pageStatusSchema equals wikiPageSchema shape', () => {
    expect(pageStatusSchema.parse(validPage)).toEqual(validPage);
  });

  const validUser = {
    id: 2,
    name: 'Ada',
    email: 'ada@example.com',
    isActive: true,
  };

  it('userSchema parses a valid user and rejects missing required field', () => {
    expect(userSchema.parse(validUser)).toEqual(validUser);
    expect(userSchema.safeParse(omit(validUser, 'email')).success).toBe(false);
  });

  const validGroup = { id: 3, name: 'editors', isSystem: false };

  it('groupSchema parses a valid group and rejects missing required field', () => {
    expect(groupSchema.parse(validGroup)).toEqual(validGroup);
    expect(groupSchema.safeParse(omit(validGroup, 'name')).success).toBe(false);
  });

  it('responseResultSchema parses a result and rejects missing `succeeded`', () => {
    const ok = { succeeded: true, message: 'done' };
    expect(responseResultSchema.parse(ok)).toEqual(ok);
    expect(responseResultSchema.safeParse({ message: 'nope' }).success).toBe(false);
  });

  it('createPageInputSchema parses valid and rejects missing `path`', () => {
    const ok = { path: '/a', title: 'A', content: 'x' };
    expect(createPageInputSchema.parse(ok)).toEqual(ok);
    expect(createPageInputSchema.safeParse(omit(ok, 'path')).success).toBe(false);
  });

  it('updatePageInputSchema accepts partial + extra fields (flexible)', () => {
    const ok = { content: 'x', isPublished: true, custom: 1 };
    expect(updatePageInputSchema.parse(ok)).toEqual(ok);
    expect(updatePageInputSchema.safeParse({}).success).toBe(true);
  });

  it('createUserInputSchema parses valid and rejects missing `password`', () => {
    const ok = { name: 'B', email: 'b@example.com', password: 'secret' };
    expect(createUserInputSchema.parse(ok)).toEqual(ok);
    expect(createUserInputSchema.safeParse(omit(ok, 'password')).success).toBe(false);
  });

  it('updateUserInputSchema accepts partial + extra fields (flexible)', () => {
    const ok = { name: 'C', custom: true };
    expect(updateUserInputSchema.parse(ok)).toEqual(ok);
    expect(updateUserInputSchema.safeParse({}).success).toBe(true);
  });
});
