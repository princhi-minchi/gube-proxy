import { Hono } from 'hono'
import { cors } from 'hono/cors'

type Bindings = {
    VERB_DB: KVNamespace
    REVERSE_DB_V2: KVNamespace
    GOOGLE_API_KEY: string
    DEEPL_API_KEY: string
    ADMIN_TOKEN: string
    ALLOWED_EXTENSION_ID?: string
    [key: string]: KVNamespace | string | undefined // For dynamic DB access
}

type ResponseTense = {
    tenseKey: string
    tenseLabel: string
    forms: string[]
}

type ResponseGroup = {
    moodKey: string
    moodLabel: string
    tenses: ResponseTense[]
}

type ConjugationLookupResponse = {
    language: string
    selection: string
    chosenInfinitive: string | null
    lookup: {
        matchedToken: string
        strategy: 'surface' | 'normalized' | 'accentless'
    }
    initialMatch: {
        moodKey: string
        moodLabel: string
        tenseKey: string
        tenseLabel: string
        formIndex: number
        storedForm: string
        matchMode: string
    } | null
    alternatives: Array<{
        infinitive: string
        initialMatch: ConjugationLookupResponse['initialMatch']
    }>
    entry: {
        infinitive: string
        groups: ResponseGroup[]
        definition?: string
    } | null
}

type MatchRecord = {
    infinitive: string
    score: number
    matchMode: string
    moodKey: string
    moodLabel: string
    tenseKey: string
    tenseLabel: string
    formIndex: number
    storedForm: string
    groups: ResponseGroup[]
    definition?: string
}

type LookupStrategy = {
    name: 'surface' | 'normalized' | 'accentless'
    prefix: string
    transform: (token: string) => string
}

type ReverseShard = Record<string, string[]>

type PreparedSelection = {
    normalized: string
    accentless: string
    variants: Set<string>
    accentlessVariants: Set<string>
    contextSuggestsChe: boolean
}

interface LanguageConfig {
    languageCode: string
    noiseTokens: Set<string>
    moodOrder: ReadonlyArray<{
        moodKey: string
        moodLabel: string
        tenses: ReadonlyArray<[string, string]>
    }>
    lookupStrategies: LookupStrategy[]
}

const ITALIAN_CONFIG: LanguageConfig = {
    languageCode: 'it',
    noiseTokens: new Set(['io', 'tu', 'lui', 'lei', 'noi', 'voi', 'loro', 'che', 'mi', 'ti', 'si', 'ci', 'vi']),
    moodOrder: [
        {
            moodKey: 'indicativo',
            moodLabel: 'Indicativo',
            tenses: [
                ['presente', 'Presente'],
                ['imperfetto', 'Imperfetto'],
                ['passato_remoto', 'Passato remoto'],
                ['futuro', 'Futuro'],
                ['passato_prossimo', 'Passato prossimo'],
                ['trapassato_prossimo', 'Trapassato prossimo'],
                ['trapassato_remoto', 'Trapassato remoto'],
                ['futuro_anteriore', 'Futuro anteriore']
            ]
        },
        {
            moodKey: 'congiuntivo',
            moodLabel: 'Congiuntivo',
            tenses: [
                ['presente', 'Presente'],
                ['passato', 'Passato'],
                ['imperfetto', 'Imperfetto'],
                ['trapassato', 'Trapassato']
            ]
        },
        {
            moodKey: 'condizionale',
            moodLabel: 'Condizionale',
            tenses: [
                ['presente', 'Presente'],
                ['passato', 'Passato']
            ]
        },
        {
            moodKey: 'imperativo',
            moodLabel: 'Imperativo',
            tenses: [
                ['presente', 'Presente']
            ]
        },
        {
            moodKey: 'forme_non_finite',
            moodLabel: 'Forme non finite',
            tenses: [
                ['gerundio', 'Gerundio'],
                ['infinito_presente', 'Infinito presente'],
                ['participio', 'Participio']
            ]
        }
    ],
    lookupStrategies: [
        {
            name: 'surface',
            prefix: 'it:rev:v2:surface:',
            transform: (token) => normalizeSurfaceText(token)
        },
        {
            name: 'normalized',
            prefix: 'it:rev:v2:norm:',
            transform: (token) => normalizeText(token)
        },
        {
            name: 'accentless',
            prefix: 'it:rev:v2:accentless:',
            transform: (token) => normalizeAccentlessText(token)
        }
    ]
}

