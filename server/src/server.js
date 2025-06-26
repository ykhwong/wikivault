const app = require('./app');
const { serverLogger } = require('./config/logger');

// Start server
const PORT = parseInt(process.env.PORT, 10) || 3000;
app.listen(PORT, () => {
  serverLogger.info(`Server running on port ${PORT}`);
}); 