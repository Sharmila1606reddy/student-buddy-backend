import express from "express";
import { analyzeWithGPT } from "../services/gpt.js";

const router = express.Router();

router.post("/", async (req, res) => {
  const result = await analyzeWithGPT(req.body);
  res.json(result);
});

export default router;