import { extension_settings, getContext } from "../../../extensions.js";
import { callGenericPopup, POPUP_TYPE } from "../../../popup.js";
import { MacrosParser } from "../../../macros.js";

// Import all data files
import { commonWords } from './common_words.js';
import { defaultNames } from './default_names.js';
import { lemmaMap } from './lemmas.js';

const LOG_PREFIX = `[ProsePolisher:Analyzer]`;
const EXTENSION_FOLDER_PATH = `scripts/extensions/third-party/ProsePolisher`;

// Constants
const CANDIDATE_LIMIT_FOR_ANALYSIS = 2000;
const NGRAM_MIN = 3; // The minimum n-gram size is fundamental to the logic.

// Utility Functions
function stripMarkup(text) {
    if (!text) return '';
    let cleanText = text;

    // Remove code blocks first
    cleanText = cleanText.replace(/(?:```|~~~)\w*\s*[\s\S]*?(?:```|~~~)/g, ' ');
    
    // Remove ALL HTML tags and their content, including:
    // - Paired tags with content: <tag>content</tag>
    // - Self-closing tags: <img src="..." />
    // - Tags with attributes: <div class="example">
    // This comprehensive regex handles nested tags and attributes
    cleanText = cleanText.replace(/<([^>]+)>[\s\S]*?<\/\1>/gi, ' '); // Remove paired tags with content
    cleanText = cleanText.replace(/<[^>]+\/>/g, ' '); // Remove self-closing tags
    cleanText = cleanText.replace(/<[^>]*>/g, ' '); // Remove any remaining HTML tags
    
    // Remove markdown emphasis but keep the text
    cleanText = cleanText.replace(/(?:\*|_|~|`)+(.+?)(?:\*|_|~|`)+/g, '$1');
    // Remove content in quotes and parentheses, which often cause fragments
    cleanText = cleanText.replace(/"(.*?)"/g, ' $1 ');
    cleanText = cleanText.replace(/\((.*?)\)/g, ' $1 ');
    // Collapse multiple spaces and trim
    cleanText = cleanText.replace(/\s+/g, ' ').trim();

    return cleanText;
}

function generateNgrams(words, n) {
    const ngrams = [];
    if (words.length < n) return ngrams;
    for (let i = 0; i <= words.length - n; i++) {
        ngrams.push(words.slice(i, i + n).join(' '));
    }
    return ngrams;
}

class PhraseTrieNode {
    constructor(word = '', depth = 0, tokens = []) {
        this.word = word;
        this.depth = depth;
        this.tokens = tokens;
        this.children = new Map();
        this.phraseRefs = [];
        this.isTerminal = false;
    }
}

const HYPHEN_SPLIT_REGEX = /[\-–—]+/g;

function normalizeTokenForComparison(token) {
    if (!token) return '';
    const trimmed = token.replace(/^[^A-Za-z0-9']+|[^A-Za-z0-9']+$/g, '');
    return trimmed.toLowerCase();
}

function normalizeTokensSegment(tokens, startIndex = 0) {
    const normalized = [];
    for (let i = startIndex; i < tokens.length; i++) {
        const token = tokens[i];
        if (!token) continue;
        const parts = token.split(HYPHEN_SPLIT_REGEX);
        for (const part of parts) {
            const normalizedPart = normalizeTokenForComparison(part);
            if (normalizedPart) {
                normalized.push(normalizedPart);
            }
        }
    }
    return normalized.join(' ');
}

function buildPhraseTrie(phraseStatsMap) {
    const root = new PhraseTrieNode('', 0, []);
    for (const [phrase, stats] of Object.entries(phraseStatsMap)) {
        if (!phrase || !stats) continue;
        const tokens = phrase.split(' ').filter(Boolean);
        if (tokens.length === 0) continue;

        const phraseRef = {
            phrase,
            tokens,
            stats,
        };

        let node = root;
        for (const token of tokens) {
            if (!node.children.has(token)) {
                const childTokens = node.tokens.length ? [...node.tokens, token] : [token];
                node.children.set(token, new PhraseTrieNode(token, node.depth + 1, childTokens));
            }
            node = node.children.get(token);
            node.phraseRefs.push(phraseRef);
        }
        node.isTerminal = true;
    }
    return root;
}

function collectPatternCandidatesFromTrie(root, minCommonWords, filterVariations) {
    const candidates = [];
    const stack = [...root.children.values()];

    while (stack.length > 0) {
        const node = stack.pop();
        node.children.forEach(child => stack.push(child));

        if (node.depth < minCommonWords) continue;
        if (!node.phraseRefs || node.phraseRefs.length < 2) continue;

        const rawVariations = new Set();
        const phraseSet = new Set();
        const phraseTokenMap = new Map();
        const messageIds = new Set();
        let totalOccurrences = 0;
        let scoreSum = 0;
        let scoreCount = 0;
        let maxScore = 0;

        const uniquePhraseRefs = new Map();
        for (const ref of node.phraseRefs) {
            if (!ref || !ref.tokens || !ref.phrase) continue;
            if (!uniquePhraseRefs.has(ref.phrase)) {
                uniquePhraseRefs.set(ref.phrase, ref);
            }
        }

        const seenStats = new Set();

        for (const ref of uniquePhraseRefs.values()) {
            const suffixTokens = ref.tokens.slice(node.depth);
            if (suffixTokens.length === 0) continue;
            const variation = suffixTokens.join(' ').trim();
            if (!variation) continue;

            rawVariations.add(variation);
            phraseSet.add(ref.phrase);
            phraseTokenMap.set(ref.phrase, ref.tokens);

            if (!seenStats.has(ref.stats)) {
                seenStats.add(ref.stats);
                const scoreValue = Number(ref.stats?.score ?? 0);
                if (Number.isFinite(scoreValue)) {
                    scoreSum += scoreValue;
                    scoreCount++;
                    maxScore = Math.max(maxScore, scoreValue);
                }
                totalOccurrences += ref.stats?.occurrences ?? 0;
            }

            const ids = ref.stats?.messageIds;
            if (ids && typeof ids.forEach === 'function') {
                ids.forEach(id => messageIds.add(id));
            } else if (Number.isFinite(ref.stats?.lastSeenMessageIndex)) {
                messageIds.add(ref.stats.lastSeenMessageIndex);
            }
        }

        if (rawVariations.size < 2 || phraseSet.size < 2) {
            continue;
        }

        const cleanedVariations = filterVariations(rawVariations);
        if (!cleanedVariations || cleanedVariations.size < 2) {
            continue;
        }

        const sortedVariations = Array.from(cleanedVariations).sort((a, b) => a.localeCompare(b));

        const averageScore = scoreCount > 0 ? scoreSum / scoreCount : 0;
        const diversityBonus = rawVariations.size > 1
            ? Math.min(2, Math.log1p(rawVariations.size - 1) * 0.75)
            : 0;
        const candidateScore = Math.min(10, Math.max(maxScore, averageScore + diversityBonus));

        candidates.push({
            prefix: node.tokens.join(' '),
            prefixTokens: [...node.tokens],
            variations: sortedVariations,
            score: candidateScore,
            occurrences: totalOccurrences,
            messageIds,
            variationCount: sortedVariations.length,
            phraseSet,
            depth: node.depth,
            phraseTokenMap,
        });
    }

    return candidates;
}

