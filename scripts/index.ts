import express, { Request, Response } from "express";
import { Client } from "@elastic/elasticsearch";
import tokenizer from "sbd";
import type { estypes } from "@elastic/elasticsearch";
import stringSimilarity from "string-similarity";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { unescape } from "he";
import dotenv from "dotenv";
dotenv.config({ quiet: true });

const ES_NODE = process.env.ES_NODE;
const ES_API_KEY = process.env.ES_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SIMILARITY_THRESHOLD = Number(process.env.SIMILARITY_THRESHOLD) || 80;
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
  serverMode: "serverless",
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
 * Splits source and translated texts into segments using sentence boundaries.
 * Returns mismatch flag if segment counts don't align.
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
    tokenizer_options,
  );
  const mismatch = source_segments.length !== translated_segments.length;

  return { source_segments, translated_segments, mismatch };
}

/**
 * @function split_segments_by_line
 * @param source_text - Source text to split by lines and segments
 * @returns Line-aware segmentation with flat segments for lookup
 * Preserves original line breaks while enabling segment-based lookup.
 */
function split_segments_by_line(source_text: string): {
  lines: string[];
  line_segments: string[][];
  flat_segments: string[];
} {
  const tokenizer_options: tokenizer.Options = {
    newline_boundaries: true,
    html_boundaries: true,
  };

  const lines = source_text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const line_segments: string[][] = new Array(lines.length);
  const flat_segments: string[] = [];

  lines.forEach((line, index) => {
    const segments = tokenizer.sentences(line, tokenizer_options);
    line_segments[index] = segments;
    flat_segments.push(...segments);
  });

  return { lines, line_segments, flat_segments };
}

/**
 * @function find_translation_segment
 * @param index_name - Name of the Elasticsearch index
 * @param source_lang - Source language
 * @param target_lang - Target language
 * @param segments - Array of source text segments
 * @returns Array of search hits or undefined
 * Finds exact translation segments in the Elasticsearch index using _msearch.
 */
async function find_translation_segment(
  index_name: string,
  source_lang: string,
  target_lang: string,
  segments: string[],
): Promise<(SearchHit | undefined)[]> {
  if (segments.length === 0) return [];

  // Build msearch request body
  const searches = segments.flatMap((segment) => [
    { index: index_name },
    {
      size: 1,
      query: {
        bool: {
          must: [
            { term: { source_lang } },
            { term: { target_lang } },
            { term: { "source_text.dedup": segment.toLowerCase() } },
          ],
        },
      },
    },
  ]);

  const msearch_result = await es_client.msearch<TranslationDocument>({
    searches,
  });

  // Process each response
  const results: (SearchHit | undefined)[] = [];

  for (let i = 0; i < segments.length; i++) {
    const response = msearch_result.responses[i];

    if (
      "error" in response ||
      !response.hits ||
      response.hits.hits.length === 0
    ) {
      results.push(undefined);
    } else {
      results.push(response.hits.hits[0]);
    }
  }

  return results;
}

/**
 * @function fuzzy_search
 * @param index_name - Name of the Elasticsearch index
 * @param source_lang - Source language
 * @param target_lang - Target language
 * @param segments - Array of source text segments
 * @returns Array of search hits with similarity scores or undefined
 * Finds the best fuzzy translation segments matching the similarity threshold using _msearch.
 */
