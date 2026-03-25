import { Hono } from 'hono';
import { cors } from 'hono/cors';
const SUBJECT_PRONOUNS = new Set(['io', 'tu', 'lui', 'lei', 'noi', 'voi', 'loro']);
const LOOKUP_STRATEGIES = [
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
];
const MOOD_ORDER = [
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
];
const app = new Hono();
app.use('/*', cors());

function normalizeApostrophes(value) {
    return value.replace(/[\u2018\u2019\u0060\u00B4]/g, "'");
}
function normalizeText(value) {
    return normalizeApostrophes(value)
        .toLowerCase()
        .normalize('NFC')
        .replace(/\s+/g, ' ')
        .trim();
}
function normalizeSurfaceText(value) {
    return normalizeApostrophes(value)
        .replace(/\s+/g, ' ')
        .trim();
}
function normalizeAccentlessText(value) {
    return normalizeText(value)
        .normalize('NFD')
        .replace(/\p{M}+/gu, '')
        .normalize('NFC');
}
function normalizeKey(value) {
    return normalizeText(value)
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, '_')
        .trim();
}
function extractTokens(value) {
    const normalized = normalizeText(value);
    const matches = normalized.match(/[\p{L}\p{N}']+/gu);
    if (!matches) {
        return [];
    }
    return matches
        .map((token) => token.replace(/^'+|'+$/g, ''))
        .filter(Boolean);
}
function getShardSuffix(token) {
    const normalized = normalizeText(token);
    return normalized.slice(0, 2) || '_';
}
function getStringArray(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((item) => typeof item === 'string');
}
function getObjectRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    return value;
}
function getNestedRecord(source, ...keys) {
    for (const key of keys) {
        const match = Object.entries(source).find(([candidate]) => normalizeKey(candidate) === normalizeKey(key));
        if (match) {
            return getObjectRecord(match[1]);
        }
    }
    return null;
}
function getFormsFromTenseValue(value) {
    if (typeof value === 'string' && value.trim().length > 0) {
        return [value];
    }
    if (Array.isArray(value)) {
        return getStringArray(value);
    }
    const record = getObjectRecord(value);
    if (!record) {
        return [];
    }
    if (Array.isArray(record.forms)) {
        return getStringArray(record.forms);
    }
    if (typeof record.forms === 'string' && record.forms.trim().length > 0) {
        return [record.forms];
    }
    if (typeof record.form === 'string' && record.form.trim().length > 0) {
        return [record.form];
    }
    return [];
}
function findValueByNormalizedKey(source, targetKey) {
    const normalizedTarget = normalizeKey(targetKey);
    const match = Object.entries(source).find(([key]) => normalizeKey(key) === normalizedTarget);
    return match?.[1];
}
function extractInfinitive(rawEntry) {
    const candidates = [rawEntry.infinitive, rawEntry.lemma, rawEntry.verb];
    const stringValue = candidates.find((item) => typeof item === 'string' && item.trim().length > 0);
    return stringValue ?? null;
}
function getNonFiniteFormsGroup(rawEntry) {
    const nonFiniteDefinitions = [
        { sourceKey: 'gerundio', label: 'Gerundio' },
        { sourceKey: 'participio', label: 'Participio' },
        { sourceKey: 'infinito', label: 'Infinito' }
    ];
    const tenses = nonFiniteDefinitions.flatMap(({ sourceKey, label }) => {
        const source = getObjectRecord(findValueByNormalizedKey(rawEntry, sourceKey));
        if (!source) {
            return [];
        }
        return [
            ['presente', 'Presente'],
            ['passato', 'Passato']
        ].flatMap(([tenseKey, tenseLabel]) => {
            const rawValue = findValueByNormalizedKey(source, tenseKey);
            const forms = Array.isArray(rawValue)
                ? rawValue.filter((form) => typeof form === 'string' && form.trim().length > 0)
                : (typeof rawValue === 'string' && rawValue.trim().length > 0 ? [rawValue] : []);
            if (forms.length === 0) {
                return [];
            }
            return [{
                    tenseKey: `${sourceKey}_${tenseKey}`,
                    tenseLabel: `${label} ${tenseLabel}`,
                    forms
                }];
        });
    });
    if (tenses.length === 0) {
        return null;
    }
    return {
        moodKey: 'forme_non_finite',
        moodLabel: 'Forme non finite',
        tenses
    };
}
function normalizeEntryGroups(rawEntry) {
    const explicitGroups = Array.isArray(rawEntry.groups)
        ? rawEntry.groups.map((group) => getObjectRecord(group)).filter((group) => Boolean(group))
        : [];
    const containerCandidates = [
        getNestedRecord(rawEntry, 'conjugation'),
        getNestedRecord(rawEntry, 'conjugations'),
        getNestedRecord(rawEntry, 'moods')
    ].filter((item) => Boolean(item));
    const standardGroups = MOOD_ORDER
        .filter((moodConfig) => moodConfig.moodKey !== 'forme_non_finite')
        .map((moodConfig) => {
        const matchingExplicitGroup = explicitGroups.find((group) => {
            const keyCandidate = [group.moodKey, group.key, group.id, group.moodLabel, group.label]
                .find((item) => typeof item === 'string');
            return keyCandidate ? normalizeKey(keyCandidate) === moodConfig.moodKey : false;
        });
        const matchingContainer = containerCandidates
            .map((container) => findValueByNormalizedKey(container, moodConfig.moodKey))
            .find((value) => value !== undefined);
        const matchingInlineValue = findValueByNormalizedKey(rawEntry, moodConfig.moodKey);
        const tenseSource = matchingExplicitGroup
            ?? getObjectRecord(matchingContainer)
            ?? getObjectRecord(matchingInlineValue);
        const explicitTenses = Array.isArray(matchingExplicitGroup?.tenses)
            ? matchingExplicitGroup.tenses
                .map((tense) => getObjectRecord(tense))
                .filter((tense) => Boolean(tense))
            : [];
        const tenses = moodConfig.tenses.map(([tenseKey, tenseLabel]) => {
            const explicitTense = explicitTenses.find((tense) => {
                const keyCandidate = [tense.tenseKey, tense.key, tense.id, tense.tenseLabel, tense.label]
                    .find((item) => typeof item === 'string');
                return keyCandidate ? normalizeKey(keyCandidate) === tenseKey : false;
            });
            const inlineTenseValue = tenseSource ? findValueByNormalizedKey(tenseSource, tenseKey) : undefined;
            const forms = explicitTense
                ? getFormsFromTenseValue(explicitTense)
                : getFormsFromTenseValue(inlineTenseValue);
            return {
                tenseKey,
                tenseLabel,
                forms
            };
        }).filter((tense) => tense.forms.length > 0);
        return {
            moodKey: moodConfig.moodKey,
            moodLabel: moodConfig.moodLabel,
            tenses
        };
    }).filter((group) => group.tenses.length > 0);
    const nonFiniteGroup = getNonFiniteFormsGroup(rawEntry);
    return nonFiniteGroup ? [...standardGroups, nonFiniteGroup] : standardGroups;
}
function buildSelectionVariants(selection, selectionContext) {
    const variants = new Set();
    const normalizedSelection = normalizeText(selection);
    if (normalizedSelection) {
        variants.add(normalizedSelection);
    }
    const normalizedContext = normalizeText(selectionContext ?? '');
    const contextTokens = extractTokens(normalizedContext);
    const contextSuggestsChe = contextTokens.at(-1) === 'che';
    if (contextSuggestsChe && normalizedSelection) {
        variants.add(`che ${normalizedSelection}`);
    }
    return {
        variants,
        contextSuggestsChe
    };
}
function scoreStoredForm(storedForm, selection, selectionContext) {
    const normalizedStored = normalizeText(storedForm);
    const { variants, contextSuggestsChe } = buildSelectionVariants(selection, selectionContext);
    if (variants.has(normalizedStored)) {
        const matchMode = normalizedStored === normalizeText(selection) ? 'exact' : 'context_che_prefix';
        return { score: 1000 + (matchMode === 'context_che_prefix' ? 25 : 0), matchMode };
    }
    const storedTokens = extractTokens(storedForm);
    if (storedTokens.length > 1 && SUBJECT_PRONOUNS.has(storedTokens[0])) {
        const withoutPronoun = storedTokens.slice(1).join(' ');
        if (variants.has(withoutPronoun) || normalizeText(selection) === withoutPronoun) {
            return {
                score: 900 + (contextSuggestsChe && normalizedStored.startsWith('che ') ? 25 : 0),
                matchMode: 'subject_pronoun_prefix_omitted'
            };
        }
    }
    if (contextSuggestsChe && normalizedStored.startsWith('che ') && normalizedStored.endsWith(normalizeText(selection))) {
        return {
            score: 875,
            matchMode: 'context_che_bias'
        };
    }
    return null;
}
function normalizeFormsForSearch(tenseForms) {
    if (Array.isArray(tenseForms)) {
        return tenseForms.filter((form) => typeof form === 'string' && form.trim().length > 0);
    }
    if (typeof tenseForms === 'string' && tenseForms.trim().length > 0) {
        return [tenseForms];
    }
    return [];
}
function findBestEntryMatch(infinitive, groups, selection, selectionContext) {
    let bestMatch = null;
    for (const group of groups) {
        for (const tense of group.tenses) {
            const formsToSearch = normalizeFormsForSearch(tense.forms);
            formsToSearch.forEach((storedForm, formIndex) => {
                const scored = scoreStoredForm(storedForm, selection, selectionContext);
                if (!scored) {
                    return;
                }
                const candidate = {
                    infinitive,
                    score: scored.score,
                    matchMode: scored.matchMode,
                    moodKey: group.moodKey,
                    moodLabel: group.moodLabel,
                    tenseKey: tense.tenseKey,
                    tenseLabel: tense.tenseLabel,
                    formIndex,
                    storedForm,
                    groups
                };
                if (!bestMatch || candidate.score > bestMatch.score) {
                    bestMatch = candidate;
                }
            });
        }
    }
    return bestMatch;
}
async function getReverseCandidates(env, token, strategy) {
    const transformedToken = strategy.transform(token);
    if (!transformedToken) {
        return [];
    }
    const shardKey = `${strategy.prefix}${getShardSuffix(transformedToken)}`;
    const shard = await env.REVERSE_DB_V2.get(shardKey, 'json');
    if (!shard || typeof shard !== 'object') {
        return [];
    }
    const candidates = shard[transformedToken];
    return Array.isArray(candidates)
        ? candidates.filter((item) => typeof item === 'string' && item.length > 0)
        : [];
}
async function findLookupCandidates(env, selection) {
    const tokens = extractTokens(selection);
    const lookupTokens = (tokens.length <= 1 ? tokens : [...tokens].reverse())
        .filter((token, index, source) => token.length > 0 && source.indexOf(token) === index);
    for (const token of lookupTokens) {
        for (const strategy of LOOKUP_STRATEGIES) {
            const candidates = await getReverseCandidates(env, token, strategy);
            if (candidates.length > 0) {
                return {
                    matchedToken: token,
                    strategy: strategy.name,
                    candidates
                };
            }
        }
    }
    return {
        matchedToken: tokens.at(-1) ?? normalizeText(selection),
        strategy: 'normalized',
        candidates: []
    };
}
function toInitialMatch(match) {
    if (!match) {
        return null;
    }
    return {
        moodKey: match.moodKey,
        moodLabel: match.moodLabel,
        tenseKey: match.tenseKey,
        tenseLabel: match.tenseLabel,
        formIndex: match.formIndex,
        storedForm: match.storedForm,
        matchMode: match.matchMode
    };
}
// 3. Google Translate Proxy
app.post('/api/translate', async (c) => {
    const body = await c.req.json();
    const response = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${c.env.GOOGLE_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const data = await response.json();
    return c.json(data);
});
// DeepL Translate Proxy
app.post('/api/deepl', async (c) => {
    const body = await c.req.json();
    // Extract target text, source language, target language, and optional context
    const text = body.text || body.targetText || body.target_text;
    const targetLang = body.target_lang || body.targetLang;
    const sourceLang = body.source_lang || body.sourceLang;
    const context = body.context;
    const deeplPayload = {
        text: Array.isArray(text) ? text : [text],
        target_lang: targetLang
    };
    if (sourceLang) {
        deeplPayload.source_lang = sourceLang;
    }
    if (context) {
        deeplPayload.context = context;
    }
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
});
app.post('/api/italian/conjugation-lookup', async (c) => {
    const body = await c.req.json();
    const selection = typeof body.selection === 'string' ? body.selection : '';
    const selectionContext = typeof body.selectionContext === 'string' ? body.selectionContext : undefined;
    if (!normalizeText(selection)) {
        return c.json({ error: 'selection is required' }, 400);
    }
    const lookup = await findLookupCandidates(c.env, selection);
    if (lookup.candidates.length === 0) {
        return c.json({
            error: 'No conjugation candidates found',
            lookup: {
                matchedToken: lookup.matchedToken,
                strategy: lookup.strategy
            }
        }, 404);
    }
    const matches = [];
    for (const infinitive of lookup.candidates) {
        const rawEntry = await c.env.VERB_DB.get(`verb:${infinitive}`, 'json');
        if (!rawEntry || typeof rawEntry !== 'object') {
            continue;
        }
        const groups = normalizeEntryGroups(rawEntry);
        if (groups.length === 0) {
            continue;
        }
        const resolvedInfinitive = extractInfinitive(rawEntry) ?? infinitive;
        const match = findBestEntryMatch(resolvedInfinitive, groups, selection, selectionContext);
        if (match) {
            matches.push(match);
        }
    }
    matches.sort((a, b) => b.score - a.score || a.infinitive.localeCompare(b.infinitive));
    const bestMatch = matches[0] ?? null;
    const response = {
        language: 'it',
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
            groups: bestMatch.groups
        } : null
    };
    if (!bestMatch) {
        return c.json(response, 404);
    }
    return c.json(response);
});
export default app;
