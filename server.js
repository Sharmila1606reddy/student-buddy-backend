import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";
import * as cheerio from "cheerio";
import mongoose from "mongoose";


dotenv.config();
mongoose.connect(process.env.MONGO_URI);

mongoose.connection.on("connected", () => {
  console.log("✅ MongoDB Connected");
});
const userSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  weightedProfile: { type: Object, default: {} }
});

const User = mongoose.model("User", userSchema);

const topicGraph = {
  "machine learning": [
    "deep learning",
    "neural networks",
    "ai",
    "data science",
    "supervised learning"
  ],
  "data structures": [
    "algorithms",
    "time complexity",
    "recursion",
    "trees",
    "graphs"
  ],
  "dbms": [
    "sql",
    "database design",
    "normalization",
    "transactions",
    "indexing"
  ],
  "python": [
    "automation",
    "data science",
    "flask",
    "django",
    "pandas"
  ]
};

/* =========================================================
   PRODUCTION CACHE + REQUEST DEDUPLICATION
========================================================= */

const responseCache = new Map();
const pendingRequests = new Map();
const CACHE_TTL = 1000 * 60 * 30;

function getCache(key) {
  const entry = responseCache.get(key);
  if (!entry) return null;

  const isExpired = Date.now() - entry.timestamp > CACHE_TTL;
  if (isExpired) {
    responseCache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key, data) {
  responseCache.set(key, { data, timestamp: Date.now() });
}

/* ========================================================= */

const app = express();
app.use(cors());
app.use(express.json());

function extractDominantTopics(weightedProfile) {
  if (!weightedProfile) return [];

  return Object.entries(weightedProfile)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([topic]) => topic.toLowerCase());
}

function scoreCourse(courseTitle, topic, dominantTopics) {

  let score = 0;

  const title = courseTitle.toLowerCase();
  const baseTopic = topic.toLowerCase();

  // 1️⃣ Direct topic match (strongest signal)
  if (title.includes(baseTopic)) score += 5;

  // 2️⃣ Related topic expansion
  const related = topicGraph[baseTopic] || [];
  related.forEach(rel => {
    if (title.includes(rel)) score += 3;
  });

  // 3️⃣ User interest overlap
  dominantTopics.forEach(userTopic => {
    if (title.includes(userTopic)) score += 2;
  });

  // 4️⃣ Skill progression detection
  if (title.includes("beginner")) score += 1;
  if (title.includes("intermediate")) score += 2;
  if (title.includes("advanced")) score += 3;

  return score;
}

/* =========================================================
   PROFILE BUILDER (Weighted Personalization)
========================================================= */

function buildUserProfileSummary(historyObject) {
  if (!historyObject || typeof historyObject !== "object") return "";

  const sorted = Object.entries(historyObject)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  if (!sorted.length) return "";

  const summary = sorted
    .map(([topic, count]) => `${topic} (${count} interactions)`)
    .join(", ");

  return `User dominant interests: ${summary}`;
}
async function generateWithAI(prompt) {

  const primaryURL =
    `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;

  const fallbackURL =
`https://generativelanguage.googleapis.com/v1/models/gemini-1.5-pro:generateContent?key=${process.env.GEMINI_API_KEY}`;

  const payload = {
    contents: [{ parts: [{ text: prompt }] }]
  };

  try {
    console.log("🤖 Trying Gemini 2.5...");
    const response = await callGeminiWithRetry(primaryURL, payload);
    return response.data.candidates?.[0]?.content?.parts?.[0]?.text || "[]";

  } catch {
    try {
      console.log("⚠ Falling back to Gemini 1.5 Pro...");
      const fallbackResponse = await axios.post(fallbackURL, payload);
      return fallbackResponse.data.candidates?.[0]?.content?.parts?.[0]?.text || "[]";

    } catch {
      console.log("❌ All AI models failed. Returning empty JSON.");
      return "[]";
    }
  }
}

/* =========================================================
   YOUTUBE RETRIEVAL
========================================================= */