const LANGUAGE_REGISTRY: Record<string, LanguageConfig> = {
    'it': ITALIAN_CONFIG,
    'italian': ITALIAN_CONFIG
}

const app = new Hono<{ Bindings: Bindings }>()

// 1. Security: CORS & Origin Lockdown
app.use('/*', async (c, next) => {
    const allowedId = c.env.ALLOWED_EXTENSION_ID
    const origin = c.req.header('Origin')
    
    let targetOrigin = '*'
    if (allowedId) {
        if (origin === `chrome-extension://${allowedId}`) {
            targetOrigin = origin
        } else if (origin) {
            return c.json({ error: 'Unauthorized origin' }, 403)
        }
    }

    const corsMiddleware = cors({
        origin: targetOrigin,
        allowMethods: ['POST', 'GET', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'x-user-id'],
        maxAge: 86400,
    })
    
    return corsMiddleware(c, next)
})

function normalizeApostrophes(value: string) {
    return value.replace(/[\u2018\u2019\u0060\u00B4]/g, "'")
}

function normalizeText(value: string) {
    return normalizeApostrophes(value)
        .toLowerCase()
        .normalize('NFC')
        .replace(/\s+/g, ' ')
        .trim()
}

function normalizeSurfaceText(value: string) {
    return normalizeApostrophes(value)
        .replace(/\s+/g, ' ')
        .trim()
}

function normalizeAccentlessText(value: string) {
    return normalizeText(value)
        .normalize('NFD')
        .replace(/\p{M}+/gu, '')
        .normalize('NFC')
}

function normalizeKey(value: string) {
    return normalizeText(value)
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, '_')
        .trim()
}

function extractTokens(value: string) {
    const normalized = normalizeText(value)
    const matches = normalized.match(/[\p{L}\p{N}']+/gu)
    if (!matches) {
        return []
    }

    return matches
        .map((token) => token.replace(/^'+|'+$/g, ''))
        .filter(Boolean)
}

function getShardSuffix(token: string) {
    const normalized = normalizeText(token)
    return normalized.slice(0, 2) || '_'
}

function getStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return []
    }

    return value.filter((item): item is string => typeof item === 'string')
}

function getObjectRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null
    }

    return value as Record<string, unknown>
}

function getNestedRecord(source: Record<string, unknown>, ...keys: string[]) {
    for (const key of keys) {
        const match = Object.entries(source).find(([candidate]) => normalizeKey(candidate) === normalizeKey(key))
        if (match) {
            return getObjectRecord(match[1])
        }
    }

    return null
}

function getFormsFromTenseValue(value: unknown): string[] {
    if (typeof value === 'string' && value.trim().length > 0) {
        return [value]
    }

    if (Array.isArray(value)) {
        return getStringArray(value)
    }

    const record = getObjectRecord(value)
    if (!record) {
        return []
    }

    if (Array.isArray(record.forms)) {
        return getStringArray(record.forms)
    }

    if (typeof record.forms === 'string' && record.forms.trim().length > 0) {
        return [record.forms]
    }

    if (typeof record.form === 'string' && record.form.trim().length > 0) {
        return [record.form]
    }

    return []
}

function findValueByNormalizedKey(source: Record<string, unknown>, targetKey: string) {
    const normalizedTarget = normalizeKey(targetKey)
    const match = Object.entries(source).find(([key]) => normalizeKey(key) === normalizedTarget)
    return match?.[1]
}

function extractInfinitive(rawEntry: Record<string, unknown>) {
    const candidates = [rawEntry.infinitive, rawEntry.lemma, rawEntry.verb]
    const stringValue = candidates.find((item): item is string => typeof item === 'string' && item.trim().length > 0)
    return stringValue ?? null
}

