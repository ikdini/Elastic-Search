import fs from "fs";
import path from "path";
import { Client } from "@elastic/elasticsearch";
import tokenizer from "sbd";
// import type { estypes } from "@elastic/elasticsearch";
import dotenv from "dotenv";
dotenv.config({ quiet: true });

const ES_NODE = process.env.ES_NODE;
const ES_API_KEY = process.env.ES_API_KEY;
const TM_DB_DIR = path.join(__dirname, "../tm-db/jsonl");

if (!ES_NODE || !ES_API_KEY) {
  console.error("Missing required env variable(s).");
  process.exit(1);
}

const es_client = new Client({
  node: ES_NODE,
  auth: {
    apiKey: ES_API_KEY,
  },
  serverMode: "serverless",
});

interface TranslationDocument {
  source_lang: string;
  target_lang: string;
  source_text: string;
  translated_text?: string;
}
// type SearchHit = estypes.SearchHit<TranslationDocument>;

const non_segment_languages = new Set([
  "arabic",
  "japanese",
  "korean",
  "simplified-chinese",
  "traditional-chinese",
]);

interface ErrorDetail {
  lineNumber: number;
  error: string;
}

/**
 * @function ensure_translations_index
 * @param index_name - Name of the Elasticsearch index
 * Ensures the translations index exists with the correct mapping.
 */
async function ensure_translations_index(index_name: string): Promise<void> {
  const exists = await es_client.indices.exists({ index: index_name });
  if (!exists) {
    await es_client.indices.create({
      index: index_name,
      settings: {
        analysis: {
          normalizer: {
            lowercase_normalizer: {
              type: "custom",
              filter: ["lowercase"],
            },
          },
          tokenizer: {
            ngram_tokenizer: {
              type: "ngram",
              min_gram: 2,
              max_gram: 3,
              token_chars: ["letter", "digit", "whitespace"],
            },
          },
          analyzer: {
            ngram_analyzer: {
              type: "custom",
              tokenizer: "ngram_tokenizer",
              filter: ["lowercase"],
            },
          },
        },
      },
      mappings: {
        properties: {
          source_text: {
            type: "text",
            analyzer: "ngram_analyzer",
            search_analyzer: "ngram_analyzer",
            fields: {
              dedup: {
                type: "keyword",
                normalizer: "lowercase_normalizer",
              },
            },
          },
          translated_text: { type: "text", analyzer: "standard" },
          source_lang: { type: "keyword" },
          target_lang: { type: "keyword" },
        },
      },
    });
  }
}

/**
 * @function split_segments
 * @param source_text - Source text to split into segments
 * @param translated_text - Translated text to split into segments
 * @returns Object containing source and translated segments, with mismatch flag
 */
function split_segments(source_text: string, translated_text?: string) {
  const tokenizer_options: tokenizer.Options = {
    newline_boundaries: true,
    html_boundaries: true,
  };

  const source_segments = tokenizer.sentences(source_text, tokenizer_options);

  if (!translated_text) {
    return { source_segments, translated_segments: undefined, mismatch: false };
  }

  const translated_segments = tokenizer.sentences(
    translated_text,
    tokenizer_options
  );
  const mismatch = source_segments.length !== translated_segments.length;

  return { source_segments, translated_segments, mismatch };
}

// /**
//  * @function find_translation_segment
//  * @param index_name - Name of the Elasticsearch index
//  * @param source_lang - Source language
//  * @param target_lang - Target language
//  * @param source_text - Source text segment
//  * @returns Search hit or undefined
//  */
// async function find_translation_segment(
//   index_name: string,
//   source_lang: string,
//   target_lang: string,
//   source_text: string
// ): Promise<SearchHit | undefined> {
//   const searchResult = await es_client.search<TranslationDocument>({
//     index: index_name,
//     size: 1,
//     query: {
//       bool: {
//         must: [
//           { term: { source_lang } },
//           { term: { target_lang } },
//           { term: { "source_text.dedup": source_text.toLowerCase() } },
//         ],
//       },
//     },
//   });
//   return searchResult.hits.hits[0];
// }

