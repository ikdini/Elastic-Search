import { google } from "googleapis";
import path from "path";
import fs from "fs";
import { Client } from "@elastic/elasticsearch";
import tokenizer from "sbd";
import dotenv from "dotenv";
dotenv.config({ quiet: true });

const ES_NODE = process.env.ES_NODE;
const ES_API_KEY = process.env.ES_API_KEY;
const SERVICE_ACCOUNT_FILE = process.env.SERVICE_ACCOUNT_FILE;
if (!ES_NODE || !ES_API_KEY || !SERVICE_ACCOUNT_FILE) {
  console.error("Missing required env variable(s).");
  process.exit(1);
}

// Path to your service account key file
const service_account_file = path.join(__dirname, SERVICE_ACCOUNT_FILE);

// Load credentials from the service account file
const credentials = JSON.parse(fs.readFileSync(service_account_file, "utf8"));

// Folder ID to list files from
const folder_id = "1PQqnYZKu5WAChw1D4IVPiO60NSfr6Orf"; //TODO: Change to your folder ID
const target_language = "traditional-chinese".toLowerCase(); //TODO: Change target language

const non_segment_languages = [
  "arabic",
  "japanese",
  "korean",
  "simplified-chinese",
  "traditional-chinese",
];

const es_client = new Client({
  node: ES_NODE,
  auth: {
    apiKey: ES_API_KEY,
  },
});

// Ensure translations index exists with mapping
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

// Split segments using sbd
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

// Normalize text (remove HTML, emojis, trim)
function normalize_text(str: string): string {
  return str
    .replace(/<[^>]*>/g, "")
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "")
    .trim();
}

async function listFilesInFolder() {
  // Authenticate with service account using JWT constructor (recommended)
  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
  const drive = google.drive({ version: "v3", auth });
  const sheets = google.sheets({ version: "v4", auth });

  try {
    const res = await drive.files.list({
      q: `'${folder_id}' in parents and trashed = false and mimeType = 'application/vnd.google-apps.spreadsheet'`,
      fields: "files(id, name, mimeType)",
    });
    const files = res.data.files;
    if (!files || files.length === 0) {
      console.log("No spreadsheet files found.");
      return;
    }
    // Process all spreadsheet files in the folder
    console.log(`Total Files: ${files.length}`);
    for (const file of files) {
      const name = file.name ?? "(no name)";
      const id = file.id ?? "(no id)";
      if (!file.id) {
        console.log(`${name} (${id}): No file id.`);
        continue;
      }
      try {
        const meta = await sheets.spreadsheets.get({ spreadsheetId: file.id });
        const sheet = meta.data.sheets?.[0];
        const sheetName = sheet?.properties?.title;
        if (!sheetName) {
          console.log(
            `${name} (${id}): Could not determine the first sheet's name.`
          );
          continue;
        }
        const valuesRes = await sheets.spreadsheets.values.get({
          spreadsheetId: file.id,
          range: `${sheetName}`,
        });
        const rows = valuesRes.data.values || [];
        console.log(
          `${name} (${id}): First sheet name: ${sheetName}, Total rows: ${rows.length}`
        );

        // Prepare all segments for this file
        const index_name = `translations(${target_language})`;
        await ensure_translations_index(index_name);

        const segmentMap = new Map(); // key: source_segment, value: translated_segment
        for (let i = 1; i < rows.length; i++) {
          const row = rows[i];
          const source_text = normalize_text(row[0] ?? "");
          const translated_text = normalize_text(row[1] ?? "");
          if (!source_text || !translated_text) continue;

          let source_segments = [source_text];
          let translated_segments = [translated_text];
          if (!non_segment_languages.includes(target_language)) {
            const segmentResult = split_segments(source_text, translated_text);
            source_segments = segmentResult.source_segments;
            translated_segments = segmentResult.translated_segments!;
          }

          for (let j = 0; j < source_segments.length; j++) {
            segmentMap.set(source_segments[j], translated_segments[j]);
          }
        }
        // Batch search for all segments in this file
        const allSourceSegments = Array.from(segmentMap.keys());
        let existingHits: Record<string, any> = {};
        if (allSourceSegments.length > 0) {
          const msearchBody = allSourceSegments.flatMap((seg) => [
            { index: index_name },
            {
              size: 1,
              query: {
                bool: {
                  must: [
                    { term: { source_lang: "english" } },
                    { term: { target_lang: target_language } },
                    { term: { "source_text.dedup": seg.toLowerCase() } },
                  ],
                },
              },
            },
          ]);
          const msearchRes = await es_client.msearch({ body: msearchBody });
          msearchRes.responses.forEach((resp: any, idx: number) => {
            if (resp.hits && resp.hits.hits && resp.hits.hits[0]) {
              existingHits[allSourceSegments[idx]] = resp.hits.hits[0];
            }
          });
        }
        // Build bulk body
        const bulkBody: object[] = [];
        for (const [
          source_segment,
          translated_segment,
        ] of segmentMap.entries()) {
          const hit = existingHits[source_segment];
          if (hit) {
            bulkBody.push({ update: { _index: index_name, _id: hit._id } });
            bulkBody.push({ doc: { translated_text: translated_segment } });
          } else {
            bulkBody.push({ index: { _index: index_name } });
            bulkBody.push({
              source_lang: "english",
              target_lang: target_language,
              source_text: source_segment,
              translated_text: translated_segment,
            });
          }
        }
        if (bulkBody.length > 0) {
          const bulkResponse = await es_client.bulk({
            refresh: "wait_for",
            body: bulkBody,
          });
          if (bulkResponse.errors) {
            console.error(
              `${name} (${id}): Bulk insert/update had errors`,
              bulkResponse
            );
          } else {
            console.log(
              `${name} (${id}): Bulk upserted ${
                bulkBody.length / 2
              } segments into TM.`
            );
          }
        } else {
          console.log(`${name} (${id}): No valid rows to insert/update.`);
        }
      } catch (err) {
        console.error(
          `${name} (${id}): Failed to read spreadsheet or insert:`,
          err
        );
      }
    }
  } catch (err) {
    console.error("The API returned an error:", err);
  }
}

// Run the function if this file is executed directly
if (require.main === module) {
  listFilesInFolder();
}