async function fuzzy_search(
  index_name: string,
  source_lang: string,
  target_lang: string,
  segments: string[],
): Promise<((SearchHit & { similarity: number }) | undefined)[]> {
  if (segments.length === 0) return [];

  // Build msearch request body
  const searches = segments.flatMap((segment) => [
    { index: index_name },
    {
      size: 10,
      query: {
        bool: {
          must: [{ term: { source_lang } }, { term: { target_lang } }],
          should: [
            {
              match_phrase: {
                source_text: { query: segment, boost: 5 },
              },
            },
            {
              match: {
                source_text: {
                  query: segment,
                  operator: "and",
                  boost: 3,
                },
              },
            },
            {
              match: {
                source_text: {
                  query: segment,
                  fuzziness: "AUTO",
                  boost: 1,
                },
              },
            },
          ],
          minimum_should_match: 1,
        },
      },
    },
  ]);

  const msearch_result = await es_client.msearch<TranslationDocument>({
    searches,
  });

  // Process each response
  const results: ((SearchHit & { similarity: number }) | undefined)[] = [];

  for (let i = 0; i < segments.length; i++) {
    const response = msearch_result.responses[i];

    if (
      "error" in response ||
      !response.hits ||
      response.hits.hits.length === 0
    ) {
      results.push(undefined);
      continue;
    }

    const hits = response.hits.hits;
    const target_strings = hits
      .map((hit) => hit._source?.source_text?.toLowerCase())
      .filter((text): text is string => text !== undefined);

    if (target_strings.length === 0) {
      results.push(undefined);
      continue;
    }

    const best_match_result = stringSimilarity.findBestMatch(
      segments[i].toLowerCase(),
      target_strings,
    );

    const percentage = +(best_match_result.bestMatch.rating * 100).toFixed(2);

    if (percentage >= SIMILARITY_THRESHOLD) {
      const best_hit = hits[best_match_result.bestMatchIndex];
      results.push({ ...best_hit, similarity: percentage });
    } else {
      results.push(undefined);
    }
  }

  return results;
}

/**
 * @function create_segment_mismatch_report
 * @param source_segments - Array of source segments
 * @param translated_segments - Array of translated segments
 * @returns Detailed mismatch report for logging and response
 * Creates a paired mapping of source to translated segments for debugging mismatches.
 */
function create_segment_mismatch_report(
  source_segments: string[],
  translated_segments: string[],
): {
  source: string;
  translated: string;
}[] {
  const max_length = Math.max(
    source_segments.length,
    translated_segments.length,
  );
  const segments = Array.from({ length: max_length }, (_, i) => ({
    source: source_segments[i] ?? null,
    translated: translated_segments[i] ?? null,
  }));

  return segments;
}

/**
 * @function fully_unescape
 * @param text - Text to fully unescape
 * @returns Fully unescaped text
 * Repeatedly unescapes HTML entities until no changes occur.
 */
function fully_unescape(text: string): string {
  let prev: string;
  do {
    prev = text;
    text = unescape(text);
  } while (text !== prev);
  return text;
}

/**
 * @function top_search
 * @param index_name - Name of the Elasticsearch index
 * @param source_lang - Source language
 * @param target_lang - Target language
 * @param source_text - Source text segment
 * @returns Search hit or undefined
 * Finds the best fuzzy translation segment in the Elasticsearch index with >=80% match accuracy.
 */
