/* Fitroom AI Worker (Cloudflare). Paste this whole file into the fitroom-ai Worker and Deploy.
   The API key stays in the Worker as the secret ANTHROPIC_API_KEY; it is never in the website. */
const ALLOWED = ["https://cara-xie.github.io"];
const MODEL = "claude-haiku-5-5";

/* Fallback style list. The website also sends its own list (from styles.js), which is used when present. */
const DEFAULT_STYLES = ["Modernist","Contemporary","Minimalist","Warm minimalism","Organic modern","Scandinavian","Japandi","Mid-century","Bauhaus-inspired","Industrial loft","Brutalist-inspired","Contemporary Italian","Wabi-sabi","Belgian rustic","Rustic cabin","Modern mountain","Alpine chalet","Traditional farmhouse","Modern farmhouse","Desert modern","Southwestern","Biophilic","Relaxed coastal","Hamptons","California casual","Mediterranean","Modern Mediterranean","Spanish Revival","Tuscan country","Greek island","French Riviera","Tropical contemporary","Balinese resort","Soft pink","Traditional","Transitional","Modern traditional","English country","English cottage","French country","Parisian apartment","Neoclassical","Georgian / Regency","Victorian","Arts and Crafts","Grandmillennial","Art Deco","Hollywood Regency","Contemporary luxury","Eclectic","Maximalist","Bohemian","Jungalow","Memphis / postmodern","1970s retro","Space-age retrofuturism","Cosmic / space","Dark academia","Moroccan-inspired","Traditional Japanese","Contemporary Chinese","Indian contemporary"];

const STYLE_SYSTEM =
  "You are an interior design assistant for Fitroom. The person may give written words, photos of rooms they like, or both. " +
  "Read everything they say, including themes and moods that are not decor words (for example space, NASA, ocean, Paris, cute, moody), " +
  "and pick the single closest style from the allowed list. When photos are given, judge style, materials, shapes, mood and palette, not only colors. " +
  "Colors must match what they asked for (for example deep blue means dark navy hex codes). Always answer by calling the set_vibe tool.";

const SIZE_SYSTEM =
  'You read text taken from a furniture product web page. Find the overall dimensions of the main item in inches (convert centimeters by dividing by 2.54). Width is the longest side along the front, depth is front to back, height is floor to top. If several sizes or variants are listed, use the first or default one and say so in "note". If the page has no dimensions, use null. Reply with ONLY JSON: {"name":"short product name","width_in":number or null,"depth_in":number or null,"height_in":number or null,"note":"one short sentence"}';

function vibeTool(styles) {
  return {
    name: "set_vibe",
    description: "Record the design style and details read from the person's words and photos. Call this exactly once.",
    input_schema: {
      type: "object",
      properties: {
        style: { type: "string", enum: styles, description: "The single closest style from the allowed list." },
        colors: { type: "array", items: { type: "string", description: "Hex color like #1B2A4A" }, description: "3 to 5 hex colors for the palette they described." },
        mustHave: { type: "array", items: { type: "string" }, description: "Up to 4 furniture pieces they want, each 1 to 3 words." },
        budget: { type: "string", enum: ["low", "mid", "high"] },
        words: { type: "array", items: { type: "string" }, description: "Up to 8 short words for the colors, materials, shapes and mood noticed." },
        reason: { type: "string", description: "One short sentence, under 25 words, on why this style fits." },
      },
      required: ["style", "colors", "budget", "reason"],
    },
  };
}

async function callClaude(env, payload) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: MODEL, ...payload }),
  });
  return r.json();
}

function pageText(html) {
  const ld = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1].trim()).join("\n").slice(0, 6000);
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ""])[1].trim();
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
  const windows = [];
  const re = /(dimensions?|overall|width|depth|height|length|diameter|seat height)/gi;
  let m, last = -1000;
  while ((m = re.exec(text)) && windows.join(" ").length < 7000) {
    if (m.index - last > 250) { windows.push(text.slice(Math.max(0, m.index - 100), m.index + 300)); last = m.index; }
  }
  return `TITLE: ${title}\nSTRUCTURED DATA: ${ld}\nPAGE TEXT: ${text.slice(0, 1500)}\nSIZE SNIPPETS: ${windows.join(" | ")}`.slice(0, 15000);
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const ok = ALLOWED.includes(origin) || origin.endsWith(".app.github.dev") || origin.startsWith("http://localhost");
    const cors = {
      "Access-Control-Allow-Origin": ok ? origin : ALLOWED[0],
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    const json = (obj) => new Response(JSON.stringify(obj), { headers: { ...cors, "content-type": "application/json" } });
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (!ok || req.method !== "POST") return new Response("Not allowed", { status: 403, headers: cors });

    let body = {};
    try { body = await req.json(); } catch (e) {}

    /* Mode 2: read a furniture size from a product link */
    if (body.url) {
      let u;
      try { u = new URL(String(body.url)); } catch (e) { return json({ error: "bad link" }); }
      if (!/^https?:$/.test(u.protocol) || u.hostname === "localhost" || /^[\d.:\[]/.test(u.hostname) || !u.hostname.includes(".")) {
        return json({ error: "bad link" });
      }
      let html = "";
      try {
        const pr = await fetch(u.toString(), {
          headers: {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
            Accept: "text/html,application/xhtml+xml",
            "Accept-Language": "en-US,en;q=0.9",
          },
          redirect: "follow",
        });
        if (!pr.ok) return json({ error: "blocked", status: pr.status });
        html = (await pr.text()).slice(0, 1500000);
      } catch (e) { return json({ error: "blocked" }); }
      const txt = pageText(html);
      if (txt.length < 300) return json({ error: "blocked" });
      const data = await callClaude(env, { max_tokens: 400, system: SIZE_SYSTEM, messages: [{ role: "user", content: [{ type: "text", text: txt }] }] });
      const out = data.content?.find((b) => b.type === "text")?.text;
      if (!out) return json({ error: "no text", raw: JSON.stringify(data).slice(0, 300) });
      return new Response(out, { headers: { ...cors, "content-type": "application/json" } });
    }

    /* Mode 1: read a vibe from words and photos */
    const text = String(body.text || "").slice(0, 1000);
    const sent = (Array.isArray(body.styles) ? body.styles : []).filter((s) => typeof s === "string" && s.length > 0 && s.length <= 40).slice(0, 120);
    const styles = sent.length >= 5 ? [...new Set(sent)] : DEFAULT_STYLES;
    const images = (Array.isArray(body.images) ? body.images : [])
      .filter((d) => typeof d === "string" && d.length < 2000000 && /^[A-Za-z0-9+/=]+$/.test(d))
      .slice(0, 3);
    const content = images.map((data) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } }));
    content.push({ type: "text", text: text || "No description was written. Judge only from the photos." });
    const data = await callClaude(env, {
      max_tokens: 800,
      system: STYLE_SYSTEM,
      tools: [vibeTool(styles)],
      tool_choice: { type: "tool", name: "set_vibe" },
      messages: [{ role: "user", content }],
    });
    const call = data.content?.find((b) => b.type === "tool_use");
    if (call && call.input) return json(call.input);
    const out = data.content?.find((b) => b.type === "text")?.text;
    if (out) return new Response(out, { headers: { ...cors, "content-type": "application/json" } });
    return json({ error: "no reply", raw: JSON.stringify(data).slice(0, 400) });
  },
};