function getNonFiniteFormsGroup(rawEntry: Record<string, unknown>): ResponseGroup | null {
    const nonFiniteDefinitions = [
        { sourceKey: 'gerundio', label: 'Gerundio' },
        { sourceKey: 'participio', label: 'Participio' },
        { sourceKey: 'infinito', label: 'Infinito' }
    ] as const

    const tenses = nonFiniteDefinitions.flatMap(({ sourceKey, label }) => {
        const source = getObjectRecord(findValueByNormalizedKey(rawEntry, sourceKey))
        if (!source) {
            return []
        }

        return ([
            ['presente', 'Presente'],
            ['passato', 'Passato']
        ] as const).flatMap(([tenseKey, tenseLabel]) => {
            const rawValue = findValueByNormalizedKey(source, tenseKey)
            const forms = Array.isArray(rawValue)
                ? rawValue.filter((form): form is string => typeof form === 'string' && form.trim().length > 0)
                : (typeof rawValue === 'string' && rawValue.trim().length > 0 ? [rawValue] : [])

            if (forms.length === 0) {
                return []
            }

            return [{
                tenseKey: `${sourceKey}_${tenseKey}`,
                tenseLabel: `${label} ${tenseLabel}`,
                forms
            }]
        })
    })

    if (tenses.length === 0) {
        return null
    }

    return {
        moodKey: 'forme_non_finite',
        moodLabel: 'Forme non finite',
        tenses
    }
}

function normalizeEntryGroups(rawEntry: Record<string, unknown>, moodOrder: ReadonlyArray<{ moodKey: string, moodLabel: string, tenses: ReadonlyArray<[string, string]> }>): ResponseGroup[] {
    const explicitGroups = Array.isArray(rawEntry.groups)
        ? rawEntry.groups.map((group) => getObjectRecord(group)).filter((group): group is Record<string, unknown> => Boolean(group))
        : []

    const containerCandidates = [
        getNestedRecord(rawEntry, 'conjugation'),
        getNestedRecord(rawEntry, 'conjugations'),
        getNestedRecord(rawEntry, 'moods')
    ].filter((item): item is Record<string, unknown> => Boolean(item))

    const standardGroups = moodOrder
        .filter((moodConfig) => moodConfig.moodKey !== 'forme_non_finite')
        .map((moodConfig) => {
        const matchingExplicitGroup = explicitGroups.find((group) => {
            const keyCandidate = [group.moodKey, group.key, group.id, group.moodLabel, group.label]
                .find((item): item is string => typeof item === 'string')
            return keyCandidate ? normalizeKey(keyCandidate) === moodConfig.moodKey : false
        })

        const matchingContainer = containerCandidates
            .map((container) => findValueByNormalizedKey(container, moodConfig.moodKey))
            .find((value) => value !== undefined)

        const matchingInlineValue = findValueByNormalizedKey(rawEntry, moodConfig.moodKey)

        const tenseSource = matchingExplicitGroup
            ?? getObjectRecord(matchingContainer)
            ?? getObjectRecord(matchingInlineValue)

        const explicitTenses = Array.isArray(matchingExplicitGroup?.tenses)
            ? matchingExplicitGroup.tenses
                .map((tense) => getObjectRecord(tense))
                .filter((tense): tense is Record<string, unknown> => Boolean(tense))
            : []

        const tenses = moodConfig.tenses.map(([tenseKey, tenseLabel]) => {
            const explicitTense = explicitTenses.find((tense) => {
                const keyCandidate = [tense.tenseKey, tense.key, tense.id, tense.tenseLabel, tense.label]
                    .find((item): item is string => typeof item === 'string')
                return keyCandidate ? normalizeKey(keyCandidate) === tenseKey : false
            })

            const inlineTenseValue = tenseSource ? findValueByNormalizedKey(tenseSource, tenseKey) : undefined
            const forms = explicitTense
                ? getFormsFromTenseValue(explicitTense)
                : getFormsFromTenseValue(inlineTenseValue)

            return {
                tenseKey,
                tenseLabel,
                forms
            }
        }).filter((tense) => tense.forms.length > 0)

        return {
            moodKey: moodConfig.moodKey,
            moodLabel: moodConfig.moodLabel,
            tenses
        }
    }).filter((group) => group.tenses.length > 0)

    const nonFiniteGroup = getNonFiniteFormsGroup(rawEntry)

    return nonFiniteGroup ? [...standardGroups, nonFiniteGroup] : standardGroups
}