async function top_search(
  index_name: string,
  source_lang: string,
  target_lang: string,
  source_text: string,
): Promise<SearchHit[]> {
  const search_result = await es_client.search<TranslationDocument>({
    index: index_name,
    size: 10,
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
  const hits = search_result.hits.hits;
  return hits;
}

/**
 * @function chatgpt
 * @param source_lang - Source language
 * @param target_lang - Target language
 * @param segments - Array of source text segments
 * @returns Array of translation objects
 * Uses OpenAI's model to translate text segments in batches.
 */
async function chatgpt(
  source_lang: string,
  target_lang: string,
  segments: string[],
): Promise<
  {
    id: number;
    source: string;
    translation: string;
  }[]
> {
  const BATCH_SIZE = 100; // Limit batch size to prevent token overflow
  const allTranslations: {
    id: number;
    source: string;
    translation: string;
  }[] = [];

  const TranslationsList = z.object({
    translations: z.array(
      z.object({
        id: z.number(),
        source: z.string(),
        translation: z.string(),
      }),
    ),
  });

  // Process in batches
  for (let i = 0; i < segments.length; i += BATCH_SIZE) {
    const batch = segments.slice(i, i + BATCH_SIZE);

    // Format segments with indices for better tracking
    const segmentsWithIds = batch.map((seg, idx) => ({
      id: i + idx,
      source: seg,
    }));

    const response = await openai.responses.parse({
      model: "gpt-5.2",
      input: [
        {
          role: "developer",
          content: [
            {
              type: "input_text",
              text: `You are a professional native ${target_lang} translator.\n\nYour task is to translate MULTIPLE text segments from ${source_lang} to ${target_lang}.\n\nYou must follow ALL rules below EXACTLY.\n\nTRANSLATION RULES (apply to every segment individually):\n\n1. Meaning Preservation\n   - Preserve every meaning with full precision.\n   - Do NOT add, omit, generalize, infer, clarify, emphasize, or invent anything.\n\n2. Punctuation & Symbols Fidelity\n   - Do NOT introduce punctuation, quotation marks, symbols, or formatting that do not exist in the ${source_lang} text.\n   - If the ${source_lang} text uses "double quotes", the ${target_lang} translation MUST also use "double quotes".\n   - Do NOT replace quotes with language-specific variants.\n   - Do NOT add emphasis marks, dashes, colons, or parentheses unless they exist in the ${source_lang} text.\n\n3. Code & Markup Preservation (VERBATIM)\n   - ALL code elements MUST be preserved character-for-character.\n   - NEVER translate, reformat, explain, or normalize code.\n   - If a segment contains only code or markup, return it EXACTLY as-is.\n   - If a segment contains both code and natural language, translate ONLY the natural language.\n\n4. Output Discipline\n   - NEVER explain anything.\n   - NEVER add comments.\n   - NEVER add meta-text.\n   - Output ONLY valid JSON.\n\nOUTPUT FORMAT REQUIREMENT:\n\nYou MUST return a JSON object with this exact structure:\n\n{\n  "translations": [\n    {\n      "id": number,\n      "source": string,\n      "translation": string\n    }\n  ]\n}\n\n- The order of items must match the input order exactly.\n- Each id must be copied exactly from input.\n- Each source must be copied exactly from input.\n- Each translation must obey all rules above\n`,
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify(segmentsWithIds),
            },
          ],
        },
      ],
      text: {
        format: zodTextFormat(TranslationsList, "translations_list"),
      },
      store: false,
      max_output_tokens: 25000,
    });

    const batchTranslations = response.output_parsed!.translations;
    allTranslations.push(...batchTranslations);
  }

  return allTranslations;
}

// Health check for Elasticsearch connection
app.get("/es-health", async (req: Request, res: Response): Promise<void> => {
  try {
    await es_client.ping();
    res.json({ status: "Elasticsearch connection OK" });
  } catch (err: unknown) {
    throw new Error(err instanceof Error ? err.message : "Unknown error");
  }
});

// Save a translation to the database (segment-based)
app.post(
  "/save-translation",
  async (req: Request, res: Response): Promise<void> => {
    try {
      let { source_lang, target_lang, source_text, translated_text } =
        req.body as TranslationDocument;

      if (!source_lang || !target_lang || !source_text || !translated_text) {
        res.status(400).json({ error: "All fields are required" });
        return;
      }

      source_lang = source_lang.toLowerCase().trim().replace(/\s+/g, "-");
      target_lang = target_lang.toLowerCase().trim().replace(/\s+/g, "-");
      source_text = fully_unescape(source_text);
      translated_text = fully_unescape(translated_text);

      const { source_segments, translated_segments, mismatch } = split_segments(
        source_text,
        translated_text,
      );

      if (mismatch) {
        res.status(400).json({
          error: "Segment count mismatch",
          details: `${source_lang}(${
            source_segments.length
          }) and ${target_lang}(${
            translated_segments!.length
          }) segments mismatch.`,
          source_lang,
          target_lang,
          segments: create_segment_mismatch_report(
            source_segments,
            translated_segments!,
          ),
        });
        return;
      }

      const index_name = `${source_lang}-${target_lang}`;
      await ensure_translations_index(index_name);

      // Use batch search for better performance
      const hits = await find_translation_segment(
        index_name,
        source_lang,
        target_lang,
        source_segments,
      );

      const bulkBody: object[] = [];
      const results: {
        segment: string;
        id: string | null | undefined;
        action: "inserted" | "updated";
      }[] = [];
      const cache = new Map<
        string,
        { id: string | null; action: "inserted" | "updated" }
      >();

      for (let i = 0; i < source_segments.length; i++) {
        const seg = source_segments[i];
        const key = seg.toLowerCase().trim();
        const hit = hits[i];

        if (cache.has(key)) {
          const { id, action } = cache.get(key)!;
          results.push({ segment: seg, id, action });
        } else if (hit) {
          bulkBody.push(
            { update: { _index: index_name, _id: hit._id } },
            { doc: { translated_text: translated_segments![i] } },
          );
          const entry = { id: hit._id ?? null, action: "updated" as const };
          results.push({ segment: seg, ...entry });
          cache.set(key, entry);
        } else {
          bulkBody.push(
            { index: { _index: index_name } },
            {
              source_lang,
              target_lang,
              source_text: seg,
              translated_text: translated_segments![i],
            },
          );
          const entry = { id: null, action: "inserted" as const };
          results.push({ segment: seg, ...entry });
          cache.set(key, entry);
        }
      }

      if (bulkBody.length > 0) {
        const { items } = await es_client.bulk({
          refresh: "wait_for",
          body: bulkBody,
        });

        if (items) {
          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.index?._id) {
              const resultIdx = results.findIndex(
                (r) => r.action === "inserted" && r.id === null,
              );
              if (resultIdx !== -1) results[resultIdx].id = item.index._id;
            }
          }
        }
      }

      res.json({ segments: results });
    } catch (err) {
      console.error("[/save-translation] Error:", {
        error: err instanceof Error ? err.message : "Unknown error",
        source_lang: req.body.source_lang,
        target_lang: req.body.target_lang,
      });
      res.status(500).json({
        error: "Failed to save translation",
        details: err instanceof Error ? err.message : "Unknown error",
      });
      return;
    }
  },
);

