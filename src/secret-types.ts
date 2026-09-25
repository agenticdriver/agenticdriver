import { z } from "zod";
export const SecretReferenceSchema = z.union([
  z
    .object({ env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/) })
    .strict(),
  z.object({ file: z.string().min(1).max(4096) }).strict(),
  z
    .object({
      keychain: z
        .object({
          service: z.string().min(1).max(128),
          account: z.string().min(1).max(128),
        })
        .strict(),
    })
    .strict(),
]);
export type SecretReference = z.infer<typeof SecretReferenceSchema>;