async function fetchYouTubeResults(query) {
  const YT_API_KEY = process.env.YOUTUBE_API_KEY;

  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=5&q=${encodeURIComponent(
    query
  )}&key=${YT_API_KEY}`;

  const res = await fetch(url);
  const data = await res.json();

  if (!data.items) return [];

  return data.items.map((item) => ({
    title: item.snippet.title,
    description: item.snippet.description,
    url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
  }));
}

/* =========================================================
   LEETCODE RETRIEVAL
========================================================= */

async function fetchLeetCodeCandidates(topic) {
  const query = {
    query: `
      query problemsetQuestionList($categorySlug: String, $limit: Int, $filters: QuestionListFilterInput) {
        problemsetQuestionList: questionList(
          categorySlug: $categorySlug
          limit: $limit
          filters: $filters
        ) {
          questions: data {
            title
            titleSlug
            difficulty
            acRate
          }
        }
      }
    `,
    variables: {
      categorySlug: "",
      limit: 12,
      filters: { searchKeywords: topic },
    },
  };

  const response = await axios.post(
    "https://leetcode.com/graphql",
    query,
    {
      headers: {
        "Content-Type": "application/json",
        Referer: "https://leetcode.com",
      },
    }
  );

  return response.data.data.problemsetQuestionList.questions.map((q) => ({
    title: q.title,
    difficulty: q.difficulty,
    acRate: q.acRate,
    description: `Difficulty: ${q.difficulty}, Acceptance Rate: ${q.acRate}`,
    url: `https://leetcode.com/problems/${q.titleSlug}`,
  }));
}

/* =========================================================
   YOUTUBE GEMINI RANKING
========================================================= */

