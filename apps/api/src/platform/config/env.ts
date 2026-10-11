import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  DATABASE_URL: z.string().min(1),
  JWT_PRIVATE_KEY: z.string().optional().default(''),
  JWT_PUBLIC_KEY: z.string().optional().default(''),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  COOKIE_SECURE: z
    .string()
    .default('false')
    .transform((value) => value === 'true'),
  /** Vận hành thật: tạo admin đầu tiên khi database chưa có user nào (không seed dữ liệu demo). */
  BOOTSTRAP_ADMIN_USERNAME: z.string().regex(/^[a-z0-9._-]{3,40}$/).optional(),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(12).optional(),
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
  BOOTSTRAP_ADMIN_FULL_NAME: z.string().min(2).optional(),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

/** Validate biến môi trường khi khởi động — thiếu thì fail fast (mục 19.7). */
export function env(): Env {
  if (!cached) {
    const parsed = EnvSchema.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
      throw new Error(`Invalid environment: ${issues}`);
    }
    cached = parsed.data;
  }
  return cached;
}

export function webOrigins(): string[] {
  return env()
    .WEB_ORIGIN.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}
