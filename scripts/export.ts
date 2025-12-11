import { Client } from "@elastic/elasticsearch";
import { writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import dotenv from "dotenv";
dotenv.config({ quiet: true });

const ES_NODE = process.env.ES_NODE;
const ES_API_KEY = process.env.ES_API_KEY;
if (!ES_NODE || !ES_API_KEY) {
  console.error("Missing required env variables: ES_NODE and ES_API_KEY");
  process.exit(1);
}

const TM_DB_DIR = resolve(__dirname, "../tm-db");

interface TranslationDocument {
  source_lang: string;
  target_lang: string;
  source_text: string;
  translated_text?: string;
}

const es_client = new Client({
  node: ES_NODE,
  auth: {
    apiKey: ES_API_KEY,
  },
});

/**
 * @function exportTranslations
 * @param target_lang - Target language to export
 * Fetches all translations from the index using scroll API and saves to JSON file
 */
async function exportTranslations(target_lang: string): Promise<void> {
  target_lang = target_lang.toLowerCase().trim().replace(/\s+/g, "-");
  const index_name = `english-${target_lang}`;

  // Check if index exists
  const exists = await es_client.indices.exists({ index: index_name });
  if (!exists) {
    throw new Error(`Index "${index_name}" does not exist`);
  }

  console.log(`Fetching all documents from index: ${index_name}...`);

  // Use scroll API to fetch all documents efficiently
  const documents: TranslationDocument[] = [];
  let scrollId: string | undefined;

  try {
    // Initial search with scroll
    let result = await es_client.search<TranslationDocument>({
      index: index_name,
      size: 1000,
      scroll: "2m",
      query: { match_all: {} },
    });

    scrollId = result._scroll_id;

    // Collect documents from first batch
    result.hits.hits.forEach((hit) => {
      if (hit._source) {
        documents.push(hit._source);
      }
    });

    // Continue scrolling until no more documents
    while (result.hits.hits.length > 0) {
      result = await es_client.scroll({
        scroll_id: scrollId,
        scroll: "2m",
      });

      scrollId = result._scroll_id;

      if (result.hits.hits.length === 0) break;

      result.hits.hits.forEach((hit) => {
        if (hit._source) {
          documents.push(hit._source);
        }
      });
    }
  } finally {
    // Clear scroll context
    if (scrollId) {
      await es_client.clearScroll({ scroll_id: scrollId }).catch(() => {
        // Ignore errors on scroll cleanup
      });
    }
  }

  console.log(`Retrieved ${documents.length} documents`);

  // Create tm_db directory if it doesn't exist
  mkdirSync(TM_DB_DIR, { recursive: true });

  // Save to JSON file
  const fileName = `${target_lang}.json`;
  const filePath = resolve(TM_DB_DIR, fileName);

  writeFileSync(filePath, JSON.stringify(documents, null, 2), "utf-8");
  console.log(`✓ Exported ${documents.length} translations to: ${filePath}`);
}

/**
 * @function exportMultipleLanguages
 * @param target_langs - Array of target languages to export
 * Exports all provided languages to separate JSON files
 */
async function exportMultipleLanguages(target_langs: string[]): Promise<void> {
  if (target_langs.length === 0) {
    console.error("No target languages provided");
    process.exit(1);
  }

  console.log(
    `\n📦 Starting export for ${target_langs.length} language(s)...\n`
  );

  const results = await Promise.allSettled(
    target_langs.map((lang) => exportTranslations(lang))
  );

  const successCount = results.filter(
    (result) => result.status === "fulfilled"
  ).length;
  const failureCount = results.filter(
    (result) => result.status === "rejected"
  ).length;

  // Log errors for failed exports
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      console.error(`❌ ${target_langs[index]}: ${result.reason}`);
    }
  });

  console.log(
    `\n✅ Export completed: ${successCount} succeeded, ${failureCount} failed\n`
  );
  process.exit(failureCount > 0 ? 1 : 0);
}

// Target languages to export - modify this array as needed
const target_langs = [
  "arabic",
  "filipino",
  "french",
  "german",
  "greek",
  "indonesian",
  "italian",
  "japanese",
  "korean",
  "malay",
  "polish",
  "portuguese",
  "russian",
  "simplified-chinese",
  "spanish",
  "swedish",
  "thai",
  "traditional-chinese",
  "turkish",
  "vietnamese",
];

exportMultipleLanguages(target_langs);
