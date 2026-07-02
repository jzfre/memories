import { z } from "zod";

// ---------------------------------------------------------------------------
// Context pack schema
// ---------------------------------------------------------------------------

export const ContextPackBodySchema = z.object({
  goal: z.string().min(1),
  namespaces: z.array(z.string()).optional(),
  sensitivity_allowed: z.array(z.string()).optional(),
  max_tokens: z.number().int().positive().optional(),
});

export type ContextPackBody = z.infer<typeof ContextPackBodySchema>;