/**
 * @function add_translation
 * @param translations - Array of translations to batch process
 * @returns Upload result
 */
async function add_translations_batch(
  translations: Array<{
    source_lang: string;
    target_lang: string;
    source_text: string;
    translated_text?: string;
    lineNumber: number;
  }>
): Promise<{
  success: number;
  failed: number;
  totalSegments: number;
  errors: ErrorDetail[];
}> {
  let successCount = 0;
  let failedCount = 0;
  let totalSegmentCount = 0;
  const errors: ErrorDetail[] = [];

  // Group by target language for efficient bulk operations
  const byLanguage = new Map<
    string,
    Array<{
      source_lang: string;
      target_lang: string;
      source_text: string;
      translated_text: string;
      lineNumber: number;
      segments: string[];
      translatedSegments: string[];
    }>
  >();

  // Preprocess translations: split segments and group by language
  for (const translation of translations) {
    try {
      const source_lang = translation.source_lang
        ?.toLowerCase()
        .trim()
        .replace(/\s+/g, "-");
      const target_lang = translation.target_lang
        ?.toLowerCase()
        .trim()
        .replace(/\s+/g, "-");

      if (
        !source_lang ||
        !target_lang ||
        !translation.source_text ||
        !translation.translated_text
      ) {
        failedCount++;
        errors.push({
          lineNumber: translation.lineNumber,
          error: `Missing required fields`,
        });
        continue;
      }

      let source_segments = [translation.source_text];
      let translated_segments = [translation.translated_text];

      if (!non_segment_languages.has(target_lang)) {
        const segmentResult = split_segments(
          translation.source_text,
          translation.translated_text
        );

        if (segmentResult.mismatch) {
          failedCount++;
          errors.push({
            lineNumber: translation.lineNumber,
            error: `Segment count mismatch (${segmentResult.source_segments.length} vs ${segmentResult.translated_segments?.length})`,
          });
          continue;
        }

        source_segments = segmentResult.source_segments;
        translated_segments = segmentResult.translated_segments!;
      }

      if (!byLanguage.has(target_lang)) {
        byLanguage.set(target_lang, []);
      }

      byLanguage.get(target_lang)!.push({
        source_lang,
        target_lang,
        source_text: translation.source_text,
        translated_text: translation.translated_text,
        lineNumber: translation.lineNumber,
        segments: source_segments,
        translatedSegments: translated_segments,
      });

      totalSegmentCount += source_segments.length;
    } catch (err) {
      failedCount++;
      errors.push({
        lineNumber: translation.lineNumber,
        error: `${err instanceof Error ? err.message : "Unknown error"}`,
      });
    }
  }

  // Process each language's translations
  const indexRefreshQueue = new Set<string>();

  for (const [targetLang, translationGroup] of byLanguage) {
    try {
      const sourceLang = translationGroup[0].source_lang;
      const index_name = `${sourceLang}-${targetLang}`;
      await ensure_translations_index(index_name);

      // Bulk build all operations with deduplication
      const bulkBody: object[] = [];
      const processedSegments = new Set<string>();

      // Prepare bulk body without individual lookups for better performance
      for (const item of translationGroup) {
        for (let i = 0; i < item.segments.length; i++) {
          const source_segment = item.segments[i];
          const segment_key = source_segment.toLowerCase().trim();

          if (processedSegments.has(segment_key)) {
            continue;
          }

          // Insert new TM entry
          bulkBody.push({ index: { _index: index_name } });
          bulkBody.push({
            source_lang: item.source_lang,
            target_lang: item.target_lang,
            source_text: source_segment,
            translated_text: item.translatedSegments[i],
          });

          processedSegments.add(segment_key);
        }
      }

      // Perform bulk write without refresh
      if (bulkBody.length > 0) {
        await es_client.bulk({
          body: bulkBody,
        });
        indexRefreshQueue.add(index_name);
      }

      successCount += translationGroup.length;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      for (const item of translationGroup) {
        failedCount++;
        errors.push({
          lineNumber: item.lineNumber,
          error: errorMsg,
        });
      }
    }
  }

  // Refresh all indices at once after all uploads
  for (const index_name of indexRefreshQueue) {
    try {
      await es_client.indices.refresh({ index: index_name });
    } catch {
      // Silently ignore refresh errors
    }
  }

  return {
    success: successCount,
    failed: failedCount,
    totalSegments: totalSegmentCount,
    errors,
  };
}

