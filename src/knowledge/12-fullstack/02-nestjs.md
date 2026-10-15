# NestJS Practices

Check the installed `@nestjs/*` major and follow the project's structure. Generic API rules: `07-api/`.

## Creating the app
- `npx @nestjs/cli new <dir> --package-manager npm --skip-git` (run with `--help` to confirm flags). Generate pieces with `nest g module|controller|service|resource <name>`; check the result with `get_directory_tree`.

## Structure
- One feature module per domain (`users`, `auth`, `files`): controller, service, DTOs, entities/repository, tests together. Modules export only what others need. Shared concerns (config, database, logging) in `common/` or core modules.
- Controllers are thin: bind input, call a service, return a DTO. Business rules live in services; data access in a repository or the ORM service. No business logic in guards or controllers.

## Cross-cutting setup in `main.ts`
- Global `ValidationPipe` with `whitelist: true`, `forbidNonWhitelisted: true`, `transform: true`. DTO classes with `class-validator` decorators (or zod pipes if the project uses them).
- Global exception filter returning one error format (Problem Details); `helmet`; CORS with an explicit origin list from config; graceful shutdown (`enableShutdownHooks`); versioned or prefixed routes (`/api/v1`).
- Swagger (`@nestjs/swagger`) for the OpenAPI document; the web app's client types can be generated from it.

## Config and DI
- `@nestjs/config` with a validated schema (zod or Joi) so a missing variable stops startup with a clear message. Inject config through a typed service, never `process.env` scattered in code.
- Constructor injection. A "Nest can't resolve dependencies" error means a missing `imports`, `exports` or `providers` entry. Avoid circular module imports; extract the shared part.

## Auth building blocks
- Guards for authentication and roles/permissions; a `@Public()` decorator for open routes with a global guard as the default. See `03-auth-jwt.md`.

## Data
- Wrap multi-step writes in a transaction. Return DTOs, never entities with hashes or internal fields. Paginate list endpoints.

## Testing
- Unit tests with `@nestjs/testing` and mocked providers; e2e tests with `supertest` against `AppModule` and a test database. Verify with `npm run build`, `npm run lint`, `npm test`, `npm run test:e2e`.
