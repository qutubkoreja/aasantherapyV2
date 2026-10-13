// Vercel serverless function.
// FREE: set GEMINI_API_KEY (aistudio.google.com) and/or GROQ_API_KEY (console.groq.com). Providers are tried in that order.
// Add keys in Vercel > Settings > Environment Variables.
const SYSTEM = `You are AasanTherapy, a warm, psychology-informed support companion for people struggling with low mood, anxiety, stress, loneliness and similar difficulties. Many users cannot afford therapy.

How you help:
- Listen first. Reflect feelings in plain, gentle language before offering anything.
- Use evidence-based skills in small steps: CBT (spotting and gently questioning unhelpful thoughts), behavioural activation, grounding (5-4-3-2-1), slow breathing, sleep and routine basics, journaling, self-compassion, problem-solving.
- Keep replies short (under 150 words), warm, and conversational. Ask at most one question at a time. No long lists.
- Reply in the same language the user writes in (English, Urdu, Roman Urdu, Arabic, etc.).

Boundaries:
- You are not a doctor or therapist. Never diagnose, never advise on starting, stopping or changing medication.
- If symptoms are severe, long-lasting, or affect daily life, encourage seeing a doctor or counsellor, and mention low-cost options (government hospitals, community or NGO counselling, helplines, trusted family or friends).
- If the user mentions suicide, self-harm, abuse, or being in danger: respond with calm care, take it seriously, ask if they are safe right now, urge them to contact local emergency services or a crisis line and a trusted person nearby, and stay with them in the conversation. Do not give methods. Do not argue about their wish to die; acknowledge their pain and encourage immediate human support.

Islamic touch (gentle, optional):
- Many users are Muslim. Where it fits naturally, you may offer a short, authentic reminder from the Quran or a well-known dua, or mention patience (sabr), trust in Allah (tawakkul), prayer, dhikr, and gratitude, as comfort alongside practical steps.
- Never invent or misquote verses, hadith or scholars. If unsure, speak in general terms. Do not issue religious rulings (fatwas).
- Never imply that depression or anxiety means weak faith or is a punishment. Seeking treatment and counselling is encouraged and compatible with faith.
- If the user is not Muslim or prefers a non-religious approach, respect that fully and keep to psychology only. Do not push religion.

Be respectful, never judgmental, and never promise outcomes.`;

const hits = new Map(); // best-effort rate limit per instance
function limited(ip){
  const now = Date.now(), win = 60_000, max = 8;
  const arr = (hits.get(ip) || []).filter(t => now - t < win);
  arr.push(now); hits.set(ip, arr);
  return arr.length > max;
}

const FALLBACK = "I'm here with you. I couldn't put that into words just now, but what you're feeling matters. If you're in danger or thinking of hurting yourself, please contact your local emergency number or a crisis line and tell someone near you right now. Would you like to tell me more about what's going on?";

async function callGemini(key, msgs){
  const models = [process.env.MODEL, "gemini-2.5-flash-lite", "gemini-flash-lite-latest", "gemini-flash-latest"].filter(Boolean);
  let last = "";
  for (const model of models) {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent", {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: msgs.map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
        generationConfig: { maxOutputTokens: 800, temperature: 0.7 }
      })
    });
    const data = await r.json().catch(() => ({}));
    if (r.status === 429) return { busy: true };
    if (r.status === 404) { last = model + ": not found"; continue; } // try next model name
    if (!r.ok) {
      const msg = (data.error && data.error.message) || "unknown";
      console.error("Gemini error", r.status, msg);
      return { error: true, detail: r.status + " " + msg.slice(0, 160) };
    }
    const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
    return { reply: parts.map(p => p.text || "").join("").trim() };
  }
  return { error: true, detail: "no model available (" + last + ")" };
}

async function callGroq(key, msgs){
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", "authorization": "Bearer " + key },
    body: JSON.stringify({
      model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
      max_tokens: 600, temperature: 0.7,
      messages: [{ role: "system", content: SYSTEM }, ...msgs]
    })
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 429) return { busy: true };
  if (!r.ok) {
    const msg = (data.error && data.error.message) || "unknown";
    console.error("Groq error", r.status, msg);
    return { error: true, detail: "Groq " + r.status + " " + msg.slice(0, 120) };
  }
  return { reply: ((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "").trim() };
}

async function callClaude(key, msgs){
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: process.env.MODEL || "claude-haiku-5-5", max_tokens: 600, system: SYSTEM, messages: msgs })
  });
  const data = await r.json();
  if (r.status === 429) return { busy: true };
  if (!r.ok) return { error: true };
  return { reply: (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim() };
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const gKey = process.env.GEMINI_API_KEY, qKey = process.env.GROQ_API_KEY, aKey = process.env.ANTHROPIC_API_KEY;
  if (!gKey && !qKey && !aKey) return res.status(500).json({ error: "Server is missing GEMINI_API_KEY (or GROQ_API_KEY)." });
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0] || "x";
  if (limited(ip)) return res.status(429).json({ error: "Too many messages. Please wait a minute." });

  let msgs = req.body && req.body.messages;
  if (!Array.isArray(msgs) || !msgs.length) return res.status(400).json({ error: "No messages." });
  msgs = msgs.slice(-20)
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map(m => ({ role: m.role, content: m.content.slice(0, 2000) }));
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  if (!msgs.length) return res.status(400).json({ error: "Invalid messages." });

  try {
    // Try each configured provider in order; fall back to the next if one fails or is busy.
    const providers = [];
    if (gKey) providers.push(() => callGemini(gKey, msgs));
    if (qKey) providers.push(() => callGroq(qKey, msgs));
    if (aKey) providers.push(() => callClaude(aKey, msgs));
    let out = { error: true };
    for (const p of providers) {
      try { out = await p(); } catch (e) { out = { error: true, detail: "network" }; }
      if (out && out.reply !== undefined) break;
    }
    if (out.busy) return res.status(429).json({ error: "AasanTherapy is very busy right now. Please try again in a minute." });
    if (out.error) return res.status(502).json({ error: "The AI service had a problem" + (out.detail ? " [" + out.detail + "]" : "") + ". Please try again." });
    return res.status(200).json({ reply: out.reply || FALLBACK });
  } catch (e) {
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
};
