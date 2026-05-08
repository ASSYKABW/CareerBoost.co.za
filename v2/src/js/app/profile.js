// Lightweight profile cache + event bus.
// Hydrated on sign-in (from public.profiles) and shared across UI components
// that want to render the current user's avatar, full name, plan, etc.
//
// Usage:
//   window.CBV2.profile.get()           -> latest profile snapshot (or null)
//   window.CBV2.profile.load()          -> re-fetch and emit "change"
//   window.CBV2.profile.update(patch)   -> update profiles table + cache
//   window.CBV2.profile.uploadAvatar(file) -> upload to storage + update profile
//   window.CBV2.profile.on("change", fn)
(function () {
  window.CBV2 = window.CBV2 || {};
  if (window.CBV2.profile) return;

  const listeners = { change: [] };
  let current = null;

  function emit(event, payload) {
    (listeners[event] || []).forEach(function (fn) {
      try { fn(payload); } catch (e) { /* ignore */ }
    });
  }

  function on(event, fn) {
    if (!listeners[event]) listeners[event] = [];
    listeners[event].push(fn);
    return function off() {
      listeners[event] = listeners[event].filter(function (x) { return x !== fn; });
    };
  }

  function getClient() {
    if (window.CBV2.auth && typeof window.CBV2.auth.getClient === "function") {
      return window.CBV2.auth.getClient();
    }
    return null;
  }

  function getUser() {
    return (window.CBV2.auth && window.CBV2.auth.getUser()) || null;
  }

  async function load() {
    const client = getClient();
    const user = getUser();
    if (!client || !user) {
      current = null;
      emit("change", current);
      return null;
    }
    try {
      const { data, error } = await client
        .from("profiles")
        .select("user_id, full_name, headline, avatar_url, locale, plan, onboarding_completed, preferences")
        .eq("user_id", user.id)
        .maybeSingle();
      if (error) {
        console.warn("[profile] load failed:", error.message);
        current = null;
      } else if (!data) {
        const seed = {
          user_id: user.id,
          full_name: ((user.user_metadata && user.user_metadata.full_name) || "").trim()
        };
        const created = await client
          .from("profiles")
          .upsert(seed, { onConflict: "user_id" })
          .select("user_id, full_name, headline, avatar_url, locale, plan, onboarding_completed, preferences")
          .maybeSingle();
        if (created.error) {
          console.warn("[profile] seed failed:", created.error.message);
          current = null;
        } else {
          current = created.data || seed;
        }
      } else {
        current = data || null;
      }
    } catch (e) {
      console.warn("[profile] load threw:", e);
      current = null;
    }
    emit("change", current);
    return current;
  }

  function normalizePatch(patch) {
    const next = Object.assign({}, patch || {});
    if (next.preferences && typeof next.preferences !== "object") {
      delete next.preferences;
    }
    if (next.full_name != null) next.full_name = String(next.full_name || "").trim();
    if (next.headline != null) next.headline = String(next.headline || "").trim();
    return next;
  }

  async function update(patch) {
    const client = getClient();
    const user = getUser();
    if (!client || !user) throw new Error("Not signed in");
    const safePatch = normalizePatch(patch);
    const row = Object.assign({ user_id: user.id }, safePatch);
    const { data, error } = await client
      .from("profiles")
      .upsert(row, { onConflict: "user_id" })
      .select("user_id, full_name, headline, avatar_url, locale, plan, onboarding_completed, preferences")
      .maybeSingle();
    if (error) throw error;
    current = data || Object.assign({}, current || {}, safePatch || {});
    emit("change", current);
    return current;
  }

  function clear() {
    current = null;
    emit("change", current);
  }

  // ---------- Avatar image helpers ----------------------------------------
  function readImage(file) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = function () {
        const img = new Image();
        img.onload = function () { resolve(img); };
        img.onerror = function () { reject(new Error("Invalid image file")); };
        img.src = reader.result;
      };
      reader.onerror = function () { reject(new Error("Could not read file")); };
      reader.readAsDataURL(file);
    });
  }

  // Square-crop + downscale to <= 512×512 JPEG (~100–200KB) so we never
  // ship multi-megabyte photos into storage.
  async function normalizeAvatar(file) {
    if (!file) throw new Error("No file provided");
    if (!/^image\//.test(file.type)) throw new Error("Please upload an image file");
    if (file.size > 5 * 1024 * 1024) throw new Error("Image is larger than 5 MB");

    const img = await readImage(file);
    const size = Math.min(img.width, img.height);
    const sx = (img.width - size) / 2;
    const sy = (img.height - size) / 2;

    const target = Math.min(512, size);
    const canvas = document.createElement("canvas");
    canvas.width = target;
    canvas.height = target;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, sx, sy, size, size, 0, 0, target, target);

    return await new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (!blob) return reject(new Error("Could not encode image"));
        resolve(blob);
      }, "image/jpeg", 0.9);
    });
  }

  async function uploadAvatar(file) {
    const client = getClient();
    const user = getUser();
    if (!client || !user) throw new Error("Sign in required");

    const blob = await normalizeAvatar(file);
    const path = user.id + "/avatar-" + Date.now() + ".jpg";

    const up = await client.storage
      .from("avatars")
      .upload(path, blob, {
        contentType: "image/jpeg",
        cacheControl: "3600",
        upsert: true
      });
    if (up.error) throw up.error;

    const pub = client.storage.from("avatars").getPublicUrl(path);
    // Cache-bust so the new photo shows instantly even if CDN is lagging.
    const publicUrl = pub.data.publicUrl + "?v=" + Date.now();

    await update({ avatar_url: publicUrl });
    return publicUrl;
  }

  async function removeAvatar() {
    // Clears avatar_url on the profile. We don't aggressively delete storage
    // objects (keeps the flow simple and avoids race conditions with the CDN).
    return await update({ avatar_url: null });
  }

  window.CBV2.profile = {
    get: function () { return current; },
    load: load,
    update: update,
    clear: clear,
    uploadAvatar: uploadAvatar,
    removeAvatar: removeAvatar,
    on: on
  };
})();
