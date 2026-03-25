import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_NAMESPACE_TITLE = "REVERSE_DB_V2";
const DEFAULT_PREFIX = "it:rev:v2:norm:";
const DEFAULT_PREFIX_LENGTH = 2;
const MAX_KV_VALUE_BYTES = 25 * 1024 * 1024;
const DEFAULT_CONCURRENCY = 4;

function parseArgs(argv) {
  const args = {
    file: process.env.SOURCE_JSON_PATH ?? "",
    namespaceId: process.env.CLOUDFLARE_KV_NAMESPACE_ID ?? "",
    namespaceTitle:
      process.env.CLOUDFLARE_KV_NAMESPACE_TITLE ?? DEFAULT_NAMESPACE_TITLE,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
    apiToken: process.env.CLOUDFLARE_API_TOKEN ?? "",
    prefix: process.env.KV_KEY_PREFIX ?? DEFAULT_PREFIX,
    prefixLength: Number.parseInt(
      process.env.PREFIX_LENGTH ?? String(DEFAULT_PREFIX_LENGTH),
      10,
    ),
    concurrency: Number.parseInt(
      process.env.UPLOAD_CONCURRENCY ?? String(DEFAULT_CONCURRENCY),
      10,
    ),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--file" && next) {
      args.file = next;
      i += 1;
    } else if (arg === "--namespace-id" && next) {
      args.namespaceId = next;
      i += 1;
    } else if (arg === "--namespace-title" && next) {
      args.namespaceTitle = next;
      i += 1;
    } else if (arg === "--account-id" && next) {
      args.accountId = next;
      i += 1;
    } else if (arg === "--api-token" && next) {
      args.apiToken = next;
      i += 1;
    } else if (arg === "--key-prefix" && next) {
      args.prefix = next;
      i += 1;
    } else if (arg === "--prefix-length" && next) {
      args.prefixLength = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === "--concurrency" && next) {
      args.concurrency = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/upload-reverse-kv.mjs --file "C:\\path\\italian_reverse_lookup_product_normalized.json"

Required:
  --file              Path to the source JSON file
  --account-id        Cloudflare account ID (or set CLOUDFLARE_ACCOUNT_ID)
  --api-token         Cloudflare API token (or set CLOUDFLARE_API_TOKEN)

Namespace selection:
  --namespace-id      KV namespace ID
  --namespace-title   Namespace title to look up by name (default: ${DEFAULT_NAMESPACE_TITLE})

Optional:
  --key-prefix        KV key prefix (default: ${DEFAULT_PREFIX})
  --prefix-length     Number of starting characters per shard (default: ${DEFAULT_PREFIX_LENGTH})
  --concurrency       Parallel upload count (default: ${DEFAULT_CONCURRENCY})
`);
}

function requireArg(value, name) {
  if (!value) {
    throw new Error(`Missing required value: ${name}`);
  }
}

function normalizeShardPrefix(word, prefixLength) {
  const normalized = String(word).trim().toLowerCase();
  if (!normalized) {
    return "_";
  }

  return normalized.slice(0, prefixLength) || "_";
}

function chunkEntries(entries, prefixLength) {
  const shards = new Map();

  for (const [key, value] of entries) {
    const shardPrefix = normalizeShardPrefix(key, prefixLength);
    if (!shards.has(shardPrefix)) {
      shards.set(shardPrefix, {});
    }

    shards.get(shardPrefix)[key] = value;
  }

  return shards;
}

async function cfFetch(url, init, apiToken) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      ...(init?.headers ?? {}),
    },
  });

  const json = await response.json();
  if (!response.ok || json.success === false) {
    const errors = Array.isArray(json.errors)
      ? json.errors.map((item) => item.message).join("; ")
      : response.statusText;
    throw new Error(`Cloudflare API error: ${errors}`);
  }

  return json;
}

async function findNamespaceId({ accountId, apiToken, namespaceTitle }) {
  let page = 1;

  while (true) {
    const url =
      `https://api.cloudflare.com/client/v4/accounts/${accountId}` +
      `/storage/kv/namespaces?page=${page}&per_page=100`;
    const json = await cfFetch(url, { method: "GET" }, apiToken);
    const match = json.result.find((item) => item.title === namespaceTitle);

    if (match) {
      return match.id;
    }

    const totalPages = json.result_info?.total_pages ?? 1;
    if (page >= totalPages) {
      break;
    }

    page += 1;
  }

  throw new Error(`KV namespace "${namespaceTitle}" was not found.`);
}

