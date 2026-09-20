# RESTful Endpoint Design & Resource Conventions

## 1. Resource Naming & URI Structure
- Use plural nouns for resource paths: `/api/v1/users`, `/api/v1/orders`. Never use verbs in paths.
- Nest resources logically to represent ownership hierarchies (e.g., `/api/v1/users/{userId}/orders`), but avoid nesting past two levels deep.

## 2. Standard HTTP Status Code Usage
- **`200 OK`**: Successful GET, PUT, or PATCH requests returning a payload.
- **`201 Created`**: Successful POST requests that result in a newly created resource (must include a `Location` header or return the created entity).
- **`204 No Content`**: Successful DELETE or background action requests with no return body.
- **`400 Bad Request`**: Malformed request syntax or invalid query parameters.
- **`401 Unauthorized`**: Missing or invalid authentication credentials.
- **`403 Forbidden`**: Authenticated user lacks permission to access the target resource.
- **`404 Not Found`**: The requested resource entity does not exist.
- **`422 Unprocessable Entity`**: Semantically invalid request payload failing validation rules.

## 3. Pagination, Filtering, and Sorting
- Unbounded lists must always use query-parameter pagination: `?page=1&limit=20` or cursor-based parameters (`?cursor=xyz&limit=20`).
- Support filtering via clear query parameters (e.g., `?status=active&role=admin`).