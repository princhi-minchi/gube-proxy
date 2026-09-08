# ConjuMate Backend / gube-proxy

**Backend API and conjugation-resolution engine for [ConjuMate](https://github.com/princhi-minchi/LangHover).**

`gube-proxy` is a Cloudflare Worker I built to power ConjuMate, a Chrome extension for understanding Italian while reading online.

The service does more than proxy translations: it takes a conjugated Italian verb found on a webpage, identifies possible infinitives, determines which grammatical form the user is most likely looking at, and returns the complete conjugation data needed by the extension.

**[ConjuMate frontend](https://github.com/princhi-minchi/LangHover)** · **[Chrome Web Store](https://chromewebstore.google.com/detail/conjumate-translator-and/lddadpilkaeiijmioafidgdngomiknmn)** · **[Demo + Pitch](https://www.youtube.com/watch?v=gRBc71vt0o0)**

---

## Why this exists

A normal dictionary lookup works well when the learner already knows the base form of a word.

That becomes less useful when someone encounters:

```text
avessero abbandonato
```

while reading Italian.

The learner shouldn't need to know that this relates to **abbandonare**, or which mood and tense it belongs to, before looking it up.

ConjuMate's backend therefore works in the opposite direction:

```text
conjugated form
      ↓
possible infinitives
      ↓
candidate conjugation tables
      ↓
context + form matching
      ↓
best grammatical match
```

The API returns both the verb and the specific form that most likely corresponds to the text the learner selected.

---

## What the backend does

### Conjugation resolution

Given selected text such as:

```json
{
  "selection": "avessero abbandonato",
  "selectionContext": "... che avessero abbandonato"
}
```

the backend:

1. Normalizes and tokenizes the selection.
2. Looks up tokens in a reverse conjugation index.
3. Retrieves possible infinitives.
4. Loads each candidate verb's full conjugation data.
5. Compares the selected text against hundreds of stored forms.
6. Scores the possible matches.
7. Returns the highest-scoring infinitive, grammatical form, and complete conjugation table.

---

## Reverse lookup architecture

The main verb database is naturally organised in the forward direction:

```text
infinitive → conjugation table
```

For example:

```text
abbandonare
    ↓
indicativo
congiuntivo
condizionale
...
```

But ConjuMate needs to start with an arbitrary form the user finds in a webpage.

So the backend also maintains a **reverse lookup index**:

```text
conjugated form → possible infinitives
```

For example, conceptually:

```text
abbandonato → [abbandonare]
```

Some forms are ambiguous and can therefore point to multiple candidate infinitives.

The reverse index is stored in **Cloudflare KV** and sharded using the first two characters of the normalized token.

Conceptually:

```text
it:rev:v2:norm:ab
```

contains reverse mappings for normalized forms beginning with `ab`.

This avoids loading a single enormous reverse dictionary for every request.

---

## Matching and scoring

Finding a possible infinitive is only the first step.

A conjugated form may be ambiguous, contain pronouns or auxiliary verbs, differ in accents, or depend on surrounding context. The backend therefore ranks candidate forms using a tiered scoring system.

### 1. Exact match

The selected text exactly matches the stored form.

```text
selection:   sono andato
stored form: sono andato
```

This receives the highest base score.

### 2. Context-aware match

The backend can use surrounding text to resolve forms whose stored representation includes grammatical context.

For Italian, one example is **che + verb** in subjunctive constructions.

```text
context: ... penso che sia ...
selection: sia
```

The surrounding `che` can strengthen the relevant candidate.

### 3. Lexical match

Conjugation data often contains subject pronouns:

```text
io parlo
```

while the webpage may simply contain:

```text
parlo
```

The matching engine strips known grammatical/noise tokens and compares the lexical component.

### 4. Accent-insensitive match

As a fallback, the engine removes combining accents and checks again.

This makes lookup more tolerant of differences between source text and the stored conjugation dataset.

---

## Lookup strategies

The reverse index supports multiple representations of the same form:

```text
surface
normalized
accentless
```

The API tries these strategies when searching for candidate verbs.

This helps handle differences in:

* capitalization
* Unicode normalization
* apostrophe characters
* whitespace
* accents

without forcing every request into a single lossy normalization strategy.

---

## Example response

A successful conjugation request returns information in this general shape:

```json
{
  "language": "it",
  "selection": "parlo",
  "chosenInfinitive": "parlare",
  "lookup": {
    "matchedToken": "parlo",
    "strategy": "normalized"
  },
  "initialMatch": {
    "moodKey": "indicativo",
    "moodLabel": "Indicativo",
    "tenseKey": "presente",
    "tenseLabel": "Presente",
    "formIndex": 0,
    "storedForm": "io parlo",
    "matchMode": "lexical_exact_match"
  },
  "alternatives": [],
  "entry": {
    "infinitive": "parlare",
    "groups": []
  }
}
```

The frontend uses `initialMatch` to automatically navigate to and highlight the grammatical form the learner encountered.

---

## API

### Conjugation lookup

```http
POST /api/:language/conjugation-lookup
```

Example:

```json
{
  "selection": "parlo",
  "selectionContext": "Quando sono a casa parlo italiano"
}
```

Italian (`it`) is currently configured for conjugation lookup.

---

### DeepL translation

```http
POST /api/deepl
```

The Worker acts as a server-side proxy so API credentials do not need to be exposed in the Chrome extension.

It accepts source and target language parameters and forwards the request to DeepL.

---

### Google translation

```http
POST /api/translate
```

A Google Translate proxy also remains in the codebase from an earlier version of ConjuMate. The current frontend primarily uses DeepL.

---

## Rate limiting

Requests are rate-limited using a dedicated Cloudflare KV namespace.

Current daily limits are:

| Endpoint           |                 Limit |
| ------------------ | --------------------: |
| Conjugation lookup |  75 requests/user/day |
| DeepL translation  | 100 requests/user/day |

A lightweight user identifier is supplied by the extension in the `x-user-id` header.

Counters expire at UTC midnight.

---

## Security

The Worker supports locking API access to a specific Chrome extension ID.

When `ALLOWED_EXTENSION_ID` is configured, requests with another browser origin are rejected.

Translation API credentials are stored as Worker secrets rather than shipped with the extension.

Input lengths are also bounded before upstream API requests or conjugation searches are performed.

---

## Tech stack

* **TypeScript**
* **Cloudflare Workers**
* **Hono**
* **Cloudflare KV**
* **Wrangler**
* **DeepL API**

The application is deliberately serverless. Both the API and the data required for conjugation lookup can be served close to the user without maintaining a traditional application server.

---

## Storage

Three Cloudflare KV bindings are used by the current application:

```text
VERB_DB
REVERSE_DB_V2
RATE_LIMIT_KV
```

### `VERB_DB`

Stores complete verb entries keyed by infinitive:

```text
verb:parlare
verb:essere
verb:avere
...
```

Each entry contains the available moods, tenses and conjugated forms.

### `REVERSE_DB_V2`

Maps conjugated forms back to candidate infinitives.

The data is sharded and stored in multiple normalization variants to make reverse lookup efficient and tolerant of input differences.

### `RATE_LIMIT_KV`

Stores per-user daily request counters.

---

## Running locally

### Install dependencies

```bash
npm install
```

### Configure secrets

At minimum, local development requires the relevant translation API credentials and Cloudflare KV bindings.

For example, a local `.dev.vars` can contain:

```text
DEEPL_API_KEY=...
GOOGLE_API_KEY=...
ALLOWED_EXTENSION_ID=...
```

Cloudflare KV bindings are configured through `wrangler.jsonc`.

### Start the Worker

```bash
npm run dev
```

Wrangler starts the local Cloudflare Worker development environment.

For development against remote KV data, Wrangler can also be run with the appropriate remote configuration.

---

## Deploying

```bash
npm run deploy
```

This runs:

```text
wrangler deploy --minify
```

and deploys the Worker to Cloudflare.

---

## Project structure

```text
gube-proxy/
│
├── src/
│   └── index.ts
│       ├── API routes
│       ├── normalization
│       ├── reverse lookup
│       ├── conjugation scoring
│       └── rate limiting
│
├── scripts/
│   └── reverse-index tooling
│
├── wrangler.jsonc
├── package.json
└── README.md
```

---

## Relationship to ConjuMate

This repository is the backend half of **[ConjuMate](https://github.com/princhi-minchi/LangHover)**.

I originally built ConjuMate while studying in Milan to make reading Italian online easier. The Chrome extension handles text selection and the user interface; this Worker handles translation, verb resolution and conjugation data.

ConjuMate was later selected for the **Tech Europe Foundation Ignition Program**, where I developed the idea further and eventually expanded the product thesis into **[PorpoiseRead](https://github.com/princhi-minchi/Read-With-Porpoise)**.

---

## Development approach

I built this system using AI coding tools extensively as part of my development workflow.

A particularly interesting problem was moving from a simple translation API toward a reverse grammatical lookup system: starting with an arbitrary inflected form from a webpage, efficiently narrowing it to candidate verbs, and then ranking the possible conjugations strongly enough for the extension to highlight the correct result.

This repository contains that backend implementation.
