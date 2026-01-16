const express = require('express');
const { StringDecoder } = require('string_decoder');
const axios = require('axios');
const { APIError, sanitizeResponseData, readErrorResponseData } = require('../utils/errors');
const { hasActiveRequest, startRequest, endRequest } = require('../utils/requestTracker');
const { requestWithRateLimiting } = require('../utils/rateLimiter');
const { apiTranslateLogger, serverLogger } = require('../config/logger');
const CONFIG = require('../config');
const { 
  removeTemplates, 
  removeCategories, 
  removeItalicsPreserveBold, 
  replaceTemplates,
  cleanupTemplates
} = require('../utils/textProcessor');
const { 
  fetchKoLinks, 
  fetchKoTemplateLinks 
} = require('../services/wikiService');

const router = express.Router();

// Translation (stream)
router.post('/translate', async (req, res) => {
  const decoder = new StringDecoder('utf8');
  let { username, title, korean_title, translation_request, thinking, thinking_amount, temperature, supplement, prompt } = req.body;
  const endpoint = '/api/translate';

  try {
    if (!username || !prompt)
      throw new APIError("Missing required field", 400);

    if (hasActiveRequest(username))
      throw new APIError(`You have reached the maximum number of active requests (${3}). Please wait for one to complete.`, 429);

    startRequest(username, endpoint);
    if (username !== 'wikivault_anon') {
      apiTranslateLogger.info(`Translation requested - User: ${username}, Title: ${title}`);
    }

    // Preprocessing
    prompt = removeTemplates(prompt, CONFIG.TEMPLATES_TO_REMOVE);
    prompt = removeCategories(prompt);
    prompt = removeItalicsPreserveBold(prompt);
    prompt = prompt.replace(/\[\[\s*Image\s*:/ig, '[[File:');
    prompt = prompt.replace(/\{\{\s*[\s\S]*?-stub\s*\}\}/g, '');
    prompt = cleanupTemplates(prompt, CONFIG.TEMPLATES_TO_CLEANUP);
    let templates = await fetchKoTemplateLinks(title);
    if (templates.length) {
      prompt = replaceTemplates(prompt, templates);
    }

    let input_data = '';
    let request_data = '';
    const info_data = `<NOTICE>
1. DO NOT Translate or Modify the Following Structures:
  1-1. <ref> ... </ref> tags
    * Any content inside <ref> ... </ref> must be preserved exactly as-is. (even if they include {{ ... }} templates)
    * Do not translate, reformat, rephrase, or modify anything inside these tags — including URLs, titles, names, parameters, punctuation, or structure.
    * Examples:
      * <ref>{{웹 인용|url=http://www.aaa.com|title=Example|last=Jönsson|display-authors=etal|date=2004|website=abc|access-date=20 May 2018}}</ref> → Must be kept unchanged.
      * <ref>[http://digitaljournal.com/article/309292 Peebetter introduces the Pollee shared urinal for women]—Digital Journal</ref> → Must be preserved exactly.
      * <ref>{{뉴스 인용|url=https://example.com|title=This is a product|chapter=Maybe a good idea|publisher=Stuff}}</ref> → Must be preserved exactly. (Don't translate title, chapter, and publisher values)
  1-2. {{ ... }} Templates
    * The template name and parameter names must never be translated.
    * Only translate content inside the parameters if it is clearly a descriptive sentence or phrase in natural language.
    * Never translate settings, URLs, filenames, configuration flags, or template-specific values.
    * Examples:
      * For instance, in the template syntax {{a|b=c|d=e}}, a is the template name, and b and d are parameter names. These elements should never be translated. While c and e are parameter values and can usually be translated, do not translate them if they appear to be settings, configuration options, or technical keywords.
      * Do NOT translate anything inside these templates (keep them completely unchanged). This rule applies to—but is not limited to—these particular templates.
        * {{갤러리|...}}
        * {{여러그림|...}}
        * {{공용|...}}
        * {{위키공용분류|...}}
  1-3. Do not translate what appears to be file names.
    * For example, if you see 'Video card.jpg', quote and use it **as-is**.
    * However, if the content is in the form of '[[File:AAA.jpg|...]]', then the ... part **should be translated**.
      * Do not translate file/image options such as '|thumb', '|right', '|upright ,'|left', '|none', etc.
  1-4. Do not translate <gallery> and </gallery> tag names. Use the names **as-is**.
  1-5. Do not translate any bibliographies or references.
2. Do not use honorific or formal verb endings (e.g., use "달라진다" instead of "달라집니다").
3. If section names exist, please convert them as follows:
  3-1. == See also == → == 같이 보기 ==
  3-2. == External links == → == 외부 링크 ==
  3-3. == References == → == 각주 ==
  3-4. == Notes == → == 내용주 ==
4. Output only the translation result **without any additional summary or commentary**. In particular, **names of people should be translated as much as possible**.
</NOTICE>`;

    if (translation_request) {
      request_data = '<ADDITIONAL REQUEST>\n' + translation_request + '\n</ADDITIONAL REQUEST>';
    }

    if (supplement?.enabled) {
      // Fetch Korean wiki
      const kowikiUrl = 'https://ko.wikipedia.org/w/index.php?title=' +
        encodeURIComponent(supplement.title) +
        '&action=raw';
      let kowikiData = '';
      try {
        const r = await axios.get(kowikiUrl);
        kowikiData = r.data || '';
      } catch (e) {
        serverLogger.error('Error fetching Korean wiki:', {
          url: kowikiUrl,
          message: e.message,
          code: e.code,
          status: e.response?.status,
          stack: e.stack
        });
        throw new APIError('Failed to fetch Korean Wikipedia content', 500);
      }
      input_data = 'The following is the content of a specific English Wikipedia article that contains MediaWiki markup. ';
      if (korean_title) {
        input_data += '(Korean title: ' + korean_title + ') ' ;
      }
      input_data += 'Please use "Content 2" as a reference to improve or supplement "Content 1".\n\n' +
      info_data + '\n' + request_data + '\n' +
      '<Content 1>\n' + kowikiData + '\n</Content 1>\n\n' +
      '<Content 2>\n' + prompt + '\n</Content 2>';
    } else {
      input_data = 'The following "Content" is from a specific English Wikipedia article and contains MediaWiki markup. ';
      if (korean_title) {
        input_data += '(Korean title: ' + korean_title + ')' ;
      }
      input_data += 'Please rewrite it in Korean using the same MediaWiki markup, so it can be used on the Korean Wikipedia.\n\n' +
      info_data + '\n' + request_data + '\n' +
      '<Content>\n' + prompt + '\n</Content>\n';
    }

    const generationConfig = { maxOutputTokens: 65536 };
    if (thinking !== true) {
      generationConfig.thinkingConfig = { thinkingBudget: 0 };
    } else {
      const t = parseInt(thinking_amount);
      if ( t === 0 ) {
        // Auto
      } else {
        generationConfig.thinkingConfig = { thinkingBudget: t };
      }
    }

    if (temperature !== "auto") {
      const t = parseFloat(temperature);
      if (!isNaN(t)) generationConfig.temperature = t;
    }

    let titles = await fetchKoLinks(title);
    if (titles.length > 0) {
      input_data += '\nIf you find any English article links([[ ... ]]), please refer to the following reference phrases for translation.\n' +
      '<Reference Phrases>\n';
    for (let i = 0; i < titles.length; i++) {
      input_data += titles[i] + '\n';
    }
    input_data += '</Reference Phrases>';
    input_data += '\nEven if data from the <Reference Phrases> above cannot be found, please do your best to translate the links.\n';
    input_data += 'For example:\n';
    input_data += '1. Instead of "[[2025 Preakness Stakes|제150회 프리크니스 스테이크스]]", translate it as "[[2025 프리크니스 스테이크스|제150회 프리크니스 스테이크스]]".\n';
    input_data += '2. Human names such as "[[Gary Barber]]" should be translated as "[[게리 바버]]."\n';
    input_data += 'However, try to understand the context first—if the name refers to an album originally titled in English or another Latin-based language, ';
    input_data += 'there\'s no need to translate it.';
    }

    require('fs').writeFileSync('./debug_translate.info', input_data);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const response = await requestWithRateLimiting(apiKey =>
      axios.post(
        `${CONFIG.API.GEMINI_URL}?key=${apiKey}`,
        {
          safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "OFF" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "OFF" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "OFF" },
            { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "OFF" }
          ],
          contents: [{ parts: [{ text: input_data }] }],
          generationConfig
        },
        { responseType: 'stream' }
      )
    );

    response.data.on('data', chunk => {
      const txt = decoder.write(chunk);
      if (txt) res.write(txt);
    });
    response.data.on('end', () => {
      const rem = decoder.end(); if (rem) res.write(rem);
      res.write('\nevent: end\ndata: [DONE]\n');
      res.end();
      endRequest(username);
    });
    response.data.on('error', err => {
      serverLogger.error('Stream error in translate:', {
        username,
        title,
        message: err.message,
        code: err.code,
        stack: err.stack
      });
      res.write('\nevent: error\ndata: Stream processing error\n');
      res.end();
      endRequest(username);
    });

  } catch (err) {
    endRequest(username);
    const status = err.statusCode || 500;
    const logData = {
      username,
      title,
      endpoint: '/api/translate',
      status,
      message: err.message,
      code: err.code,
      responseStatus: err.response?.status,
      responseData: sanitizeResponseData(err.response?.data),
      stack: err.stack
    };
    
    // API 응답 오류인 경우 상세 정보를 로그에 남김
    if (err.response) {
      // 응답 데이터에서 실제 오류 메시지 읽기
      const errorResponseData = await readErrorResponseData(err.response?.data);
      logData.geminiApiError = {
        status: err.response?.status,
        statusText: err.response?.statusText,
        headers: err.response?.headers,
        errorMessage: errorResponseData,
        errorDetails: typeof errorResponseData === 'object' ? errorResponseData : { rawMessage: errorResponseData },
        requestUrl: err.config?.url,
        requestMethod: err.config?.method
      };
      serverLogger.error('Gemini API Error in translate endpoint:', logData);
    } else {
      serverLogger.error('Error in translate endpoint:', logData);
    }
    
    return res.status(status).json({ error: err.message });
  }
});

