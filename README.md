# Translation Memory Demo (Node.js + Express + Elasticsearch + OpenAI)

Segment-based translation memory service that:

- Stores sentence-level bilingual segments in Elasticsearch
- Performs fuzzy lookups with n‑gram + phrase + fuzzy queries
- Falls back to OpenAI GPT (gpt-4o) for on‑the‑fly MT when no TM match >= 50%
- Never stores MT output from /translate (only /add-translation writes)

## Features

- Automatic sentence segmentation (except for languages where segmentation is disabled)
- Upsert logic: existing segment => update, new segment => insert
- Similarity scoring using string-similarity (Dice coefficient) for fuzzy matches
- OpenAI fallback clearly labeled in response (`source: "ChatGPT"` vs `"CAT Tool"`)
- Per‑target language TM index pattern: `translations(<target_lang>)`
- Lightweight health endpoint to verify Elasticsearch connectivity

## Tech Stack

- Node.js / Express
- Elasticsearch (@elastic/elasticsearch)
- OpenAI (chat completions API)
- Sentence Boundary Detection (sbd)
- TypeScript

## Prerequisites

- Node.js 18+
- Running Elasticsearch cluster (local or Elastic Cloud)
- OpenAI API key

## Quick Start

```bash
git clone <repo>
cd Elastic-Search
npm install
cp .env.example .env   # fill in values
npm run dev             # Nodemon + ts-node (hot reload)
# or: npm start         # Direct ts-node execution
```

Server runs on: http://localhost:3050

## Environment Variables (.env)

| Variable             | Required | Purpose                                                                         |
| -------------------- | -------- | ------------------------------------------------------------------------------- |
| ES_NODE              | Yes      | Elasticsearch endpoint (e.g. http://localhost:9200)                             |
| ES_API_KEY           | Yes      | Elasticsearch API key (or configure auth alternately)                           |
| OPENAI_API_KEY       | Optional | Used for GPT fallback translations. Required in the script (`index.ts`)         |
| SERVICE_ACCOUNT_FILE | Optional | Needed only for the Google Drive ingestion. Required in the script (`drive.ts`) |

Never commit real secrets. `.env` is git‑ignored.

## Index Mapping (Created Automatically)

When a target language is first used we create an index: `translations(<target_lang>)` with mapping:

```
source_text: text (custom ngram_analyzer) + keyword subfield (dedup)
translated_text: text (standard)
source_lang: keyword
target_lang: keyword
```

Custom `ngram_analyzer` (3–5 grams) enables partial/fuzzy retrieval; `source_text.dedup` (keyword + lowercase normalizer) enables exact lookups.

## Sentence Segmentation

Segmentation uses `sbd` unless the target language is in:
`[arabic, japanese, korean, simplified-chinese, traditional-chinese]`
For those, the entire string is treated as one segment.

## API Endpoints

### 1. Health

GET `/es-health`
Response:

```json
{ "status": "Elasticsearch connection OK" }
```

### 2. Add / Upsert Translation Segments

POST `/add-translation`
Body:

```json
{
  "source_lang": "en",
  "target_lang": "fr",
  "source_text": "Hello. How are you?",
  "translated_text": "Bonjour. Comment ça va?"
}
```

Behavior:

1. Normalizes languages (lowercase, hyphenates spaces) and strips HTML & emojis from text.
2. Splits both source & translated text into aligned sentence segments (unless non-segment language).
3. For each source segment, attempts exact match (`source_text.dedup`).
4. Bulk operation: update existing segment or insert new one.
   Response example:

```json
{
  "segments": [
    { "segment": "Hello.", "id": "abc123", "action": "inserted" },
    { "segment": "How are you?", "id": "def456", "action": "updated" }
  ]
}
```

### 3. Translate (Read-Only, Fuzzy + OpenAI Fallback)

POST `/translate`
Body:

```json
{
  "source_lang": "en",
  "target_lang": "fr",
  "source_text": "Hello. How are you?"
}
```

Processing per segment:

1. Exact segmentation of source text.
2. Fuzzy ES query (phrase > match > fuzzy) filtered by source_lang & target_lang.
3. Similarity (Dice) computed between request segment & matched TM segment.
4. If a hit exists with similarity >= 50%, return TM translation (`source: "CAT Tool"`).
5. Otherwise call OpenAI (`source: "ChatGPT"`). OpenAI output is NOT persisted.
   Response example:

```json
{
  "translated_text": "Bonjour. Comment ça va?",
  "segments": [
    {
      "segment": "Hello.",
      "translated_text": "Bonjour.",
      "source_text": "Hello.",
      "similarity": 100,
      "source": "CAT Tool"
    },
    {
      "segment": "How are you?",
      "translated_text": "Comment ça va?",
      "similarity": 100,
      "source": "CAT Tool"
    }
  ]
}
```

## Error Handling

All Elasticsearch errors are normalized via a helper to return structured JSON with appropriate HTTP status codes (ResponseError, ConnectionError, TimeoutError, etc.).

## Google Drive Ingestion (Optional)

`drive.ts` can read spreadsheet files from a Google Drive folder (service account) and index bilingual segments into their respective TM index. Set `SERVICE_ACCOUNT_FILE` plus required GCP credentials fields in `.env`.

Run:

```bash
ts-node drive.ts
# or after build:
npm run build && node drive.js
```

## Development Scripts

| Command       | Description                                            |
| ------------- | ------------------------------------------------------ |
| npm run dev   | Start server with nodemon (hot reload)                 |
| npm start     | Start server via ts-node                               |
| npm run build | Transpile TypeScript to JavaScript (outputs .js files) |

## Testing (Manual)

Use the HTTP request collections in `requests/` (VS Code REST Client) or curl/Postman.

Example curl:

```bash
curl -X POST http://localhost:3050/add-translation \
  -H 'Content-Type: application/json' \
  -d '{"source_lang":"en","target_lang":"fr","source_text":"Hello. How are you?","translated_text":"Bonjour. Comment ça va?"}'

curl -X POST http://localhost:3050/translate \
  -H 'Content-Type: application/json' \
  -d '{"source_lang":"en","target_lang":"fr","source_text":"Hello. How are you?"}'
```

## Data Lifecycle Notes

- Only /add-translation writes to Elasticsearch
- /translate never persists OpenAI output (ephemeral usage)
- Segment granularity ensures maximal TM reuse and minimal duplication

## Future Ideas

- Add /delete endpoint for segment removal
- Add batch ingestion endpoint
- Add similarity threshold parameter override
- Expose alignment diagnostics / debug scoring

## References

- Elasticsearch JS Client Docs: https://www.elastic.co/guide/en/elasticsearch/client/javascript-api/current/index.html
- OpenAI Node SDK: https://github.com/openai/openai-node
- sbd (Sentence Boundary Detection): https://www.npmjs.com/package/sbd

---

© 2025 Translation Memory Demo
