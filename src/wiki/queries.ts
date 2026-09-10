/**
 * Wiki.js 2.5.314 GraphQL operations.
 *
 * All operations use VARIABLES (never inline interpolation). The real endpoint is
 * `${WIKIJS_BASE_URL}/api/graphql` (NOT `/graphql`).
 *
 * Schema notes (verified):
 * - `pages.list(limit, orderBy)` returns a FLAT array (no `nodes`/`total`).
 * - Page mutations use an input object and return `{ responseResult, page }`.
 * - `pages.delete` returns a `ResponseResult` directly.
 * - There is NO `render` nor `deletePage`. Publish = `update(input: { id, isPublished: true })`.
 */

export const GetPage = /* GraphQL */ `
  query GetPage($id: Int!) {
    pages {
      single(id: $id) {
        id
        path
        title
        description
        isPublished
        createdAt
        updatedAt
      }
    }
  }
`;

export const GetPageContent = /* GraphQL */ `
  query GetPageContent($id: Int!) {
    pages {
      single(id: $id) {
        title
        content
      }
    }
  }
`;

export const ListPages = /* GraphQL */ `
  query ListPages($limit: Int, $orderBy: PageOrderBy) {
    pages {
      list(limit: $limit, orderBy: $orderBy) {
        id
        path
        title
        description
        isPublished
        createdAt
        updatedAt
      }
    }
  }
`;

export const SearchPages = /* GraphQL */ `
  query SearchPages($query: String!) {
    pages {
      search(query: $query) {
        results {
          id
          title
          description
          path
          locale
        }
        suggestions
        totalHits
      }
    }
  }
`;

export const CreatePage = /* GraphQL */ `
  mutation CreatePage($input: PageInput!) {
    pages {
      create(input: $input) {
        responseResult {
          succeeded
          message
        }
        page {
          id
          path
          title
        }
      }
    }
  }
`;

export const UpdatePage = /* GraphQL */ `
  mutation UpdatePage($input: PageInput!) {
    pages {
      update(input: $input) {
        responseResult {
          succeeded
          message
        }
        page {
          id
          path
          title
          updatedAt
        }
      }
    }
  }
`;

export const DeletePage = /* GraphQL */ `
  mutation DeletePage($id: Int!, $purge: Boolean) {
    pages {
      delete(id: $id, purge: $purge) {
        succeeded
        errorCode
        message
        slug
      }
    }
  }
`;

export const ListUsers = /* GraphQL */ `
  query ListUsers {
    users {
      list {
        id
        name
        email
        providerKey
        isSystem
        isActive
        createdAt
        updatedAt
      }
    }
  }
`;

export const SearchUsers = /* GraphQL */ `
  query SearchUsers($query: String!) {
    users {
      search(query: $query) {
        id
        name
        email
        isActive
        createdAt
        updatedAt
      }
    }
  }
`;

export const ListGroups = /* GraphQL */ `
  query ListGroups {
    groups {
      list {
        id
        name
        isSystem
        createdAt
        updatedAt
      }
    }
  }
`;

export const CreateUser = /* GraphQL */ `
  mutation CreateUser($input: UserInput!) {
    users {
      create(input: $input) {
        succeeded
        errorCode
        message
      }
    }
  }
`;

export const UpdateUser = /* GraphQL */ `
  mutation UpdateUser($id: Int!, $input: UserInput!) {
    users {
      update(id: $id, input: $input) {
        succeeded
        errorCode
        message
      }
    }
  }
`;

/** All exported operations keyed by name (handy for the client + tests). */
export const queries = {
  GetPage,
  GetPageContent,
  ListPages,
  SearchPages,
  CreatePage,
  UpdatePage,
  DeletePage,
  ListUsers,
  SearchUsers,
  ListGroups,
  CreateUser,
  UpdateUser,
} as const;

export type QueryName = keyof typeof queries;
