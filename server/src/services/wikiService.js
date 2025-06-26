const axios = require("axios");
const CONFIG = require('../config');
const { serverLogger } = require('../config/logger');

async function fetchTemplateLinksForPage(pageTitle, namespace = 10) {
  try {
    let titles = [], cont = null;
    do {
      const params = {
        action: "query",
        titles: pageTitle,
        prop: "templates",
        tlnamespace: namespace,
        tllimit: "max",
        format: "json",
        ...(cont && { tlcontinue: cont })
      };
      const res = await axios.get(CONFIG.API.WIKI_URL, { params });
      const pages = res.data.query.pages;
      for (const pid in pages) {
        if (pages[pid].templates)
          titles.push(...pages[pid].templates.map(l => l.title));
      }
      cont = res.data.continue?.tlcontinue;
    } while (cont);
    return titles;
  } catch (e) {
    serverLogger.error(`Error fetching template links for ${pageTitle}:`, e);
    return [];
  }
}

async function fetchLinksForPage(pageTitle, namespace = 0) {
  try {
    let titles = [], cont = null;
    do {
      const params = {
        action: "query",
        titles: pageTitle,
        prop: "links",
        plnamespace: namespace,
        pllimit: "max",
        format: "json",
        ...(cont && { plcontinue: cont })
      };
      const res = await axios.get(CONFIG.API.WIKI_URL, { params });
      const pages = res.data.query.pages;
      if (namespace === 10)
        require('fs').writeFileSync('./debug2.info', JSON.stringify(pages));
      for (const pid in pages) {
        if (pages[pid].links)
          titles.push(...pages[pid].links.map(l => l.title));
      }
      cont = res.data.continue?.plcontinue;
    } while (cont);
    return titles;
  } catch (e) {
    serverLogger.error(`Error fetching links for ${pageTitle}:`, e);
    return [];
  }
}

async function fetchLangLinksForBatch(titleBatch) {
  try {
    let data = {}, cont = null;
    do {
      const params = {
        action: "query",
        prop: "langlinks",
        titles: titleBatch.join("|"),
        lllimit: "max",
        format: "json",
        ...(cont && { llcontinue: cont })
      };
      const res = await axios.get(CONFIG.API.WIKI_URL, { params });
      const pages = res.data.query.pages;
      for (const pid in pages) {
        const t = pages[pid].title;
        if (!data[t]) data[t] = {};
        if (pages[pid].langlinks) {
          pages[pid].langlinks.forEach(l => {
            data[t][l.lang] = true;
          });
        }
      }
      cont = res.data.continue?.llcontinue;
    } while (cont);
    return data;
  } catch (e) {
    serverLogger.error('Error fetching language links:', e);
    return {};
  }
}

async function fetchLangLinksForBatch2(titleBatch, redirects = false, lllang) {
  try {
    let data          = {};    // Actual page name → { lang: translated name }
    let cont          = null;
    const redirectMap = {};    // Redirect (from → to)
    const normalizedMap = {};  // Normalization (from → to)

    do {
      const params = {
        action: "query",
        prop:   "langlinks",
        titles: titleBatch.join("|"),
        lllimit: "max",
        format:  "json",
        ...(redirects && { redirects: true }),
        ...(lllang    && { lllang }),
        ...(cont      && { llcontinue: cont })
      };

      const res = await axios.get(CONFIG.API.WIKI_URL, { params });
      const q   = res.data.query;

      // 1) normalized processing
      if (q.normalized) {
        q.normalized.forEach(n => {
          normalizedMap[n.from] = n.to;
        });
      }

      // 2) redirects processing
      if (q.redirects) {
        q.redirects.forEach(r => {
          redirectMap[r.from] = r.to;
        });
      }

      // 3) pages → accumulate data
      for (const pid in q.pages) {
        const pg = q.pages[pid];
        const title = pg.title; // Actual page name
        if (!data[title]) data[title] = {};
        if (pg.langlinks) {
          pg.langlinks.forEach(l => {
            data[title][l.lang] = l["*"];
          });
        }
      }

      cont = res.data.continue?.llcontinue;
    } while (cont);

    // 4) Result mapping: input(orig) → actual page(resolved) → langlinks
    const result = {};
    for (const orig of titleBatch) {
      const resolved = redirectMap[orig] 
                     || normalizedMap[orig] 
                     || orig;
      if (data[resolved] && data[resolved].ko) {
        // The desired format is { inputTitle: { ko: "translation" } },
        // but in fetchKo* functions, it's used as "orig → data[resolved].ko" string
        result[orig] = { ko: data[resolved].ko };
      }
    }

    return result;

  } catch (e) {
    serverLogger.error('Error fetching language links:', e);
    return {};
  }
}

