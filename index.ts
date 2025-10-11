import express, { Request, Response } from "express";
import { Client, errors } from "@elastic/elasticsearch";
import tokenizer from "sbd";
import type { estypes } from "@elastic/elasticsearch";
import stringSimilarity from "string-similarity";
import OpenAI from "openai";
import dotenv from "dotenv";
dotenv.config({quiet: true});

const ES_NODE = process.env.ES_NODE;
const ES_API_KEY = process.env.ES_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!ES_NODE || !ES_API_KEY || !OPENAI_API_KEY) {
  console.error("Missing required env variable(s).");
  process.exit(1);
}

const app = express();
app.use(express.json());

const es_client = new Client({
  node: ES_NODE,
  auth: {
    apiKey: ES_API_KEY,
  },
  // serverMode: "serverless",
});

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

interface TranslationDocument {
  source_lang: string;
  target_lang: string;
  source_text: string;
  translated_text?: string;
}
type SearchHit = estypes.SearchHit<TranslationDocument>;

const non_segment_languages = [
  "arabic",
  "japanese",
  "korean",
  "simplified-chinese",
  "traditional-chinese",
];

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
        index: {
          max_ngram_diff: 8,
        },
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
              min_gram: 3,
              max_gram: 5,
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
            search_analyzer: "standard",
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
 * @returns Object containing source and translated segments
 * Splits source and translated texts into segments using sentence boundaries.
 */
function split_segments(source_text: string, translated_text?: string) {
  const source_segments = tokenizer.sentences(source_text).map((s) => s.trim());

  if (!translated_text) {
    return { source_segments };
  }

  const translated_segments = tokenizer
    .sentences(translated_text)
    .map((s) => s.trim());

  if (source_segments.length === translated_segments.length) {
    return { source_segments, translated_segments };
  }

  return {
    source_segments: [source_text.trim()],
    translated_segments: [translated_text.trim()],
  };
}

/**
 * @function normalize_text
 * @param str - Input string
 * @returns Normalized string
 * Removes HTML tags and emojis from the input string and trims whitespace.
 */
function normalize_text(str: string): string {
  return str
    .replace(/<[^>]*>/g, "")
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "")
    .trim();
}

/**
 * @function find_translation_segment
 * @param index_name - Name of the Elasticsearch index
 * @param source_lang - Source language
 * @param target_lang - Target language
 * @param source_text - Source text segment
 * @returns Search hit or undefined
 * Finds an exact translation segment in the Elasticsearch index.
 */
async function find_translation_segment(
  index_name: string,
  source_lang: string,
  target_lang: string,
  source_text: string
): Promise<SearchHit | undefined> {
  const searchResult = await es_client.search<TranslationDocument>({
    index: index_name,
    size: 1,
    query: {
      bool: {
        must: [
          { term: { source_lang } },
          { term: { target_lang } },
          { term: { "source_text.dedup": source_text.toLowerCase() } },
        ],
      },
    },
  });
  return searchResult.hits.hits[0];
}

/**
 * @function fuzzy_search
 * @param index_name - Name of the Elasticsearch index
 * @param source_lang - Source language
 * @param target_lang - Target language
 * @param source_text - Source text segment
 * @returns Search hit or undefined
 * Finds the best fuzzy translation segment in the Elasticsearch index with >=80% match accuracy.
 */
async function fuzzy_search(
  index_name: string,
  source_lang: string,
  target_lang: string,
  source_text: string
): Promise<(SearchHit & { similarity: number }) | undefined> {
  const search_result = await es_client.search<TranslationDocument>({
    index: index_name,
    size: 1,
    query: {
      bool: {
        must: [{ term: { source_lang } }, { term: { target_lang } }],
        should: [
          {
            match_phrase: {
              source_text: {
                query: source_text,
                boost: 5,
              },
            },
          },
          {
            match: {
              source_text: {
                query: source_text,
                operator: "and",
                boost: 3,
              },
            },
          },
          {
            match: {
              source_text: {
                query: source_text,
                fuzziness: "AUTO",
                boost: 1,
              },
            },
          },
        ],
        minimum_should_match: 1,
      },
    },
  });
  const hit = search_result.hits.hits[0];
  if (!hit) return undefined;

  // Calculate similarity between query segment and TM source
  const similarity = stringSimilarity.compareTwoStrings(
    source_text,
    hit._source?.source_text!
  );
  const percentage = +(similarity * 100).toFixed(2);

  // Only return if >= 50%
  if (percentage < 50) return undefined;

  return {
    ...hit,
    similarity: percentage,
  };
}

