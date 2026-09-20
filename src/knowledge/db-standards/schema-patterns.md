# Advanced Schema Patterns & Modeling Rules

## 1. Multi-Tenancy & Data Isolation
- Every core entity belonging to a client/organization MUST include a `tenantId` (or `workspaceId`) indexed alongside foreign keys for row-level isolation.
- Compound unique constraints must incorporate the tenant identifier: `@@unique([tenantId, slug])`.

## 2. Handling Soft Deletes vs. Hard Deletes
- Do not use physical deletes (`DELETE`) for transactional records (e.g., users, orders, billing logs).
- Implement soft-deletes using `deletedAt DateTime?`. 
- Global filters or Prisma extensions must be used to exclude soft-deleted records by default (`where: { deletedAt: null }`).

## 3. Enums vs. Reference Tables
- Use Prisma native `enum` types only for static, globally unchanging domain values (e.g., `Role`, `OrderStatus`).
- Use relational reference tables with foreign keys if the application requires user-editable metadata, descriptions, or active/inactive flags.

## 4. Prisma Naming Conventions
- Models: PascalCase (e.g., `UserAccount`, `SubscriptionInvoice`).
- Fields: camelCase (e.g., `createdAt`, `passwordHash`).
- Relations: Explicitly name relation fields and underlying scalar fields to prevent Prisma auto-generation ambiguities:
  ```prisma
  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)
  userId String