# WikiVault Server

A modular Express.js application that provides Wikipedia translation and content generation APIs.

## Project Structure

```
server/
├── src/
│   ├── config/           # Configuration files
│   │   ├── index.js      # Main configuration
│   │   └── logger.js     # Logger configuration
│   ├── middleware/       # Middleware
│   │   └── cors.js       # CORS-related middleware
│   ├── routes/           # Route handlers
│   │   ├── init.js       # Initialization route
│   │   ├── create.js     # Content creation route
│   │   ├── translate.js  # Translation route
│   │   └── other.js      # Other routes
│   ├── services/         # Business logic
│   │   ├── wikiService.js # Wiki API service
│   │   └── fileService.js # File caching service
│   ├── utils/            # Utility functions
│   │   ├── errors.js     # Error classes
│   │   ├── rateLimiter.js # Rate limiting
│   │   ├── requestTracker.js # Request tracking
│   │   └── textProcessor.js # Text processing
│   ├── app.js            # Main application
│   └── server.js         # Server entry point
├── package.json
└── README.md
```

## Installation & Execution

1. Install dependencies:
```bash
npm install
```

2. Set environment variables:
Create a `.env` file and set the following variables:
```
GEMINI_API_KEYS=your_api_key
GOOGLE_API_KEY=your_google_api_key
PORT=3000
NODE_ENV=development
```

3. Start the server:
```bash
# Development mode
npm run dev

# Production mode
npm start
```

## API Endpoints

### Initialization
- `GET /api/init` - Responds with file timestamp

### Content Creation
- `POST /api/create` - Streaming content generation

### Translation
- `POST /api/translate` - Streaming translation
- `POST /api/fast-translate` - Fast translation

### Others
- `GET /api/get-suggested-pages` - Suggested pages
- `GET /api/get-js-content` - JS bundle content
- `POST /api/get-source-info` - External URL information
- `GET /api/status` - Server status check

## Development

### Adding a New Route
1. Create a new route file in `src/routes/`
2. Register the route in `src/app.js`
3. Add any required services or utility functions

### Adding a New Service
1. Create a new service file in `src/services/`
2. Inject necessary dependencies
3. Use the service in routes

## License

MIT