/**
 * @function chatgpt
 * @param source_lang - Source language
 * @param target_lang - Target language
 * @param source_text - Source text segment
 * @returns Translated text from ChatGPT
 * Uses OpenAI's GPT-4o model to translate text segments.
 */
async function chatgpt(
  source_lang: string,
  target_lang: string,
  source_text: string
): Promise<string> {
  const modelCompletion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content: [
          {
            text: `You are a professional native translator.\nTranslate the following ${source_lang} text into ${target_lang} using native-level, idiomatic structures typical of the ${target_lang} language. Do not mirror the sentence structure or punctuation of the source. However, you must preserve every meaning in the original ${source_lang} text with full precision. Do not add, omit, generalize, or invent anything. The final result must read as if it were originally written in the ${target_lang} language: fluid, accurate, and professional.`,
            type: "text",
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            text: source_text,
            type: "text",
          },
        ],
      },
    ],
    response_format: {
      type: "text",
    },
    temperature: 1,
    max_completion_tokens: 15000,
    store: true,
  });
  const response = modelCompletion.choices[0].message.content;

  return response!;
}

// Health check for Elasticsearch connection
app.get("/es-health", async (req: Request, res: Response): Promise<void> => {
  try {
    await es_client.ping();
    res.json({ status: "Elasticsearch connection OK" });
  } catch (err: any) {
    handle_elastic_error(err, res, "Elasticsearch connection failed");
  }
});

// Add a translation to the database (segment-based)
app.post(
  "/add-translation",
  async (req: Request, res: Response): Promise<void> => {
    try {
      let { source_lang, target_lang, source_text, translated_text } =
        req.body as TranslationDocument;

      // Normalize
      source_lang = source_lang?.toLowerCase().trim().replace(/\s+/g, "-");
      target_lang = target_lang?.toLowerCase().trim().replace(/\s+/g, "-");
      source_text = normalize_text(source_text);
      translated_text = normalize_text(translated_text!);

      if (!source_lang || !target_lang || !source_text || !translated_text) {
        res.status(400).json({ error: "All fields are required" });
        return;
      }

      let source_segments = [source_text];
      let translated_segments = [translated_text];
      if (!non_segment_languages.includes(target_lang)) {
        const segmentResult = split_segments(source_text, translated_text);
        source_segments = segmentResult.source_segments;
        translated_segments = segmentResult.translated_segments!;
      }

      const index_name = `translations(${target_lang})`;
      await ensure_translations_index(index_name);

      // Gather all hits in parallel to minimize latency
      const hits = await Promise.all(
        source_segments.map((segment) =>
          find_translation_segment(
            index_name,
            source_lang,
            target_lang,
            segment
          )
        )
      );

      const bulkBody: object[] = [];
      const results: {
        segment: string;
        id: string | null | undefined;
        action: "inserted" | "updated";
      }[] = [];

      for (let i = 0; i < source_segments.length; i++) {
        const source_segment = source_segments[i];
        const translated_segment = translated_segments[i];
        const hit = hits[i];

        if (hit) {
          // Update existing TM entry
          bulkBody.push({ update: { _index: index_name, _id: hit._id } });
          bulkBody.push({ doc: { translated_text: translated_segment } });
          results.push({
            segment: source_segment,
            id: hit._id,
            action: "updated",
          });
        } else {
          // Insert new TM entry
          bulkBody.push({ index: { _index: index_name } });
          bulkBody.push({
            source_lang,
            target_lang,
            source_text: source_segment,
            translated_text: translated_segment,
          });
          results.push({
            segment: source_segment,
            id: null,
            action: "inserted",
          });
        }
      }

      // Perform bulk write if needed
      if (bulkBody.length > 0) {
        const bulkResponse = await es_client.bulk({
          refresh: "wait_for",
          body: bulkBody,
        });

        // Map back ES IDs for inserts (only for inserted actions)
        let insertIdx = 0;
        for (let i = 0; i < results.length; i++) {
          if (results[i].action === "inserted") {
            // Find the corresponding bulk response item for this insert
            // Each insert is 2 items in bulkBody: action, then doc
            // Bulk response items are in order, so we can use insertIdx
            const id = bulkResponse.items[insertIdx]?.index?._id || null;
            results[i].id = id;
            insertIdx++;
          }
        }
      }

      res.json({ segments: results });
    } catch (err) {
      handle_elastic_error(err, res);
    }
  }
);