function buildSelectionVariants(selection: string, selectionContext?: string) {
    const variants = new Set<string>()
    const normalizedSelection = normalizeText(selection)
    if (normalizedSelection) {
        variants.add(normalizedSelection)
    }

    const normalizedContext = normalizeText(selectionContext ?? '')
    const contextTokens = extractTokens(normalizedContext)
    const contextSuggestsChe = contextTokens.at(-1) === 'che'

    if (contextSuggestsChe && normalizedSelection) {
        variants.add(`che ${normalizedSelection}`)
    }

    return {
        variants,
        contextSuggestsChe
    }
}

function getLexicalForm(storedForm: string, noiseTokens: Set<string>): { lexicalNormalized: string, lexicalAccentless: string } {
    const tokens = extractTokens(storedForm)
    let startIndex = 0
    while (startIndex < tokens.length - 1 && noiseTokens.has(tokens[startIndex])) {
        startIndex++
    }
    
    if (startIndex === 0 && tokens.length > 0) {
        // No noise tokens at start, lexical is same as stored normalized
        const normalized = tokens.join(' ')
        return {
            lexicalNormalized: normalized,
            lexicalAccentless: normalizeAccentlessText(normalized)
        }
    }

    const lexicalTokens = tokens.slice(startIndex)
    const normalized = lexicalTokens.join(' ')
    return {
        lexicalNormalized: normalized,
        lexicalAccentless: normalizeAccentlessText(normalized)
    }
}

function scoreStoredForm(
    storedForm: string,
    prep: PreparedSelection,
    noiseTokens: Set<string>
): { score: number, matchMode: string } | null {
    const normalizedStored = normalizeText(storedForm)
    
    if (prep.variants.has(normalizedStored)) {
        const matchMode = normalizedStored === prep.normalized ? 'exact' : 'context_che_prefix'
        return { score: 1000 + (matchMode === 'context_che_prefix' ? 25 : 0), matchMode }
    }

    const { lexicalNormalized, lexicalAccentless } = getLexicalForm(storedForm, noiseTokens)
    if (prep.variants.has(lexicalNormalized) || lexicalNormalized === prep.normalized) {
        return {
            score: 900 + (prep.contextSuggestsChe && normalizedStored.startsWith('che ') ? 25 : 0),
            matchMode: 'lexical_exact_match'
        }
    }

    const accentlessStored = normalizeAccentlessText(normalizedStored)
    if (prep.accentlessVariants.has(accentlessStored) || accentlessStored === prep.accentless) {
        return { score: 850, matchMode: 'accentless_match' }
    }

    if (prep.accentlessVariants.has(lexicalAccentless) || lexicalAccentless === prep.accentless) {
        return { score: 800, matchMode: 'accentless_lexical_match' }
    }

    return null
}

function normalizeFormsForSearch(tenseForms: string[] | string | null | undefined): string[] {
    if (Array.isArray(tenseForms)) {
        return tenseForms.filter((form): form is string => typeof form === 'string' && form.trim().length > 0)
    }

    if (typeof tenseForms === 'string' && tenseForms.trim().length > 0) {
        return [tenseForms]
    }

    return []
}

