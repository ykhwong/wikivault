const express = require('express');
const { APIError } = require('../utils/errors');
const { getFileData } = require('../services/fileService');

const router = express.Router();

// Initialization: file timestamp response
router.get("/init", async (req, res, next) => {
  try {
    const { lastModified } = await getFileData();
    res.json({ status: "ok", lastModified: lastModified || null });
  } catch (e) {
    next(new APIError("Initialization failed", 500));
  }
});

module.exports = router; 