import "dotenv/config";
import { toolDefinitions } from "@/lib/ai/tools";

async function main() {
  const key = process.env.GROQ_API_KEY!;
  const model = process.env.GROQ_MODEL ?? "openai/gpt-oss-20b";
  const tools = toolDefinitions();
  console.log(`Model: ${model}  |  Tools: ${tools.length}`);

  const scenarios = [
    { id: "G3-tools-en", content: "Who are my top 5 customers?", locale: "en" },
    { id: "G4-chart-ar", content: "وريني مبيعات آخر ٧ أيام في رسم بياني", locale: "ar" },
  ];

  for (const s of scenarios) {
    const start = Date.now();
    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: `You can call render_text to answer. Respond in ${s.locale === "ar" ? "Arabic" : "English"}.` },
            { role: "user", content: s.content },
          ],
          tools,
          tool_choice: "auto",
          max_tokens: 3000,
          temperature: 0.2,
          reasoning_effort: "low",
        }),
      });
      const elapsed = Date.now() - start;
      if (!res.ok) {
        const body = await res.text();
        console.log(`[${s.id}] HTTP ${res.status} (${elapsed}ms)`);
        console.log(`  body: ${body.slice(0, 400)}`);
        continue;
      }
      const data = await res.json() as any;
      const msg = data.choices?.[0]?.message;
      const toolCalls = msg?.tool_calls?.map((t: any) => `${t.function.name}(${t.function.arguments.slice(0, 80)}…)`) ?? [];
      const contentPreview = (msg?.content ?? "").slice(0, 300).replace(/\n/g, " ");
      console.log(`[${s.id}] HTTP 200 (${elapsed}ms) tokens=${data.usage?.total_tokens}`);
      console.log(`  tool_calls: ${toolCalls.length === 0 ? "(none)" : toolCalls.join(" ; ")}`);
      console.log(`  content:    "${contentPreview}"`);
      console.log(`  finish:     ${data.choices?.[0]?.finish_reason}`);
    } catch (e: any) {
      console.log(`[${s.id}] THREW: ${e.message}`);
    }
  }
}
main().catch(console.error);