function findBestEntryMatch(
    infinitive: string,
    groups: ResponseGroup[],
    prep: PreparedSelection,
    rawEntry: Record<string, unknown>,
    noiseTokens: Set<string>
): MatchRecord | null {
    let bestMatch: MatchRecord | null = null

    for (const group of groups) {
        for (const tense of group.tenses) {
            const formsToSearch = normalizeFormsForSearch(tense.forms)
            formsToSearch.forEach((storedForm, formIndex) => {
                const scored = scoreStoredForm(storedForm, prep, noiseTokens)
                if (!scored) {
                    return
                }

                const candidate: MatchRecord = {
                    infinitive,
                    score: scored.score,
                    matchMode: scored.matchMode,
                    moodKey: group.moodKey,
                    moodLabel: group.moodLabel,
                    tenseKey: tense.tenseKey,
                    tenseLabel: tense.tenseLabel,
                    formIndex,
                    storedForm,
                    groups,
                    definition: (rawEntry.definition || rawEntry.significato || rawEntry.meaning) as string | undefined
                }

                if (!bestMatch || candidate.score > bestMatch.score) {
                    bestMatch = candidate
                }
            })
        }
    }

    return bestMatch
}

async function findLookupCandidates(env: Bindings, selection: string, strategies: LookupStrategy[], reverseDB: KVNamespace) {
    const tokens = extractTokens(selection)
    const lookupTokens = (tokens.length <= 1 ? tokens : [...tokens].reverse())
        .filter((token, index, source) => token.length > 0 && source.indexOf(token) === index)

    for (const token of lookupTokens) {
        for (const strategy of strategies) {
            const transformedToken = strategy.transform(token)
            if (!transformedToken) {
                continue
            }

            const shardKey = `${strategy.prefix}${getShardSuffix(transformedToken)}`
            const shard = await reverseDB.get<ReverseShard>(shardKey, 'json')
            if (!shard || typeof shard !== 'object') {
                continue
            }

            const candidates = shard[transformedToken]
            if (Array.isArray(candidates) && candidates.length > 0) {
                return {
                    matchedToken: token,
                    strategy: strategy.name,
                    candidates: candidates.filter((item): item is string => typeof item === 'string' && item.length > 0)
                }
            }
        }
    }

    return {
        matchedToken: tokens.at(-1) ?? normalizeText(selection),
        strategy: 'normalized' as const,
        candidates: []
    }
}

function toInitialMatch(match: MatchRecord | null): ConjugationLookupResponse['initialMatch'] {
    if (!match) {
        return null
    }

    return {
        moodKey: match.moodKey,
        moodLabel: match.moodLabel,
        tenseKey: match.tenseKey,
        tenseLabel: match.tenseLabel,
        formIndex: match.formIndex,
        storedForm: match.storedForm,
        matchMode: match.matchMode
    }
}

function getDatabaseBindings(lang: string, env: Bindings): { verbDB: KVNamespace, reverseDB: KVNamespace } | null {
    const normalizedLang = lang.toLowerCase()
    
    if (normalizedLang === 'it' || normalizedLang === 'italian') {
        return {
            verbDB: env.VERB_DB,
            reverseDB: env.REVERSE_DB_V2
        }
    }

    const verbDBKey = `VERBS_DB_${normalizedLang.toUpperCase()}` as keyof Bindings
    const reverseDBKey = `REVERSE_DB_${normalizedLang.toUpperCase()}` as keyof Bindings
    
    const verbDB = env[verbDBKey] as KVNamespace
    const reverseDB = env[reverseDBKey] as KVNamespace

    if (verbDB && reverseDB) {
        return { verbDB, reverseDB }
    }

    return null
}