function countSetIntersection(a, b) {
    let count = 0;
    for (const value of a) {
        if (b.has(value)) {
            count++;
        }
    }
    return count;
}

function deduplicatePatternCandidates(candidates, overlapThreshold = 0.9) {
    const sortedCandidates = [...candidates].sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (b.variationCount !== a.variationCount) return b.variationCount - a.variationCount;
        return b.depth - a.depth;
    });

    const accepted = [];

    for (const candidate of sortedCandidates) {
        let isCovered = false;
        for (const kept of accepted) {
            const minSize = Math.min(candidate.phraseSet.size, kept.phraseSet.size);
            if (minSize === 0) continue;
            const overlap = countSetIntersection(candidate.phraseSet, kept.phraseSet);
            if (overlap / minSize >= overlapThreshold) {
                isCovered = true;
                break;
            }
        }

        if (!isCovered) {
            accepted.push(candidate);
        }
    }

    return accepted;
}

const SHIFTED_PHRASE_CACHE = new WeakMap();

function getShiftedPhraseSets(candidate, maxShift = 3) {
    if (SHIFTED_PHRASE_CACHE.has(candidate)) {
        return SHIFTED_PHRASE_CACHE.get(candidate);
    }

    const prefixLength = candidate.prefixTokens ? candidate.prefixTokens.length : candidate.prefix.split(' ').filter(Boolean).length;
    const limit = Math.min(maxShift, prefixLength);
    const shifted = new Map();

    for (const tokens of candidate.phraseTokenMap?.values() || []) {
        if (!Array.isArray(tokens) || tokens.length === 0) continue;
        const maxLocalShift = Math.min(limit, tokens.length - 1);
        for (let shift = 0; shift <= maxLocalShift; shift++) {
            const normalizedSegment = normalizeTokensSegment(tokens, shift);
            if (!normalizedSegment) continue;
            if (!shifted.has(shift)) {
                shifted.set(shift, new Set());
            }
            shifted.get(shift).add(normalizedSegment);
        }
    }

    SHIFTED_PHRASE_CACHE.set(candidate, shifted);
    return shifted;
}

function evaluatePatternOverlap(candidateA, candidateB, options = {}) {
    const { overlapThreshold = 0.6, maxShift = 3 } = options;
    const shiftedA = getShiftedPhraseSets(candidateA, maxShift);
    const shiftedB = getShiftedPhraseSets(candidateB, maxShift);

    let best = null;

    for (const [shiftA, setA] of shiftedA.entries()) {
        if (!setA || setA.size === 0) continue;
        for (const [shiftB, setB] of shiftedB.entries()) {
            if (!setB || setB.size === 0) continue;

            let overlapCount = 0;
            for (const phrase of setA) {
                if (setB.has(phrase)) {
                    overlapCount++;
                }
            }
            if (overlapCount === 0) continue;

            const minSize = Math.min(setA.size, setB.size);
            if (minSize === 0) continue;

            const ratio = overlapCount / minSize;

            if (ratio < overlapThreshold) {
                continue;
            }

            if (!best || ratio > best.ratio || (ratio === best.ratio && overlapCount > best.count)) {
                best = {
                    ratio,
                    count: overlapCount,
                    shiftA,
                    shiftB,
                    setASize: setA.size,
                    setBSize: setB.size,
                };
            }
        }
    }

    return best;
}

function preferFirstPattern(first, second, overlapInfo) {
    const shiftA = overlapInfo?.shiftA ?? 0;
    const shiftB = overlapInfo?.shiftB ?? 0;

    if (shiftA !== shiftB) {
        return shiftA > shiftB;
    }

    const prefixLenFirst = first.prefixTokens ? first.prefixTokens.length : first.prefix.split(' ').filter(Boolean).length;
    const prefixLenSecond = second.prefixTokens ? second.prefixTokens.length : second.prefix.split(' ').filter(Boolean).length;

    if (prefixLenFirst !== prefixLenSecond) {
        return prefixLenFirst > prefixLenSecond;
    }

    const scoreFirst = Number(first.score ?? 0);
    const scoreSecond = Number(second.score ?? 0);
    if (scoreFirst !== scoreSecond) {
        return scoreFirst > scoreSecond;
    }

    const variationFirst = Number(first.variationCount ?? 0);
    const variationSecond = Number(second.variationCount ?? 0);
    if (variationFirst !== variationSecond) {
        return variationFirst > variationSecond;
    }

    return true;
}

function filterContainedPatternCandidates(candidates, options = {}) {
    const { overlapThreshold = 0.6, maxShift = 3 } = options;
    const filtered = [];

    const sorted = [...candidates].sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (b.variationCount !== a.variationCount) return b.variationCount - a.variationCount;
        const aPrefixLen = a.prefixTokens ? a.prefixTokens.length : a.prefix.split(' ').filter(Boolean).length;
        const bPrefixLen = b.prefixTokens ? b.prefixTokens.length : b.prefix.split(' ').filter(Boolean).length;
        return bPrefixLen - aPrefixLen;
    });

    for (const candidate of sorted) {
        let isDominated = false;

        for (let i = 0; i < filtered.length; i++) {
            const kept = filtered[i];
            const overlapInfo = evaluatePatternOverlap(candidate, kept, { overlapThreshold, maxShift });
            if (!overlapInfo) continue;

            const preferKept = preferFirstPattern(kept, candidate, {
                shiftA: overlapInfo.shiftB,
                shiftB: overlapInfo.shiftA,
            });

            if (preferKept) {
                isDominated = true;
                break;
            }

            filtered.splice(i, 1);
            i--;
        }

        if (!isDominated) {
            filtered.push(candidate);
        }
    }

    return filtered;
}

