# Cloudflare R2 (S3-compatible object storage)

## Client
- Use the AWS SDK v3 `S3Client` (`@aws-sdk/client-s3`) with `region: "auto"`, `endpoint: https://<ACCOUNT_ID>.r2.cloudflarestorage.com`, and an R2 access key pair. Variables: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, optional `R2_PUBLIC_URL`. Names only in `.env.example`.
- Recent AWS SDK versions add checksum headers by default that R2 may reject (for example on presigned or put requests). If uploads fail with checksum or signature errors, set `requestChecksumCalculation: "WHEN_REQUIRED"` (and the matching response option) on the client and confirm in the current R2 docs.
- Wrap storage in one `StorageService` (put, get, delete, signed URLs) behind an interface so tests can use a fake.

## Upload and download patterns
- Browser uploads: the API issues a short-lived presigned PUT URL (`@aws-sdk/s3-request-presigner`, a few minutes), after checking the user's permission, file type and size limit; the browser uploads straight to R2; then calls the API to confirm and store the object key and metadata in the database. Credentials never reach the browser.
- Keys: generated server-side, `tenant-or-user/yyyy/mm/<uuid>.<ext>`; never trust the client file name for the key or the extension. Store the original name as metadata.
- Private by default. Serve private files through short-lived presigned GET URLs or an authenticated API route. Public assets use a custom domain or the public bucket URL, enabled deliberately.
- CORS on the bucket: allow only your web origins, the needed methods (PUT, GET, HEAD) and headers (`Content-Type`).

## Safety and operations
- Validate content type (by content where possible) and enforce a max size when signing. Scan or restrict executable and HTML types served from your domain.
- Clean up: delete the object when its database row is deleted; handle abandoned uploads with a lifecycle rule on a temp prefix.
- Test with a fake storage in unit tests; use a separate dev bucket for integration tests, never the production bucket.