// Fetch translation (segment-based, always fuzzy search, do not store)
app.post("/translate", async (req: Request, res: Response): Promise<void> => {
  try {
    let { source_lang, target_lang, source_text } =
      req.body as TranslationDocument;

    if (!source_lang || !target_lang || !source_text) {
      res.status(400).json({ error: "All fields are required" });
      return;
    }

    source_lang = source_lang.toLowerCase().trim().replace(/\s+/g, "-");
    target_lang = target_lang.toLowerCase().trim().replace(/\s+/g, "-");
    source_text = fully_unescape(source_text);

    const index_name = `${source_lang}-${target_lang}`;
    await ensure_translations_index(index_name);
    const { lines, line_segments, flat_segments } =
      split_segments_by_line(source_text);

    // Build deduplication keys and unique segment list
    const seen_keys = new Set<string>();
    const unique_keys: string[] = [];
    const unique_segments: string[] = [];

    for (let i = 0; i < flat_segments.length; i++) {
      const key = flat_segments[i].toLowerCase();
      if (!seen_keys.has(key)) {
        seen_keys.add(key);
        unique_keys.push(key);
        unique_segments.push(flat_segments[i]);
      }
    }

    // Batch fuzzy search using _msearch API
    const fuzzyResults = await fuzzy_search(
      index_name,
      source_lang,
      target_lang,
      unique_segments,
    );

    // Build result maps and collect missing segments
    const fuzzyResultMap = new Map<
      string,
      SearchHit & { similarity: number }
    >();
    const missingSegments: string[] = [];

    for (let i = 0; i < unique_keys.length; i++) {
      const key = unique_keys[i];
      if (fuzzyResults[i]) {
        fuzzyResultMap.set(key, fuzzyResults[i]!);
      } else {
        missingSegments.push(unique_segments[i]);
      }
    }

    // Batch ChatGPT translation for missing segments
    const chatgptResultMap = new Map<string, string>();
    if (missingSegments.length > 0) {
      const translations = await chatgpt(
        source_lang,
        target_lang,
        missingSegments,
      );
      for (const t of translations) {
        chatgptResultMap.set(t.source.toLowerCase(), t.translation);
      }
    }

    // Build final results maintaining original order
    const results = new Array(flat_segments.length);
    for (let i = 0; i < flat_segments.length; i++) {
      const segment_key = flat_segments[i].toLowerCase();
      const fuzzyHit = fuzzyResultMap.get(segment_key);

      results[i] = fuzzyHit?._source?.translated_text
        ? {
            line_segment: flat_segments[i],
            translated_text: fuzzyHit._source.translated_text,
            source_text: fuzzyHit._source.source_text,
            similarity: fuzzyHit.similarity,
            source: "CAT Tool",
            id: fuzzyHit._id,
          }
        : {
            line_segment: flat_segments[i],
            translated_text:
              chatgptResultMap.get(segment_key) || flat_segments[i],
            similarity: 0,
            source: "ChatGPT",
            id: null,
          };
    }

    let resultIndex = 0;
    const segments_by_line: {
      source_segment: string;
      translated_text: string;
      line_segments: (typeof results)[number][];
    }[] = [];
    const translated_lines = new Array(line_segments.length);

    for (let i = 0; i < line_segments.length; i++) {
      const segments = line_segments[i];
      if (segments.length === 0) {
        translated_lines[i] = "";
        continue;
      }

      const lineResults = new Array(segments.length);
      for (let j = 0; j < segments.length; j++) {
        lineResults[j] = results[resultIndex];
        resultIndex += 1;
      }

      const translated_text = lineResults
        .map((result) => result?.translated_text ?? "")
        .join(" ");

      translated_lines[i] = translated_text;
      segments_by_line.push({
        source_segment: lines[i] ?? "",
        translated_text,
        line_segments: lineResults,
      });
    }

    res.json({
      translated_text: translated_lines.join("\n"),
      segments: segments_by_line,
    });
  } catch (err) {
    console.error("[/translate] Error:", {
      error: err instanceof Error ? err.message : "Unknown error",
      request: req.body,
    });
    res.status(500).json({
      error: "Translation failed",
      details: err instanceof Error ? err.message : "Unknown error",
    });
    return;
  }
});

