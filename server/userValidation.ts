import { z } from "zod";

const role = z.enum(["admin", "manager", "sales", "technician", "user"]);
const permissions = z.record(
  z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/),
  z.boolean(),
).refine((value) => Object.keys(value).length <= 100, "Too many permissions.");

export const managedUserIdParamsSchema = z.object({
  id: z.string().trim().min(1).max(160),
});

export const managedUserListQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  role: role.optional(),
  active: z.enum(["true", "false"]).optional(),
});

const userFields = {
  name: z.string().trim().max(200).optional(),
  email: z.string().trim().email().max(320).optional().nullable(),
  phone: z.string().trim().max(32).optional(),
  role: role.optional(),
  permissions: permissions.optional(),
  uid: z.string().trim().min(1).max(160).optional(),
  active: z.boolean().optional(),
};

export const managedUserCreateSchema = z.object(userFields)
  .refine((value) => Boolean(value.name || value.email), "Name or email is required.");

export const managedUserUpdateSchema = z.object(userFields)
  .omit({ uid: true })
  .refine((value) => Object.keys(value).length > 0, "At least one field is required.");
