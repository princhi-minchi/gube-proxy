// verify_scoring_fix.js
import { unicodedata } from 'node:util'; // Not available in standard node, will use native string methods

function normalizeApostrophes(value) {
    return value.replace(/[\u2018\u2019\u0060\u00B4]/g, "'")
}

function normalizeText(value) {
    return normalizeApostrophes(value)
        .toLowerCase()
        .normalize('NFC')
        .replace(/\s+/g, ' ')
        .trim()
}

function normalizeAccentlessText(value) {
    return normalizeText(value)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, "") // Manual stripping for node
        .normalize('NFC')
}

function extractTokens(value) {
    const normalized = normalizeText(value)
    const matches = normalized.match(/[a-z0-9']+/gi) // Simple regex for testing
    if (!matches) {
        return []
    }

    return matches
        .map((token) => token.replace(/^'+|'+$/g, ''))
        .filter(Boolean)
}

const NOISE_TOKENS = new Set(['io', 'tu', 'lui', 'lei', 'noi', 'voi', 'loro', 'che', 'mi', 'ti', 'si', 'ci', 'vi'])

function getLexicalForm(storedForm) {
    const tokens = extractTokens(storedForm)
    let startIndex = 0
    while (startIndex < tokens.length - 1 && NOISE_TOKENS.has(tokens[startIndex])) {
        startIndex++
    }
    
    const lexicalTokens = tokens.slice(startIndex)
    const normalized = lexicalTokens.join(' ')
    return {
        lexicalNormalized: normalized,
        lexicalAccentless: normalizeAccentlessText(normalized)
    }
}

function buildSelectionVariants(selection, selectionContext) {
    const variants = new Set()
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

function scoreStoredForm(
    storedForm,
    selection,
    selectionContext
) {
    const normalizedStored = normalizeText(storedForm)
    const accentlessStored = normalizeAccentlessText(storedForm)
    
    const { variants, contextSuggestsChe } = buildSelectionVariants(selection, selectionContext)
    const normalizedSelection = normalizeText(selection)
    const accentlessSelection = normalizeAccentlessText(selection)
    
    const accentlessVariants = new Set()
    for (const v of variants) {
        accentlessVariants.add(normalizeAccentlessText(v))
    }

    // 1. Exact or Context-matched
    if (variants.has(normalizedStored)) {
        const matchMode = normalizedStored === normalizedSelection ? 'exact' : 'context_che_prefix'
        return { score: 1000 + (matchMode === 'context_che_prefix' ? 25 : 0), matchMode }
    }

    // 2. Lexical Match
    const { lexicalNormalized, lexicalAccentless } = getLexicalForm(storedForm)
    if (variants.has(lexicalNormalized) || lexicalNormalized === normalizedSelection) {
        return {
            score: 900 + (contextSuggestsChe && normalizedStored.startsWith('che ') ? 25 : 0),
            matchMode: 'lexical_exact_match'
        }
    }

    // 3. Accentless Match
    if (accentlessVariants.has(accentlessStored) || accentlessStored === accentlessSelection) {
        return { score: 850, matchMode: 'accentless_match' }
    }

    // 4. Accentless Lexical Match
    if (accentlessVariants.has(lexicalAccentless) || lexicalAccentless === accentlessSelection) {
        return { score: 800, matchMode: 'accentless_lexical_match' }
    }

    return null
}

// TEST CASES
const tests = [
    { selection: "riusci", stored: "lui/lei riuscì", expected: "accentless_lexical_match" },
    { selection: "considerava", stored: "lui/lei considerava", expected: "lexical_exact_match" },
    { selection: "avrebbe", stored: "lui/lei avrebbe", expected: "lexical_exact_match" },
    { selection: "abbiamo dato", stored: "noi abbiamo dato", expected: "lexical_exact_match" },
    { selection: "mangiato", stored: "io ho mangiato", expected: "lexical_exact_match" }, // "ho" is NOT a noise token here, but "io" is. Wait, "ho" is an auxiliary.
]

console.log("Running Italian Conjugation Scoring Tests:\n");

tests.forEach(({ selection, stored, expected }, i) => {
    const result = scoreStoredForm(stored, selection);
    const passed = result && result.matchMode === expected;
    console.log(`Test ${i + 1}: selection='${selection}', stored='${stored}'`);
    console.log(`  Result: ${result ? result.matchMode : 'NULL'} (Score: ${result ? result.score : 'N/A'})`);
    console.log(`  Expected: ${expected}`);
    console.log(`  Status: ${passed ? '✅ PASSED' : '❌ FAILED'}\n`);
});