// Fetch translations (segment-based, always fuzzy search, do not store)
app.post("/find", async (req: Request, res: Response): Promise<void> => {
  try {
    let { source_lang, target_lang, source_text } =
      req.body as TranslationDocument;

    if (!source_lang || !target_lang || !source_text) {
      res.status(400).json({ error: "All fields are required" });
      return;
    }

    source_lang = source_lang?.toLowerCase().trim().replace(/\s+/g, "-");
    target_lang = target_lang?.toLowerCase().trim().replace(/\s+/g, "-");
    source_text = fully_unescape(source_text);

    const index_name = `${source_lang}-${target_lang}`;
    const hits = await top_search(
      index_name,
      source_lang,
      target_lang,
      source_text,
    );

    res.json(hits);
  } catch (err) {
    console.error("[/find] Error:", {
      error: err instanceof Error ? err.message : "Unknown error",
      request: req.body,
    });
    res.status(500).json({
      error: "Search failed",
      details: err instanceof Error ? err.message : "Unknown error",
    });
    return;
  }
});

// Delete a document in TM by id
app.delete("/delete", async (req: Request, res: Response): Promise<void> => {
  try {
    let { source_lang, target_lang, id } = req.body as {
      source_lang: string;
      target_lang: string;
      id: string;
    };

    if (!source_lang || !target_lang || !id) {
      res
        .status(400)
        .json({ error: "source_lang, target_lang and id are required" });
      return;
    }

    source_lang = source_lang?.toLowerCase().trim().replace(/\s+/g, "-");
    target_lang = target_lang?.toLowerCase().trim().replace(/\s+/g, "-");

    const index_name = `${source_lang}-${target_lang}`;
    await ensure_translations_index(index_name);
    const result = await es_client.delete({ index: index_name, id });
    res.json({ success: true, result });
  } catch (err) {
    console.error("[/delete] Error:", {
      error: err instanceof Error ? err.message : "Unknown error",
      request: req.body,
    });
    res.status(500).json({
      error: "Delete failed",
      details: err instanceof Error ? err.message : "Unknown error",
    });
    return;
  }
});

const PORT = 3050;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