// Fetch translation (segment-based, always fuzzy search, do not store)
app.post("/translate", async (req: Request, res: Response): Promise<void> => {
  try {
    let { source_lang, target_lang, source_text } =
      req.body as TranslationDocument;
    source_lang = source_lang?.toLowerCase().trim().replace(/\s+/g, "-");
    target_lang = target_lang?.toLowerCase().trim().replace(/\s+/g, "-");
    source_text = normalize_text(source_text);
    if (!source_lang || !target_lang || !source_text) {
      res.status(400).json({ error: "All fields are required" });
      return;
    }

    const { source_segments } = split_segments(source_text);
    const index_name = `translations(${target_lang.toLowerCase()})`;
    await ensure_translations_index(index_name);

    const results = await Promise.all(
      source_segments.map(async (source_segment) => {
        const hit = await fuzzy_search(
          index_name,
          source_lang,
          target_lang,
          source_segment
        );
        if (hit && hit._source?.translated_text) {
          return {
            segment: source_segment,
            translated_text: hit._source.translated_text,
            source_text: hit._source.source_text,
            similarity: hit.similarity,
            source: "CAT Tool",
          };
        } else {
          const translated_text = await chatgpt(
            source_lang,
            target_lang,
            source_segment
          );
          return {
            segment: source_segment,
            translated_text,
            similarity: 0,
            source: "ChatGPT",
          };
        }
      })
    );

    res.json({
      translated_text: results.map((r) => r.translated_text).join(" "),
      segments: results,
    });
  } catch (err) {
    handle_elastic_error(err, res);
  }
});

/**
 * @function handleElasticError
 * @param err - The error object
 * @param res - Express response object
 * @param customMsg - Optional custom message
 * Handles Elasticsearch errors and sends appropriate HTTP responses.
 */
function handle_elastic_error(
  err: any,
  res: Response,
  customMsg?: string
): void {
  console.error("Elasticsearch error:", err && err.name);
  if (err instanceof errors.ResponseError) {
    let details = err.message;
    if (err.body && typeof err.body === "object" && "error" in err.body) {
      details = (err.body as { error: string }).error;
    } else if (
      err.meta &&
      err.meta.body &&
      typeof err.meta.body === "object" &&
      "error" in err.meta.body
    ) {
      details = (err.meta.body as { error: string }).error;
    }
    res
      .status(err.statusCode || 500)
      .json({ error: customMsg || err.message, details });
  } else if (err instanceof errors.ConnectionError) {
    res.status(502).json({
      error: customMsg || "Elasticsearch connection error",
      details: err.message,
    });
  } else if (err instanceof errors.TimeoutError) {
    res.status(504).json({
      error: customMsg || "Elasticsearch timeout",
      details: err.message,
    });
  } else {
    res.status(500).json({
      error: customMsg || (err && (err as Error).message) || "Unknown error",
    });
  }
}

const PORT = 3050;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
