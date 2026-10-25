# Records that matter: contracts, invoices, personal data

For apps that store agreements, invoices or other documents a person may have to show later. Apply with the auth rules in `06-recipe-auth-rbac-nextauth.md`.

## Data model
- ONE owner column on every record (`userId` = the signed-in account that created it). Parties named in the document (buyer, seller, commissioner) are separate fields, never the owner.
- Keep records: no `onDelete: Cascade` from User; deactivate users (`active=false`), archive or soft-delete records (`deletedAt`), and say so in `docs/DECISIONS.md`. A hard delete is an explicit, admin-only, logged action.
- Snapshot at issue time: when a document is finalised, store the party and vehicle/goods data AS PRINTED (JSON column or copied fields) and the version of the clause text. Later profile edits must not rewrite an issued document.
- Document numbers are business data: a unique, per-year sequence with a unique index (`@@unique([year, number])`), created inside a transaction. Not the row id, not the app version.
- Status field (`DRAFT`, `ISSUED`, `CANCELLED`); an issued document is not edited, it is cancelled and re-issued.
- Money as integer minor units or `Decimal`, never `Float`. Dates as `DateTime`; print them in the document's locale.
- Audit: `createdAt`, `updatedAt`, `createdById`; for issue/cancel/delete also an `AuditLog` row (who, what, when).

## Fields and print rules
- Language of the document = language of the request (labels, clauses, button texts). Keep clause text in one file (`src/lib/clauses.ts`) so a legal reviewer can read it in one place; do not invent legal wording: use the text from the supplied spec or reference, and list anything not supplied under "Open items".
- Amounts: show the number AND the amount in words when the reference shows both; put the words function under test.
- Vehicle power: store kW as the number, derive horsepower (KS/PS) only for display (`Math.round(kw * 1.35962)`), and label both.
- Personal data: mask in lists (last 4 characters of an ID number), show in full only on the detail and print views, never in logs or error messages.
- Seed users: take email and password from environment variables (`SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`); a dev-only fallback is allowed ONLY when `NODE_ENV !== "production"`, and the seed refuses to run in production without the variables. Never print the password.

## Tests worth writing (each one a real assertion)
USER B cannot read, edit or delete USER A's record (403); a list only contains own rows; ADMIN sees all; an issued record cannot be edited; the document number never repeats; the amount-in-words function for 0, 1, 21, 1000, 1999, 2500.50.
