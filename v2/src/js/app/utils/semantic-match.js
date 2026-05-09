// Shared semantic-match utilities for Phase 5.
//
// Replaces the substring + JSON.stringify regex patterns scattered across the
// codebase with three deterministic primitives that handle real-world
// matching gotchas:
//
//   1. tokenize(text)        — lowercase + punctuation strip + stopword cull
//   2. expandSynonyms(token) — TS → typescript, k8s → kubernetes, etc.
//   3. bm25Score(...)        — Okapi BM25 relevance, much better than substring
//   4. semanticHas(corpus, term) — "does this resume genuinely mention X?"
//                                 Considers synonyms + word boundaries + tokens
//
// All three sit on window.CBV2.semanticMatch so any module can use them
// without refactoring its existing API.
//
// NOTE: This is purely deterministic — no embeddings, no API calls. Phase 5B
// will layer cosine-similarity on top via a new Edge Function for cases where
// substring/synonym fails (e.g. "machine learning" vs "ML engineer").

(function () {
  window.CBV2 = window.CBV2 || {};
  if (window.CBV2.semanticMatch) return;

  // ---------------------------------------------------------------------------
  // Synonyms — bidirectional. Both keys and values are normalized to lowercase.
  // expandSynonyms(t) returns a Set of every form a writer might use.
  //
  // Strategy:
  //   - Tech aliases (TS ↔ typescript, k8s ↔ kubernetes)
  //   - Pluralization (sprinkler ↔ sprinklers)
  //   - Common abbreviations (ml ↔ machine learning)
  //   - Tooling families (postgres / postgresql / pg)
  //
  // Single source of truth — analytics, resume, and candidate intel share it.
  // ---------------------------------------------------------------------------
  const SYNONYM_GROUPS = [
    ["typescript", "ts"],
    ["javascript", "js"],
    ["node.js", "nodejs", "node"],
    ["next.js", "nextjs"],
    ["react", "reactjs", "react.js"],
    ["vue", "vuejs", "vue.js"],
    ["angular", "angularjs"],
    ["postgresql", "postgres", "pg"],
    ["mongodb", "mongo"],
    ["kubernetes", "k8s"],
    ["ci/cd", "cicd", "continuous integration", "continuous delivery"],
    ["machine learning", "ml"],
    ["deep learning", "dl"],
    ["natural language processing", "nlp"],
    ["amazon web services", "aws"],
    ["google cloud platform", "gcp", "google cloud"],
    ["microsoft azure", "azure"],
    ["python", "py"],
    ["c sharp", "c#", "csharp"],
    ["c plus plus", "c++", "cpp"],
    ["go", "golang"],
    ["objective c", "objective-c", "objc"],
    ["graphql", "gql"],
    ["restful", "rest"],
    ["object oriented programming", "oop"],
    ["test driven development", "tdd"],
    ["user experience", "ux"],
    ["user interface", "ui"],
    ["search engine optimization", "seo"],
    ["software as a service", "saas"],
    ["application programming interface", "api"],
    ["sprinkler systems", "sprinklers", "sprinkler"],
    ["fire protection", "fire safety"],
    ["a/b testing", "ab testing", "split testing"],
    ["product manager", "pm", "product management"],
    ["software engineer", "swe", "software developer"],
    ["lead engineer", "tech lead", "technical lead"],
    ["staff engineer", "staff swe"],
    ["data scientist", "ds"],
    ["data analyst", "data analytics"],
    ["devops", "dev ops", "platform engineering"],
    ["site reliability engineer", "sre"]
  ];

  /** Build a forward+reverse synonym map from the symmetric groups. */
  const SYNONYM_MAP = (function build() {
    const m = new Map();
    SYNONYM_GROUPS.forEach(function (group) {
      const all = group.map(function (t) { return t.toLowerCase(); });
      all.forEach(function (term) {
        const set = m.get(term) || new Set();
        all.forEach(function (other) { set.add(other); });
        m.set(term, set);
      });
    });
    return m;
  })();

  // ---------------------------------------------------------------------------
  // Stopwords — the same set used by candidate.intelligence.js + a few extras
  // BM25 needs to exclude. Consciously SHORT — over-aggressive stopword culling
  // hurts technical relevance more than it helps.
  // ---------------------------------------------------------------------------
  const STOPWORDS = new Set([
    "a", "an", "and", "are", "as", "at", "be", "been", "by", "for", "from",
    "has", "have", "in", "is", "it", "its", "of", "on", "or", "our", "that",
    "the", "their", "they", "this", "to", "we", "was", "were", "will", "with",
    "would", "you", "your", "i", "me", "my", "us", "if", "can", "do", "does",
    "but", "not", "any", "all", "more", "most", "than", "then", "so", "into",
    "about", "also", "such", "between", "during", "while", "after", "before",
    "above", "below", "very", "just", "some", "other"
  ]);

  // Singular ↔ plural normalization. Only the cheap rules — anything more is
  // false positives (Stemmer territory). Keeps "designs" ≈ "design" but
  // doesn't claim "engines" ≈ "engineering".
  function singularize(token) {
    if (token.length <= 3) return token;
    if (token.endsWith("ies") && token.length > 4) return token.slice(0, -3) + "y"; // libraries → library
    if (token.endsWith("ses") || token.endsWith("xes") || token.endsWith("zes")) return token.slice(0, -2);
    if (token.endsWith("s") && !token.endsWith("ss") && !token.endsWith("us")) return token.slice(0, -1);
    return token;
  }

  /**
   * Tokenize a string into a list of normalized tokens.
   * Lowercase, strip punctuation (preserve `+ # . -` for tech terms), drop
   * stopwords, drop tokens shorter than 2 chars.
   */
  function tokenize(text) {
    const raw = String(text == null ? "" : text).toLowerCase();
    if (!raw) return [];
    return raw
      .replace(/[^\w+#./\-\s]+/g, " ")  // keep tech punctuation
      .split(/\s+/)
      .map(function (t) { return t.trim(); })
      .filter(function (t) {
        if (!t || t.length < 2) return false;
        if (STOPWORDS.has(t)) return false;
        return true;
      });
  }

  /** Return the set of synonyms for a token (always includes the token itself). */
  function expandSynonyms(token) {
    const norm = String(token || "").toLowerCase().trim();
    if (!norm) return new Set();
    const known = SYNONYM_MAP.get(norm);
    if (known) return new Set(known);
    // Also try singularized form — "sprinklers" → "sprinkler" → group lookup.
    const singular = singularize(norm);
    if (singular !== norm) {
      const knownSing = SYNONYM_MAP.get(singular);
      if (knownSing) {
        const set = new Set(knownSing);
        set.add(norm);
        return set;
      }
    }
    return new Set([norm]);
  }

  /**
   * Does `corpus` (a string OR pre-tokenized array) genuinely mention `term`?
   * Considers synonyms, word boundaries, singular/plural forms.
   *
   * Returns a boolean. Use this as the synonym-aware drop-in for
   *   `JSON.stringify(resume).toLowerCase().includes(skill)`
   * in places that previously did regex coverage checks.
   */
  function semanticHas(corpus, term) {
    if (!term) return false;
    const tokens = Array.isArray(corpus)
      ? corpus.map(function (t) { return String(t || "").toLowerCase(); })
      : tokenize(corpus);
    if (!tokens.length) return false;
    const tokenSet = new Set(tokens);
    // Build the search-set: term + synonyms + singular form.
    const searchTerms = expandSynonyms(term);
    searchTerms.add(singularize(String(term).toLowerCase()));
    // Multi-word terms (e.g. "machine learning") need a different check —
    // tokenSet only has unigrams. Fall back to substring on the joined corpus.
    const corpusJoined = Array.isArray(corpus)
      ? corpus.join(" ").toLowerCase()
      : String(corpus || "").toLowerCase();
    let found = false;
    searchTerms.forEach(function (t) {
      if (found) return;
      const tt = String(t || "").toLowerCase().trim();
      if (!tt) return;
      if (tt.indexOf(" ") >= 0) {
        // Multi-word — substring with word boundaries on the joined corpus.
        const boundaryPattern = new RegExp(
          "(^|\\W)" + tt.replace(/[.+*?^$()|\[\]\\]/g, "\\$&") + "(\\W|$)",
          "i"
        );
        if (boundaryPattern.test(corpusJoined)) found = true;
      } else {
        if (tokenSet.has(tt)) found = true;
        else if (tokenSet.has(singularize(tt))) found = true;
      }
    });
    return found;
  }

  // ---------------------------------------------------------------------------
  // BM25 ranking — Okapi BM25, the search-relevance gold standard since 1994.
  // Replaces "+14 if title includes term, +8 if tags, +5 if company..." with
  // a math-grounded relevance function that handles term frequency saturation
  // (mentioning "react" 50 times doesn't make a job 50× more relevant) and
  // length normalization (short titles aren't penalized vs. long descriptions).
  //
  // k1 = 1.5  — term-frequency saturation point
  // b  = 0.75 — length-normalization strength
  // ---------------------------------------------------------------------------
  const BM25_K1 = 1.5;
  const BM25_B = 0.75;

  /**
   * Build a BM25 corpus from N documents in a single pass.
   *
   * @param {Array<{id:string,fields:Object<string,string|string[]>}>} docs
   *        Each doc has a stable `id` and a map of field-name → text/list.
   * @param {Object<string,number>} [fieldBoosts]
   *        Optional per-field weighting. Higher = more important.
   *        Defaults to { title:3, tags:2, company:1.5, location:1, body:1 }.
   * @returns {Object} Corpus object with a `score(query)` method.
   */
  function buildBm25(docs, fieldBoosts) {
    const boosts = Object.assign(
      { title: 3, tags: 2, company: 1.5, location: 1, body: 1 },
      fieldBoosts || {}
    );
    const N = docs.length;
    if (!N) {
      return { score: function () { return 0; } };
    }

    // Per-doc tokenized fields + total length.
    const docFields = docs.map(function (d) {
      const out = {};
      let totalLen = 0;
      Object.keys(d.fields || {}).forEach(function (field) {
        const raw = d.fields[field];
        const tokens = tokenize(Array.isArray(raw) ? raw.join(" ") : raw);
        out[field] = tokens;
        totalLen += tokens.length * (boosts[field] || 1);
      });
      return { id: d.id, fields: out, length: Math.max(1, totalLen) };
    });
    const avgDocLen = docFields.reduce(function (s, d) { return s + d.length; }, 0) / N;

    // Build inverted document-frequency index — for each token, how many docs
    // contain it (across any field — synonym-aware so "ts" and "typescript"
    // count as the same term).
    const df = new Map();
    docFields.forEach(function (d) {
      const seen = new Set();
      Object.keys(d.fields).forEach(function (field) {
        d.fields[field].forEach(function (tok) {
          // Canonicalize: use first synonym in the group as the bucket key.
          const canon = canonicalForm(tok);
          if (seen.has(canon)) return;
          seen.add(canon);
        });
      });
      seen.forEach(function (term) {
        df.set(term, (df.get(term) || 0) + 1);
      });
    });

    function idf(term) {
      const n = df.get(term) || 0;
      // BM25 idf with the +0.5 smoothing form.
      return Math.log((N - n + 0.5) / (n + 0.5) + 1);
    }

    return {
      /**
       * Score a single document by id against a query string. Returns a
       * non-negative relevance score; higher = better match.
       */
      score: function (queryText, docId) {
        const qTokens = expandQueryTokens(tokenize(queryText));
        if (!qTokens.length) return 0;
        const doc = docFields.find(function (d) { return d.id === docId; });
        if (!doc) return 0;
        let total = 0;
        qTokens.forEach(function (qt) {
          const qCanon = canonicalForm(qt);
          const inverseDoc = idf(qCanon);
          // Per-field term-frequency, weighted by boost.
          let weightedTf = 0;
          Object.keys(doc.fields).forEach(function (field) {
            const tf = countTermInTokens(doc.fields[field], qt);
            weightedTf += tf * (boosts[field] || 1);
          });
          if (weightedTf === 0) return;
          const num = weightedTf * (BM25_K1 + 1);
          const denom = weightedTf + BM25_K1 * (1 - BM25_B + BM25_B * (doc.length / avgDocLen));
          total += inverseDoc * (num / denom);
        });
        return total;
      },
      /** Score every doc in the corpus; returns sorted [{id, score}, ...]. */
      rank: function (queryText) {
        const out = [];
        docFields.forEach(function (d) {
          const s = this.score(queryText, d.id);
          if (s > 0) out.push({ id: d.id, score: s });
        }.bind(this));
        out.sort(function (a, b) { return b.score - a.score; });
        return out;
      }
    };
  }

  /** Count occurrences of `term` (synonym-aware) in a token array. */
  function countTermInTokens(tokens, term) {
    const expanded = expandSynonyms(term);
    let count = 0;
    tokens.forEach(function (t) {
      if (expanded.has(t) || expanded.has(singularize(t))) count += 1;
    });
    return count;
  }

  /** Pick a canonical form for a synonym group (first member, alphabetically). */
  function canonicalForm(token) {
    const set = SYNONYM_MAP.get(String(token || "").toLowerCase());
    if (!set || !set.size) return String(token || "").toLowerCase();
    return Array.from(set).sort()[0];
  }

  /** Expand query tokens with their synonyms (deduped). */
  function expandQueryTokens(tokens) {
    const out = new Set();
    tokens.forEach(function (t) {
      expandSynonyms(t).forEach(function (s) { out.add(s); });
    });
    return Array.from(out);
  }

  // ---------------------------------------------------------------------------
  // Geo lookup — replaces hardcoded "South Africa" regex in analytics.
  // Lightweight country/major-city detector. Not exhaustive — just covers
  // common patterns so a Toronto user no longer gets "South Africa" as a
  // baseline location score.
  // ---------------------------------------------------------------------------
  const COUNTRY_TOKENS = {
    "south africa": ["south africa", "pretoria", "centurion", "cape town", "johannesburg", "durban", "stellenbosch", "sandton"],
    "united states": ["united states", "usa", "u.s.", "u.s.a.", "new york", "san francisco", "los angeles", "chicago", "boston", "seattle", "austin", "denver", "atlanta", "remote us", "remote, us"],
    "united kingdom": ["united kingdom", "uk", "u.k.", "london", "manchester", "edinburgh", "birmingham", "glasgow", "remote uk"],
    "canada": ["canada", "toronto", "vancouver", "montreal", "calgary", "ottawa", "remote canada"],
    "germany": ["germany", "berlin", "munich", "hamburg", "frankfurt", "cologne", "remote germany"],
    "netherlands": ["netherlands", "amsterdam", "rotterdam", "utrecht", "the hague", "remote netherlands"],
    "france": ["france", "paris", "lyon", "marseille", "remote france"],
    "spain": ["spain", "madrid", "barcelona", "valencia", "remote spain"],
    "australia": ["australia", "sydney", "melbourne", "brisbane", "perth", "remote australia"],
    "india": ["india", "bengaluru", "bangalore", "mumbai", "delhi", "hyderabad", "pune", "chennai", "remote india"],
    "ireland": ["ireland", "dublin", "cork", "remote ireland"],
    "singapore": ["singapore"],
    "uae": ["united arab emirates", "uae", "dubai", "abu dhabi"],
    "remote": ["remote", "anywhere", "work from home", "wfh", "fully remote", "100% remote"]
  };

  /** Detect which country/region the text refers to. Returns "" if unknown. */
  function detectRegion(text) {
    const low = String(text || "").toLowerCase();
    if (!low) return "";
    let bestRegion = "";
    let bestHits = 0;
    Object.keys(COUNTRY_TOKENS).forEach(function (region) {
      const tokens = COUNTRY_TOKENS[region];
      let hits = 0;
      tokens.forEach(function (t) {
        if (low.indexOf(t) >= 0) hits += 1;
      });
      if (hits > bestHits) { bestHits = hits; bestRegion = region; }
    });
    return bestRegion;
  }

  /**
   * Phase 5 replacement for the hardcoded SA regex `locationScore`.
   * Returns a 0-100 score based on whether the candidate's preferred region
   * matches the job's region (or whether the job is remote).
   *
   * @param {string} jobLocationText  — raw job location/description
   * @param {string} candidateRegion  — user's preferred region (from profile)
   *                                    or empty string for any
   */
  function scoreLocationMatch(jobLocationText, candidateRegion) {
    const jobRegion = detectRegion(jobLocationText);
    const cand = (candidateRegion || "").toLowerCase().trim();
    if (jobRegion === "remote") return 90;        // remote = strong location match for everyone
    if (!jobRegion) return 60;                    // unknown — neutral score
    if (!cand) return 65;                         // candidate has no preference — slight boost for a known region
    if (jobRegion === cand) return 92;            // exact region match
    return 38;                                    // mismatch — different region
  }

  // ---------------------------------------------------------------------------
  // Phase 5C: heuristic skill-candidate extractor.
  //
  // Replaces the SKILL_LEXICON hard-gate with a permissive detector that
  // recognises tech-shaped tokens, CamelCase identifiers, multi-word
  // capitalized phrases, and dotted module paths. Any matched candidate is
  // returned alongside lexicon hits so domain-specific skills (Snowflake,
  // RabbitMQ, Datadog, Salesforce, "Marine Biology", "Asset Reliability")
  // are no longer silently dropped just because they're not pre-listed.
  //
  // This is purely deterministic — no embeddings, no API calls. Pair it
  // with the existing lexicon for high-precision known-skill detection,
  // then take the union for high-recall novel-skill detection.
  // ---------------------------------------------------------------------------

  // Tech-shape patterns that indicate "this is probably a skill term":
  //   - CamelCase / PascalCase: TypeScript, GitHub, NestJS
  //   - Dotted: Node.js, Vue.js, F#.NET
  //   - Acronyms (2-5 uppercase letters): AWS, GCP, NLP, REST
  //   - Tech-suffix: -ing/-ops/-DB/-QL/-flow forms (ClickHouse, GraphQL, MongoDB)
  //   - Code-like: kebab-case-with-numbers (k3s, k8s, OAuth2)
  //   - Number-prefixed model names (gpt-4, claude-3, llama-3.3)
  const SHAPE_PATTERNS = [
    /^[A-Z][a-z]+[A-Z][A-Za-z0-9]+$/,             // CamelCase: NestJS, TypeScript, GitHub
    /^[A-Z]{2,6}$/,                                // Acronym: AWS, GCP, NLP, REST, GRAPHQL
    /^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9.]*$/, // Dotted: Node.js, Vue.js
    /^[A-Za-z]+[0-9]+[A-Za-z]*$/,                 // k8s, OAuth2, ES6, gpt4
    /^[A-Z][a-z]+(?:[A-Z][a-z]+)+$/,              // PascalCase: Salesforce, MongoDb
    /^[a-z][a-z0-9]+(?:-[a-z0-9]+){1,3}$/,        // kebab-case: ci-cd, t-sql
    /^[A-Za-z][A-Za-z]+(?:DB|QL|JS|TS|API|SDK|CLI|UI|IDE)$/i, // suffix: MongoDB, GraphQL
  ];

  // Stopword phrases that look skill-shaped but are common English nouns.
  // Used to suppress false positives from the capitalized-phrase pass.
  const PHRASE_STOPWORDS = new Set([
    "Job Description", "About Us", "About The", "Our Team", "Key Responsibilities",
    "Required Skills", "Preferred Skills", "Nice To Have", "Must Have",
    "Years Experience", "Years Of Experience", "Bachelor Degree", "Masters Degree",
    "Equal Opportunity", "Apply Now", "Click Here", "Read More", "Learn More",
    "United States", "United Kingdom", "South Africa", "Cape Town", "New York",
    "Monday Friday", "Full Time", "Part Time", "Remote Work",
  ]);

  function looksLikeTechShape(token) {
    if (!token || token.length < 2 || token.length > 32) return false;
    return SHAPE_PATTERNS.some(function (re) { return re.test(token); });
  }

  function isCapitalizedPhraseToken(t) {
    return /^[A-Z][a-zA-Z0-9+#.\-]{1,28}$/.test(t);
  }

  /**
   * Extract candidate skill terms from raw text using heuristics only.
   * Returns a deduped array (lowercase canonical forms via expandSynonyms).
   * Use as a fallback / supplement to SKILL_LEXICON.
   *
   * @param {string} text
   * @param {{ maxItems?: number }} [opts]
   */
  function extractSkillCandidates(text, opts) {
    const max = (opts && opts.maxItems) || 60;
    const raw = String(text == null ? "" : text);
    if (!raw.trim()) return [];
    const found = new Set();

    // Pass 1: tech-shape tokens. Walk word boundaries, keep the original case
    // for the shape test, but bucket the result lowercased so duplicates merge.
    raw.replace(/[A-Za-z][A-Za-z0-9+#.\-]{1,31}/g, function (tok) {
      if (looksLikeTechShape(tok)) {
        const norm = tok.toLowerCase();
        if (!STOPWORDS.has(norm)) found.add(norm);
      }
      return tok;
    });

    // Pass 2: capitalized 2-3 word phrases that aren't generic English.
    // Splits the corpus into rough sentences then scans each for sequences
    // of capitalized tokens of reasonable length. Cheap; no NLP library.
    const sentences = raw.split(/[.!?\n\r]+/);
    sentences.forEach(function (sentence) {
      const tokens = sentence.split(/\s+/);
      for (let i = 0; i < tokens.length; i++) {
        const cleanT = tokens[i].replace(/[,;:()"']/g, "");
        if (!isCapitalizedPhraseToken(cleanT)) continue;
        // Try 2-word phrase
        const next = i + 1 < tokens.length ? tokens[i + 1].replace(/[,;:()"']/g, "") : "";
        if (next && isCapitalizedPhraseToken(next)) {
          const phrase = cleanT + " " + next;
          if (!PHRASE_STOPWORDS.has(phrase) && phrase.length >= 5 && phrase.length <= 48) {
            found.add(phrase.toLowerCase());
          }
          // 3-word phrase
          const third = i + 2 < tokens.length ? tokens[i + 2].replace(/[,;:()"']/g, "") : "";
          if (third && isCapitalizedPhraseToken(third)) {
            const triple = cleanT + " " + next + " " + third;
            if (!PHRASE_STOPWORDS.has(triple) && triple.length >= 8 && triple.length <= 60) {
              found.add(triple.toLowerCase());
            }
          }
        }
      }
    });

    // Drop bare common words (single-letter or all-stopword fragments)
    const out = [];
    found.forEach(function (term) {
      const t = term.trim();
      if (!t || t.length < 2) return;
      // Skip phrases that are purely stopwords post-split.
      const parts = t.split(/\s+/);
      if (parts.every(function (p) { return STOPWORDS.has(p); })) return;
      out.push(t);
    });
    return out.slice(0, max);
  }

  window.CBV2.semanticMatch = {
    tokenize: tokenize,
    expandSynonyms: expandSynonyms,
    semanticHas: semanticHas,
    buildBm25: buildBm25,
    detectRegion: detectRegion,
    scoreLocationMatch: scoreLocationMatch,
    countTermInTokens: countTermInTokens,
    singularize: singularize,
    // Phase 5C
    extractSkillCandidates: extractSkillCandidates,
    looksLikeTechShape: looksLikeTechShape,
  };
})();
