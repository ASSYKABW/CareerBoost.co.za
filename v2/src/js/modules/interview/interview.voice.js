// Phase 4.5 voice extension: Web Speech API wrapper for the mock
// interview. Two directions:
//
//   1. SpeechRecognition  — candidate speaks → text → AI sees it like a
//                           typed reply.
//   2. SpeechSynthesis    — AI response → spoken aloud in the persona's
//                           voice profile (rate / pitch / voice hints).
//
// Browser support:
//   - SpeechRecognition: Chrome, Edge, Safari 14.1+, Brave, Opera.
//     Firefox: NOT supported. Module reports unsupported, UI hides
//     the mic button.
//   - SpeechSynthesis: every modern browser. Voice availability varies
//     by OS — we pick the best match for the persona profile from the
//     available voiceURIs at speak() time.
//
// Permissions:
//   - SpeechRecognition needs microphone permission (a browser prompt
//     on first start). We don't pre-request — let the prompt fire on
//     the user's first push-to-talk gesture so they understand why.
//
// Design choice — push-to-talk vs continuous:
//   We use PUSH-TO-TALK (button-held or click-toggle) for two reasons:
//     (a) practice realism — real candidates think before speaking;
//         continuous mode picks up "um" and false starts as full turns.
//     (b) cost predictability — interim transcript events fire many
//         times per second; gating them behind a user gesture keeps
//         the AI cost flat (one round-trip per intentional reply).
//
// No backend dependencies — this is 100% client-side. Future "premium
// voice" (OpenAI TTS / ElevenLabs) can layer on top via the same API
// surface (voice.speak swaps to a backend call when a config flag is
// set; signature stays the same).

