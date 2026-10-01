# Python Backend Standards (FastAPI)

## 1. Typing & Static Analysis
- Python 3.10+ type hinting is mandatory for all function arguments and return types.
- Use `mypy` in strict mode. Use `typing.Optional`, `typing.Union`, or the new `|` syntax explicitly. Do not rely on implicit `None`.
- Use Pydantic v2 models for all request validation, response serialization, and environment variable configuration.

## 2. Asynchronous API Design
- Use FastAPI as the standard framework.
- Define endpoints using `async def`. For blocking I/O (like interacting with legacy synchronous libraries), use standard `def` so FastAPI routes it to a worker thread.

## 3. Database Interactions
- Utilize asynchronous database drivers (e.g., `asyncpg` for PostgreSQL).
- If using SQLAlchemy, utilize SQLAlchemy 2.0 with the `asyncio` extension (`AsyncSession`).
- Abstract database operations behind Repository classes; do not write raw SQL or ORM queries directly inside FastAPI route handlers.
