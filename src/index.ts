import { and, desc, eq, gte, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

import { transaction } from "./db/schema";
import { createAuth } from "./auth";

export type Env = {
  DB: D1Database;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_GENERATIVE_AI_API_KEY: string;
  CORS_ORIGIN: string;
};

const app = new Hono<{ Bindings: Env }>();

app.use(logger());
app.use(
  "/*",
  cors({
    origin: (_, c) => c.env.CORS_ORIGIN,
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "Cookie"],
    credentials: true,
  }),
);

app.on(["POST", "GET"], "/api/auth/*", (c) => {
  const auth = createAuth(c.env);
  return auth.handler(new Request(c.req.raw));
});

// One-time migration endpoint
app.post("/api/migrate", async (c) => {
  const statements = [
    `CREATE TABLE IF NOT EXISTS user (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      email_verified INTEGER NOT NULL DEFAULT 0,
      image TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS session (
      id TEXT PRIMARY KEY NOT NULL,
      expires_at INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS session_userId_idx ON session(user_id)`,
    `CREATE TABLE IF NOT EXISTS account (
      id TEXT PRIMARY KEY NOT NULL,
      account_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      access_token TEXT,
      refresh_token TEXT,
      id_token TEXT,
      access_token_expires_at INTEGER,
      refresh_token_expires_at INTEGER,
      scope TEXT,
      password TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS account_userId_idx ON account(user_id)`,
    `CREATE TABLE IF NOT EXISTS verification (
      id TEXT PRIMARY KEY NOT NULL,
      identifier TEXT NOT NULL,
      value TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS verification_identifier_idx ON verification(identifier)`,
    `CREATE TABLE IF NOT EXISTS "transaction" (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      amount TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      type TEXT NOT NULL,
      category TEXT,
      note TEXT,
      occurred_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS transaction_userId_idx ON "transaction"(user_id)`,
    `CREATE INDEX IF NOT EXISTS transaction_occurredAt_idx ON "transaction"(occurred_at)`,
  ];

  for (const sql of statements) {
    await c.env.DB.prepare(sql).run();
  }

  return c.json({ message: "Migrations completed" });
});

app.post("/ai", async (c) => {
  const auth = createAuth(c.env);
  const sessionData = await auth.api.getSession({
    headers: c.req.raw.headers,
  });
  if (!sessionData?.user) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const body = await c.req.json();
  const text = (body?.text ?? "").toString().trim();
  const preferredCurrency = (body?.currency ?? "USD")
    .toString()
    .trim()
    .toUpperCase();

  if (!text) {
    return c.json({ error: "Missing text" }, 400);
  }

  const todayISO = new Date().toISOString();

  const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
  const { generateObject } = await import("ai");
  const { z } = await import("zod");

  const google = createGoogleGenerativeAI({
    apiKey: c.env.GOOGLE_GENERATIVE_AI_API_KEY,
  });
  const model = google("gemini-2.5-flash");

  const schema = z.object({
    title: z.string().min(1),
    amount: z.number(),
    currency: z.string().min(3).max(3).default("USD"),
    type: z.enum(["income", "expense"]),
    category: z.string(),
    note: z.string().optional(),
    occurredAt: z.string().optional(),
  });

  const result = await generateObject({
    model,
    schema,
    prompt: [
      "Extract a transaction from the user text.",
      "Return a JSON object matching the schema.",
      `Preferred currency is ${preferredCurrency}.`,
      "If currency is not specified, use the preferred currency.",
      `Today's date/time (UTC) is ${todayISO}.`,
      "If date/time isn't specified, omit occurredAt.",
      "Title should be a short label like 'Chipotle' or 'Salary'.",
      `User text: ${text}`,
    ].join("\n"),
  });

  const occurredAt = result.object.occurredAt
    ? new Date(result.object.occurredAt)
    : new Date();

  const db = drizzle(c.env.DB);
  const [created] = await db
    .insert(transaction)
    .values({
      id: crypto.randomUUID(),
      userId: sessionData.user.id,
      title: result.object.title,
      amount: result.object.amount.toString(),
      currency: result.object.currency,
      type: result.object.type,
      category: result.object.category,
      note: result.object.note ?? null,
      occurredAt,
    })
    .returning();

  return c.json({ parsed: result.object, transaction: created });
});