let cachedSuggestedPages = null;
async function fetchSuggestedPages() {
  try {
    const pagesToFetch = ["Main Page", "Portal:Current events"];
    const unique = new Set();
    for (const p of pagesToFetch) {
      const links = await fetchLinksForPage(p);
      links.forEach(t => unique.add(t));
    }
    const all = Array.from(unique);
    const bothJaZh = [], eitherJaZh = [], multiLang = [];
    for (let i = 0; i < all.length; i += CONFIG.REQUEST.MAX_BATCH_SIZE) {
      const batch = all.slice(i, i + CONFIG.REQUEST.MAX_BATCH_SIZE);
      const langData = await fetchLangLinksForBatch(batch);
      for (const title in langData) {
        const langs = langData[title];
        const hasJa = !!langs.ja, hasZh = !!langs.zh, hasKo = !!langs.ko;
        const cnt = Object.keys(langs).length;
        if (!hasKo) {
          if (hasJa && hasZh) bothJaZh.push(title);
          else if (hasJa || hasZh) eitherJaZh.push(title);
          else if (cnt >= 15) multiLang.push(title);
        }
      }
    }
    cachedSuggestedPages = {
      bothJaZh,
      eitherJaZh: eitherJaZh.filter(t => !bothJaZh.includes(t)),
      multiLang: multiLang.filter(t =>
        !bothJaZh.includes(t) && !eitherJaZh.includes(t)
      )
    };
  } catch (e) {
    serverLogger.error('Error in fetchSuggestedPages:', e);
  }
}

async function fetchKoLinks(pageTitle) {
  try {
    let titles = [];
    const pagesToFetch = [pageTitle];
    const unique = new Set();
    for (const p of pagesToFetch) {
      const links = await fetchLinksForPage(p);
      links.forEach(t => unique.add(t));
    }
    const all = Array.from(unique);
    for (let i = 0; i < all.length; i += CONFIG.REQUEST.MAX_BATCH_SIZE) {
      const batch = all.slice(i, i + CONFIG.REQUEST.MAX_BATCH_SIZE);
      // Changed fetchLangLinksForBatch2 call (default: redirects=false, lllang=undefined)
      const langData = await fetchLangLinksForBatch2(batch);
      for (const title in langData) {
        const langs = langData[title];
        if (langs.ko) {
          titles.push(title + ' → ' + langs.ko);
        }
      }
    }
    return titles;
  } catch (e) {
    serverLogger.error('Error in fetchKoLinks:', e);
    return [];
  }
}

async function fetchKoTemplateLinks(pageTitle) {
  try {
    let titles = [];
    const pagesToFetch = [pageTitle];
    const unique = new Set();
    for (const p of pagesToFetch) {
      const links = await fetchTemplateLinksForPage(p);
      links.forEach(t => unique.add(t));
    }
    const all = Array.from(unique);
    for (let i = 0; i < all.length; i += CONFIG.REQUEST.MAX_BATCH_SIZE) {
      const batch = all.slice(i, i + CONFIG.REQUEST.MAX_BATCH_SIZE);
      // Changed fetchLangLinksForBatch2 call (redirects=true, lllang="ko")
      const langData = await fetchLangLinksForBatch2(batch, true, "ko");
      for (const title in langData) {
        const langs = langData[title];
        if (langs.ko) {
          const langKo = langs.ko.replace(/^틀:/, '');
          const newTitle = title.replace(/^Template:/i, '');
          titles.push(newTitle + '\t' + langKo);
        }
      }
    }
    return titles;
  } catch (e) {
    serverLogger.error('Error in fetchKoTemplateLinks:', e);
    return [];
  }
}

module.exports = {
  fetchTemplateLinksForPage,
  fetchLinksForPage,
  fetchLangLinksForBatch,
  fetchLangLinksForBatch2,
  fetchSuggestedPages,
  fetchKoLinks,
  fetchKoTemplateLinks,
  cachedSuggestedPages
}; 