/**
 * Prisma client singleton. DATABASE_URL comes from the repo-root .env
 * (loaded by the app entrypoint via @apecheck/core/node loadEnv()).
 */
import { Prisma, PrismaClient } from '@prisma/client';

export * from '@prisma/client';

const g = globalThis as unknown as { __apecheckPrisma?: PrismaClient };

export const prisma: PrismaClient =
  g.__apecheckPrisma ??
  new PrismaClient({ log: process.env.PRISMA_LOG ? ['query', 'warn', 'error'] : ['warn', 'error'] });

if (process.env.NODE_ENV !== 'production') g.__apecheckPrisma = prisma;

/** Decimal | null → number | null for DTOs */
export const num = (d: Prisma.Decimal | number | null | undefined): number | null =>
  d == null ? null : typeof d === 'number' ? d : d.toNumber();

export * from './checks';
