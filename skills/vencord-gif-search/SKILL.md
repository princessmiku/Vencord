---
name: vencord-gif-search
description: Build or update a Vencord/Discord plugin for GIF search, listing, selection, and sending, using the MyAnimeManager backend GIF API with API key auth.
---

# Vencord GIF Search

This skill must be self-contained because the plugin repo is separate. Do not rely on context or files outside this skill.

Required reference files:
- `skills/vencord-gif-search/references/gif-api.md`
- `skills/vencord-gif-search/references/auth-api.md`

If any required reference is missing or incomplete, stop and request the missing info.

## Quick start

1) Confirm GIF API routes and response shapes from `skills/vencord-gif-search/references/gif-api.md`.
2) Confirm auth flows and API key usage from `skills/vencord-gif-search/references/auth-api.md`.
4) Confirm the UX surface (slash command, text input, modal, panel) and where the message is sent.
5) Implement the plugin features with minimal assumptions.

## Workflow

### 1) Gather requirements

Ask for:
- GIF endpoints (search, list, media) and required params
- Auth method (header or query param, key name)
- Response fields needed (id, url, preview url, title)
- Vencord plugin API surface (commands, UI components, settings storage)
- UI expectations and user flow (how selection happens)
- Error and rate limit expectations

If any are missing, stop and request the info. Do not invent API shapes.

### 2) Locate Vencord plugin structure

- Match the existing framework style (TS/JS, React patterns) and coding conventions.
- Reuse existing UI components and settings storage patterns.

### 3) Implement core functions

Implement and wire:
- API key storage in plugin settings
- `searchGifs(query)` using the search endpoint
- `listGifs()` using list or list-items endpoints
- `selectGif(item)` to choose a result for sending
- `sendGif(url)` to send to the active channel

Keep functions small and testable. Surface failures to the UI.

### 4) UX and safety

- Show empty and loading states.
- Handle HTTP errors and bad responses.
- Respect rate limits (basic debounce or retry backoff if needed).
- Sanitize user input used in requests.

### 5) Integration notes

- If the plugin requires Discord permissions or specific APIs, note them clearly in code comments.
- If the user wants a slash command, implement a concise command with arguments for search and list.
- If UI selection uses a modal or picker, keep it simple and keyboard friendly.

## References

- `skills/vencord-gif-search/references/gif-api.md` for API routes and response shapes.
- `skills/vencord-gif-search/references/auth-api.md` for login and API key handling.
