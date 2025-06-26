require('dotenv').config();

const CONFIG = {
  REQUEST: {
    MIN_INTERVAL: 7000,      // Minimum interval per key is 7 seconds
    MAX_BATCH_SIZE: 50,      // Size of wiki request batch
    FILE_SIZE_LIMIT: '50mb'
  },
  API: {
    KEYS: process.env.GEMINI_API_KEYS
      ? process.env.GEMINI_API_KEYS.split(',')
      : [],
    GEMINI_URL:
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      "gemini-2.5-flash-preview-05-20:streamGenerateContent",
    WIKI_URL: "https://en.wikipedia.org/w/api.php"
  },
  CORS: {
    ALLOWED_ORIGINS: ["https://ko.wikipedia.org", "https://ko.m.wikipedia.org"]
  },
  TEMPLATES_TO_REMOVE: [
    'Use mdy dates','Use dmy dates','pp','pp-blp','pp-dispute','pp-semi-indef',
    'pp-move','Pp-move-dispute','Pp-move-vandalism','Pp-office','Pp-pc','pp-sock',
    'short description','pp-template','pp-usertalk','Pp-vandalism','pp-protected',
    'Multiple issues','More citations needed','More citations needed section',
    'Overly detailed','Citation needed','cn','cb','fact','Unreferenced',
    'Page needed','pn','Notability','redirect','condensed','Refimprove',
    'No footnotes','Primary sources','Cleanup','Cleanup-section','Copy edit',
    'Orphan','POV','Advert','COI','Fanpov','NPOV language','Peacock','Tone',
    'Lead too short','Expand section','Stub','Update','Dead link','Disputed',
    'Weasel','Globalize','Globalise','Too many see alsos','Trivia','Prose','Technical',
    'Confusing','In-universe','How-to','Manual','Other uses','Otheruses',
    'Other uses of','Others','Hatnote','Distinguish','Use American English',
    'Use Antiguan and Barbudan English','Use Australian English',
    'Use British English','Use Oxford spelling','Use Canadian English',
    'Use Ghanaian English','Use Hiberno-English','Use Hong Kong English',
    'Use Indian English','Use Jamaican English','Use Kenyan English',
    'Use Liberian English','Use Malaysian English','Use New Zealand English',
    'Use Nigerian English','Use Pakistani English','Use Philippine English',
    'Use Singapore English','Use South African English','Use Sri Lankan English',
    'Use Trinidad and Tobago English','Use Ugandan English','Cbignore',
    'Italics title','One source','Update inline','Wiktionary','Good article',
    'Featured article','Featured list','Portal','About','protection padlock','for',
    'EngvarB','more footnotes','Very long','Split','Dynamic list','Portal bar',
    'Wikinews', 'Unreferenced section', 'Essay-like', 'Wiktionary-inline', 'Split section',
    'For multi', 'Not to be confused with', 'Clarify', 'Failed verification', 'Promotional',
    'Update section', 'mdy', 'cn', 'Missing information', 'No plot', 'Unreliable sources',
    'other people', 'Unsourced section', 'Example needed', 'clarification needed',
    'for-multi', 'Primary source inline', 'Promotional source', 'Redirect-distinguish',
    'Prone to spam', 'Unreliable source?', 'Unreliable source', 'procon', 'Verify credibility',
    'dubious', 'when', 'when?', 'Pronunciation needed', 'Not verified in body', 'One source section',
    'explain', 'merge from', 'merge to', 'Not English', 'not English inline', 'Disambiguation needed',
    'long plot', 'plot', 'Improve categories', 'No context', 'Very few citations', 'Importance section',
    'Out-of-date', 'Pov-check', 'All plot', 'and then what', 'definition', 'Pp-extended',
    'speculation section', 'moreinline', 'Use list-defined references', 'more references', 'single source',
    'Full citations needed', 'stub-section', 'medcn', 'CS1 config', 'Circular reference', 'Clarify span',
    'Refimprove section'
  ],
  TEMPLATES_TO_CLEANUP: [
    { "from": ["Citation"], "to": "인용" },
    { "from": ["Cite web"], "to": "웹 인용" },
    { "from": ["Cite news"], "to": "뉴스 인용" },
    { "from": ["Cite book"], "to": "서적 인용" },
    { "from": ["Cite journal"], "to": "서적 인용" },
    { "from": ["Webarchive"], "to": "웹아카이브" },
    { "from": ["Main"], "to": "본문" },
    { "from": ["See also"], "to": "참고" },
    { "from": ["Further"], "to": "추가 정보" },
    { "from": ["Langx"], "to": "llang" },
  ],
  UPDATE_INTERVAL: 3600000,  // 1 hour
  LOGS: {
    DIR: 'log',
    SERVER: 'server.log',
    API_TRANSLATE: 'api_translate.log',
    API_CREATE: 'api_create.log'
  }
};

module.exports = CONFIG; 