app.get("/transactions", async (c) => {
  const auth = createAuth(c.env);
  const sessionData = await auth.api.getSession({
    headers: c.req.raw.headers,
  });
  if (!sessionData?.user) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const dateParam = c.req.query("date");
  const tzOffsetParam = c.req.query("tzOffset");
  let dayStart: Date | null = null;
  let dayEnd: Date | null = null;

  if (dateParam) {
    const [year, month, day] = dateParam.split("-").map((part) => Number(part));
    const tzOffset = Number(tzOffsetParam);
    if (
      !year ||
      !month ||
      !day ||
      Number.isNaN(year) ||
      Number.isNaN(month) ||
      Number.isNaN(day) ||
      Number.isNaN(tzOffset)
    ) {
      return c.json({ error: "Invalid date or tzOffset" }, 400);
    }

    const utcStart =
      Date.UTC(year, month - 1, day, 0, 0, 0, 0) + tzOffset * 60000;
    dayStart = new Date(utcStart);
    dayEnd = new Date(utcStart + 24 * 60 * 60 * 1000);
  }

  const db = drizzle(c.env.DB);
  const filters = [eq(transaction.userId, sessionData.user.id)];
  if (dayStart && dayEnd) {
    filters.push(gte(transaction.occurredAt, dayStart));
    filters.push(lt(transaction.occurredAt, dayEnd));
  }

  const items = await db
    .select()
    .from(transaction)
    .where(and(...filters))
    .orderBy(desc(transaction.occurredAt))
    .limit(50);

  return c.json({ transactions: items });
});

app.delete("/transactions/:id", async (c) => {
  const auth = createAuth(c.env);
  const sessionData = await auth.api.getSession({
    headers: c.req.raw.headers,
  });
  if (!sessionData?.user) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const id = c.req.param("id");
  if (!id) {
    return c.json({ error: "Missing id" }, 400);
  }

  const db = drizzle(c.env.DB);
  const [deleted] = await db
    .delete(transaction)
    .where(
      and(eq(transaction.id, id), eq(transaction.userId, sessionData.user.id)),
    )
    .returning();

  if (!deleted) {
    return c.json({ error: "Not found" }, 404);
  }

  return c.json({ success: true });
});

app.put("/transactions/:id", async (c) => {
  const auth = createAuth(c.env);
  const sessionData = await auth.api.getSession({
    headers: c.req.raw.headers,
  });
  if (!sessionData?.user) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const id = c.req.param("id");
  if (!id) {
    return c.json({ error: "Missing id" }, 400);
  }

  const body = await c.req.json();
  const payload = {
    title: body?.title?.toString().trim(),
    amount: body?.amount,
    currency: body?.currency?.toString().trim().toUpperCase(),
    type: body?.type,
    category: body?.category?.toString().trim() || null,
    note: body?.note?.toString().trim() || null,
    occurredAt: body?.occurredAt ? new Date(body.occurredAt) : null,
  };

  if (
    !payload.title ||
    payload.amount === undefined ||
    !payload.currency ||
    !payload.type
  ) {
    return c.json({ error: "Invalid payload" }, 400);
  }

  const db = drizzle(c.env.DB);
  const [updated] = await db
    .update(transaction)
    .set({
      title: payload.title,
      amount: Number(payload.amount).toString(),
      currency: payload.currency,
      type: payload.type,
      category: payload.category,
      note: payload.note,
      occurredAt: payload.occurredAt ?? undefined,
    })
    .where(
      and(eq(transaction.id, id), eq(transaction.userId, sessionData.user.id)),
    )
    .returning();

  if (!updated) {
    return c.json({ error: "Not found" }, 404);
  }

  return c.json({ transaction: updated });
});

app.get("/", (c) => {
  return c.text("OK");
});

export default app;