function cullSubstrings(frequenciesObject) {
    // This function removes overlapping/substring phrases to prevent duplicates
    // while keeping the highest scoring versions

    const culledFrequencies = { ...frequenciesObject };
    const sortedPhrases = Object.keys(culledFrequencies).sort((a, b) => b.length - a.length);
    const phrasesToRemove = new Set();

    // First pass: Remove exact duplicates, keeping higher scores
    const phraseMap = new Map();
    for (const [phrase, score] of Object.entries(culledFrequencies)) {
        const normalizedPhrase = phrase.toLowerCase().trim();
        if (phraseMap.has(normalizedPhrase)) {
            // Keep the one with higher score
            const existingScore = phraseMap.get(normalizedPhrase).score;
            if (score <= existingScore) {
                phrasesToRemove.add(phrase);
            } else {
                phrasesToRemove.add(phraseMap.get(normalizedPhrase).phrase);
                phraseMap.set(normalizedPhrase, { phrase, score });
            }
        } else {
            phraseMap.set(normalizedPhrase, { phrase, score });
        }
    }

    // Second pass: Remove substrings if they have significantly lower scores
    // This prevents the duplicate overlapping phrases issue
    // OPTIMIZATION: Limit to top phrases to avoid O(n²) complexity on large sets
    const maxPhrasesToCheck = Math.min(sortedPhrases.length, 500);

    for (let i = 0; i < maxPhrasesToCheck; i++) {
        const longerPhrase = sortedPhrases[i];
        if (phrasesToRemove.has(longerPhrase)) continue;

        const longerScore = culledFrequencies[longerPhrase];

        // Only check phrases that could potentially be substrings
        for (let j = i + 1; j < maxPhrasesToCheck; j++) {
            const shorterPhrase = sortedPhrases[j];
            if (phrasesToRemove.has(shorterPhrase)) continue;

            // Quick length check before expensive string operation
            if (shorterPhrase.length >= longerPhrase.length) continue;

            // Check if shorter phrase is contained in longer phrase
            if (longerPhrase.includes(shorterPhrase)) {
                const shorterScore = culledFrequencies[shorterPhrase];

                // Remove the shorter phrase if:
                // 1. The longer phrase has a higher or similar score (within 20%)
                // 2. OR the phrases overlap significantly (more than 70% of shorter phrase)
                const scoreDifference = Math.abs(longerScore - shorterScore) / Math.max(longerScore, shorterScore);
                const overlapRatio = shorterPhrase.length / longerPhrase.length;

                if (scoreDifference < 0.2 || overlapRatio > 0.7) {
                    // Keep the one with higher score
                    if (longerScore >= shorterScore) {
                        phrasesToRemove.add(shorterPhrase);
                    } else {
                        phrasesToRemove.add(longerPhrase);
                        break; // No need to check more shorter phrases for this longer one
                    }
                }
            }
        }
    }

    phrasesToRemove.forEach(phrase => {
        delete culledFrequencies[phrase];
    });
    return culledFrequencies;
}


// --- Analyzer Class ---
export class Analyzer {
    constructor(settings, callGenericPopup, POPUP_TYPE, toastr, saveSettingsDebounced) {
        this.settings = settings;
        this.callGenericPopup = callGenericPopup;
        this.POPUP_TYPE = POPUP_TYPE;
        this.toastr = toastr;
        this.saveSettingsDebounced = saveSettingsDebounced;

        this.ngramFrequencies = new Map();
        this.slopCandidates = new Set();
        this.analyzedLeaderboardData = { merged: {}, remaining: {} };
        this.messageCounterForTrigger = 0;
        this.totalAiMessagesProcessed = 0;
        this.isAnalyzingHistory = false;
        this.lastAnalysisMessageCount = 0; // Track when analysis was last performed
        this.isUpdatingMacro = false; // Flag to prevent recursive macro updates

        this.effectiveWhitelist = new Set();
        this.updateEffectiveWhitelist();
    }

    updateEffectiveWhitelist() {
        // Note: effectiveWhitelist is deprecated but kept for compatibility
        // The actual whitelist logic is now in isPhraseLowQuality
        const userWhitelist = new Set((this.settings.whitelist || []).map(w => w.toLowerCase()));
        this.effectiveWhitelist = new Set([...defaultNames, ...commonWords, ...userWhitelist]);
        console.log(`${LOG_PREFIX} User whitelist updated. Size: ${userWhitelist.size}`);
    }

    getWordStats(phrase, userWhitelistSet = null) {
        if (!phrase || typeof phrase !== 'string') {
            return { total: 0, meaningfulCount: 0, commonCount: 0, hasWhitelistedWord: false };
        }

        const words = phrase.split(' ').filter(Boolean);
        if (words.length === 0) {
            return { total: 0, meaningfulCount: 0, commonCount: 0, hasWhitelistedWord: false };
        }

        const whitelist = userWhitelistSet || new Set((this.settings.whitelist || []).map(w => w.toLowerCase()));

        let meaningfulCount = 0;
        let commonCount = 0;
        let hasWhitelistedWord = false;

        for (const word of words) {
            const lowerWord = word.toLowerCase();
            if (whitelist.has(lowerWord) || defaultNames.has(lowerWord)) {
                hasWhitelistedWord = true;
            }

            if (commonWords.has(lowerWord)) {
                commonCount++;
            } else {
                meaningfulCount++;
            }
        }

        return {
            words,
            total: words.length,
            meaningfulCount,
            commonCount,
            hasWhitelistedWord,
            allCommon: meaningfulCount === 0,
        };
    }

    isPhraseLowQuality(wordStats) {
        if (!wordStats || typeof wordStats !== 'object') return true;

        // Filter 1: Must be at least NGRAM_MIN words long.
        if (wordStats.total < NGRAM_MIN) return true;

        // Filter 2: Check if phrase contains any user-whitelisted words or character names
        // These should cause phrases to be ignored entirely
        if (wordStats.hasWhitelistedWord) return true;

        // Filter 3: Must contain at least one non-common word to be interesting
        if (wordStats.allCommon) return true;

        // Filter 4: Require at least two meaningful (non-common) words to avoid stopword-heavy phrases
        if (wordStats.meaningfulCount < 2) return true;

        return false;
    }

    calculateEntryScore(entry, wordStats, chunkType) {
        if (!entry || !wordStats) {
            return 0;
        }

        const distinctMessages = entry.messageCount || (entry.messageIds ? entry.messageIds.size : 0) || 0;
        if (distinctMessages <= 0) {
            return 0;
        }

        const totalOccurrences = entry.count || 0;
        const averageOccurrences = distinctMessages > 0 ? totalOccurrences / distinctMessages : 0;

        const totalWords = wordStats.total || entry.ngramLength || NGRAM_MIN;
        const meaningfulRatio = totalWords > 0 ? (wordStats.meaningfulCount || 0) / totalWords : 0;
        let wordQualityMultiplier = 0.7 + (meaningfulRatio * 0.6);

        if (wordStats.meaningfulCount < 2) {
            wordQualityMultiplier -= 0.2;
        }

        if ((wordStats.commonCount || 0) >= (wordStats.meaningfulCount || 0)) {
            wordQualityMultiplier -= 0.25;
        }

        wordQualityMultiplier = Math.max(0.45, Math.min(1.2, wordQualityMultiplier));

        const ngramLength = entry.ngramLength || totalWords || NGRAM_MIN;
        const lengthSeverity = Math.min(Math.max(ngramLength - (NGRAM_MIN - 1), 0) / 6, 1);
        const chunkFactor = chunkType === 'narration' ? 1.05 : 1;

        const messageSeverity = Math.min(distinctMessages / 6, 1);
        const repetitionSeverity = averageOccurrences > 1
            ? Math.min((averageOccurrences - 1) / 3, 1)
            : 0;

        let combinedSeverity = (messageSeverity * 0.6) + (repetitionSeverity * 0.25) + (lengthSeverity * 0.15);
        combinedSeverity *= wordQualityMultiplier;
        combinedSeverity *= chunkFactor;

        const blacklistWeight = this.getBlacklistWeight(entry.original || '');
        const blacklistSeverity = Math.min(3, Math.max(0, blacklistWeight * 0.5));

        let finalScore = (combinedSeverity * 10) + blacklistSeverity;
        if (!Number.isFinite(finalScore)) {
            finalScore = 0;
        }

        return Math.max(0, Math.min(10, finalScore));
    }

