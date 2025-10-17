const express = require('express');
const { StringDecoder } = require('string_decoder');
const axios = require('axios');
const { APIError } = require('../utils/errors');
const { hasActiveRequest, startRequest, endRequest } = require('../utils/requestTracker');
const { requestWithRateLimiting } = require('../utils/rateLimiter');
const { apiCreateLogger } = require('../config/logger');
const CONFIG = require('../config');

const router = express.Router();

// Content creation (stream)
router.post('/create', async (req, res) => {
  const decoder = new StringDecoder('utf8');
  const { username, title, thinking, thinking_amount, temperature, context } = req.body;
  const endpoint = '/api/create';

  try {
    if (!username || !title || !context)
      throw new APIError("Missing required field", 400);

    if (hasActiveRequest(username))
      throw new APIError(`You have reached the maximum number of active requests (${3}). Please wait for one to complete.`, 429);

    startRequest(username, endpoint);
    if (username !== 'wikivault_anon') {
      apiCreateLogger.info(`Create requested - User: ${username}, Title: ${title}`);
    }

    // Set streaming headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Assemble input
    const info_data = `<NOTICE>
    1. Please write all content in Korean as much as possible.
    2. Exclude wikis (e.g., namu.wiki, wikipedia.org) and blogs (e.g., tistory, blog.naver.com) from internet search sources.
    3. Articles usually start with bold formatting using triple apostrophes ('''). For example, if the article title is "Apple", the content should begin like this: '''Apple''' is a fruit.
    4. When describing a sentence, allow users to access important or related topics using internal links. This format starts with [[ and ends with ]].
    5. At the very bottom of the article, include the most appropriate category that exists on the Korean Wikipedia (ko.wikipedia.org), such as [[Category:Computers]]. Do not add any content below the category tag.
    6. There's no need to create sections. (e.g, == History ==)
    7. Do not use honorific language(존칭어), and do not include any additional explanations or summaries in the output.
    </NOTICE>`;
    
    const input_data =
      'This content will be posted on the Korean Wikipedia, so please write it using MediaWiki markup. ' +
      'Occasionally, the data may be outdated, so internet search may be required to update it.\n\n' +
      `Article title to create: ${title}\n` +
      `Topic description: ${context}\n\n` +
      info_data;

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
          "tools": [
          {
              "google_search": {}
          }
          ],
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
      console.error('Stream error:', err);
      res.write('\nevent: error\ndata: Stream processing error\n');
      res.end();
      endRequest(username);
    });

  } catch (err) {
    endRequest(username);
    const status = err.statusCode || 500;
    return res.status(status).json({ error: err.message });
  }
});


module.exports = router; 