(function () {
  window.CBV2 = window.CBV2 || {};

  // --- Feature detection -----------------------------------------------

  function getRecognitionCtor() {
    if (typeof window === "undefined") return null;
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  function isRecognitionSupported() {
    return Boolean(getRecognitionCtor());
  }

  function isSynthesisSupported() {
    return typeof window !== "undefined"
      && typeof window.speechSynthesis !== "undefined"
      && typeof window.SpeechSynthesisUtterance !== "undefined";
  }

  function isFullySupported() {
    return isRecognitionSupported() && isSynthesisSupported();
  }

  // --- Voice cache (browser loads voices asynchronously) ---------------

  let cachedVoices = null;

  function refreshVoices() {
    if (!isSynthesisSupported()) return [];
    try {
      cachedVoices = window.speechSynthesis.getVoices() || [];
    } catch (e) {
      cachedVoices = [];
    }
    return cachedVoices;
  }

  function getVoices() {
    if (cachedVoices && cachedVoices.length) return cachedVoices;
    return refreshVoices();
  }

  if (isSynthesisSupported()) {
    // Some browsers populate voices asynchronously after page load.
    try {
      window.speechSynthesis.addEventListener("voiceschanged", refreshVoices);
    } catch (e) { /* older browsers expose only the deprecated handler */ }
    // Kick a sync read in case voices are already available.
    refreshVoices();
  }

  // Map a persona voiceProfile to the best-match SpeechSynthesisVoice
  // available on the user's device. Heuristics:
  //   1. Honor preferredLang first (en-US / en-GB) so the accent matches.
  //   2. Within the matching language, prefer:
  //        a. A voice whose name contains a persona "gender" hint
  //        b. A voice marked "natural" / "premium" / "enhanced"
  //        c. Any local voice over a remote one
  //   3. Fall back to the platform default voice.
  function pickVoice(profile) {
    const voices = getVoices();
    if (!voices.length) return null;
    profile = profile || {};
    const wantLang = (profile.preferredLang || "en-US").toLowerCase();
    const wantGender = (profile.gender || "").toLowerCase();
    const nameHints = profile.preferredNames || [];

    // Pass 1: explicit name match (e.g. "Samantha" on macOS).
    for (let i = 0; i < nameHints.length; i++) {
      const hint = String(nameHints[i] || "").toLowerCase();
      if (!hint) continue;
      const match = voices.find(function (v) {
        return (v.name || "").toLowerCase().indexOf(hint) >= 0;
      });
      if (match) return match;
    }

    // Pass 2: same language + gender hint.
    const langMatches = voices.filter(function (v) {
      const vl = (v.lang || "").toLowerCase();
      return vl.indexOf(wantLang) >= 0 || vl.indexOf(wantLang.slice(0, 2)) >= 0;
    });
    if (langMatches.length && wantGender) {
      // Name-based gender hints — imperfect but works across vendors.
      const femaleHints = ["female", "woman", "samantha", "victoria", "karen", "moira", "tessa", "fiona", "zira", "google us english"];
      const maleHints   = ["male", "man", "daniel", "alex", "fred", "tom", "david", "mark"];
      const hints = wantGender === "female" ? femaleHints : wantGender === "male" ? maleHints : [];
      if (hints.length) {
        const found = langMatches.find(function (v) {
          const n = (v.name || "").toLowerCase();
          return hints.some(function (h) { return n.indexOf(h) >= 0; });
        });
        if (found) return found;
      }
    }
    if (langMatches.length) {
      // Prefer a local voice over a remote (cloud) one — fewer hiccups
      // when the user is offline.
      const local = langMatches.find(function (v) { return v.localService; });
      if (local) return local;
      return langMatches[0];
    }
    // Final fallback: platform default.
    return voices[0] || null;
  }

  // --- Recognition -----------------------------------------------------

  let activeRecognition = null;

  function startRecognition(opts) {
    opts = opts || {};
    if (!isRecognitionSupported()) {
      if (typeof opts.onError === "function") {
        opts.onError({ code: "unsupported", message: "Speech recognition isn't available in this browser. Chrome, Edge, and Safari work best." });
      }
      return null;
    }
    // Stop any previous instance — only one active recognition at a time.
    stopRecognition();
    try {
      const Ctor = getRecognitionCtor();
      const rec = new Ctor();
      rec.lang = opts.lang || "en-US";
      // Continuous=false → recognition ends after a clear silence; that
      // matches push-to-talk semantics (release = end of turn).
      rec.continuous = !!opts.continuous;
      // Interim results so the UI can show partial text while the user
      // is speaking ("I worked on... I worked on the search team...").
      rec.interimResults = opts.interimResults !== false;
      rec.maxAlternatives = 1;
      let lastTranscript = "";
      rec.onresult = function (event) {
        let interim = "";
        let final = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          const transcript = result[0] && result[0].transcript ? result[0].transcript : "";
          if (result.isFinal) final += transcript;
          else interim += transcript;
        }
        lastTranscript = (final + interim).trim();
        if (typeof opts.onResult === "function") {
          opts.onResult({ text: lastTranscript, final: !!final, interim: !final });
        }
      };
      rec.onerror = function (event) {
        if (typeof opts.onError === "function") {
          // Common codes: "not-allowed" (no mic permission), "no-speech",
          // "audio-capture", "network", "service-not-allowed".
          opts.onError({ code: event && event.error ? event.error : "unknown", message: speechErrorMessage(event && event.error) });
        }
      };
      rec.onend = function () {
        // Recognition naturally ended (silence timeout or stop()). Fire
        // the end callback with the accumulated transcript.
        if (typeof opts.onEnd === "function") {
          opts.onEnd({ text: lastTranscript });
        }
        if (activeRecognition === rec) activeRecognition = null;
      };
      activeRecognition = rec;
      rec.start();
      return rec;
    } catch (err) {
      if (typeof opts.onError === "function") {
        opts.onError({ code: "start-failed", message: (err && err.message) || "Could not start recognition." });
      }
      return null;
    }
  }

  function stopRecognition() {
    if (!activeRecognition) return;
    try { activeRecognition.stop(); } catch (e) { /* already stopped */ }
    activeRecognition = null;
  }

  function speechErrorMessage(code) {
    if (code === "not-allowed" || code === "service-not-allowed") {
      return "Microphone access was denied. Click the lock icon in your address bar to re-enable.";
    }
    if (code === "no-speech") return "No speech detected. Tap the mic and try again.";
    if (code === "audio-capture") return "No microphone found. Check your audio device.";
    if (code === "network") return "Speech recognition needs an internet connection.";
    return "Speech recognition error: " + (code || "unknown");
  }

  // --- Synthesis -------------------------------------------------------

  // Some browsers (Chrome) have a bug where utterances over ~200 chars
  // get cut off after ~15 seconds. Split long messages into sentences
  // and queue them sequentially.
  function chunkForTts(text, maxLen) {
    const max = maxLen || 220;
    if (!text) return [];
    if (text.length <= max) return [text];
    // Split on sentence terminators, keep them.
    const sentences = String(text).split(/([.!?]+\s+)/);
    const chunks = [];
    let buffer = "";
    for (let i = 0; i < sentences.length; i++) {
      const piece = sentences[i];
      if (buffer.length + piece.length > max && buffer.trim()) {
        chunks.push(buffer.trim());
        buffer = piece;
      } else {
        buffer += piece;
      }
    }
    if (buffer.trim()) chunks.push(buffer.trim());
    return chunks;
  }

  let activeUtterance = null;

  function stopSpeaking() {
    if (!isSynthesisSupported()) return;
    try { window.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
    activeUtterance = null;
  }

  function speak(text, opts) {
    opts = opts || {};
    if (!isSynthesisSupported()) {
      if (typeof opts.onEnd === "function") opts.onEnd();
      return;
    }
    if (!text || typeof text !== "string") {
      if (typeof opts.onEnd === "function") opts.onEnd();
      return;
    }
    // Cancel any in-flight utterance — last speak wins.
    stopSpeaking();

    const profile = opts.profile || {};
    const voice = pickVoice(profile);
    const chunks = chunkForTts(text);
    let idx = 0;
    let cancelled = false;

    function speakNext() {
      if (cancelled) return;
      if (idx >= chunks.length) {
        if (typeof opts.onEnd === "function") opts.onEnd();
        return;
      }
      const utter = new window.SpeechSynthesisUtterance(chunks[idx]);
      if (voice) utter.voice = voice;
      // Rate: 0.1–10, default 1. Persona profiles use 0.85–1.15 — small
      // shifts are perceptible without sounding alien.
      utter.rate = clamp(profile.rate, 0.5, 1.8, 1);
      utter.pitch = clamp(profile.pitch, 0.5, 1.8, 1);
      utter.volume = clamp(profile.volume, 0, 1, 1);
      utter.lang = (profile.preferredLang) || (voice && voice.lang) || "en-US";
      utter.onstart = function () {
        if (typeof opts.onStart === "function" && idx === 0) opts.onStart();
        if (typeof opts.onChunk === "function") opts.onChunk(idx);
      };
      utter.onend = function () {
        idx += 1;
        speakNext();
      };
      utter.onerror = function (event) {
        if (typeof opts.onError === "function") opts.onError({ code: event && event.error ? event.error : "unknown" });
        idx += 1;
        speakNext();
      };
      activeUtterance = utter;
      try { window.speechSynthesis.speak(utter); } catch (e) {
        if (typeof opts.onError === "function") opts.onError({ code: "speak-failed", message: e.message });
      }
    }

    // Return a cancel handle so callers can abort mid-speech.
    speakNext();
    return {
      cancel: function () {
        cancelled = true;
        stopSpeaking();
      }
    };
  }

  function clamp(value, lo, hi, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.max(lo, Math.min(hi, num));
  }

  function isSpeaking() {
    if (!isSynthesisSupported()) return false;
    try { return Boolean(window.speechSynthesis.speaking); } catch (e) { return false; }
  }

  function isListening() {
    return activeRecognition != null;
  }

  // --- Public surface --------------------------------------------------

  window.CBV2.interviewVoice = {
    isRecognitionSupported: isRecognitionSupported,
    isSynthesisSupported: isSynthesisSupported,
    isFullySupported: isFullySupported,
    listen: startRecognition,
    stopListening: stopRecognition,
    isListening: isListening,
    speak: speak,
    stopSpeaking: stopSpeaking,
    isSpeaking: isSpeaking,
    getVoices: getVoices,
    refreshVoices: refreshVoices,
    pickVoice: pickVoice,
    // Exposed for tests.
    _chunkForTts: chunkForTts,
    _clamp: clamp,
  };
})();