// Fast translation
router.post('/fast-translate', async (req, res) => {
  let { username, prompt, source = 'auto', dest = 'ko' } = req.body;

  try {
    if (!username || !prompt)
      throw new APIError("Missing required field", 400);

    if (!process.env.GOOGLE_API_KEY)
      throw new APIError("Google API key not configured", 500);

    prompt = prompt.replace(/== *See also *==/i, '== 같이 보기 ==')
    .replace(/== *External links *==/i, '== 외부 링크 ==');

    const response = await axios.post(
      'https://translate-pa.googleapis.com/v1/translateHtml',
      [[[prompt], source, dest], "wt_lib"],
      {
        headers: {
          'Accept': '*/*',
          'Content-Type': 'application/json+protobuf',
          'X-Goog-API-Key': process.env.GOOGLE_API_KEY
        }
      }
    );

    let well = response.data[0][0];
    well = well.replaceAll('<h2>', '\n\n<h2>')
              .replaceAll('</h2>', '</h2>\n\n')
              .replaceAll('<h3>', '\n\n<h3>')
              .replaceAll('</h3>', '</h3>\n\n')
              .replaceAll('<h4>', '\n\n<h4>')
              .replaceAll('</h4>', '</h4>\n\n')
              .replaceAll('<h5>', '\n\n<h5>')
              .replaceAll('</h5>', '</h5>\n\n')
              .replaceAll('<li>', '\n\n<li>');

    const cheerio = require('cheerio');
    const $ = cheerio.load(well);
    let wikitext = $.text().trim().replaceAll(/\n{3,}/mg, "\n\n");
    var lines = wikitext.split('\n');
    for (var i = 0; i < lines.length; i++) {
      lines[i] = lines[i].replace(/^\s+|\s+$/g, '');
    }
    wikitext = lines.join('\n');

    const { replaceStrForTranslation } = require('../utils/textProcessor');

    res.json({ 
      translatedText: replaceStrForTranslation(wikitext)
    });

  } catch (err) {
    const status = err.statusCode || 500;
    serverLogger.error('Error in fast-translate endpoint:', {
      username,
      source,
      dest,
      status,
      message: err.message,
      code: err.code,
      responseStatus: err.response?.status,
      responseData: sanitizeResponseData(err.response?.data),
      stack: err.stack
    });
    return res.status(status).json({ error: err.message });
  }
});


module.exports = router; 

