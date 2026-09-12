/**
 * Wiki.js 2.5.314 GraphQL operations.
 *
 * All operations use VARIABLES (never inline interpolation). The real endpoint is
 * `${WIKIJS_BASE_URL}/graphql` (site root + `/graphql`, no `/api` prefix).
 *
 * Schema notes (verified against live introspection):
 * - `pages.list(limit, orderBy)` returns a FLAT array (no `nodes`/`total`).
 * - Page mutations take FLAT arguments (there is NO `PageInput` type).
 *   - `create(...)` / `update(id, ...)` return `{ responseResult, page }`.
 *   - `delete(id)` takes only `id` (NO `purge`) and returns `{ responseResult }`.
 * - `responseResult` is a `ResponseStatus { succeeded, errorCode, slug, message }`.
 * - Publish = `update(id, isPublished: true)`. A separate `render(id)` op also exists.
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
  mutation CreatePage(
    $content: String!
    $description: String!
    $editor: String!
    $isPublished: Boolean!
    $isPrivate: Boolean!
    $locale: String!
    $path: String!
    $tags: [String]!
    $title: String!
  ) {
    pages {
      create(
        content: $content
        description: $description
        editor: $editor
        isPublished: $isPublished
        isPrivate: $isPrivate
        locale: $locale
        path: $path
        tags: $tags
        title: $title
      ) {
        responseResult {
          succeeded
          errorCode
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
  mutation UpdatePage($id: Int!, $content: String, $description: String, $isPublished: Boolean, $title: String, $tags: [String]) {
    pages {
      update(id: $id, content: $content, description: $description, isPublished: $isPublished, title: $title, tags: $tags) {
        responseResult {
          succeeded
          errorCode
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

/**
 * Fetches a page's full editable state in one request (content + metadata + tags).
 * Used internally by {@link WikiClient.getFullState} before any update/publish,
 * because Wiki.js's `update` mutation requires a non-empty content and crashes
 * if `tags` is omitted (model does `tags.map()` without null-check).
 */
export const GetPageFull = /* GraphQL */ `
  query GetPageFull($id: Int!) {
    pages {
      single(id: $id) {
        id
        title
        description
        isPublished
        content
        tags { tag }
      }
    }
  }
`;

export const DeletePage = /* GraphQL */ `
  mutation DeletePage($id: Int!) {
    pages {
      delete(id: $id) {
        responseResult {
          succeeded
          errorCode
          message
        }
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
  mutation CreateUser(
    $email: String!
    $name: String!
    $passwordRaw: String
    $providerKey: String!
    $groups: [Int]!
    $mustChangePassword: Boolean
    $sendWelcomeEmail: Boolean
  ) {
    users {
      create(
        email: $email
        name: $name
        passwordRaw: $passwordRaw
        providerKey: $providerKey
        groups: $groups
        mustChangePassword: $mustChangePassword
        sendWelcomeEmail: $sendWelcomeEmail
      ) {
        responseResult {
          succeeded
          errorCode
          message
        }
        user {
          id
          name
          email
        }
      }
    }
  }
`;

export const UpdateUser = /* GraphQL */ `
  mutation UpdateUser($id: Int!, $email: String, $name: String, $newPassword: String) {
    users {
      update(id: $id, email: $email, name: $name, newPassword: $newPassword) {
        responseResult {
          succeeded
          errorCode
          message
        }
      }
    }
  }
`;

/** All exported operations keyed by name (handy for the client + tests). */
export const queries = {
  GetPage,
  GetPageContent,
  GetPageFull,
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