/**
 * Upload translations from a JSONL file
 */
async function uploadTranslationsFromFile(filePath: string): Promise<{
  success: number;
  failed: number;
  totalSegments: number;
  errors: ErrorDetail[];
}> {
  try {
    const fileName = path.basename(filePath);
    console.log(`\n📁 Processing: ${fileName}`);
    console.log("─".repeat(70));

    const fileContent = fs.readFileSync(filePath, "utf-8");
    const lines = fileContent.trim().split("\n");

    console.log(`   Total lines: ${lines.length}`);

    const translations: Array<{
      source_lang: string;
      target_lang: string;
      source_text: string;
      translated_text?: string;
      lineNumber: number;
    }> = [];
    const parseErrors: ErrorDetail[] = [];

    // Parse all JSON lines first
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const lineNumber = lineIdx + 1;
      const line = lines[lineIdx].trim();

      if (!line) {
        continue; // Skip empty lines
      }

      try {
        const translation: TranslationDocument = JSON.parse(line);
        translations.push({
          ...translation,
          lineNumber,
        });
      } catch (parseError) {
        parseErrors.push({
          lineNumber,
          error: `JSON parse error - ${
            parseError instanceof Error ? parseError.message : "Unknown error"
          }`,
        });
      }
    }

    console.log(`   Parsed: ${translations.length} valid entries`);
    console.log(`   Processing in batches...`);

    // Process in batches of 2000 for better throughput
    const BATCH_SIZE = 2000;
    let totalSuccess = 0;
    let totalFailed = 0;
    let totalSegmentCount = 0;
    let mismatchCount = 0;
    const allErrors: ErrorDetail[] = [];

    for (let i = 0; i < translations.length; i += BATCH_SIZE) {
      const batch = translations.slice(i, i + BATCH_SIZE);
      const result = await add_translations_batch(batch);

      totalSuccess += result.success;
      totalFailed += result.failed;
      totalSegmentCount += result.totalSegments;

      // Count mismatches
      const mismatches = result.errors.filter((e) =>
        e.error.includes("Segment count mismatch")
      );
      mismatchCount += mismatches.length;

      allErrors.push(...result.errors);

      const progress = Math.min(i + BATCH_SIZE, translations.length);
      console.log(
        `   ✓ Progress: ${progress}/${translations.length} entries processed`
      );
    }

    // Add parse errors
    totalFailed += parseErrors.length;
    allErrors.push(...parseErrors);

    console.log("─".repeat(70));
    console.log(
      `   ✅ File complete: ${totalSuccess} succeeded, ${totalFailed} failed`
    );
    console.log(`   📊 Total segments: ${totalSegmentCount}`);
    if (mismatchCount > 0) {
      console.log(`   ⚠️  Segment mismatches: ${mismatchCount}`);
    }

    // Log non-mismatch errors
    const nonMismatchErrors = allErrors.filter(
      (e) => !e.error.includes("Segment count mismatch")
    );
    if (nonMismatchErrors.length > 0) {
      console.log(`   ❌ Other errors (${nonMismatchErrors.length}):`);
      const errorGroups = new Map<string, number[]>();
      for (const err of nonMismatchErrors) {
        const key = err.error;
        if (!errorGroups.has(key)) {
          errorGroups.set(key, []);
        }
        errorGroups.get(key)!.push(err.lineNumber);
      }
      for (const [errorMsg, lineNumbers] of errorGroups.entries()) {
        const lineStr =
          lineNumbers.length === 1
            ? `line ${lineNumbers[0]}`
            : `lines ${lineNumbers.join(", ")}`;
        console.log(`      • ${errorMsg} (${lineNumbers.length}) - ${lineStr}`);
      }
    }

    return {
      success: totalSuccess,
      failed: totalFailed,
      totalSegments: totalSegmentCount,
      errors: allErrors,
    };
  } catch (error) {
    const errorMsg = `${path.basename(filePath)}: File read error - ${
      error instanceof Error ? error.message : "Unknown error"
    }`;
    console.error(`   ❌ ${errorMsg}`);
    return {
      success: 0,
      failed: 0,
      totalSegments: 0,
      errors: [
        {
          lineNumber: 0,
          error: errorMsg,
        },
      ],
    };
  }
}

