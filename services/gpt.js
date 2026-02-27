import OpenAI from "openai";
const openai = new OpenAI({ apiKey: process.env.OPENAI_KEY });

export async function analyzeWithGPT(data) {
  const prompt = `
User is learning on ${data.site}.
Context: ${JSON.stringify(data)}
Suggest better resources, channels or practice paths.
`;

  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }]
  });

  return { recommendation: res.choices[0].message.content };
}