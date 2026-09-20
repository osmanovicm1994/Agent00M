# Request Validation & DTO Standards

## 1. Mandatory Input DTOs
- Every endpoint receiving query parameters, route parameters, or request bodies must map data through a strongly typed DTO class.
- Never accept raw, unvalidated `req.body` inside business logic services.

## 2. Validation Decorators & Sanitization
- Leverage explicit validation rules (e.g., `class-validator`) ensuring types, formats, and boundary constraints are strictly enforced:
  ```typescript
  import { IsEmail, IsString, MinLength } from 'class-validator';

  export class CreateUserDto {
    @IsEmail()
    email!: string;

    @IsString()
    @MinLength(8)
    password!: string;
  }