import { z } from 'zod';

export const $BaseServerOptions = z.object({
  port: z.number().min(0),
  address: z.string().min(1),
  grace: z.number().min(1),
  telemetry: z.boolean().default(true),
});

export const $RedisServerOptions = z.object({
  redisUrl: z.string().optional(),
});

export const $LevelServerOptions = z.object({
  data: z
    .string({
      required_error: 'Database directory path is required',
    })
    .min(1),
  scheduler: z.boolean().default(true),
  schedulerFrequency: z.number().min(1000),
  sweepExpiry: z.number().min(20000),
});

export const $ConfigServerOptions = z.object({
  config: z.string().min(1).optional(),
});

export const $CorsServerOptions = z.object({
  cors: z.boolean().default(false),
  corsCredentials: z.boolean().default(true),
  corsOrigin: z.optional(z.array(z.string()).or(z.boolean())),
});

export const $SubscriptionServerOptions = z.object({
  wsMaxClients: z.number().min(0).optional(),
  subscriptionMaxEphemeral: z.number().min(0).optional(),
  subscriptionMaxPersistent: z.number().min(0).optional(),
});

export type CorsServerOptions = z.infer<typeof $CorsServerOptions>;
export type ConfigServerOptions = z.infer<typeof $ConfigServerOptions>;
export type RedisServerOptions = z.infer<typeof $RedisServerOptions>;
export type IngressOptions = {
  distributed?: boolean;
} & RedisServerOptions;