/**
 * Upload all TM database files
 */
async function uploadAllTranslations(): Promise<void> {
  try {
    // Check Elasticsearch connection
    console.log(`\n🔗 Checking Elasticsearch connection...`);
    try {
      await es_client.ping();
      console.log("✅ Elasticsearch connection OK");
    } catch (pingError) {
      console.error(
        `❌ Connection failed: ${
          pingError instanceof Error ? pingError.message : "Unknown error"
        }`
      );
      process.exit(1);
    }

    // Get all JSONL files in tm-db/jsonl directory
    if (!fs.existsSync(TM_DB_DIR)) {
      console.error(`❌ Directory not found: ${TM_DB_DIR}`);
      process.exit(1);
    }

    const jsonlFiles = fs
      .readdirSync(TM_DB_DIR)
      .filter((f) => f.endsWith(".jsonl"))
      .sort();

    if (jsonlFiles.length === 0) {
      console.error(`❌ No JSONL files found in: ${TM_DB_DIR}`);
      process.exit(1);
    }

    console.log(`\n📊 Found ${jsonlFiles.length} language file(s) to process`);

    let totalFilesSucceeded = 0;
    let totalFilesFailed = 0;
    let totalSegmentsProcessed = 0;
    let totalTranslationsProcessed = 0;
    const totalErrorsCollected: ErrorDetail[] = [];

    // Process each JSONL file
    for (const fileName of jsonlFiles) {
      const filePath = path.join(TM_DB_DIR, fileName);
      const result = await uploadTranslationsFromFile(filePath);

      totalFilesSucceeded += result.success;
      totalFilesFailed += result.failed;
      totalSegmentsProcessed += result.totalSegments;
      totalTranslationsProcessed += result.success + result.failed;
      totalErrorsCollected.push(...result.errors);
    }

    console.log("\n" + "=".repeat(70));
    console.log("📊 OVERALL SUMMARY");
    console.log("=".repeat(70));
    console.log(`✅ Succeeded:     ${totalFilesSucceeded}`);
    console.log(`❌ Failed:        ${totalFilesFailed}`);
    console.log(`📦 Processed:     ${totalTranslationsProcessed}`);
    console.log(`🔄 Segments:      ${totalSegmentsProcessed}`);
    console.log("=".repeat(70));

    if (totalErrorsCollected.length > 0) {
      console.log("\n⚠️  ERRORS");
      console.log("=".repeat(70));

      const mismatchCount = totalErrorsCollected.filter((e) =>
        e.error.includes("Segment count mismatch")
      ).length;
      const parseErrs = totalErrorsCollected.filter((e) =>
        e.error.includes("JSON parse error")
      ).length;
      const otherErrs = totalErrorsCollected.filter(
        (e) =>
          !e.error.includes("Segment count mismatch") &&
          !e.error.includes("JSON parse error")
      ).length;

      if (mismatchCount > 0) {
        console.log(`   📊 Segment mismatches: ${mismatchCount}`);
      }
      if (parseErrs > 0) {
        console.log(`   📄 JSON parse errors: ${parseErrs}`);
      }
      if (otherErrs > 0) {
        console.log(`   ⚠️  Other errors: ${otherErrs}`);
      }

      console.log("=".repeat(70));
    }

    console.log("");
    await es_client.close();

    if (totalFilesFailed > 0) {
      process.exit(1);
    }
  } catch (error) {
    console.error(
      "Fatal error:",
      error instanceof Error ? error.message : error
    );
    process.exit(1);
  }
}

// Run the upload
uploadAllTranslations();