async function rankWithGemini(context, results, userProfileSummary) {

  const prompt = `
You are an intelligent educational recommendation ranking agent.

User topic: ${context.topic}
${userProfileSummary}
Return ONLY JSON array:
[
  { "title": "...", "url": "...", "reason": "..." }
]

Resources:
${results.map((r, i) => `
${i + 1}.
Title: ${r.title}
URL: ${r.url}
Description: ${r.description}
`).join("\n")}
`;

  const text = await generateWithAI(prompt);

  const match = text?.match(/\[[\s\S]*\]/);
  if (!match) return null;

  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

/* =========================================================
   LEETCODE AI
========================================================= */

async function rankAndGenerate(problemContext, candidates, userProfileSummary) {

  const prompt = `
You are an AI LeetCode mentor.

Current Problem:
Title: ${problemContext.title}
Difficulty: ${problemContext.difficulty}
Description: ${problemContext.description.slice(0,1500)}

${userProfileSummary}

Rank top 5 similar problems and provide 3 hints + solution outline.

Return JSON:
{
  "similar_problems": [],
  "hints": [],
  "solution_outline": ""
}
`;

  const text = await generateWithAI(prompt);

  const match = text?.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Invalid JSON");

  return JSON.parse(match[0]);
}


/* =========================================================
   MAIN ENDPOINT
========================================================= */

app.post("/recommend", async (req, res) => {
  console.log("BODY:", req.body);
  try {
  const {
  userId,
  platform,
  activity_type,
  topic,
  difficulty,
  description,
} = req.body;
// ===========================
// LOAD OR CREATE USER
// ===========================


 let user = await User.findOne({ userId });

if (!user) {
  user = new User({
    userId,
    weightedProfile: {}
  });
}
for (let key in user.weightedProfile) {
  user.weightedProfile[key] *= 0.98; // decay old interests
}
// Update weighted memory
if (topic && topic.trim() !== "") {
  const normalized = topic.toLowerCase().trim();
  user.weightedProfile[normalized] =
    (user.weightedProfile[normalized] || 0) + 1;
}

// Always save (important)
await user.save();
    

    const userProfileSummary =
      buildUserProfileSummary(user.weightedProfile);

    const cacheKey = `${platform}-${activity_type}-${topic}`;

    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    if (pendingRequests.has(cacheKey)) {
      return pendingRequests.get(cacheKey);
    }


    const requestPromise = (async () => {

      /* ================= LEETCODE ================= */

      if (platform === "LeetCode") {
        if (!topic || !description)
          return { recommendations: [] };

        const candidates = await fetchLeetCodeCandidates(topic);

        try {
          const ai = await rankAndGenerate(
            { title: topic, difficulty, description },
            candidates,
            userProfileSummary
          );

          const normalized = {
            recommendations: [
              ...ai.similar_problems,
              {
                title: "💡 AI Hints",
                description: ai.hints.join("\n\n"),
                url: "#"
              },
              {
                title: "🧠 Solution Strategy",
                description: ai.solution_outline,
                url: "#"
              }
            ]
          };

          setCache(cacheKey, normalized);
          return normalized;

        } catch {
          const fallback = {
            recommendations: candidates.slice(0,5)
          };
          setCache(cacheKey, fallback);
          return fallback;
        }
      }
      /* ================= HACKERRANK ================= */

if (platform === "HackerRank") {

  if (!topic || !description)
    return { recommendations: [] };

  // Reuse LeetCode AI logic
  const candidates = await fetchLeetCodeCandidates(topic); 
  // NOTE: You can later build dedicated HackerRank retrieval

  try {
    const ai = await rankAndGenerate(
      { title: topic, difficulty, description },
      candidates,
      userProfileSummary
    );

    const normalized = {
      recommendations: [
        ...ai.similar_problems,
        {
          title: "💡 AI Hints",
          description: ai.hints.join("\n\n"),
          url: "#"
        },
        {
          title: "🧠 Solution Strategy",
          description: ai.solution_outline,
          url: "#"
        }
      ]
    };

    setCache(cacheKey, normalized);
    return normalized;

  } catch {
    return { recommendations: candidates.slice(0,5) };
  }
}

      /* ================= COURSERA ================= */

  if (platform === "Coursera") {
  if (!topic) return { recommendations: [] };

  const dominantTopics = extractDominantTopics(user.weightedProfile);

  const simulatedCourses = [
    { title: `${topic} Foundations`, url: "#" },
    { title: `Advanced ${topic}`, url: "#" },
    { title: `${topic} for Beginners`, url: "#" },
    { title: `${topic} Specialization`, url: "#" },
    { title: `Practical ${topic} Projects`, url: "#" },
    { title: `AI Applications in ${topic}`, url: "#" }
  ];

  const ranked = simulatedCourses
    .map(course => ({
      ...course,
      score: scoreCourse(course.title, topic, dominantTopics)
    }))
    .sort((a,b)=>b.score - a.score)
    .slice(0,5)
    .map(course => ({
      title: course.title,
      url: `https://www.coursera.org/search?query=${encodeURIComponent(course.title)}`,
      reason: `Recommended because it aligns with your interest in ${topic} and related areas.`
    }));

  return { recommendations: ranked };
}
      /* ================= UDEMY ================= */
  if (platform === "Udemy") {
  if (!topic) return { recommendations: [] };

  const dominantTopics = extractDominantTopics(user.weightedProfile);

  const simulatedCourses = [
    `${topic} Bootcamp`,
    `Complete ${topic} Masterclass`,
    `${topic} Zero to Hero`,
    `${topic} Interview Preparation`,
    `Hands-On ${topic} Projects`,
    `${topic} for Professionals`
  ];

  const ranked = simulatedCourses
    .map(title => ({
      title,
      score: scoreCourse(title, topic, dominantTopics)
    }))
    .sort((a,b)=>b.score - a.score)
    .slice(0,5)
    .map(course => ({
      title: course.title,
      url: `https://www.udemy.com/courses/search/?q=${encodeURIComponent(course.title)}`,
      reason: `Matches your learning pattern and strengthens your ${topic} expertise.`
    }));

  return { recommendations: ranked };
}

      /* ================= YOUTUBE ================= */

      if (platform === "YouTube") {
        if (!topic) return { recommendations: [] };

        const retrieved = await fetchYouTubeResults(topic);
        if (!retrieved.length) return { recommendations: [] };

        const ranked = await rankWithGemini(
          { topic },
          retrieved,
          userProfileSummary
        );

        const final = {
          recommendations: ranked || retrieved.slice(0,3)
        };

        setCache(cacheKey, final);
        return final;
      }

      return { recommendations: [] };
    })();

    pendingRequests.set(cacheKey, requestPromise);
    const result = await requestPromise;
    pendingRequests.delete(cacheKey);

    return res.json(result);

  } catch (err) {
    console.error("SERVER ERROR:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});
async function callGeminiWithRetry(url, payload, retries = 3) {
  try {
    return await axios.post(url, payload);
  } catch (err) {
    if (err.response?.status === 429 && retries > 0) {
      console.log("⚠ Gemini Rate Limited. Retrying...");
      await new Promise(res => setTimeout(res, 2000));
      return callGeminiWithRetry(url, payload, retries - 1);
    }
    throw err;
  }
}
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});