    getBlacklistWeight(phrase) {
        const blacklist = this.settings.blacklist || {};
        if (Object.keys(blacklist).length === 0) return 0;
        const lowerCasePhrase = phrase.toLowerCase();
        let maxWeight = 0;
        for (const blacklistedTerm in blacklist) {
            if (lowerCasePhrase.includes(blacklistedTerm)) {
                maxWeight = Math.max(maxWeight, blacklist[blacklistedTerm]);
            }
        }
        return maxWeight;
    }

    analyzeAndTrackFrequency(text) {
        const cleanText = stripMarkup(text);
        if (!cleanText.trim()) return;

        // Use current settings values, not fallback defaults
        const NGRAM_MAX = this.settings.ngramMax;
        const SLOP_THRESHOLD = this.settings.slopThreshold;
        const userWhitelistSet = new Set((this.settings.whitelist || []).map(w => w.toLowerCase()));

        // Debug log settings values occasionally
        if (this.totalAiMessagesProcessed % 50 === 0) {
            console.log(`${LOG_PREFIX} Current analysis settings:`, {
                ngramMax: NGRAM_MAX,
                slopThreshold: SLOP_THRESHOLD,
                decayRate: this.settings.decayRate,
                decayInterval: this.settings.decayInterval,
                patternMinCommon: this.settings.patternMinCommon
            });
        }

        // CRITICAL CHANGE: Split text into sentences first to prevent cross-sentence n-grams.
        const sentences = cleanText.match(/[^.!?]+[.!?]+["]?/g) || [cleanText];

        for (const sentence of sentences) {
            if (!sentence.trim()) continue;

            const isDialogue = /["']/.test(sentence.trim().substring(0, 10));
            const chunkType = isDialogue ? 'dialogue' : 'narration';

            const originalWords = sentence.replace(/[.,!?]/g, '').toLowerCase().split(/\s+/).filter(Boolean);
            const lemmatizedWords = originalWords.map(word => lemmaMap.get(word) || word);

            for (let n = NGRAM_MIN; n <= NGRAM_MAX; n++) {
                if (originalWords.length < n) continue;

                const originalNgrams = generateNgrams(originalWords, n);
                const lemmatizedNgrams = generateNgrams(lemmatizedWords, n);

                for (let i = 0; i < originalNgrams.length; i++) {
                    const originalNgram = originalNgrams[i];
                    const lemmatizedNgram = lemmatizedNgrams[i];

                    const wordStats = this.getWordStats(originalNgram, userWhitelistSet);
                    if (this.isPhraseLowQuality(wordStats)) {
                        continue;
                    }

                    const currentMessageIndex = this.totalAiMessagesProcessed;
                    let entry = this.ngramFrequencies.get(lemmatizedNgram);

                    if (!entry) {
                        entry = {
                            count: 0,
                            score: 0,
                            messageIds: new Set(),
                            messageCount: 0,
                            lastSeenMessageIndex: currentMessageIndex,
                            original: originalNgram,
                            contextSentence: sentence,
                            wordStats,
                            ngramLength: wordStats.total || n,
                        };
                        this.ngramFrequencies.set(lemmatizedNgram, entry);
                    } else {
                        entry.wordStats = wordStats;
                        entry.ngramLength = wordStats.total || entry.ngramLength || n;
                    }

                    const isNewMessageOccurrence = !entry.messageIds.has(currentMessageIndex);

                    if (isNewMessageOccurrence) {
                        entry.messageIds.add(currentMessageIndex);
                        entry.messageCount = entry.messageIds.size;
                    } else if (!entry.messageCount && entry.messageIds) {
                        entry.messageCount = entry.messageIds.size;
                    }
                    entry.count = (entry.count || 0) + 1;
                    entry.lastSeenMessageIndex = currentMessageIndex;
                    entry.original = originalNgram;
                    entry.contextSentence = sentence;
                    entry.wordStats = wordStats;

                    const previousScore = entry.score || 0;
                    entry.score = this.calculateEntryScore(entry, wordStats, chunkType);

                    if (entry.score >= SLOP_THRESHOLD && previousScore < SLOP_THRESHOLD) {
                        this.processNewSlopCandidate(lemmatizedNgram);
                    }
                }
            }
        }
    }

    processNewSlopCandidate(newPhraseLemmatized) {
        // Simply add all candidates without removing substrings
        // The substring culling will happen later during pattern merging
        this.slopCandidates.add(newPhraseLemmatized);
    }
    
    pruneOldNgrams() {
        const DECAY_RATE = this.settings.decayRate || 10; // Default 10% decay
        const DECAY_INTERVAL = this.settings.decayInterval || 10; // Default interval of 10 messages
        const DECAY_MULTIPLIER = 1 - (DECAY_RATE / 100); // Convert percentage to multiplier
        
        let decayedCount = 0;
        
        for (const [ngram, data] of this.ngramFrequencies.entries()) {
            const messageAge = this.totalAiMessagesProcessed - data.lastSeenMessageIndex;
            
            if (messageAge > 0) {
                // Calculate how many decay cycles to apply based on message age
                const decayCycles = Math.floor(messageAge / DECAY_INTERVAL);
                
                if (decayCycles > 0) {
                    // Apply compound decay for the number of cycles
                    const totalDecayMultiplier = Math.pow(DECAY_MULTIPLIER, decayCycles);
                    data.score *= totalDecayMultiplier;
                    decayedCount++;
                }
            }
        }
        
        if (decayedCount > 0) {
            console.log(`${LOG_PREFIX} Decayed ${decayedCount} phrase scores (${DECAY_RATE}% per ${DECAY_INTERVAL} messages)`);
        }
    }

    pruneDuringManualAnalysis() {
        let prunedCount = 0;
        for (const [ngram, data] of this.ngramFrequencies.entries()) {
            if (data.score < 2 && data.count < 2) { 
                this.ngramFrequencies.delete(ngram);
                this.slopCandidates.delete(ngram);
                prunedCount++;
            }
        }
        if (prunedCount > 0) {
            console.log(`${LOG_PREFIX} [Manual Analysis] Pruned ${prunedCount} very low-score n-grams from chunk.`);
        }
    }

    filterRedundantVariations(variationSet) {
        if (!variationSet || variationSet.size <= 1) {
            return new Set(variationSet);
        }

        const variations = Array.from(variationSet).filter(v => typeof v === 'string' && v.trim().length > 0);
        if (variations.length <= 1) {
            return new Set(variations);
        }

        // Sort by word-length descending to prioritize more specific suffixes first
        variations.sort((a, b) => {
            const aWords = a.split(' ').filter(Boolean).length;
            const bWords = b.split(' ').filter(Boolean).length;
            if (bWords !== aWords) return bWords - aWords;
            return b.length - a.length;
        });

        const keptVariations = [];
        const keptWordLists = [];

        for (const variation of variations) {
            const words = variation.split(' ').filter(Boolean);
            let isCovered = false;

            for (const existingWords of keptWordLists) {
                if (existingWords.length < words.length) {
                    continue;
                }

                let matches = true;
                for (let i = 0; i < words.length; i++) {
                    if (existingWords[i] !== words[i]) {
                        matches = false;
                        break;
                    }
                }

                if (matches) {
                    isCovered = true;
                    break;
                }
            }

            if (!isCovered) {
                keptVariations.push(variation);
                keptWordLists.push(words);
            }
        }

        return new Set(keptVariations);
    }

    findAndMergePatterns(frequenciesObjectWithOriginals) {
        // OPTIMIZATION: Early exit if no data
        if (!frequenciesObjectWithOriginals || Object.keys(frequenciesObjectWithOriginals).length === 0) {
            return { merged: {}, remaining: {} };
        }

        const PATTERN_MIN_COMMON_WORDS = this.settings.patternMinCommon;
        const phraseStatsMap = {};

        for (const data of Object.values(frequenciesObjectWithOriginals)) {
            if (!data || !data.original) continue;

            const originalPhrase = data.original;
            if (!phraseStatsMap[originalPhrase]) {
                phraseStatsMap[originalPhrase] = {
                    score: 0,
                    occurrences: 0,
                    messageIds: new Set(),
                };
            }

            phraseStatsMap[originalPhrase].score = Math.max(
                phraseStatsMap[originalPhrase].score || 0,
                Number.isFinite(data.score) ? data.score : 0,
            );
            phraseStatsMap[originalPhrase].occurrences += data.count || 0;

            if (data.messageIds && typeof data.messageIds.forEach === 'function') {
                data.messageIds.forEach(id => phraseStatsMap[originalPhrase].messageIds.add(id));
            } else if (Number.isFinite(data.lastSeenMessageIndex)) {
                phraseStatsMap[originalPhrase].messageIds.add(data.lastSeenMessageIndex);
            }
        }

        if (Object.keys(phraseStatsMap).length === 0) {
            return { merged: {}, remaining: {} };
        }

        // Apply substring culling to remove redundant shorter phrases (based on score)
        const scoreOnlyMap = {};
        for (const [phrase, stats] of Object.entries(phraseStatsMap)) {
            scoreOnlyMap[phrase] = stats.score;
        }
        const culledScores = cullSubstrings(scoreOnlyMap);

        const culledStats = {};
        for (const phrase of Object.keys(culledScores)) {
            if (phraseStatsMap[phrase]) {
                culledStats[phrase] = phraseStatsMap[phrase];
            }
        }

        const trieRoot = buildPhraseTrie(culledStats);
        const patternCandidates = collectPatternCandidatesFromTrie(
            trieRoot,
            PATTERN_MIN_COMMON_WORDS,
            variations => this.filterRedundantVariations(variations),
        );
        const dedupedCandidates = deduplicatePatternCandidates(patternCandidates);
        const filteredCandidates = filterContainedPatternCandidates(dedupedCandidates, {
            overlapThreshold: 0.6,
            maxShift: 3,
        });

        const mergedPatterns = {};
        const consumedPhrases = new Set();

        for (const candidate of filteredCandidates) {
            if (!candidate.prefix || candidate.variations.length < 2) continue;

            const patternKey = `${candidate.prefix}|${candidate.variations.join('/')}`;
            const messageCap = this.totalAiMessagesProcessed > 0
                ? this.totalAiMessagesProcessed
                : candidate.messageIds.size;
            const cappedMessageIds = new Set();
            for (const id of candidate.messageIds) {
                if (cappedMessageIds.size >= messageCap) break;
                cappedMessageIds.add(id);
            }

            mergedPatterns[patternKey] = {
                score: candidate.score,
                occurrences: candidate.occurrences,
                messageIds: cappedMessageIds,
                variationCount: Math.max(1, candidate.variationCount),
            };

            candidate.phraseSet.forEach(phrase => consumedPhrases.add(phrase));
        }

        // For remaining phrases, apply very strict filtering
        // We want to focus on patterns, not random standalone phrases
        const remaining = {};

        // Option to completely disable standalone phrases (focus only on patterns)
        const includeStandalone = this.settings.includeStandalonePhrases !== false; // Default true for compatibility

        if (includeStandalone) {
            // If including standalone, use a much higher threshold to filter noise
            const STANDALONE_THRESHOLD_MULTIPLIER = 1.35; // Standalone phrases need a higher threshold
            const standaloneThreshold = Math.min(10, (this.settings.slopThreshold || 5) * STANDALONE_THRESHOLD_MULTIPLIER);

            for (const [phrase, stats] of Object.entries(culledStats)) {
                if (consumedPhrases.has(phrase)) continue;
                if ((stats.score || 0) >= standaloneThreshold) {
                    const messageIds = stats.messageIds instanceof Set ? stats.messageIds : new Set();
                    remaining[phrase] = {
                        score: stats.score || 0,
                        messageCount: messageIds.size,
                        occurrences: stats.occurrences || 0,
                    };
                }
            }
        }

        const normalizedMerged = {};
        for (const [pattern, data] of Object.entries(mergedPatterns)) {
            const messageCount = data?.messageIds && typeof data.messageIds.size === 'number'
                ? data.messageIds.size
                : (data?.messageCount ?? 0);
            if (!Number.isFinite(messageCount) || messageCount <= 1) {
                continue;
            }
            const variationCount = Math.max(1, data?.variationCount ?? 1);
            const rawScore = Number(data?.score ?? 0);
            const normalizedScore = Number.isFinite(rawScore)
                ? Math.min(10, rawScore)
                : 0;
            normalizedMerged[pattern] = {
                score: Number.isFinite(normalizedScore) ? normalizedScore : 0,
                messageCount,
                occurrences: data?.occurrences ?? 0,
                variationCount,
            };
        }

        const normalizedRemaining = {};
        for (const [phrase, data] of Object.entries(remaining)) {
            const messageCount = data?.messageCount ?? 0;
            if (!Number.isFinite(messageCount) || messageCount <= 1) {
                continue;
            }
            const rawScore = Number(data?.score ?? 0);
            normalizedRemaining[phrase] = {
                score: Math.min(10, Number.isFinite(rawScore) ? rawScore : 0),
                messageCount,
                occurrences: data?.occurrences ?? 0,
            };
        }

        return { merged: normalizedMerged, remaining: normalizedRemaining };
    }


    performIntermediateAnalysis() {
        if (this.ngramFrequencies.size === 0) {
            console.log(`${LOG_PREFIX} Skipping intermediate analysis - no n-grams collected yet.`);
            this.analyzedLeaderboardData = { merged: {}, remaining: {} };
            this.lastAnalysisMessageCount = this.totalAiMessagesProcessed;
            return;
        }

        let messagesSinceLast = this.totalAiMessagesProcessed - this.lastAnalysisMessageCount;
        if (messagesSinceLast < 0) {
            // Handle counter resets (e.g., manual re-analysis)
            this.lastAnalysisMessageCount = 0;
            messagesSinceLast = this.totalAiMessagesProcessed;
        }

        // OPTIMIZATION: Skip if already analyzed recently (within last 5 messages)
        if (this.lastAnalysisMessageCount !== 0 && messagesSinceLast < 5) {
            console.log(`${LOG_PREFIX} Skipping redundant analysis - only ${messagesSinceLast} new AI messages since last analysis (last at ${this.lastAnalysisMessageCount})`);
            return;
        }
        this.lastAnalysisMessageCount = this.totalAiMessagesProcessed;

        const candidatesWithData = {};
        for (const [phrase, data] of this.ngramFrequencies.entries()) {
            if (data.score > 1) {
                candidatesWithData[phrase] = data;
            }
        }
        const sortedCandidates = Object.entries(candidatesWithData).sort((a, b) => b[1].score - a[1].score);
        const limitedCandidates = Object.fromEntries(sortedCandidates.slice(0, CANDIDATE_LIMIT_FOR_ANALYSIS));

        if (Object.keys(candidatesWithData).length > CANDIDATE_LIMIT_FOR_ANALYSIS) {
            console.log(`${LOG_PREFIX} [Perf] Limited candidates from ${Object.keys(candidatesWithData).length} to ${CANDIDATE_LIMIT_FOR_ANALYSIS} BEFORE heavy processing.`);
        }
        
        const { merged, remaining } = this.findAndMergePatterns(limitedCandidates);
        
        const mergedEntries = Object.entries(merged).sort((a, b) => (b[1]?.score ?? 0) - (a[1]?.score ?? 0));
        const allRemainingEntries = Object.entries(remaining).sort((a, b) => (b[1]?.score ?? 0) - (a[1]?.score ?? 0));
        
        this.analyzedLeaderboardData = {
            merged: Object.fromEntries(mergedEntries),
            remaining: Object.fromEntries(allRemainingEntries),
        };
    }

    showFrequencyLeaderboard() {
        
        const { merged: mergedEntries, remaining: remainingEntries } = this.analyzedLeaderboardData;
        let contentHtml;
        const isProcessedDataAvailable = (mergedEntries && Object.keys(mergedEntries).length > 0) || (remainingEntries && Object.keys(remainingEntries).length > 0);

        if (isProcessedDataAvailable) {
            // Path 1: Show the fully processed, patterned data (the best view)
            const mergedRows = Object.entries(mergedEntries).map(([phrase, data]) => {
                const scoreValue = Number(data?.score ?? 0);
                const responseCountSource = data?.messageCount ?? (data?.messageIds && typeof data.messageIds.size === 'number' ? data.messageIds.size : 0);
                const responseCountValue = Number(responseCountSource);
                const safeScore = Number.isFinite(scoreValue) ? scoreValue : 0;
                const safeResponseCount = Number.isFinite(responseCountValue) ? Math.max(0, Math.round(responseCountValue)) : 0;

                // Format patterns with | separator for better display
                let displayPhrase = phrase;
                if (phrase.includes('|')) {
                    const [template, variations] = phrase.split('|');
                    displayPhrase = `${template.trim()} [${variations}]`;
                }
                return `<tr class="is-pattern"><td>${this.escapeHtml(displayPhrase)}</td><td>${safeResponseCount}</td><td>${safeScore.toFixed(1)}</td></tr>`;
            }).join('');
            const remainingRows = Object.entries(remainingEntries).map(([phrase, data]) => {
                const scoreValue = Number(data?.score ?? 0);
                const responseCountSource = data?.messageCount ?? (data?.messageIds && typeof data.messageIds.size === 'number' ? data.messageIds.size : 0);
                const responseCountValue = Number(responseCountSource);
                const safeScore = Number.isFinite(scoreValue) ? scoreValue : 0;
                const safeResponseCount = Number.isFinite(responseCountValue) ? Math.max(0, Math.round(responseCountValue)) : 0;
                return `<tr><td>${this.escapeHtml(phrase)}</td><td>${safeResponseCount}</td><td>${safeScore.toFixed(1)}</td></tr>`;
            }).join('');
            
            contentHtml = `<p>Showing <strong>processed and patterned</strong> slop data. Phrases in <strong>bold orange</strong> are detected patterns. This list updates automatically every 10 messages.</p>
                           <table class="prose-polisher-frequency-table">
                               <thead><tr><th>Repetitive Phrase or Pattern</th><th>Responses</th><th>Slop Score</th></tr></thead>
                               <tbody>${mergedRows}${remainingRows}</tbody>
                           </table>`;
        } else if (this.ngramFrequencies.size > 0) {
            // Path 2 (Fallback): Show raw, unprocessed data for immediate feedback
            const rawEntries = Array.from(this.ngramFrequencies.values())
                .filter(data => data.score > 0) // Only show items with a score
                .sort((a, b) => b.score - a.score);

            const rawRows = rawEntries.map(data => {
                const scoreValue = Number(data?.score ?? 0);
                const responseCountSource = data?.messageCount ?? (data?.messageIds && typeof data.messageIds.size === 'number' ? data.messageIds.size : 0);
                const responseCountValue = Number(responseCountSource);
                const safeScore = Number.isFinite(scoreValue) ? scoreValue : 0;
                const safeResponseCount = Number.isFinite(responseCountValue) ? Math.max(0, Math.round(responseCountValue)) : 0;
                return `<tr><td>${this.escapeHtml(data.original)}</td><td>${safeResponseCount}</td><td>${safeScore.toFixed(1)}</td></tr>`;
            }).join('');
            
            contentHtml = `<p>Showing <strong>raw, unprocessed</strong> n-grams detected so far. This data is collected on every AI message and will be processed into patterns periodically.</p>
                           <table class="prose-polisher-frequency-table">
                               <thead><tr><th>Detected Phrase</th><th>Responses</th><th>Slop Score</th></tr></thead>
                               <tbody>${rawRows}</tbody>
                           </table>`;
        } else {
            // Path 3 (Final Fallback): Nothing has been detected at all
            contentHtml = '<p>No repetitive phrases have been detected yet. Send some AI messages to begin analysis.</p>';
        }

        this.callGenericPopup(contentHtml, this.POPUP_TYPE.TEXT, "Live Frequency Data (Slop Score)", { wide: true, large: true });
    }

   escapeHtml(unsafe) {
        if (typeof unsafe !== 'string') return '';
        return unsafe
             .replace(/&/g, "&amp;")
             .replace(/</g, "&lt;")
             .replace(/>/g, "&gt;")
             .replace(/"/g, "&quot;")
             .replace(/'/g, "&#039;");
    }

    showWhitelistManager() {
        const settings = this.settings;
        const container = document.createElement('div');
        container.className = 'prose-polisher-whitelist-manager';
        container.innerHTML = `
            <h4>Whitelist Manager</h4>
            <p>Add approved words to this list (e.g., character names, specific jargon). Any phrase containing these words will be <strong>completely ignored</strong> by the analyzer. Default character names are already filtered out automatically.</p>
            <div class="list-container">
                <ul id="pp-whitelist-list"></ul>
            </div>
            <div class="add-controls">
                <input type="text" id="pp-whitelist-input" class="text_pole" placeholder="Add a word to your whitelist...">
                <button id="pp-whitelist-add-btn" class="menu_button">Add</button>
            </div>
        `;
        const listElement = container.querySelector('#pp-whitelist-list');
        const inputElement = container.querySelector('#pp-whitelist-input');
        const addButton = container.querySelector('#pp-whitelist-add-btn');

        const renderWhitelist = () => {
            listElement.innerHTML = '';
            (settings.whitelist || []).sort().forEach(originalWord => {
                const item = document.createElement('li');
                item.className = 'list-item';
                const displayWord = this.escapeHtml(originalWord);
                item.innerHTML = `<span>${displayWord}</span><i class="fa-solid fa-trash-can delete-btn" data-word="${originalWord}"></i>`;
                item.querySelector('.delete-btn').addEventListener('pointerup', (event) => {
                    const wordToRemove = event.target.dataset.word; 
                    settings.whitelist = (settings.whitelist || []).filter(w => w !== wordToRemove);
                    this.saveSettingsDebounced();
                    this.updateEffectiveWhitelist(); 
                    renderWhitelist();
                });
                listElement.appendChild(item);
            });
        };

        const addWord = () => {
            const newWord = inputElement.value.trim().toLowerCase();
            if (newWord && !(settings.whitelist || []).includes(newWord)) {
                if (!settings.whitelist) settings.whitelist = [];
                settings.whitelist.push(newWord);
                this.saveSettingsDebounced();
                this.updateEffectiveWhitelist(); 
                renderWhitelist();
                inputElement.value = '';
            }
            inputElement.focus();
        };

        addButton.addEventListener('pointerup', addWord);
        inputElement.addEventListener('keydown', (event) => { if (event.key === 'Enter') addWord(); });

        renderWhitelist();
        this.callGenericPopup(container, this.POPUP_TYPE.DISPLAY, "Whitelist Manager", { wide: false, large: false });
    }

    showBlacklistManager() {
        const settings = this.settings;
        const container = document.createElement('div');
        container.className = 'prose-polisher-blacklist-manager';
        container.innerHTML = `
            <h4>Blacklist Manager (Weighted)</h4>
            <p>Add words to this list with a weight (1-10). Any phrase containing these words will get a score boost equal to the weight, making them much more likely to be flagged as slop.</p>
            <div class="list-container">
                <ul id="pp-blacklist-list"></ul>
            </div>
            <div class="add-controls">
                <input type="text" id="pp-blacklist-input" class="text_pole" placeholder="e.g., suddenly, began to" style="flex-grow: 3;">
                <input type="number" id="pp-blacklist-weight" class="text_pole" placeholder="Weight" value="3" min="1" max="10" style="flex-grow: 1;">
                <button id="pp-blacklist-add-btn" class="menu_button">Add</button>
            </div>
        `;
        const listElement = container.querySelector('#pp-blacklist-list');
        const inputElement = container.querySelector('#pp-blacklist-input');
        const weightElement = container.querySelector('#pp-blacklist-weight');
        const addButton = container.querySelector('#pp-blacklist-add-btn');

        const renderBlacklist = () => {
            listElement.innerHTML = '';
            const sortedBlacklist = Object.entries(settings.blacklist || {}).sort((a, b) => a[0].localeCompare(b[0]));
            
            sortedBlacklist.forEach(([originalWordKey, weight]) => {
                const item = document.createElement('li');
                item.className = 'list-item';
                const displayWord = this.escapeHtml(originalWordKey);
                item.innerHTML = `<span><strong>${displayWord}</strong> (Weight: ${weight})</span><i class="fa-solid fa-trash-can delete-btn" data-word="${originalWordKey}"></i>`;
                
                item.querySelector('.delete-btn').addEventListener('pointerup', (event) => {
                    const wordKeyToRemove = event.target.dataset.word; 
                    if (wordKeyToRemove && settings.blacklist && settings.blacklist.hasOwnProperty(wordKeyToRemove)) {
                        delete settings.blacklist[wordKeyToRemove];
                        this.saveSettingsDebounced();
                        renderBlacklist(); 
                    }
                });
                listElement.appendChild(item);
            });
        };

        const addWord = () => {
            const newWord = inputElement.value.trim().toLowerCase();
            const weight = parseInt(weightElement.value, 10);

            if (newWord && !isNaN(weight) && weight >= 1 && weight <= 10) {
                if (!settings.blacklist) settings.blacklist = {};
                settings.blacklist[newWord] = weight;
                this.saveSettingsDebounced();
                renderBlacklist();
                inputElement.value = '';
                inputElement.focus();
            } else {
                this.toastr.warning("Please enter a valid word and a weight between 1 and 10.");
            }
        };

        addButton.addEventListener('pointerup', addWord);
        inputElement.addEventListener('keydown', (event) => { if (event.key === 'Enter') addWord(); });
        weightElement.addEventListener('keydown', (event) => { if (event.key === 'Enter') addWord(); });
        
        renderBlacklist();
        this.callGenericPopup(container, this.POPUP_TYPE.DISPLAY, "Blacklist Manager", { wide: false, large: false });
    }


    clearFrequencyData() {
        this.ngramFrequencies.clear();
        this.slopCandidates.clear();
        this.messageCounterForTrigger = 0;
        this.analyzedLeaderboardData = { merged: {}, remaining: {} };
        this.lastAnalysisMessageCount = 0; // Reset analysis tracking
        this.totalAiMessagesProcessed = 0; // Reset message counter
        this.toastr.success("Prose Polisher frequency data cleared!");
    }

    incrementProcessedMessages() {
         this.totalAiMessagesProcessed++;
    }

    getSlopList() {
        const analyzedData = this.analyzedLeaderboardData || { merged: {}, remaining: {} };
        const hasAnalyzedData = (analyzedData.merged && Object.keys(analyzedData.merged).length > 0) ||
            (analyzedData.remaining && Object.keys(analyzedData.remaining).length > 0);

        if (this.ngramFrequencies.size === 0 && !hasAnalyzedData) {
            console.log(`${LOG_PREFIX} No n-gram data collected yet. Returning empty slop list.`);
            return [];
        }

        // If no analyzed data and we're not currently updating macro, perform analysis on demand
        if (!hasAnalyzedData && !this.isUpdatingMacro) {
            console.log(`${LOG_PREFIX} No analyzed data available, performing analysis for getSlopList`);
            this.performIntermediateAnalysis();
        }
        
        const latestData = this.analyzedLeaderboardData || { merged: {}, remaining: {} };
        const SLOP_THRESHOLD = this.settings.slopThreshold;
        const slopList = [];
        
        // Add merged patterns that exceed threshold
        for (const [pattern, data] of Object.entries(latestData.merged || {})) {
            const rawScore = Number(data?.score ?? 0);
            const score = Number.isFinite(rawScore) ? rawScore : 0;
            if (score >= SLOP_THRESHOLD) {
                const roundedScore = Number(score.toFixed(1));
                // Check if this is a pattern with variations (uses | separator)
                if (pattern.includes('|')) {
                    // Split by | to separate template from variations
                    const [template, variationString] = pattern.split('|');
                    
                    if (template && variationString) {
                        const variants = variationString.split('/').map(v => v.trim()).filter(v => v);
                        
                        slopList.push({
                            pattern_template: `${template.trim()} {variant}`,
                            variants: variants,
                            score: roundedScore,
                            type: 'pattern'
                        });
                    } else {
                        // Shouldn't happen but handle as regular phrase
                        slopList.push({
                            phrase: pattern,
                            score: roundedScore,
                            type: 'pattern'
                        });
                    }
                } else {
                    // Pattern without variations
                    slopList.push({
                        phrase: pattern,
                        score: roundedScore,
                        type: 'pattern'
                    });
                }
            }
        }

        // Add remaining individual phrases that exceed threshold
        for (const [phrase, data] of Object.entries(latestData.remaining || {})) {
            const rawScore = Number(data?.score ?? 0);
            const score = Number.isFinite(rawScore) ? rawScore : 0;
            if (score >= SLOP_THRESHOLD) {
                slopList.push({
                    phrase: phrase,
                    score: Number(score.toFixed(1)),
                    type: 'phrase'
                });
            }
        }
        
        // Sort by score descending
        slopList.sort((a, b) => b.score - a.score);
        
        console.log(`${LOG_PREFIX} getSlopList() returning ${slopList.length} items above threshold ${SLOP_THRESHOLD}`);
        return slopList;
    }

    async manualAnalyzeChatHistory() {
        if (this.isAnalyzingHistory) {
            this.toastr.warning("Prose Polisher: Chat history analysis is already in progress.");
            return;
        }

        this.isAnalyzingHistory = true;
        this.toastr.info("Prose Polisher: Starting chat history analysis...", "Chat Analysis", { timeOut: 2000 });
        console.log(`${LOG_PREFIX} Starting manual chat history analysis.`);

        const context = getContext();
        if (!context || !context.chat) {
            this.toastr.error("Prose Polisher: Could not get chat context for analysis.");
            this.isAnalyzingHistory = false;
            return;
        }

        // Check if we have enough messages to analyze
        const aiMessageCount = context.chat.filter(msg => !msg.is_user && msg.mes).length;
        if (aiMessageCount === 0) {
            this.toastr.info("Prose Polisher: No AI messages available to analyze yet.", "Insufficient Data");
            console.log(`${LOG_PREFIX} Manual analysis skipped - no AI messages in chat history.`);
            this.ngramFrequencies.clear();
            this.slopCandidates.clear();
            this.analyzedLeaderboardData = { merged: {}, remaining: {} };
            this.messageCounterForTrigger = 0;
            this.totalAiMessagesProcessed = 0;
            this.lastAnalysisMessageCount = 0;
            this.isAnalyzingHistory = false;
            if (this.updateSlopListMacro) {
                this.updateSlopListMacro();
            }
            return;
        }

        if (aiMessageCount < 5) {
            console.log(`${LOG_PREFIX} Proceeding with manual analysis using limited data set (${aiMessageCount} AI messages). Results may be noisy.`);
        }

        try {
            // Clear existing data
            this.ngramFrequencies.clear();
            this.slopCandidates.clear();
            this.totalAiMessagesProcessed = 0;

            // Log current settings being used for analysis
            console.log(`${LOG_PREFIX} Manual analysis using settings:`, {
                ngramMax: this.settings.ngramMax,
                slopThreshold: this.settings.slopThreshold,
                decayRate: this.settings.decayRate,
                decayInterval: this.settings.decayInterval,
                patternMinCommon: this.settings.patternMinCommon,
                messageLimit: this.settings.messageLimit
            });

            let chatMessages = context.chat;

            // Apply message limit if configured
            const messageLimit = this.settings.messageLimit || -1;
            if (messageLimit > 0) {
                // Get only the last N messages
                chatMessages = chatMessages.slice(-messageLimit);
                console.log(`${LOG_PREFIX} Limited analysis to last ${messageLimit} messages out of ${context.chat.length} total messages`);
            }

            let aiMessagesAnalyzed = 0;
            const batchSize = 10; // Process messages in smaller batches

            // Process messages in batches to avoid blocking UI
            for (let i = 0; i < chatMessages.length; i += batchSize) {
                const batch = chatMessages.slice(i, Math.min(i + batchSize, chatMessages.length));

                for (const message of batch) {
                    if (message.is_user || !message.mes || typeof message.mes !== 'string') {
                        continue;
                    }

                    this.analyzeAndTrackFrequency(message.mes);
                    aiMessagesAnalyzed++;
                    this.totalAiMessagesProcessed++;
                }

                // Yield to UI thread periodically
                if (i + batchSize < chatMessages.length) {
                    await new Promise(resolve => setTimeout(resolve, 0));
                }
            }

            // Apply decay before final analysis
            this.pruneOldNgrams();

            // Perform final analysis
            this.performIntermediateAnalysis();

            // Update macro using the external function to avoid recursion
            if (this.updateSlopListMacro) {
                this.updateSlopListMacro();
            }

            this.isAnalyzingHistory = false;
            this.toastr.success(`Prose Polisher: Analysis complete! Analyzed ${aiMessagesAnalyzed} AI messages.`, "Chat Analysis Complete", { timeOut: 3000 });
            console.log(`${LOG_PREFIX} Manual chat history analysis complete. Analyzed ${aiMessagesAnalyzed} AI messages.`);

            this.showFrequencyLeaderboard();
        } catch (error) {
            console.error(`${LOG_PREFIX} Error during manual chat history analysis:`, error);
            this.toastr.error("Prose Polisher: An error occurred during chat analysis. Check console.", "Chat Analysis Error");
            this.isAnalyzingHistory = false;
        }
    }
}