async function uploadShard({
  accountId,
  apiToken,
  namespaceId,
  key,
  value,
}) {
  const url =
    `https://api.cloudflare.com/client/v4/accounts/${accountId}` +
    `/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`;

  await cfFetch(
    url,
    {
      method: "PUT",
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
      },
      body: value,
    },
    apiToken,
  );
}

async function runWithConcurrency(items, limit, worker) {
  let index = 0;

  async function next() {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      await worker(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () =>
    next(),
  );
  await Promise.all(workers);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  requireArg(args.file, "--file or SOURCE_JSON_PATH");
  requireArg(args.accountId, "--account-id or CLOUDFLARE_ACCOUNT_ID");
  requireArg(args.apiToken, "--api-token or CLOUDFLARE_API_TOKEN");

  if (!Number.isInteger(args.prefixLength) || args.prefixLength < 1) {
    throw new Error("prefix length must be a positive integer");
  }

  if (!Number.isInteger(args.concurrency) || args.concurrency < 1) {
    throw new Error("concurrency must be a positive integer");
  }

  const resolvedFile = path.resolve(args.file);
  console.log(`Reading ${resolvedFile} ...`);
  const raw = await fs.readFile(resolvedFile, "utf8");
  const parsed = JSON.parse(raw);

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Source JSON must be a single object mapping words to arrays.");
  }

  const entries = Object.entries(parsed);
  console.log(`Loaded ${entries.length} entries.`);

  const shards = chunkEntries(entries, args.prefixLength);
  const shardList = Array.from(shards.entries())
    .map(([suffix, shardObject]) => {
      const value = JSON.stringify(shardObject);
      const bytes = Buffer.byteLength(value);
      return {
        suffix,
        key: `${args.prefix}${suffix}`,
        value,
        bytes,
        count: Object.keys(shardObject).length,
      };
    })
    .sort((a, b) => a.suffix.localeCompare(b.suffix));

  const oversized = shardList.filter((item) => item.bytes > MAX_KV_VALUE_BYTES);
  if (oversized.length > 0) {
    const details = oversized
      .map(
        (item) =>
          `${item.key} (${(item.bytes / 1024 / 1024).toFixed(2)} MiB, ${item.count} entries)`,
      )
      .join(", ");
    throw new Error(
      `One or more shards exceed Cloudflare KV's 25 MiB value limit: ${details}. ` +
        `Re-run with a larger --prefix-length such as 3.`,
    );
  }

  const namespaceId =
    args.namespaceId ||
    (await findNamespaceId({
      accountId: args.accountId,
      apiToken: args.apiToken,
      namespaceTitle: args.namespaceTitle,
    }));

  console.log(`Uploading ${shardList.length} shards to namespace ${namespaceId} ...`);

  let uploaded = 0;
  await runWithConcurrency(shardList, args.concurrency, async (shard) => {
    await uploadShard({
      accountId: args.accountId,
      apiToken: args.apiToken,
      namespaceId,
      key: shard.key,
      value: shard.value,
    });

    uploaded += 1;
    console.log(
      `[${uploaded}/${shardList.length}] ${shard.key} (${shard.count} entries, ${(shard.bytes / 1024).toFixed(1)} KiB)`,
    );
  });

  console.log("Upload complete.");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
