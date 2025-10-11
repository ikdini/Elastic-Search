# Copilot Instructions: Elastic-Search Translation Memory Demo

This project is a Node.js + Express.js REST API for translation memory, using Elasticsearch as the backend. The core logic is in `index.ts`.

## Architecture & Data Flow

- **Single Service**: All logic is in `index.ts`. No separate modules or layers.
- **Translation Memory**: Text is split into segments (by ".") and each segment is stored as a separate document in Elasticsearch.
- **Elasticsearch Mapping**: The `translations` index uses:
  - `sourceLang` and `targetLang`: `keyword`
  - `sourceText`: `text` with a `keyword` subfield
  - `translatedText`: `text`
- **Endpoints:**
  - `POST /add-translation`: Add source/target text, split by ".", upsert each segment.
  - `POST /translate`: Split input, look up each segment, return translation if found, else original.
  - `DELETE /delete`: Remove a translation segment by ID.
  - `GET /es-health`: Check Elasticsearch connection.

## Key Patterns & Conventions

- **Index Name**: Always use the `indexName` constant (`translations`). Do not pass or redefine index names.
- **Elasticsearch Client**: Use the top-level `esClient` constant directly in all helpers and routes.
- **Segment Handling**: Use `splitSegments(text)` to split and trim by ".". Never store or translate unsplit text.
- **Upsert Logic**: Use `findTranslationSegment` to check for an existing segment, then update or insert as needed.
- **Error Handling**: Use `handleElasticError` for all Elasticsearch errors. Do not throw raw errors.
- **No Unrelated Endpoints**: Only implement endpoints for translation memory and Elasticsearch segment-based translation.

## Developer Workflow

- **Install**: `npm install`
- **Run**: `node index.js` (or use the VS Code task if available)
- **Elasticsearch**: Assumes a local instance at `http://localhost:9200` with basic auth.
- **Testing**: No test suite is present; use HTTP requests (e.g., `requests.http` or curl) to verify endpoints.

## Examples

- To add a translation:
  ```json
  {
    "sourceLang": "en",
    "targetLang": "fr",
    "sourceText": "Hello. How are you?",
    "translatedText": "Bonjour. Comment ça va?"
  }
  ```
- To translate:
  ```json
  {
    "sourceLang": "en",
    "targetLang": "fr",
    "sourceText": "Hello. How are you?"
  }
  ```

## Do/Don't for AI Agents

- **Do**: Use the segment-based approach for all translation logic.
- **Do**: Use the provided helpers and patterns in `index.ts`.
- **Don't**: Add endpoints or logic unrelated to translation memory or Elasticsearch segment-based translation.
- **Don't**: Change the index name or Elasticsearch connection logic unless explicitly requested.
