// Calls Supabase Edge company-intel-search (Google Programmable Search) with JWT.
(function () {
  window.CBV2 = window.CBV2 || {};

  const TIMEOUT_MS = 42000;

  function fetchJsonWithTimeout(url, init) {
    const controller = new AbortController();
    const timer = setTimeout(function () {
      controller.abort();
    }, TIMEOUT_MS);
    return fetch(url, Object.assign({}, init || {}, { signal: controller.signal }))
      .then(function (res) {
        clearTimeout(timer);
        return res
          .json()
          .catch(function () {
            return {};
          })
          .then(function (json) {
            if (res.ok) return json;
            const e = new Error(
              (json && (json.error || json.message)) || "HTTP " + res.status
            );
            e.status = res.status;
            throw e;
          });
      })
      .catch(function (err) {
        clearTimeout(timer);
        throw err;
      });
  }

  /** @returns {Promise<{ ok:boolean, hits?: unknown[], queries?: unknown[], warnings?: unknown[], error?: string }>} */
  function searchCompanyIntel(payload) {
    const p = payload || {};
    const company = String(p.company || "").trim();
    if (!company) {
      return Promise.resolve({ ok: false, hits: [], error: "company is required" });
    }

    const body = JSON.stringify({
      company: company,
      role: String(p.role || "").trim()
    });

    const auth = window.CBV2.auth;
    const client =
      auth && typeof auth.getClient === "function" ? auth.getClient() : null;
    const fnUrl =
      window.CBV2.config &&
      typeof window.CBV2.config.getFunctionsUrl === "function"
        ? window.CBV2.config.getFunctionsUrl()
        : "";

    function postWithToken(token) {
      if (!fnUrl) throw new Error("Functions URL not configured.");
      const u = String(fnUrl).replace(/\/+$/, "") + "/company-intel-search";
      return fetchJsonWithTimeout(u, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          apikey: window.CBV2.config.getSupabaseAnon(),
          "Content-Type": "application/json"
        },
        body: body
      });
    }

    if (
      client &&
      client.functions &&
      typeof client.functions.invoke === "function"
    ) {
      return client.functions
        .invoke("company-intel-search", {
          body: { company: company, role: String(p.role || "").trim() }
        })
        .then(function (res) {
          const data = res && res.data;
          const err = res && res.error;
          if (err) throw err;
          if (!data || !data.ok) {
            throw new Error(
              (data && data.error) || "company-intel-search failed"
            );
          }
          return {
            ok: true,
            hits: Array.isArray(data.hits) ? data.hits : [],
            queries: Array.isArray(data.queries) ? data.queries : [],
            warnings: Array.isArray(data.warnings) ? data.warnings : [],
            company: data.company || company,
            role: data.role || null
          };
        })
        .catch(function (e) {
          return {
            ok: false,
            hits: [],
            error: e && e.message ? String(e.message) : String(e)
          };
        });
    }

    const tokenPromise =
      auth && typeof auth.getAccessToken === "function"
        ? auth.getAccessToken()
        : Promise.resolve("");
    return tokenPromise
      .then(function (token) {
        if (!token) throw new Error("Not signed in.");
        return postWithToken(token);
      })
      .then(function (data) {
        if (!data.ok) throw new Error(data.error || "company-intel-search failed");
        return {
          ok: true,
          hits: Array.isArray(data.hits) ? data.hits : [],
          queries: Array.isArray(data.queries) ? data.queries : [],
          warnings: Array.isArray(data.warnings) ? data.warnings : [],
          company: data.company || company,
          role: data.role || null
        };
      })
      .catch(function (e) {
        return {
          ok: false,
          hits: [],
          error: e && e.message ? String(e.message) : String(e)
        };
      });
  }

  window.CBV2.companyIntel = window.CBV2.companyIntel || {};
  window.CBV2.companyIntel.search = searchCompanyIntel;
})();
