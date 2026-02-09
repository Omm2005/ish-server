import { relations } from "drizzle-orm";
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

import { user } from "./auth";

export const transaction = sqliteTable(
  "transaction",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    amount: text("amount").notNull(),
    currency: text("currency").default("USD").notNull(),
    type: text("type").notNull(), // "income" | "expense" (enforced in app layer)
    category: text("category"),
    note: text("note"),
    occurredAt: integer("occurred_at", { mode: "timestamp" })
      .$defaultFn(() => new Date())
      .notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => ({
    userIdIdx: index("transaction_userId_idx").on(table.userId),
    occurredAtIdx: index("transaction_occurredAt_idx").on(table.occurredAt),
  })
);

export const transactionRelations = relations(transaction, ({ one }) => ({
  user: one(user, {
    fields: [transaction.userId],
    references: [user.id],
  }),
}));
