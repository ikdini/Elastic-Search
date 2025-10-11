# Elasticsearch Node.js Express Demo

This is a simple demo project showing how to use Elasticsearch with Node.js and Express.js.

## Prerequisites

- Node.js and npm
- Elasticsearch running locally at `http://localhost:9200` (default)

## Setup

```bash
npm install
```

## Running the Project

```bash
node index.js
```

## Environment Variables

Create a `.env` file (copy from `.env.example`) to configure Elasticsearch credentials used by `drive.ts`:

```
ES_NODE=https://your-deployment-id.region.gcp.cloud.es.io:443
ES_API_KEY=your_api_key_here
SERVICE_ACCOUNT_FILE=path_to_your_service_account_file.json
```

Do NOT commit your real `.env` file. The script `drive.ts` will exit with an error if these are missing.

To run the Google Drive ingestion script after setting variables:

```bash
npm run build # if using TypeScript compilation
node drive.js  # or: ts-node drive.ts
```

## API Endpoints

### 1. Index a Document

- **POST** `/index`
- **Body:**

```json
{
  "index": "your_index",
  "id": "1",
  "body": { "field": "value" }
}
```

### 2. Search Documents

- **GET** `/search?index=your_index&query={"field":"value"}`

### 3. Delete a Document

- **DELETE** `/delete`
- **Body:**

```json
{
  "index": "your_index",
  "id": "1"
}
```

---

For more information, see the [Elasticsearch Node.js client documentation](https://www.elastic.co/guide/en/elasticsearch/client/javascript-api/current/index.html).
