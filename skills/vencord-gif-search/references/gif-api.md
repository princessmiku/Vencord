# MyAnimeManager GIF API

These routes are extracted from the current project backend. Use them as the source of truth.

## Provider

- Name: MyAnimeManager backend
- Base URL: `https://www.midevelopment.de` (from `APP_HOST` and `APP_PORT` in `dev.env`; adjust per environment)
- Test URL: ``http://127.0.0.1:8000``
## Auth

- API key header: `X-API-Key: <key>`
- Make a setting that are needed to set the api key

## Endpoints

### Search and list GIFs

`GET /gifs`

Query params:
- `q` (string, optional): search query
- `user_id` (int, optional)
- `franchise` (int, optional)
- `character` (int, optional)
- `tag` (int, optional)
- `nsfw` (bool, default false)
- `visibility` (string, enum: `published|unpublished|all`, default `published`)
- `sort_by` (string, enum: `id|created_at`, default `id`)
- `order` (string, enum: `asc|desc`, default `desc`)
- `page` (int, default 1, min 1)
- `limit` (int, default 20, min 1, max 100)

DEFAULT REQUEST: `GET /gifs?q=<query>&limit=20&page=1&nsfw=false&visibility=published`

Response (200):
```json
{
  "pagination": {
    "page": 1,
    "per_page": 20,
    "has_more": false,
    "next_page": null
  },
  "items": [
    {
      "id": 123,
      "file_id": "550e8400-e29b-41d4-a716-446655440000",
      "owner_id": 1,
      "public_url": "https://example.com/media/gifs/123",
      "source_url": "https://source.example/gif/abc",
      "source_type": "web",
      "nsfw": false,
      "published": true,
      "franchise_id": 10,
      "created_at": "2025-01-01T12:00:00Z"
    }
  ]
}
```

### Single GIF

`GET /gifs/{gif_id}`

Send gifs with the public_url.

Response (200) extends the base fields with relations:
```json
{
  "id": 123,
  "file_id": "550e8400-e29b-41d4-a716-446655440000",
  "owner_id": 1,
  "public_url": "https://example.com/media/gifs/123",
  "source_url": "https://source.example/gif/abc",
  "source_type": "web",
  "nsfw": false,
  "published": true,
  "franchise_id": 10,
  "created_at": "2025-01-01T12:00:00Z",
  "franchise": { "id": 10, "name": "Example Franchise" },
  "characters": [{ "id": 1, "name": "Example Character" }],
  "tag_categories": [{ "id": 5, "name": "Mood", "description": "Happy" }]
}
```

### Suggestions

`GET /gifs/suggestions?q=<query>`

Response (200):
```json
["cat", "cat dance", "cat loop"]
```

### GIF lists (user lists)

`GET /gif-lists`

Query params:
- `gif_id` (int, optional): adds `contains` field for each list

Response (200):
```json
[
  {
    "id": 7,
    "owner_id": 1,
    "name": "Favorites",
    "created_at": "2025-01-01T12:00:00Z",
    "gif_count": 12,
    "contains": true
  }
]
```

`POST /gif-lists`

Body:
```json
{ "name": "Favorites" }
```

Response (200): same shape as list item above.

`PATCH /gif-lists/{list_id}`

Body:
```json
{ "name": "New Name" }
```

Response (200): same shape as list item above.

`DELETE /gif-lists/{list_id}`

Response (200):
```json
{ "detail": "deleted" }
```

### GIF list items

`GET /gif-lists/{list_id}/items`

Query params:
- `page` (int, default 1, min 1)
- `limit` (int, default 20, min 1, max 100)
- `nsfw` (bool, default true)

Response (200):
```json
{
  "pagination": {
    "page": 1,
    "per_page": 20,
    "has_more": false,
    "next_page": null
  },
  "items": [
    {
      "id": 123,
      "file_id": "550e8400-e29b-41d4-a716-446655440000",
      "owner_id": 1,
      "public_url": "https://example.com/media/gifs/123",
      "source_url": "https://source.example/gif/abc",
      "source_type": "web",
      "nsfw": false,
      "published": true,
      "franchise_id": 10,
      "created_at": "2025-01-01T12:00:00Z"
    }
  ]
}
```

`POST /gif-lists/{list_id}/items`

Body:
```json
{ "gif_id": 123 }
```

Response (200):
```json
{ "detail": "added" }
```

If already present:
```json
{ "detail": "exists" }
```

`DELETE /gif-lists/{list_id}/items/{gif_id}`

Response (200):
```json
{ "detail": "removed" }
```

### Media

`GET /media/gifs/{gif_id}`

- Optional query param: `preview` (bool, default false)
- Returns `image/gif` as file response.

`GET /media/gifs/{gif_id}/preview`

- Returns preview GIF.

## Input validation and accepted values

- `limit` is clamped to 1..100.
- `page` min 1.
- `visibility`: `published|unpublished|all`
- `sort_by`: `id|created_at`
- `order`: `asc|desc`
- List names must be non-empty; duplicates per user are rejected.

## Error responses

- `400` for invalid data (e.g., empty list name)
- `401` not authenticated
- `403` permission denied
- `404` not found

## Example requests

Search:
```bash
curl -H "X-API-Key: <key>" "http://127.0.0.1:8000/gifs?q=cat&limit=20&page=1"
```

List items:
```bash
curl -H "X-API-Key: <key>" "http://127.0.0.1:8000/gif-lists/7/items?limit=20&page=1"
```

Fetch media:
```bash
curl -H "X-API-Key: <key>" "http://127.0.0.1:8000/media/gifs/123"
```
