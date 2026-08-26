import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/app/generated/prisma/client";
import { Pool } from "pg";

type PrismaGlobal = typeof globalThis & {
  __fixPrisma?: PrismaClient;
  __fixPgPool?: Pool;
};

const globalForPrisma = globalThis as PrismaGlobal;

function createPrismaClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("DATABASE_URL is required to connect to PostgreSQL");
  }

  const pool =
    globalForPrisma.__fixPgPool ??
    new Pool({
      connectionString,
      max: 10,
    });

  const client = new PrismaClient({
    adapter: new PrismaPg(pool),
  });

  if (process.env.NODE_ENV !== "production") {
    globalForPrisma.__fixPgPool = pool;
    globalForPrisma.__fixPrisma = client;
  }

  return client;
}

export const prisma = globalForPrisma.__fixPrisma ?? createPrismaClient();
