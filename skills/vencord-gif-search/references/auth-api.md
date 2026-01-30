# Auth and API Key Usage

These routes and headers are extracted from the current project backend.

## API key header

- Header name: `X-API-Key`
- Example: `X-API-Key: <key>`
- If the header is present and valid, the request is authenticated as that user.
- If the header is invalid, the API returns `401 Invalid API key`.

## Current user

`GET /auth/me`

Requires auth (API key header or session cookie).