// 2. Google Translate Proxy
app.post('/api/translate', async (c) => {
    const body = await c.req.json();
    const text = body.q || body.text;

    if (typeof text === 'string' && text.length > 500) {
        return c.json({ error: 'Selection too long (max 500 characters)' }, 400);
    }

    const response = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${c.env.GOOGLE_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    const data = await response.json();
    return c.json(data);
})

// 3. DeepL Translate Proxy
app.post('/api/deepl', async (c) => {
    const body = await c.req.json();

    const text = body.text || body.targetText || body.target_text;
    const targetLang = body.target_lang || body.targetLang;
    const sourceLang = body.source_lang || body.sourceLang;
    const context = body.context;

    if (typeof text === 'string' && text.length > 500) {
        return c.json({ error: 'Selection too long (max 500 characters)' }, 400);
    }

    const deeplPayload: Record<string, any> = {
        text: Array.isArray(text) ? text : [text],
        target_lang: targetLang
    };

    if (sourceLang) deeplPayload.source_lang = sourceLang;
    if (context) deeplPayload.context = context;

    const response = await fetch('https://api-free.deepl.com/v2/translate', {
        method: 'POST',
        headers: {
            'Authorization': `DeepL-Auth-Key ${c.env.DEEPL_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(deeplPayload)
    });

    const data = await response.json();
    return c.json(data);
})

// 4. Dynamic Conjugation Lookup Route
app.post('/api/:language/conjugation-lookup', async (c) => {
    const lang = c.req.param('language')
    const body = await c.req.json<{ selection?: unknown, selectionContext?: unknown }>()
    const selection = typeof body.selection === 'string' ? body.selection : ''
    const selectionContext = typeof body.selectionContext === 'string' ? body.selectionContext : undefined

    if (selection.length > 500) {
        return c.json({ error: 'Selection too long (max 500 characters)' }, 400)
    }

    const config = LANGUAGE_REGISTRY[lang.toLowerCase()]
    if (!config) {
        return c.json({ error: `Language '${lang}' is not supported for conjugation yet.` }, 404)
    }

    const dbs = getDatabaseBindings(lang, c.env)
    if (!dbs) {
        return c.json({ error: `Database for language '${lang}' is not configured.` }, 500)
    }

    if (!normalizeText(selection) || selection.length > 50) {
        return c.json({ 
            error: selection.length > 50 ? 'Selection too long for conjugation search' : 'selection is required',
            skipConjugation: selection.length > 50 
        }, 400)
    }

    const { variants, contextSuggestsChe } = buildSelectionVariants(selection, selectionContext)
    const normalizedSelection = normalizeText(selection)
    const accentlessSelection = normalizeAccentlessText(normalizedSelection)
    const accentlessVariants = new Set<string>()
    for (const v of variants) {
        accentlessVariants.add(normalizeAccentlessText(v))
    }
    const prep: PreparedSelection = {
        normalized: normalizedSelection,
        accentless: accentlessSelection,
        variants,
        accentlessVariants,
        contextSuggestsChe
    }

    const lookup = await findLookupCandidates(c.env, selection, config.lookupStrategies, dbs.reverseDB)
    if (lookup.candidates.length === 0) {
        return c.json({
            error: 'No conjugation candidates found',
            lookup: {
                matchedToken: lookup.matchedToken,
                strategy: lookup.strategy
            }
        }, 404)
    }

    const matches: MatchRecord[] = []

    for (const infinitive of lookup.candidates) {
        const rawEntry = await dbs.verbDB.get<Record<string, unknown>>(`verb:${infinitive}`, 'json')
        if (!rawEntry || typeof rawEntry !== 'object') {
            continue
        }

        const groups = normalizeEntryGroups(rawEntry, config.moodOrder)
        if (groups.length === 0) {
            continue
        }

        const resolvedInfinitive = extractInfinitive(rawEntry) ?? infinitive
        const match = findBestEntryMatch(resolvedInfinitive, groups, prep, rawEntry, config.noiseTokens)
        if (match) {
            matches.push(match)
        }
    }

    matches.sort((a, b) => b.score - a.score || a.infinitive.localeCompare(b.infinitive))

    const bestMatch = matches[0] ?? null
    const response: ConjugationLookupResponse = {
        language: config.languageCode,
        selection,
        chosenInfinitive: bestMatch?.infinitive ?? null,
        lookup: {
            matchedToken: lookup.matchedToken,
            strategy: lookup.strategy
        },
        initialMatch: toInitialMatch(bestMatch),
        alternatives: matches.slice(1).map((match) => ({
            infinitive: match.infinitive,
            initialMatch: toInitialMatch(match)
        })),
        entry: bestMatch ? {
            infinitive: bestMatch.infinitive,
            groups: bestMatch.groups,
            definition: bestMatch.definition
        } : null
    }

    if (!bestMatch) {
        return c.json(response, 404)
    }

    return c.json(response)
})

export default app
