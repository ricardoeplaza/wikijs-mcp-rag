import { z } from 'zod';

/** A Wiki.js page (full metadata, no content). */
export const wikiPageSchema = z.object({
  id: z.number(),
  path: z.string(),
  title: z.string(),
  description: z.string().optional(),
  isPrivate: z.boolean().optional(),
  isPublished: z.boolean(),
  createdAt: z.string().optional(),
  updatedAt: z.string(),
});

export type WikiPage = z.infer<typeof wikiPageSchema>;

/** A Wiki.js user. */
export const userSchema = z.object({
  id: z.number(),
  name: z.string(),
  email: z.string(),
  providerKey: z.string().optional(),
  isSystem: z.boolean().optional(),
  isActive: z.boolean(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

export type User = z.infer<typeof userSchema>;

/** A Wiki.js group. */
export const groupSchema = z.object({
  id: z.number(),
  name: z.string(),
  isSystem: z.boolean(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

export type Group = z.infer<typeof groupSchema>;

/** A page's status (same shape as WikiPage, includes `isPublished`). */
export const pageStatusSchema = wikiPageSchema;

export type PageStatus = z.infer<typeof pageStatusSchema>;

/** Standard Wiki.js mutation result envelope. */
export const responseResultSchema = z.object({
  succeeded: z.boolean(),
  errorCode: z.number().optional(),
  message: z.string().optional(),
  slug: z.string().optional(),
});

export type ResponseResult = z.infer<typeof responseResultSchema>;

// --- Client inputs (for the client methods, plan §8.3) ---

/** Input for creating a page. */
export const createPageInputSchema = z.object({
  path: z.string(),
  title: z.string(),
  content: z.string(),
  locale: z.string().optional(),
  description: z.string().optional(),
  isPrivate: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
});

export type CreatePageInput = z.infer<typeof createPageInputSchema>;

/** Input for updating a page (flexible: extra fields allowed). */
export const updatePageInputSchema = z
  .object({
    content: z.string().optional(),
    isPublished: z.boolean().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    /** Full desired tag list (replace-all semantics). Omitted = keep current tags. */
    tags: z.array(z.string()).optional(),
  })
  .passthrough();

export type UpdatePageInput = z.infer<typeof updatePageInputSchema>;

/** Input for creating a user. */
export const createUserInputSchema = z.object({
  name: z.string(),
  email: z.string(),
  password: z.string(),
  role: z.string().optional(),
  groups: z.array(z.number()).optional(),
});

export type CreateUserInput = z.infer<typeof createUserInputSchema>;

/** Input for updating a user (flexible: extra fields allowed). */
export const updateUserInputSchema = z
  .object({
    name: z.string().optional(),
    email: z.string().optional(),
    password: z.string().optional(),
  })
  .passthrough();

export type UpdateUserInput = z.infer<typeof updateUserInputSchema>;
